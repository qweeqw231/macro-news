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
import { SOURCES, fetchQuotes, getQuoteError } from './sources.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const ARCHIVE = path.join(DATA, 'archive');

// 默认回补 24h：既能覆盖两次轮询之间的空档，又不会把陈旧条目反复拉回来。
// 注意：官方源（统计局/央行）多为月度或季度发布，窗口内没有新条目属正常情况。
const argSince = process.argv.indexOf('--since');
const SINCE_HOURS = argSince > -1 ? Number(process.argv[argSince + 1]) || 24 : 24;

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

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

async function main() {
  const startedAt = new Date();
  console.log(`[collect] 开始 · 回补窗口 ${SINCE_HOURS}h`);

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
        console.log(`  ❌ ${s.label.padEnd(12)} ${String(err.message).slice(0, 60)}`);
        return { id: s.id, label: s.label, ok: false, error: err.message, items: [], ms: Date.now() - t0, windowed: s.windowed !== false };
      }
    })
  );

  // ---- 时间窗过滤 ----
  // 官方源（央行/统计局等）发布频率低，最新一条可能在窗口之外；
  // 若同样按 24h 过滤会被永久丢弃。标记 windowed:false 的源跳过窗口，
  // 靠 archive 的 id 去重保证不重复入库。
  const cutoff = startedAt.getTime() - SINCE_HOURS * 3600 * 1000;
  const merged = new Map();
  for (const s of perSource) {
    for (const it of s.items) {
      const t = it.ts ? it.ts * 1000 : new Date(it.time).getTime();
      if (s.windowed && Number.isFinite(t) && t < cutoff) continue;
      if (!merged.has(it.id)) merged.set(it.id, it);
    }
  }
  const fresh = [...merged.values()].sort((a, b) => b.ts - a.ts);
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

  // ---- 写入：按天归档 ----
  const byDay = new Map();
  for (const it of fresh) {
    const d = it.time ? new Date(it.time) : startedAt;
    const k = dayKey(Number.isNaN(d.getTime()) ? startedAt : d);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(it);
  }

  let addedTotal = 0;
  for (const [day, items] of byDay) {
    const file = path.join(ARCHIVE, `${day}.json`);
    const existing = await readJSON(file, { day, items: [] });
    const seen = new Set(existing.items.map((i) => i.id));
    const add = items.filter((i) => !seen.has(i.id));
    if (add.length) {
      existing.items = [...add, ...existing.items]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 800);
      await writeJSON(file, existing);
      addedTotal += add.length;
      console.log(`  → ${day}.json  +${add.length}（累计 ${existing.items.length}）`);
    }
  }

  // ---- 重建索引 + 最新快照 ----
  const files = (await import('node:fs')).readdirSync(ARCHIVE).filter((f) => f.endsWith('.json'));
  const days = [];
  let allCount = 0;
  for (const f of files.sort()) {
    const d = await readJSON(path.join(ARCHIVE, f), { day: f.replace('.json', ''), items: [] });
    days.push({ day: d.day, count: d.items.length });
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

  // search.json：全库精简副本，供前端全文检索（只留检索需要的字段，控制体积）
  const searchItems = [];
  for (const f of files.sort().reverse()) {
    const d = await readJSON(path.join(ARCHIVE, f), { items: [] });
    for (const it of d.items) {
      searchItems.push({
        id: it.id,
        ts: it.ts,
        time: it.time,
        source: it.source,
        channel: it.channel,
        title: it.title,
        summary: (it.summary || '').slice(0, 200),
        url: it.url,
      });
    }
  }
  await writeJSONIfChanged(path.join(DATA, 'search.json'), {
    generatedAt: startedAt.toISOString(),
    total: searchItems.length,
    items: searchItems,
  });
  if (quotes.length) {
    await writeJSONIfChanged(path.join(DATA, 'quotes.json'), { generatedAt: startedAt.toISOString(), quotes });
  }

  // ---- K线：预生成日K（保证没有 Worker 代理时也能画图） ----
  const klineOk = [];
  const klineSkip = [];
  if (!process.argv.includes('--no-kline')) {
    const keys = (await import('./sources.mjs')).INDICES.map((i) => i.key);
    const { fetchKline, klineAvailable } = await import('./sources.mjs');
    for (const key of keys) {
      if (!klineAvailable(key)) { klineSkip.push(key); continue; }
      try {
        const bars = await fetchKline(key, '1d', 250);
        const meta = (await import('./sources.mjs')).INDICES.find((i) => i.key === key);
        await writeJSONIfChanged(path.join(DATA, 'kline', `${key}.json`), {
          key,
          name: meta?.name || key,
          market: meta?.market || '',
          period: '1d',
          generatedAt: startedAt.toISOString(),
          bars,
        });
        klineOk.push(`${key}(${bars.length})`);
      } catch (err) {
        klineSkip.push(key);
      }
    }
    console.log(`[collect] K线：生成 ${klineOk.length} 个，跳过 ${klineSkip.length} 个（${klineSkip.join(', ') || '无'}）`);
  }

  const okCount = perSource.filter((s) => s.ok).length;
  await writeJSONIfChanged(path.join(DATA, '_last-run.json'), {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    sources: perSource.map(({ id, label, ok, items, ms, error }) => ({
      id, label, ok, count: items.length, ms, ...(error ? { error } : {}),
    })),
    quotes: quotes.length,
    ...(getQuoteError() ? { quoteError: getQuoteError() } : {}),
    added: addedTotal,
  });

  console.log(
    `[collect] 完成 · 源 ${okCount}/${SOURCES.length} 成功 · 新增 ${addedTotal} 条 · 库内共 ${allCount} 条 · ${Date.now() - startedAt.getTime()}ms`
  );
  if (okCount === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[collect] 致命错误', err);
  process.exit(1);
});
