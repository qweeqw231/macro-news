// src/collect.mjs
// 全球宏观资讯 · 采集主程序
//
// 设计要点：
//  - 幂等：重复运行不会产生重复条目（按 id 去重）
//  - 增量：每次只抓「最近 N 小时」，已入库的按 id 丢弃
//  - 隔离：单个源失败不影响其他源，失败信息写入 _last-run.json
//  - 零依赖：只用 Node 内置 fetch，Windows 计划任务可直接跑
//
// 用法：
//   node src/collect.mjs              # 正常采集
//   node src/collect.mjs --since 48   # 回补最近 48 小时（首次初始化用）

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDICES, SOURCES, fetchQuotes, getQuoteError } from './sources.mjs';
import { ETFS } from './etf.mjs';
import { fetchDailyK } from './kline.mjs';
import { fetchPortfolioQuotesFast } from './portfolio.mjs';
import { finalizeClosedQuotes } from './quote-finalize.mjs';
import { readBriefingMeta } from './brief-meta.mjs';
import { dedupeItems } from './news-dedupe.mjs';
import { decideBars } from './kline-guard.mjs';
import { acquireKlineLock, releaseKlineLock, lockSkipText } from './kline-lock.mjs';
import { newsDay } from './news-day.mjs';
import { searchCutoff, compactSearchItem, SEARCH_WINDOW_DAYS } from './search-window.mjs';
import { selectDayItems, OFFICIAL_RECENT_DAYS, isRecent } from './quota.mjs';
import { describeSourceError } from './source-error.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const ARCHIVE = path.join(DATA, 'archive');

// 默认回补 24h：既能覆盖两次轮询之间的空档，又不会把陈旧条目反复拉回来。
// 注意：官方源（统计局/央行）多为月度或季度发布，窗口内没有新条目属正常情况。
const argSince = process.argv.indexOf('--since');
const SINCE_HOURS = argSince > -1 ? Number(process.argv[argSince + 1]) || 24 : 24;

const pad = (n) => String(n).padStart(2, '0');
// 2.4.19：新闻日统一走 src/news-day.mjs（北京 08:00 起算，等价 UTC 日期）
// 不再使用 getFullYear/getMonth/getDate —— 本机 TZ=Asia/Shanghai 会按北京零点切日，
// 与 GitHub Actions 的 UTC 切日不一致。

