// scripts/update-kline-minute.mjs
// 生成「服务端预生成的分钟K」：data/kline/<key>_<period>.json
//
// ── 为什么必须有它（2026-10-30 实测）────────────────────────────────────
//   用户反馈：「所有非 A/非 H/非美指数 + 上海金都没有分钟级别K线」。
//   查下来是**能力边界 + 客户端被封**两件事叠加：
//     ① 能力边界：欧日韩指数、上海金、伦敦银的分钟K **只有东财一个源**
//        （腾讯对 jpNI225/ukFTSE/deDAX/krKOSPI 无可用代码；新浪只有实时价、没有分时序列；
//          新浪外盘的 MinKLine 接口一律 __ERROR）⇒ 东财挂了就是 0 根；
//     ② 客户端被封：东财 push2his 对**本机的非浏览器客户端**是 socket 级拒绝
//        （Node fetch 与 curl 实测都 http=000 / fetch failed），只有浏览器能连上；
//        而且浏览器连打几个大请求后**同样会被封**（实测：拉完 CAC40 9192 根日K 后，
//        紧接着的 5 分钟请求就变成「All promises were rejected」）。
//   ⇒ 结论：客户端直连东财做分钟K，**不可靠**。
//   补救：服务端（Actions 跑在美国节点，能稳定连东财）**预生成分钟K**，
//     客户端直连失败时回落到本地快照 ⇒ 欧日韩/上海金/伦敦银的分钟图**不再依赖东财在客户端可达**。
//
// ── 只覆盖「客户端没有别的分钟源」的标的 ──────────────────────────────────
//   A股/港股/美股：腾讯分时（minute / usMinute）稳定可用 ⇒ 不生成，省带宽也省仓库体积。
//   伦敦金/布伦特：**全网都没有同口径的分钟源**（新浪外盘只有日线）⇒ 保持「无分钟级数据」，
//     前端会明确说明原因，而不是画一张假图。
//
// 格式：**紧凑数组行** [t,o,c,h,l,v]（与 <key>_full.json 同一套，前端 localKline 能直接读）。
//
// 用法：
//   node scripts/update-kline-minute.mjs              # 全部目标 × 全部周期
//   node scripts/update-kline-minute.mjs --dry-run    # 只抓不写
//   node scripts/update-kline-minute.mjs --only cac40
//   node scripts/update-kline-minute.mjs --periods 5m,15m
//
// 退出码：0 = 成功（或无变化）；1 = 一个都没成功

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchKline, getKlineSource, klineTarget } from '../src/sources.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'kline');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const DRY = process.argv.includes('--dry-run');
const ONLY = arg('only', '');
const PERIODS = arg('periods', '1m,5m,15m,30m,60m').split(',').map((s) => s.trim()).filter(Boolean);

// 客户端没有别的分钟源 ⇒ 必须由服务端兜底
const TARGET_KEYS = [
  'n225',        // 日经225      100.N225
  'dax',         // 德国DAX30    100.GDAXI
  'cac40',       // 法国CAC40    100.FCHI
  'ukx',         // 英国富时100  100.FTSE
  'kospi',       // 韩国KOSPI    100.KS11
  'sge_au9999',  // 上海金Au99.99 118.AU9999
  'xag',         // 伦敦银       122.XAG（与报价 hf_XAG 同一条线，实测年均差 <0.7%）
];

// 根数上限：分钟级本身量不大，1000 根 ≈ 5分13天 / 15分40天 / 60分160天
// ⚠ 别再往上加：文件是 Pages 上的静态资源，本机到 Pages 只有 7~20 KB/s。
const LIMIT = 1000;

// 低于这个根数不写：宁可不写，也不要留一份「只有几根」的残缺快照
const MIN_BARS = 30;

const list = ONLY ? TARGET_KEYS.filter((k) => k === ONLY) : TARGET_KEYS;

console.log(
  `[update-kline-minute] 目标 ${list.length} 个标的 × 周期 ${PERIODS.join('/')} · limit=${LIMIT}` +
  `${DRY ? '（dry-run）' : ''}`
);

let changed = 0;
let same = 0;
let failed = 0;

for (const key of list) {
  const meta = klineTarget(key);
  if (!meta) {
    console.log(`  ⚠ ${key.padEnd(9)} 未知标的`);
    failed++;
    continue;
  }
  for (const period of PERIODS) {
    const file = path.join(OUT_DIR, `${key}_${period}.json`);
    let bars;
    try {
      bars = await fetchKline(key, period, LIMIT);
    } catch (e) {
      failed++;
      console.log(`  ⚠ ${key.padEnd(9)} ${period.padEnd(3)} 失败：${String(e.message).slice(0, 100)}`);
      continue;
    }
    if (!bars || bars.length < MIN_BARS) {
      failed++;
      console.log(`  ⚠ ${key.padEnd(9)} ${period.padEnd(3)} 只取到 ${bars ? bars.length : 0} 根，不足 ${MIN_BARS} 根，不写`);
      continue;
    }

    const payload = {
      key,
      name: meta.name,
      market: meta.market,
      period,
      generatedAt: new Date().toISOString(),
      source: `服务端预生成的分钟K（limit=${LIMIT}）· 取数源：${getKlineSource() || '未知'}`,
      caliber: meta.klineNote || '',
      // 紧凑数组行：[t,o,c,h,l,v]
      bars: bars.map((b) => [b.t, b.o, b.c, b.h, b.l, b.v]),
    };
    const text = JSON.stringify(payload);

    // 内容没变就不写 —— 免得每次跑都产生一个「只有 generatedAt 变了」的提交
    if (existsSync(file)) {
      try {
        const old = JSON.parse(await readFile(file, 'utf8'));
        const oldBars = JSON.stringify(old.bars || []);
        if (oldBars === JSON.stringify(payload.bars)) {
          same++;
          console.log(
            `  ${key.padEnd(9)} ${period.padEnd(3)} ${String(bars.length).padStart(4)} 根  内容未变，跳过` +
            `  [${old.generatedAt || '?'}]`
          );
          continue;
        }
      } catch {
        /* 文件损坏 → 重新写 */
      }
    }

    if (!DRY) {
      await mkdir(OUT_DIR, { recursive: true });
      await writeFile(file, text, 'utf8');
    }
    changed++;
    console.log(
      `  ${key.padEnd(9)} ${period.padEnd(3)} ${String(bars.length).padStart(4)} 根  ` +
      `${bars[0].t} → ${bars[bars.length - 1].t}  [${getKlineSource() || '未知源'}]${DRY ? '（dry-run）' : ''}`
    );
  }
}

console.log(`[update-kline-minute] 更新 ${changed} 个 / 无变化 ${same} 个 / 失败 ${failed} 个`);
if (failed && !changed) process.exitCode = 1;
