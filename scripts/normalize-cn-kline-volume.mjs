// scripts/normalize-cn-kline-volume.mjs
// 一次性把 A 股指数 K 线的成交量统一为「股」（2026-11-22）
//
// 背景：同一文件被两条链路用不同口径交替写 —— 东方财富/腾讯给「手」，新浪给「股」，
//   相差 100 倍；15 天实测 100 次整段历史翻转（单次改 8,000+ 根）、5.04 MiB。
//   采集侧已把口径写死为「股」（src/sources.mjs 的 KLINE_VOLUME_UNIT），本脚本负责
//   **存量文件一次性归一**：以新浪日线（股）为基准，按日期回填日/全量文件的成交量，
//   周/月按同一套分桶规则用日线累加，保证同一标的序列不再出现 ×100 台阶。
//
// 用法：
//   node scripts/normalize-cn-kline-volume.mjs             # 写盘
//   node scripts/normalize-cn-kline-volume.mjs --dry-run   # 只报告
//
// 退出码：0 = 全部成功；1 = 有文件无法判定单位（不写）

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDICES } from '../src/sources.mjs';
import { periodKey } from '../src/aggregate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KLINE_DIR = path.join(ROOT, 'data', 'kline');
const DRY = process.argv.includes('--dry-run');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const CN = INDICES.filter((i) => i.market === 'CN' && i.sina);
const SUFFIXES = ['_full', '', '_1w', '_1M'];

const isArrayBar = (b) => Array.isArray(b);
const tOf = (b) => (isArrayBar(b) ? String(b[0]) : String(b.t || ''));
const vOf = (b) => Number(isArrayBar(b) ? b[5] : b.v) || 0;
const setV = (b, v) => {
  if (isArrayBar(b)) {
    const c = b.slice();
    c[5] = v;
    return c;
  }
  return { ...b, v };
};
const closeOnly = (b) =>
  (isArrayBar(b) ? b[6] === 1 : b.z === 1) ||
  (+(isArrayBar(b) ? b[1] : b.o) === 0 && +(isArrayBar(b) ? b[3] : b.h) === 0 &&
    +(isArrayBar(b) ? b[4] : b.l) === 0 && +(isArrayBar(b) ? b[2] : b.c) > 0);

/** 新浪日线全量（股）→ Map(date → v) + 按周/月分桶的累加值 */
async function fetchSinaDaily(idx) {
  const url =
    'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/' +
    `CN_MarketData.getKLineData?symbol=${idx.sina}&scale=240&ma=no&datalen=20000`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) throw new Error('新浪返回空');
  const daily = new Map();
  const weekly = new Map();
  const monthly = new Map();
  for (const b of arr) {
    const t = String(b.day).slice(0, 10);
    const v = Number(b.volume) || 0;
    daily.set(t, v);
    const wk = periodKey(t, 'week');
    const mo = periodKey(t, 'month');
    weekly.set(wk, (weekly.get(wk) || 0) + v);
    monthly.set(mo, (monthly.get(mo) || 0) + v);
  }
  return { daily, weekly, monthly, first: String(arr[0].day).slice(0, 10) };
}