async function readJSON(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJSON(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
}

// ---------- 写入优化：内容没变就不写盘 ----------
// 时间戳类字段每次都变，若无条件写盘，git 会为同一份数据反复存新 blob。
// 实测：12 个 K 线文件（432KB）仅因 generatedAt 变化，
// 就让每次提交多出约 109KB 仓库增长，而 K 线其实一根都没变。
// 剥掉易变字段后比对，内容相同即跳过写入。
//
// 注意：只剥「纯噪声」字段（时间戳与耗时）。count / total / added / ok / error
// 都是有意义的变化——早先把它们一并剥掉，导致同一天新增条目时 index.json 的
// 天数计数被判为「未变化」而跳过写盘，归档页计数长期停留在旧值。
const TIME_FIELDS = '(generatedAt|updatedAt|startedAt|endedAt|durationMs)';
const NUM_FIELDS = '(durationMs|ms)';
const reTime = new RegExp(`"${TIME_FIELDS}"\\s*:\\s*"[^"]*"`, 'g');
const reNum = new RegExp(`"${NUM_FIELDS}"\\s*:\\s*[^,\\n}]*`, 'g');

function stripVolatile(text) {
  return String(text).replace(reTime, '"_":"_"').replace(reNum, '"_":0');
}

const stats = { skipped: 0, written: 0 };

async function writeJSONIfChanged(file, obj) {
  const text = JSON.stringify(obj, null, 2);
  if (existsSync(file)) {
    try {
      const old = await readFile(file, 'utf8');
      if (stripVolatile(old) === stripVolatile(text)) {
        stats.skipped++;
        return false;
      }
    } catch { /* 读不了就照常写 */ }
  }
  await writeFile(file, text, 'utf8');
  stats.written++;
  return true;
}

/**
 * K线预生成：日K / 周K / 月K（保证没有 Worker 代理时也能画图）。
 *
 * 为什么预生成三档，而不是像以前那样只存日K：
 *   · 前端直连（东财）能拿到 周K 1821 根（1990 起 35.8 年）、月K 431 根（36 年全量），
 *     本地兜底只有日K 的话，周/月只能由日K聚合 → 历史被砍到 4 年；
 *   · 体积与更新频率是权衡点：日K 每天变（主体成本），周K 一周变、月K 一月变
 *     → 把长历史放在周K/月K 里，日更压力只有日K 一档。
 *
 * 文件名：data/kline/<key>.json（日）/ <key>_1w.json（周）/ <key>_1M.json（月）
 *
 * @param {Date} startedAt
 * @param {string[]} [onlyKeys] 只刷这些 key（默认全部）
 */
async function collectKlines(startedAt, onlyKeys) {
  const klineOk = [];
  const klineSkip = [];
  let lockSkipped = 0;
  const { INDICES, PORTFOLIO_KLINE, fetchKline, klineAvailable, klineTarget, getKlineSource } =
    await import('./sources.mjs');
  // 23 个指数 + 6 个组合标的（纳指100 / 伦敦金 / 上海金 / 伦敦银 / 布伦特 / 人民币中间价）
  const all = [...INDICES.map((i) => i.key), ...PORTFOLIO_KLINE.map((i) => i.key)];
  const keys = onlyKeys && onlyKeys.length ? all.filter((k) => onlyKeys.includes(k)) : all;
  const KLINE_SPEC = [
    { period: '1d', limit: 1000, suffix: '' },   // 日K 1000 根 ≈ 4 年（日更主体）
    { period: '1w', limit: 1821, suffix: '_1w' }, // 周K 1821 根 ≈ 35.8 年（周更）
    { period: '1M', limit: 500, suffix: '_1M' },  // 月K 源侧实际只有 ~431~454 根 = 36 年全量（月更）
  ];
  for (const key of keys) {
    if (!klineAvailable(key)) { klineSkip.push(key); continue; }
    const meta = klineTarget(key);
    const done = [];
    for (const spec of KLINE_SPEC) {
      try {
        const file = path.join(DATA, 'kline', `${key}${spec.suffix}.json`);
        const incoming = await fetchKline(key, spec.period, spec.limit);
        const lock = await acquireKlineLock(key);
        if (!lock.ok) {
          lockSkipped++;
          console.log(`  ${lockSkipText(key, lock)}`);
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        try {
          const prev = await readJSON(file, null);
          // 2.4.10：短序列不得覆盖长序列（见 src/kline-guard.mjs）
          const decision = decideBars(prev && prev.bars, incoming);
          if (decision.action === 'reject') {
            console.log(
              `  ⛔ ${key} ${spec.period} rejected: shorter（新 ${incoming.length} 根 < 现有 ${(prev.bars || []).length} 根），保留现有文件`
            );
            continue;
          }
          const bars = decision.bars;
          await writeJSONIfChanged(file, {
            key,
            name: meta?.name || key,
            market: meta?.market || '',
            period: spec.period,
            generatedAt: startedAt.toISOString(),
            // 取数源写进文件：离线快照必须能自证是哪来的（东财 / 新浪 / 新浪外盘 / 上金所 / 腾讯）
            source: getKlineSource() || '',
            bars,
          });
          done.push(`${spec.period}:${bars.length}${decision.action === 'merge' ? '/merge' : ''}`);
        } finally {
          await releaseKlineLock(lock);
        }
      } catch (err) {
        // 单个周期失败不影响其它周期（例如某源不支持月K）
      }
      // 同一轮里要打 12×3 个请求，间隔一下别把新浪/腾讯打到限流
      await new Promise((r) => setTimeout(r, 250));
    }
    if (done.length) klineOk.push(`${key}[${done.join(',')}]`);
    else klineSkip.push(key);
  }
  console.log(
    `[collect] K线：${klineOk.length} 个标的 × ${KLINE_SPEC.length} 个周期，跳过 ${klineSkip.length} 个（${klineSkip.join(', ') || '无'}），锁占用 ${lockSkipped} 次`
  );
  if (klineOk.length) console.log(`[collect] K线明细：${klineOk.join(' ')}`);
}

async function main() {
  const startedAt = new Date();
  console.log(`[collect] 开始 · 回补窗口 ${SINCE_HOURS}h`);

  // --kline-only：只刷 K 线文件（不抓新闻、不写行情快照），用于单独补某个标的的 K 线
  if (process.argv.includes('--kline-only')) {
    const i = process.argv.indexOf('--kline-only');
    const only = process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
      ? process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    console.log(`[collect] --kline-only${only ? ' · 只刷 ' + only.join(',') : ' · 全部标的'}`);
    await collectKlines(startedAt, only);
    return;
  }

  await mkdir(ARCHIVE, { recursive: true });

  // ---- 采集各源 ----
  const perSource = await Promise.all(
    SOURCES.map(async (s) => {
      const t0 = Date.now();
      try {
        const items = await s.run();
        console.log(`  ✅ ${s.label.padEnd(12)} ${String(items.length).padStart(4)} 条  ${Date.now() - t0}ms`);
        return { id: s.id, label: s.label, ok: true, items, ms: Date.now() - t0, windowed: s.windowed !== false };
      } catch (err) {
        const cause = describeSourceError(err);
        const causeText = cause.causeCode ? `（${cause.causeCode}）` : '';
        console.log(`  ❌ ${s.label.padEnd(12)} ${String(err.message).slice(0, 60)}${causeText}`);
        return {
          id: s.id, label: s.label, ok: false, error: err.message, items: [],
          ms: Date.now() - t0, windowed: s.windowed !== false, ...cause,
        };
      }
    })
  );

  // ---- 时间窗过滤 ----
  // 官方源（央行/统计局等）发布频率低，最新一条可能在窗口之外；
  // 若同样按 24h 过滤会被永久丢弃。标记 windowed:false 的源跳过 24h 窗口，
  // 但仍只接受最近 7 天，避免 windowed:false 把几个月前的旧条目反复拉回。
  const cutoff = startedAt.getTime() - SINCE_HOURS * 3600 * 1000;
  const merged = new Map();
  for (const s of perSource) {
    for (const it of s.items) {
      const t = it.ts ? it.ts * 1000 : new Date(it.time).getTime();
      if (s.windowed && Number.isFinite(t) && t < cutoff) continue;
      if (!s.windowed && Number.isFinite(t) && !isRecent(t, startedAt.getTime(), OFFICIAL_RECENT_DAYS)) continue;
      if (!merged.has(it.id)) merged.set(it.id, it);
    }
  }
  const fresh = dedupeItems([...merged.values()]).sort((a, b) => b.ts - a.ts);
  console.log(`[collect] 窗口内去重后新增候选：${fresh.length} 条`);

  // ---- 行情 ----
  // 关键：取不到就保留上一次的好数据，绝不用空数组覆盖
  let quotes = [];
  try {
    quotes = await fetchQuotes();
    const qerr = getQuoteError();
    if (qerr) {
      console.log(`  ⚠️ 行情部分失败：${qerr}`);
    } else {
      console.log(`[collect] 行情快照：${quotes.length} 项`);
    }
    if (!quotes.length) console.log('  ↳ 本轮行情为空，将保留 data/quotes.json 原有内容');
  } catch (err) {
    console.log(`  ❌ 行情 ${err.message}`);
  }

  // ---- 组合行情：并入同一轮 15 分钟采集 ----
  // xau/xag/brent 24 小时交易、每轮都刷新；sge/usdcny/cgb 一天只发布一次，
  // 只在「过了发布时刻且存量不是今天」时重取（未到期的 key 保留 quotes.json 存量）。
  const prevDoc = await readJSON(path.join(DATA, 'quotes.json'), { quotes: [] });
  try {
    const fast = await fetchPortfolioQuotesFast(prevDoc.quotes || []);
    if (fast.quotes.length) {
      quotes = [...quotes, ...fast.quotes];
      console.log(`[collect] 组合行情：${fast.ok.join(', ')}`);
    }
    if (Object.keys(fast.fail).length) {
      console.log(`  ⚠️ 组合行情失败：${Object.keys(fast.fail).join(', ')}`);
    }
  } catch (err) {
    console.log(`  ⚠️ 组合行情 ${err.message}`);
  }

  // ---- 收盘定稿：源时间滞后的指数改用日 K 收盘价 ----
  // 2.9.1：印度 18:00 收盘后东财 f124 仍停在 17:45，价格却已是收盘价；
  // 不按市场写分支，凡「已收盘 + 源时间早于收盘」都用日 K 当日收盘覆盖。
  try {
    const meta = new Map([...INDICES, ...ETFS].map((x) => [x.key, x]));
    const fin = await finalizeClosedQuotes(quotes, {
      now: startedAt.getTime(),
      prevQuotes: prevDoc.quotes || [],
      meta,
      fetchDailyK,
    });
    quotes = fin.quotes;
    for (const c of fin.changes) {
      console.log(`  ↳ 收盘定稿 ${c.key}：${c.from} → ${c.to}（日线 ${c.price}）`);
    }
  } catch (err) {
    console.log(`  ⚠️ 收盘定稿 ${err.message}`);
  }

  // ---- 写入：按天归档 ----
  const byDay = new Map();
  for (const it of fresh) {
    const k = newsDay(it.time || startedAt) || newsDay(startedAt);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(it);
  }

  let addedTotal = 0;
  for (const [day, items] of byDay) {
    const file = path.join(ARCHIVE, `${day}.json`);
    const existing = await readJSON(file, { day, items: [] });
    const existingIds = new Set(existing.items.map((i) => i.id));
    // 2.4.5：不仅去重本轮新条目，也把**已归档**的同文重复合并掉。
    // 华尔街见闻同一篇快讯会以两个 id（A股/全球）返回，旧版本已把两条都写进归档；
    // 每次重建本日文件时重新跑一遍 dedupe，历史当日数据即可自愈。
    const mergedItems = selectDayItems(
      dedupeItems([...items, ...existing.items])
    );
    const newOnes = mergedItems.filter((i) => !existingIds.has(i.id)).length;
    const removed = existing.items.length + newOnes - mergedItems.length;
    if (newOnes || mergedItems.length !== existing.items.length) {
      existing.items = mergedItems;
      await writeJSON(file, existing);
      addedTotal += newOnes;
      console.log(
        `  → ${day}.json  +${newOnes}${removed > 0 ? ` · 合并重复 -${removed}` : ''}（累计 ${existing.items.length}）`
      );
    }
  }

  // ---- 重建索引 + 最新快照 ----
  // 早报与归档「同键绑定」：索引里只多一个 hasBriefing 与一句 ≤80 字的 briefLine，
  // 不新增索引文件、不预取早报正文（完整 JSON 在归档卡片展开时才请求）。
  const briefs = readBriefingMeta(path.join(DATA, 'briefings'));
  const files = (await import('node:fs')).readdirSync(ARCHIVE).filter((f) => f.endsWith('.json'));
  const days = [];
  let allCount = 0;
  for (const f of files.sort()) {
    const d = await readJSON(path.join(ARCHIVE, f), { day: f.replace('.json', ''), items: [] });
    const b = briefs.get(d.day);
    days.push({
      day: d.day,
      count: d.items.length,
      hasBriefing: !!b,
      ...(b && b.briefLine ? { briefLine: b.briefLine } : {}),
      ...(b ? { source: b.source } : {}),
    });
    allCount += d.items.length;
  }
  days.sort((a, b) => (a.day < b.day ? 1 : -1));

  // latest.json：最近 200 条，供首页与全文搜索
  const allItems = [];
  for (const f of files.sort().reverse()) {
    const d = await readJSON(path.join(ARCHIVE, f), { items: [] });
    allItems.push(...d.items);
    if (allItems.length >= 200) break;
  }
  const latest = allItems.sort((a, b) => b.ts - a.ts).slice(0, 200);

  await writeJSONIfChanged(path.join(DATA, 'latest.json'), {
    generatedAt: startedAt.toISOString(),
    total: allCount,
    items: latest,
  });
  await writeJSONIfChanged(path.join(DATA, 'index.json'), {
    generatedAt: startedAt.toISOString(),
    total: allCount,
    days,
  });

  // search.json：最近 62 个新闻日的精简副本（只有标题/来源/时间/链接，无摘要）
  // 2.4.19：窗口外的 archive 日期不再进索引；220 字摘要去掉，体积约减半。
  const searchFrom = searchCutoff(startedAt.getTime());
  const searchItems = [];
  let searchDays = 0;
  for (const f of files.sort().reverse()) {
    const day = f.replace('.json', '');
    if (day < searchFrom) break;
    const d = await readJSON(path.join(ARCHIVE, f), { items: [] });
    for (const it of d.items) searchItems.push(compactSearchItem(it));
    searchDays++;
  }
  await writeJSONIfChanged(path.join(DATA, 'search.json'), {
    generatedAt: startedAt.toISOString(),
    windowDays: SEARCH_WINDOW_DAYS,
    from: searchFrom,
    days: searchDays,
    total: searchItems.length,
    items: searchItems,
  });
  if (quotes.length) {
    // 按 key 合并写入：保留 portfolio-collect.mjs 写入的其它 key。
    // 本任务负责 INDICES 里的 23 个指数 + 32 只 ETF + 纳指100（ndx 在 15 分钟级别单独刷新，
    // 否则美股收盘后要等到第二天 16:30 的组合采集才更新）；若整份覆盖，
    // 组合行情（xau/xag/...）会在下一次运行里被抹掉。
    const quotesFile = path.join(DATA, 'quotes.json');
    const prevQuotes = await readJSON(quotesFile, { quotes: [] });
    const byKey = new Map((prevQuotes.quotes || []).map((q) => [q.key, q]));
    for (const q of quotes) byKey.set(q.key, q);
    await writeJSONIfChanged(quotesFile, {
      generatedAt: startedAt.toISOString(),
      quotes: [...byKey.values()],
    });
  }

  // ---- K线：预生成 日K / 周K / 月K（保证没有 Worker 代理时也能画图） ----
  //
  // 为什么预生成三档，而不是像以前那样只存日K：
  //   · 前端直连（东财）能拿到 周K 1821 根（1990 起 35.8 年）、月K 431 根（36 年全量），
  //     本地兜底只有日K 的话，周/月只能由日K 聚合 → 历史被砍到 4 年；
  //   · 体积与更新频率是权衡点：日K 每天变（主体成本），周K 一周变、月K 一月变
  //     → 把长历史放在周K/月K 里，日更压力只有日K 一档。
  //
  // 文件名：data/kline/<key>.json（日）/ <key>_1w.json（周）/ <key>_1M.json（月）
  if (!process.argv.includes('--no-kline')) {
    await collectKlines(startedAt);
  }

  const okCount = perSource.filter((s) => s.ok).length;
  // 读改写：保留 portfolio-collect.mjs（每日 16:30 任务）写入的字段
  // （at / ok / fail / macroOk / macroFail / portfolioQuotes ...）。
  // 若整份覆盖，组合行情那套运行日志会在下一次本任务运行（每 5 分钟）里被清空。
  const logFile = path.join(DATA, '_last-run.json');
  const prevLog = await readJSON(logFile, {});
  // 2.4.17：读改写保留 unknown 字段（含 localSync 本机同步状态），不要整文件重建
  const logObj = {
    ...prevLog,
    // 哪台机器在喂数据：云端 Actions / 本机 Windows 任务。页脚据此显示「云端」「本机」，
    // 排查时也能一眼看出最后一次写入是谁做的（两边都会提交这个文件）。
    runner: process.env.GITHUB_ACTIONS ? 'cloud' : 'local',
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    sources: perSource.map(({ id, label, ok, items, ms, error, causeCode, causeMessage }) => ({
      id, label, ok, count: items.length, ms,
      ...(error ? { error } : {}),
      // 2.5.0：仅在新版有 cause 时出现；旧快照没有这两个字段，页面照常读
      ...(causeCode ? { causeCode } : {}),
      ...(causeMessage ? { causeMessage } : {}),
    })),
    quotes: quotes.length,
    added: addedTotal,
  };
  const qErr = getQuoteError();
  if (qErr) logObj.quoteError = qErr;
  else delete logObj.quoteError;
  await writeJSONIfChanged(logFile, logObj);

  console.log(
    `[collect] 完成 · 源 ${okCount}/${SOURCES.length} 成功 · 新增 ${addedTotal} 条 · 库内共 ${allCount} 条 · ${Date.now() - startedAt.getTime()}ms`
  );
  if (okCount === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[collect] 致命错误', err);
  process.exit(1);
});
