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

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDICES, SOURCES, fetchQuotes, getQuoteError } from './sources.mjs';
import { ETFS } from './etf.mjs';
import { fetchDailyK } from './kline.mjs';
import { fetchPortfolioQuotesFast } from './portfolio.mjs';
import { finalizeClosedQuotes } from './quote-finalize.mjs';
import { readBriefingMeta } from './brief-meta.mjs';
import { dedupeItems } from './news-dedupe.mjs';
import { decideBars, markCloseOnlyBars, barTime } from './kline-guard.mjs';
import { aggregateDaily, collapsePeriodDuplicates } from './aggregate.mjs';
import { acquireKlineLock, releaseKlineLock, lockSkipText } from './kline-lock.mjs';
import { newsDay } from './news-day.mjs';
import { buildHotSearchDoc } from './search-index.mjs';
import { selectDayItems, OFFICIAL_RECENT_DAYS, isRecent, DAY_TOTAL, capState } from './quota.mjs';
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

/** 2.14.0：不设根数上限时的请求根数（哨兵值，见 KLINE_SPEC 注释） */
const KLINE_NO_CAP = 20000;

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
  // 2026-11-18：周/月的 reject 必须落盘。此前只打在 Actions 日志里（要鉴权才看得到），
  //   结果 csi300_1w 之类被守卫拦了 5 个交易日都只能靠「末根不动」发现。
  //   格式与 data/kline/min/_status.json 一致：{generatedAt, ok, failed, failures, rejected}。
  const rejected = [];
  let written = 0;
  const { INDICES, PORTFOLIO_KLINE, fetchKline, klineAvailable, klineTarget, getKlineSource } =
    await import('./sources.mjs');
  // 23 个指数 + 6 个组合标的（纳指100 / 伦敦金 / 上海金 / 伦敦银 / 布伦特 / 人民币中间价）
  const all = [...INDICES.map((i) => i.key), ...PORTFOLIO_KLINE.map((i) => i.key)];
  const keys = onlyKeys && onlyKeys.length ? all.filter((k) => onlyKeys.includes(k)) : all;
  // 2.14.0：日/周/月 K 一律按「源侧全量」请求，**不再设 1000 根这类够用就行的上限**。
  //   20000 是「不设上限」的哨兵值（与前端 klineLimit、update-kline-full 的 LIMIT 一致）：
  //   实测各源历史全量都在 11,000 根以内（东财 100.UDI 10,471 / 上证 8,752 /
  //   新浪外盘 XAU 5,183），源侧不会真的返回 20000 根。
  //   ⚠ 固定 1000 根时，文件被 update-kline-last 加过一根后每轮都会被「短覆盖」守卫
  //     整体拒绝（usdcny/xau 自 2026-11-04 冻结）。取消上限后，新序列自然覆盖旧序列，
  //     文件按并集长大，不再需要「按文件深度猜 limit」这种脆弱做法。
  const KLINE_SPEC = [
    { period: '1d', limit: KLINE_NO_CAP, suffix: '' },
    { period: '1w', limit: KLINE_NO_CAP, suffix: '_1w' },
    { period: '1M', limit: KLINE_NO_CAP, suffix: '_1M' },
  ];
  // 2026-11-18：源侧周/月历史比我们短（或首桶口径不同）的这 6 个文件，不再依赖源侧周/月线，
  //   改用自有日 K 聚合生成：replace = 整条替换（早期导入的桶按 CHANGELOG 2.25.1 记录后移除），
  //   union = 保留早期历史、重叠段用聚合值覆盖（ndx 聚合只有 2019 起，不能砍掉 2007/2000 起的部分）。
  const WM_FROM_DAILY = new Map([
    ['sz_comp', { '1w': 'replace' }],
    ['hsi', { '1M': 'replace' }],
    ['spx', { '1M': 'replace' }],
    ['brent', { '1w': 'replace' }],
    ['ndx', { '1w': 'union', '1M': 'union' }],
    // 2026-11-20：a100 的源侧历史比文件短（1d 4,977 < 5,798、1w 1,047 < 1,219、
    //   1M 247 < 290），每次都被 decideBars 判 shorter-overlap-mismatch 整份拒收，
    //   周/月因此停在 11-18。周/月改为自有日 K 聚合 + 保留现有历史（union）。
    //   ⚠ a100 的 2003–2005 段是 o=h=l=0 的「仅收盘」bar，文件里带 z:1；
    //   union 以现有文件为底、只用聚合覆盖重叠段，这些早期桶不会被抹掉。
    ['a100', { '1w': 'union', '1M': 'union' }],
  ]);
  for (const key of keys) {
    if (!klineAvailable(key)) { klineSkip.push(key); continue; }
    const meta = klineTarget(key);
    const done = [];
    // 2026-11-20：源侧日线在本轮内复用。1w/1M 派生（WM_FROM_DAILY）要用的就是 1d 那一份，
    //   原先每个周期各抓一次 ⇒ 同一标的连打 3 次，东财 push2his 间歇性限流时后两次必失败，
    //   而失败又被下面的 catch 吞掉（只见 1d 成功，周/月静默停更）。
    let dailyBars = null;
    for (const spec of KLINE_SPEC) {
      try {
        const file = path.join(DATA, 'kline', `${key}${spec.suffix}.json`);
        // 2.14.0：不再设「够用就行」的根数上限（原日 K 固定 1000 根）。
        //   固定 1000 时，文件被 update-kline-last 加过一根（1,001 根）后，
        //   每轮抓到的 1000 根首根更晚、根数更少 ⇒ 被 decideBars 判 shorter 整体拒绝，
        //   usdcny / xau 自 2026-11-04 起停更。现在按源侧全量抓取，两文件按并集自然长大。
        // 2026-11-18：ndx 的源侧周/月只有 2019 起（398 / 92 根），而文件里有 2007-08 / 2000-01
        //   起的早期历史。源侧直取必然「根数更少 + 左端更晚」⇒ 按约定必须拒
        //   （不能拿短序列覆盖长历史），于是这两个周期改为「自有日 K 聚合 ∪ 现有历史」，
        //   既保住早期历史，又跟得上最新一周/月；重叠段聚合值与源侧逐桶一致。
        const derive = spec.period !== '1d' ? WM_FROM_DAILY.get(key)?.[spec.period] : null;
        let incoming;
        if (derive) {
          if (!dailyBars) dailyBars = await fetchKline(key, '1d', 20000);
          const agg = aggregateDaily(dailyBars, spec.period === '1w' ? 'week' : 'month');
          if (derive === 'union') {
            const prevDoc = await readJSON(file, null);
            const merged = new Map((prevDoc?.bars || []).map((b) => [barTime(b), b]));
            for (const b of agg) merged.set(barTime(b), b);
            incoming = [...merged.values()].sort((a, b) => (barTime(a) < barTime(b) ? -1 : 1));
          } else {
            incoming = agg;
          }
        } else {
          incoming = await fetchKline(key, spec.period, spec.limit);
          if (spec.period === '1d') dailyBars = incoming;
        }
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
          //   derived（自有日 K 聚合）不走源侧比较：聚合是我们自己的口径，重叠段已与源侧逐桶一致；
          //   只做一条防呆 —— 聚合根数不能明显少于现有文件（防止日 K 抓残后把周/月写秃）。
          const decision = derive
            ? (incoming.length >= (prev?.bars?.length || 0) - 5
                ? { action: 'derive', bars: incoming }
                : { action: 'reject', reason: 'derive-shorter', bars: incoming })
            : decideBars(prev && prev.bars, incoming);
          if (decision.action === 'reject') {
            rejected.push(
              `${key}/${spec.period}: ${decision.reason}` +
                `（新 ${incoming.length} 根 < 现有 ${(prev.bars || []).length} 根）`
            );
            console.log(
              `  ⛔ ${key} ${spec.period} rejected: ${decision.reason}` +
                `（新 ${incoming.length} 根 / 现有 ${(prev.bars || []).length} 根），保留现有文件`
            );
            continue;
          }
          // 2.28.0：周/月 K 一个周期只能有一根。未走完的桶其 `t` 是「桶内最后一根日线」、
          //   每天前移，decideBars 会把它判成「缺旧末根键」走 merge 并集 ⇒ 每天多一根。
          //   xau/brent/usdcny/n225/kospi 等全标的的 2026-11 因此各出现十余根假 K 线。
          //   收敛放在 markCloseOnlyBars 之前，保留最后一根（最新的累计值）。
          const unit = spec.period === '1w' ? 'week' : spec.period === '1M' ? 'month' : null;
          const collapsed = unit ? collapsePeriodDuplicates(decision.bars, unit) : null;
          if (collapsed?.collapsed) {
            const detail = Object.entries(collapsed.periods)
              .map(([k, n]) => `${k}×${n}`)
              .join(' ');
            console.log(
              `  🧹 ${key} ${spec.period}：同周期重复 ${collapsed.collapsed} 根已收敛（${detail}）`
            );
          }
          // 2.18.0：o=h=l=0 且只有收盘的 bar 必须显式标记后进库（不许静默当正常 bar）
          const marked = markCloseOnlyBars(collapsed ? collapsed.bars : decision.bars);
          const bars = marked.bars;
          if (marked.count) {
            console.log(
              `  🏷 ${key} ${spec.period}：${marked.count} 根「仅收盘」已标记 closeOnly（开高低源侧无数据）`
            );
          }
          await writeJSONIfChanged(file, {
            key,
            name: meta?.name || key,
            market: meta?.market || '',
            period: spec.period,
            generatedAt: startedAt.toISOString(),
            // 3.1.0：盘中节流基线由 update-kline-last 维护，全量重写不能把它抹掉
            //   （抹掉后基线退回 generatedAt=本轮时刻，紧邻的盘中窗口会被误判成「刚写过」）
            ...(prev && prev.openRefreshedAt ? { openRefreshedAt: prev.openRefreshedAt } : {}),
            // 取数源写进文件：离线快照必须能自证是哪来的（东财 / 新浪 / 新浪外盘 / 上金所 / 腾讯）
            source: derive ? '自有日 K 重聚合（src/aggregate.mjs）' : (getKlineSource() || ''),
            bars,
          });
          done.push(`${spec.period}:${bars.length}${decision.action === 'merge' ? '/merge' : decision.action === 'derive' ? '/derive' : ''}`);
          written++;
        } finally {
          await releaseKlineLock(lock);
        }
      } catch (err) {
        // 单个周期失败不影响其它周期（例如某源不支持月K）。
        // 2026-11-20：不再静默 —— 上周/月被限流吞掉时日志里只有 1d 成功，没人看得出来。
        console.log(`  ⚠ ${key} ${spec.period} 取数失败：${String(err.message).slice(0, 90)}`);
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

  // 守卫拒绝明细落盘（与分钟预生成同一格式）；没有拒绝时删掉上一轮的状态文件。
  const statusFile = path.join(DATA, 'kline', '_status.json');
  if (rejected.length) {
    await writeFile(
      statusFile,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          ok: written,
          failed: klineSkip.length,
          failures: [],
          rejected,
        },
        null,
        2
      ),
      'utf8'
    );
    console.log(`  ⚠ 守卫拒绝明细已写入 ${path.relative(ROOT, statusFile)}（${rejected.length} 条）`);
  } else if (existsSync(statusFile)) {
    await rm(statusFile, { force: true });
  }
}

