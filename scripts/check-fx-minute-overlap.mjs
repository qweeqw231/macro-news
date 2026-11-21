// scripts/check-fx-minute-overlap.mjs
//
// 一次性核对：**同一个 5m/30m 时间键上，新浪外汇与东财 119.* 的收盘价差多少**。
// 用于回答「美元对分钟能不能从东财切到新浪」——不能凭感觉切，先逐根比。
//
// ⚠ 为什么必须在 Actions 上跑：东财 push2his 对**本机的非浏览器客户端**是 socket 级拒绝
//   （Node fetch / curl 实测全部 fetch failed），只有云端节点才能同时拿到两个源。
//   ⇒ 本地只能跑新浪那一半，比对必须在 runner 上做。
//
// 判定口径（写死在 PASS/FAIL 里，避免事后解释）：
//   · 时间戳：重叠区间的 HH:MM 网格必须一致（`tsMismatch` 只允许出现在序列首尾）；
//   · 价格：公共时间键上 |c_sina - c_em| / c_em 的 p99 ≤ 0.05%（5e-4）；
//   · 样本：公共键 ≥ 200 根，否则判「样本不足」，不下结论。
//
// 输出：data/kline/min/_overlap.json（由 workflow 提交回仓库）
//   ⚠ 不能写到 2026-11-21/... 下：`.gitignore` 根目录的日期产物目录是**故意忽略**的
//   （一次性产物不参与版本控制），第一版写在那里导致 workflow 的 git add 直接失败。
//
// 用法：node scripts/check-fx-minute-overlap.mjs
//       node scripts/check-fx-minute-overlap.mjs --probe-cross   # 只探测交叉盘的东财代码

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emGetJSON, KLINE_HOSTS } from '../src/em.mjs';
import { sinaFxMinute } from '../src/sources.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'data', 'kline', 'min', '_overlap.json');

const KL_FIELDS = 'fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58';
const PAIRS = [
  ['eurusd', '119.EURUSD', 'fx_seurusd'],
  ['gbpusd', '119.GBPUSD', 'fx_sgbpusd'],
  ['usdjpy', '119.USDJPY', 'fx_susdjpy'],
  ['usdkrw', '119.USDKRW', 'fx_susdkrw'],
  ['audusd', '119.AUDUSD', 'fx_saudusd'],
  ['usdcad', '119.USDCAD', 'fx_susdcad'],
  ['usdchf', '119.USDCHF', 'fx_susdchf'],
];
const PERIODS = [['5m', 5], ['30m', 30]];
const PCT_THRESHOLD = 5e-4;   // 0.05%
const MIN_COMMON = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function emMinute(secid, klt, limit = 1000) {
  const j = await emGetJSON(
    `/api/qt/stock/kline/get?secid=${secid}&klt=${klt}&fqt=1&lmt=${limit}&end=20500101&${KL_FIELDS}`,
    { hosts: KLINE_HOSTS, timeout: 15000 }
  );
  const rows = j?.data?.klines || [];
  return rows.map((r) => {
    const p = String(r).split(',');
    return { t: p[0], c: +p[2] };
  }).filter((b) => b.t && Number.isFinite(b.c));
}

const pct = (arr, q) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

function compare(em, sina) {
  const emMap = new Map(em.map((b) => [b.t, b.c]));
  const sinaMap = new Map(sina.map((b) => [b.t, b.c]));
  const common = [...emMap.keys()].filter((t) => sinaMap.has(t)).sort();
  const rels = [];
  let maxItem = null;
  for (const t of common) {
    const a = emMap.get(t);
    const b = sinaMap.get(t);
    if (!a) continue;
    const rel = Math.abs(b - a) / Math.abs(a);
    rels.push(rel);
    if (!maxItem || rel > maxItem.rel) maxItem = { t, em: a, sina: b, rel };
  }
  const over = rels.filter((r) => r > PCT_THRESHOLD).length;
  const onlyEm = [...emMap.keys()].filter((t) => !sinaMap.has(t));
  const onlySina = [...sinaMap.keys()].filter((t) => !emMap.has(t));
  return {
    emBars: em.length,
    sinaBars: sina.length,
    common: common.length,
    emFirst: em[0]?.t || null, emLast: em[em.length - 1]?.t || null,
    sinaFirst: sina[0]?.t || null, sinaLast: sina[sina.length - 1]?.t || null,
    onlyEm: onlyEm.length,
    onlySina: onlySina.length,
    onlyEmSample: onlyEm.slice(0, 3),
    onlySinaSample: onlySina.slice(0, 3),
    p50: pct(rels, 0.5),
    p90: pct(rels, 0.9),
    p99: pct(rels, 0.99),
    max: maxItem,
    overThreshold: over,
    overThresholdPct: rels.length ? over / rels.length : null,
  };
}