/** 中位数 */
function median(list) {
  if (!list.length) return NaN;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function unitsFactor(bars, refFor, unit) {
  const ratios = [];
  for (const b of bars) {
    const t = tOf(b);
    const ref = refFor(t);
    const v = vOf(b);
    if (!(ref > 0) || !(v > 0) || closeOnly(b)) continue;
    ratios.push(v / ref);
  }
  const med = median(ratios);
  if (!Number.isFinite(med)) return { factor: 1, med, n: ratios.length, ambiguous: false };
  // 日线：手/股 相差 100 倍，实测比值落在 0.006~0.04；周/月：聚合口径本身可能只覆盖部分区间，
  // 用更窄的 0.003~0.03，避免把「历史月累计不全」误当成单位错。
  const [lo, hi] = unit === 'day' ? [0.001, 0.2] : [0.003, 0.03];
  if (med > lo && med < hi) return { factor: 100, med, n: ratios.length, ambiguous: false };
  if (med >= hi && med <= 5) return { factor: 1, med, n: ratios.length, ambiguous: false };
  return { factor: 1, med, n: ratios.length, ambiguous: true };
}

async function main() {
  const results = [];
  let failed = 0;

  for (const idx of CN) {
    const ref = await fetchSinaDaily(idx).catch((err) => {
      console.log(`  ❌ ${idx.key} 新浪基准失败：${err.message}`);
      return null;
    });
    if (!ref) { failed++; continue; }

    let normalizedFull = null;
    for (const suffix of SUFFIXES) {
      const file = path.join(KLINE_DIR, `${idx.key}${suffix}.json`);
      if (!existsSync(file)) continue;
      const raw = await readFile(file, 'utf8');
      const doc = JSON.parse(raw);
      const bars = Array.isArray(doc.bars) ? doc.bars : [];
      if (!bars.length) continue;

      const unit = suffix === '_1w' ? 'week' : suffix === '_1M' ? 'month' : 'day';
      const firstWeek = periodKey(ref.first, 'week');
      const firstMonth = String(ref.first).slice(0, 7);
      const refFor = (t) => {
        if (unit === 'day') {
          // 新浪没覆盖（或该日 volume=0，如 2008-11-13 的停牌行）时，用刚归一过的 _full 补齐，
          // 保证同一标的「日线 / 全量」在同一天不会出现两个量级。
          const sina = ref.daily.get(t);
          if (sina > 0) return sina;
          return normalizedFull ? normalizedFull.get(t) : undefined;
        }
        const key = periodKey(t, unit);
        // 新浪起点所在的那个周/月桶不完整（起点当周/当月之前的交易日拿不到）→ 不拿它当基准
        if (unit === 'week') return key === firstWeek ? undefined : ref.weekly.get(key);
        return key === firstMonth ? undefined : ref.monthly.get(key);
      };

      const { factor, med, n, ambiguous } = unitsFactor(bars, refFor, unit);
      if (ambiguous) {
        console.log(`  ⛔ ${idx.key}${suffix} 单位无法判定（与新浪中位比 ${med.toFixed(3)}，${n} 根重叠），跳过`);
        failed++;
        continue;
      }

      let changed = 0;
      const out = bars.map((b) => {
        const oldV = vOf(b);
        if (!oldV || closeOnly(b)) return b;
        const r = refFor(tOf(b));
        if (r > 0) {
          // 日线/全量：直接以新浪日线（股）为准 —— 既修正单位，也消除同一天的源间尾差，
          //   日线与 _full 从此逐根一致，不会再出现「同一天两个量级」。
          // 周/月：只做单位修正（窄带），不动已有的聚合口径。
          if (unit === 'day') {
            if (r === oldV) return b;
            changed++;
            return setV(b, r);
          }
          const [lo, hi] = [0.003, 0.03];
          const ratio = oldV / r;
          if (ratio > lo && ratio < hi) {
            const nextV = Math.round(oldV * 100);
            if (nextV !== oldV) { changed++; return setV(b, nextV); }
          }
          return b;
        }
        // 新浪没有覆盖的早期 bar（如 csi1000 的 2005–2014）：按整文件单位系数换算
        if (factor === 1) return b;
        const nextV = Math.round(oldV * factor);
        if (nextV === oldV) return b;
        changed++;
        return setV(b, nextV);
      });

      if (suffix === '_full') {
        normalizedFull = new Map(out.map((b) => [tOf(b), vOf(b)]));
      }

      if (changed && !DRY) {
        const pretty = raw.includes('\n');
        doc.bars = out;
        await writeFile(file, pretty ? JSON.stringify(doc, null, 2) : JSON.stringify(doc), 'utf8');
      }
      results.push({
        file: `${idx.key}${suffix}.json`,
        bars: bars.length,
        changed,
        factor,
        median: Number.isFinite(med) ? Number(med.toFixed(4)) : null,
        before: vOf(bars[bars.length - 1]),
        after: vOf(out[out.length - 1]),
      });
    }
  }

  console.log('\n标的文件 | 根数 | 改动 | 单位系数 | 与新浪中位比 | 末根前 → 末根后');
  for (const r of results) {
    console.log(
      `${r.file.padEnd(20)} ${String(r.bars).padStart(5)} ${String(r.changed).padStart(5)} ` +
        `×${String(r.factor).padEnd(3)} ${String(r.median).padStart(7)} ` +
        `${r.before} → ${r.after}`
    );
  }
  console.log(
    `\n[normalize-cn-kline-volume] ${results.length} 个文件 · 改动 ${results.reduce((s, r) => s + r.changed, 0)} 根` +
      ` · 失败 ${failed}${DRY ? '（dry-run 不写盘）' : ''}`
  );
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[normalize-cn-kline-volume] 致命错误', err);
  process.exit(1);
});