async function main() {
  const startedAt = new Date();
  console.log(`[collect] 开始 · 回补窗口 ${SINCE_HOURS}h`);

  // Happy Eyeballs 抢跑修（2026-11-19）：Node 对「多地址域名」只给首个地址
  // autoSelectFamilyAttemptTimeout（默认 250ms）建连时间，超时就判 ETIMEDOUT 转下一个。
  // 统计局 www.stats.gov.cn 同时有 A/AAAA，且跨境 RTT 正好压在阈值上：
  //   GitHub southcentralus runner 实测 TCP 216ms（12 次样本 227-257ms）、TLS 1360ms，
  //   IPv6 侧 1ms 内 ENETUNREACH（runner 无 IPv6 出网路由）。
  //   同一 runner 上 12 次建连里 2 次在 251ms 报 `ETIMEDOUT 121.32.243.92:443`，
  //   放宽到 3000ms 后 12/12 成功 —— 与 _last-run 里 `fetch failed（ETIMEDOUT）` 完全对应。
  // 该设置只在「首个地址超时」时生效；IPv4 能连上（本机 23ms、云端 216ms）就不会等待，
  // 因此对 fed/ecb 等境外源没有影响，对同为跨境直连的国内源只会减少误判。
  net.setDefaultAutoSelectFamilyAttemptTimeout(3000);

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
  // 2.11.0：每轮记录「候选 / 保留 / 淘汰」，让满载后的真实需求可测量。
  // 背景：满载时 selectDayItems 会静默挤掉最早的条目，日志里只有「+N」，删除完全不可见；
  // 没有这三个数就无法回答「一天到底需要多少条」。
  const dayStats = [];
  for (const [day, items] of byDay) {
    const file = path.join(ARCHIVE, `${day}.json`);
    const existing = await readJSON(file, { day, items: [] });
    const existingIds = new Set(existing.items.map((i) => i.id));
    // 2.4.5：不仅去重本轮新条目，也把**已归档**的同文重复合并掉。
    // 华尔街见闻同一篇快讯会以两个 id（A股/全球）返回，旧版本已把两条都写进归档；
    // 每次重建本日文件时重新跑一遍 dedupe，历史当日数据即可自愈。
    const candidates = dedupeItems([...items, ...existing.items]);
    const mergedItems = selectDayItems(candidates);
    const newOnes = mergedItems.filter((i) => !existingIds.has(i.id)).length;
    const removed = existing.items.length + newOnes - mergedItems.length;
    // candidates 已经去过重，所以 candidates - mergedItems 就是配额淘汰量（与合并重复分开记）
    const evicted = Math.max(0, candidates.length - mergedItems.length);
    dayStats.push({
      day,
      incoming: items.length,          // 本轮窗口内新抓到的条目
      candidates: candidates.length,   // 与已归档合并去重后的候选总量
      kept: mergedItems.length,        // 实际写入文件的条数
      evicted,
      deduped: Math.max(0, items.length + existing.items.length - candidates.length),
      added: newOnes,
    });
    if (newOnes || mergedItems.length !== existing.items.length) {
      existing.items = mergedItems;
      await writeJSON(file, existing);
      addedTotal += newOnes;
      console.log(
        `  → ${day}.json  +${newOnes}${removed > 0 ? ` · 合并重复 -${removed}` : ''}（累计 ${existing.items.length}）`
      );
    }
    // 2.12.0：触顶不可静默。淘汰发生在 selectDayItems 内部，日志里原本看不到；
    // 这里逐日显式打出「候选 > 上限、丢掉多少条」，并汇总进 _last-run.json 的 news.capped。
    if (evicted > 0) {
      console.warn(
        `  ⚠ ${day}.json 触顶：候选 ${candidates.length} > 上限 ${DAY_TOTAL}，本轮淘汰 ${evicted} 条（最早的先丢）`
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
      // 2.20.0：补写标记与实际生成时刻（派生自产物，见 src/brief-meta.mjs）。
      //   索引每轮重建都只写这里列出的字段 —— 漏掉这两个字段，补写早报的
      //   「补写」标签与「晚到 / 跨日」判定会在下一轮采集后消失。
      ...(b && b.backfill ? { briefBackfill: true } : {}),
      ...(b && b.at ? { briefAt: b.at } : {}),
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
  // 2.29.0：日文件内部已各自去过重，但跨日拼接后仍会有「同源同标题、ts 差十几秒」
  //   的同一快讯（源侧 showTime 漂移），这里按同一口径再过一遍。
  const latest = dedupeItems(allItems).sort((a, b) => b.ts - a.ts).slice(0, 200);

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

  // search.json：2.30.0 起只装「热段」（最近 HOT_WINDOW_DAYS 个新闻日），更早的日期
  //   由 data/search-history 的月度分片承担。
  //   2.33.1 起这两个路径都不再进 git：Pages 部署时由 scripts/build-search.mjs 用同一套
  //   函数现算（src/search-index.mjs）。这里仍写一份到本地，保证 `node src/collect.mjs`
  //   之后本地静态预览能直接搜索。
  const { doc: searchDoc, stats: searchStats } = buildHotSearchDoc({
    dataDir: DATA,
    now: startedAt.getTime(),
    generatedAt: startedAt.toISOString(),
  });
  if (searchStats.dupMerged) {
    console.log(`  🧹 search.json：跨日重复 id ${searchStats.dupMerged} 条已合并（保留更早归属）`);
  }
  await writeJSONIfChanged(path.join(DATA, 'search.json'), searchDoc);
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
  const cap = capState(dayStats);
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
    // 2.11.0：本轮的容量画像（只增字段，不动上面的 ok/label/count/ms/error）。
    // cap 写进文件，这样脚本以后不必依赖当时的常量值也能判断「这天有没有触顶」。
    // 2.12.0：新增 capped —— 触顶的显式标记，页脚健康灯与脚本都只认这一个布尔，
    // 不用再从 evicted > 0 去猜（「有淘汰但没标记」正是上次静默丢数据的成因）。
    news: {
      cap: cap.cap,
      capped: cap.capped,
      candidates: dayStats.reduce((n, d) => n + d.candidates, 0),
      kept: dayStats.reduce((n, d) => n + d.kept, 0),
      evicted: cap.evicted,
      deduped: dayStats.reduce((n, d) => n + d.deduped, 0),
      days: dayStats,
    },
  };
  const qErr = getQuoteError();
  if (qErr) logObj.quoteError = qErr;
  else delete logObj.quoteError;
  await writeJSONIfChanged(logFile, logObj);

  console.log(
    `[collect] 完成 · 源 ${okCount}/${SOURCES.length} 成功 · 新增 ${addedTotal} 条 · 库内共 ${allCount} 条 · ${Date.now() - startedAt.getTime()}ms`
  );
  if (cap.capped) {
    console.warn(
      `[collect] ⚠ 触顶：本轮淘汰 ${cap.evicted} 条（上限 ${cap.cap}）——已写入 _last-run.json 的 news.capped`
    );
  }
  if (okCount === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[collect] 致命错误', err);
  process.exit(1);
});