const verdictOf = (r) => {
  if (!r) return 'no-data';
  if (r.common < MIN_COMMON) return 'insufficient-sample';
  if (r.p99 == null) return 'no-data';
  return r.p99 <= PCT_THRESHOLD ? 'pass' : 'fail';
};

// ── 交叉盘的东财代码探测（119.EURCNY 等是否存在、是否同一品种）──
async function probeCross() {
  const targets = ['119.EURCNY', '119.GBPCNY', '119.JPYCNY', '119.KRWCNY', '119.AUDCNY', '133.EURCNH'];
  const out = [];
  for (const secid of targets) {
    const row = { secid };
    try {
      const d = await emMinute(secid, 101, 5);
      row.dailyBars = d.length;
      row.dailyLast = d.length ? d[d.length - 1] : null;
    } catch (e) {
      row.dailyErr = String(e.message).slice(0, 100);
    }
    await sleep(1200);
    try {
      const m = await emMinute(secid, 5, 100);
      row.minBars = m.length;
      row.minLast = m.length ? m[m.length - 1] : null;
    } catch (e) {
      row.minErr = String(e.message).slice(0, 100);
    }
    await sleep(1200);
    out.push(row);
  }
  return out;
}

const report = { generatedAt: new Date().toISOString(), pairs: [], crossProbe: null };

if (process.argv.includes('--probe-cross')) {
  report.crossProbe = await probeCross();
} else {
  for (const [key, secid, sinaSymbol] of PAIRS) {
    for (const [period, klt] of PERIODS) {
      const entry = { key, secid, sinaSymbol, period, klt };
      try {
        entry.em = await emMinute(secid, klt);
      } catch (e) {
        entry.emError = String(e.message).slice(0, 120);
      }
      await sleep(1500);
      try {
        entry.sina = await sinaFxMinute(sinaSymbol, klt, 1000, 1);
      } catch (e) {
        entry.sinaError = String(e.message).slice(0, 120);
      }
      await sleep(1500);
      if (entry.em && entry.sina) {
        entry.stats = compare(entry.em, entry.sina);
        entry.verdict = verdictOf(entry.stats);
      } else {
        entry.verdict = 'no-data';
      }
      // 明细里只留统计，不带全量 bars（报告文件要能进 git）
      delete entry.em;
      delete entry.sina;
      report.pairs.push(entry);
      console.log(
        `${key} ${period}: ${entry.verdict}` +
        (entry.stats ? ` · common=${entry.stats.common} p99=${entry.stats.p99} max=${entry.stats.max?.rel} over=${entry.stats.overThreshold}` : '') +
        (entry.emError ? ` · EM错误=${entry.emError}` : '') +
        (entry.sinaError ? ` · 新浪错误=${entry.sinaError}` : '')
      );
    }
  }
  report.crossProbe = await probeCross();
}

report.summary = {
  pass: report.pairs.filter((p) => p.verdict === 'pass').length,
  fail: report.pairs.filter((p) => p.verdict === 'fail').length,
  other: report.pairs.filter((p) => !['pass', 'fail'].includes(p.verdict)).length,
  thresholdPct: PCT_THRESHOLD,
  minCommon: MIN_COMMON,
};

await mkdir(path.dirname(OUT_FILE), { recursive: true });
await writeFile(OUT_FILE, JSON.stringify(report, null, 2), 'utf8');
console.log('summary', JSON.stringify(report.summary));
console.log('written', path.relative(ROOT, OUT_FILE));
