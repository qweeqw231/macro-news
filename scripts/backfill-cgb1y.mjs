// scripts/backfill-cgb1y.mjs
// 回补「1Y 国债收益率」的日K历史 → data/kline/cgb_1y.json
//
// 为什么需要它：
//   站点上「1Y国债收益率」这张卡片**没有东财 secid、也没有腾讯代码**，
//   全站只有中债「逐日国债收益率曲线」这一个源（queryGjqxInfo?workTime=YYYY-MM-DD）。
//   而中债是**逐日**接口（没有批量接口），所以历史必须一天一天回补。
//   日常增量由 src/portfolio-collect.mjs 每天追加一根，本脚本只管历史。
//
// 用法：
//   node scripts/backfill-cgb1y.mjs                 # 默认回补最近 5 年
//   node scripts/backfill-cgb1y.mjs --years 10      # 回补最近 10 年
//   node scripts/backfill-cgb1y.mjs --from 2006-01-01 --to 2026-10-29
//   node scripts/backfill-cgb1y.mjs --dry-run       # 只抓不写

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCgbCurveOneY } from '../src/portfolio.mjs';
import { aggregateDaily } from '../src/aggregate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'kline', 'cgb_1y.json');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const DRY = process.argv.includes('--dry-run');

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const end = arg('to', ymd(new Date()));
const years = Number(arg('years', '5'));
const from = arg('from', ymd(new Date(Date.now() - years * 365 * 86400000)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`[backfill-cgb1y] ${from} ~ ${end}${DRY ? '（dry-run，不写盘）' : ''}`);

// 已有的 K 线（增量追加时不丢历史）
let bars = [];
if (existsSync(OUT)) {
  try {
    const j = JSON.parse(await readFile(OUT, 'utf8'));
    if (Array.isArray(j.bars)) bars = j.bars.slice();
  } catch { /* 文件损坏就当空 */ }
}
const seen = new Set(bars.map((b) => b.t));

// 增量落盘：全量回补要跑很久，中途被 kill / 网络断 / 机器休眠都会丢进度，
// 所以每攒够 FLUSH_EVERY 根就写一次盘（而不是等跑完才写）。
const FLUSH_EVERY = 50;
let lastFlush = 0;
const meta = (period) => ({
  key: 'cgb_1y',
  name: '1Y国债收益率',
  market: 'CN',
  period,
  generatedAt: new Date().toISOString(),
  source: '中债国债收益率曲线（queryGjqxInfo）',
});
async function flush() {
  bars.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ ...meta('1d'), bars }, null, 2), 'utf8');
  // 周K / 月K 一并预生成：前端点「周K / 月K」时直接读小文件，
  // 不用把 500KB 的日K 再下一遍（线上按本机 5~30 KB/s 的带宽重下要 20~100 秒）。
  for (const [period, unit] of [['1w', 'week'], ['1M', 'month']]) {
    const sub = aggregateDaily(bars, unit);
    if (!sub.length) continue;
    await writeFile(
      path.join(path.dirname(OUT), `cgb_1y_${period}.json`),
      JSON.stringify({ ...meta(period), source: meta('1d').source + ' · 由日K聚合', bars: sub }, null, 2),
      'utf8'
    );
  }
}

// 已有数据覆盖的日期：这些天**不需要再请求**（中债在工作日返回的 srcDate 就是当天，
// 非交易日返回空表头 ⇒ 只有节假日回退才可能落到别的日期，那天本来也不在 haveDays 里）。
// 断点续跑时能省掉全部已完成的请求（否则每次重跑都要重抓几千天）。
const haveDays = new Set(bars.map((b) => b.t));

// 并发度：中债的逐日接口是「一个 workTime 一个请求」，彼此独立，
// 所以用少量并发把 4000+ 天压到二十分钟量级。单路实测约 0.65 秒/天（0.43 请求 + 0.22 间隔）。
// ⚠ 并发不能高：实测 3 路并发跑到第 1400 多天时中债开始返回 **HTTP 429**（限流）。
//   ⇒ 这里用 2 路 + 更长的间隔，并在遇到 429 时指数退避后重试当天。
const CONCURRENCY = 2;
const GAP_MS = 600;
// 429 的退避序列（毫秒）
const BACKOFF = [3000, 8000, 20000, 45000, 90000];

const days = [];
const stop = new Date(end + 'T00:00:00');
for (let t = new Date(from + 'T00:00:00'); t <= stop; t.setDate(t.getDate() + 1)) {
  const dow = t.getDay();
  if (dow !== 0 && dow !== 6) days.push(ymd(t));   // 跳过周末（中债不发曲线）
}
console.log(`  待抓工作日 ${days.length} 天（其中 ${days.filter((d) => haveDays.has(d)).length} 天已有，跳过）`);

let ok = 0, miss = 0, err = 0;
let cursor = 0;
let flushing = false;
const t0 = Date.now();

async function worker() {
  while (true) {
    const i = cursor++;
    if (i >= days.length) break;
    const day = days[i];
    if (haveDays.has(day)) continue;
    // 429（限流）单独处理：退避后重试当天，绝不因为限流就留下一个空洞
    let done = false;
    for (let attempt = 0; attempt <= BACKOFF.length && !done; attempt++) {
      if (attempt > 0) {
        const wait = BACKOFF[attempt - 1];
        console.log(`  ⚠ ${day} 被限流（429），${wait / 1000}s 后重试`);
        await sleep(wait);
      }
      try {
        const c = await fetchCgbCurveOneY(day);
        if (c && c.srcDate && !seen.has(c.srcDate)) {
          seen.add(c.srcDate);
          bars.push({ t: c.srcDate, o: c.oneY, c: c.oneY, h: c.oneY, l: c.oneY, v: 0 });
          ok++;
        } else if (!c) {
          miss++;                            // 节假日 / 当天未发布
        }
        done = true;
      } catch (e) {
        const msg = String(e.message || e);
        if (/429/.test(msg) && attempt < BACKOFF.length) continue;   // 限流 → 退避重试
        err++;
        if (err <= 8) console.log(`  ⚠ ${day} 失败：${msg.slice(0, 80)}`);
        done = true;
      }
    }
    // 对中债友好一点：每次请求之间停一下（每路各自停 ⇒ 总并发仍是 CONCURRENCY）
    await sleep(GAP_MS);

    // 增量落盘：每攒够 FLUSH_EVERY 根就写一次盘，进程被 kill 也不丢进度。
    // flushing 标志防止并发 worker 同时写同一个文件。
    if (!DRY && !flushing && ok - lastFlush >= FLUSH_EVERY) {
      flushing = true;
      try {
        await flush();
        lastFlush = ok;
        console.log(`  … 已落盘 ${bars.length} 根（${bars[bars.length - 1].t}）`);
      } finally {
        flushing = false;
      }
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

if (!DRY && ok) await flush();

bars.sort((a, b) => String(a.t).localeCompare(String(b.t)));
console.log(
  `[backfill-cgb1y] 新增 ${ok} 天 / 无数据 ${miss} 天 / 失败 ${err} 天，` +
  `耗时 ${Math.round((Date.now() - t0) / 1000)}s，共 ${bars.length} 根`
);
if (bars.length) {
  console.log(`  区间：${bars[0].t} ~ ${bars[bars.length - 1].t}（最新 ${bars[bars.length - 1].c}%）`);
}

if (DRY) {
  console.log('[dry-run] 未写盘');
} else {
  await flush();
  console.log(`  已写入 ${OUT}`);
}
