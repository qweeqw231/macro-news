// scripts/repair-period-dupes.mjs
// 2.27.2：一次性修复「周/月 K 同一周期多根」的存量数据（幂等，默认只扫描不写盘）。
//
// 背景：src/kline-guard.mjs 的 decideBars 对「未走完的周/月桶」会走 merge 并集 ——
//   该桶的 `t` 是桶内最后一根日线、每天前移，于是每天多保留一根。
//   xau_1M 的 2026-11 从 1 根长到 12 根（2026-11-04 起），周 K、FX/美股/日股/韩股等
//   全部标的中招。修复分两处：写盘路径收敛（src/collect.mjs）+ 本脚本清存量。
//
// 口径与 src/aggregate.mjs 的 collapsePeriodDuplicates 完全一致：同一周期保留最后一根。
//
// 用法：
//   node scripts/repair-period-dupes.mjs           # 扫描（dry-run，不写盘）
//   node scripts/repair-period-dupes.mjs --write   # 落盘
//   node scripts/repair-period-dupes.mjs --write --only xau,brent   # 只修指定 key

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collapsePeriodDuplicates, periodKey, barTimeOf } from '../src/aggregate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KLINE = path.join(ROOT, 'data', 'kline');
const WRITE = process.argv.includes('--write');
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > -1 ? String(process.argv[onlyArg + 1] || '').split(',').filter(Boolean) : null;

const unitOf = (file) => (file.endsWith('_1w.json') ? 'week' : file.endsWith('_1M.json') ? 'month' : null);

async function main() {
  const files = (await readdir(KLINE)).filter((f) => unitOf(f) && f.endsWith('.json')).sort();
  const hit = [];
  const dailyDup = [];
  let totalCollapsed = 0;
  let totalFiles = 0;

  for (const f of files) {
    const key = f.replace(/_(1w|1M)\.json$/, '');
    if (ONLY && !ONLY.includes(key)) continue;
    totalFiles++;
    const p = path.join(KLINE, f);
    let doc;
    try {
      doc = JSON.parse(await readFile(p, 'utf8'));
    } catch (err) {
      console.log(`  ⚠ ${f} 解析失败，跳过：${String(err.message).slice(0, 60)}`);
      continue;
    }
    const bars = Array.isArray(doc.bars) ? doc.bars : [];
    if (!bars.length) continue;
    const unit = unitOf(f);
    const res = collapsePeriodDuplicates(bars, unit);
    if (!res.collapsed) continue;
    totalCollapsed += res.collapsed;
    const detail = Object.entries(res.periods)
      .map(([k, n]) => `${k}×${n}`)
      .join(' ');
    hit.push(
      `${f.replace('.json', '').padEnd(18)} ${String(bars.length).padStart(5)}→` +
        `${String(res.bars.length).padStart(5)}  -${String(res.collapsed).padStart(4)}  ${detail}`
    );
    if (WRITE) {
      // 只改 bars，其余字段（key/name/market/period/source）原样保留
      await writeFile(p, JSON.stringify({ ...doc, bars: res.bars }, null, 2), 'utf8');
    }
  }

  // 顺带核对日 K 是否存在同一日期重复（同类问题的另一面，正常应为 0）
  const dailyFiles = (await readdir(KLINE)).filter((f) => /\.json$/.test(f) && !unitOf(f));
  for (const f of dailyFiles) {
    let doc;
    try {
      doc = JSON.parse(await readFile(path.join(KLINE, f), 'utf8'));
    } catch {
      continue;
    }
    const bars = Array.isArray(doc.bars) ? doc.bars : [];
    const seen = new Set();
    let dup = 0;
    for (const b of bars) {
      const k = barTimeOf(b).slice(0, 10);
      if (seen.has(k)) dup++;
      seen.add(k);
    }
    if (dup) dailyDup.push(`${f}（${dup} 根）`);
  }

  console.log(
    `[period-dupes] ${WRITE ? '已写盘' : 'dry-run（加 --write 落盘）'} · ` +
      `扫描 ${totalFiles} 个周/月文件 · 命中 ${hit.length} 个 · 收敛 ${totalCollapsed} 根`
  );
  for (const line of hit) console.log(`  ${line}`);
  console.log(
    `[period-dupes] 日K 同日重复：${dailyDup.length ? dailyDup.join(', ') : '0 个文件'}`
  );
  if (!WRITE && hit.length) console.log('[period-dupes] 未写盘。确认后执行：node scripts/repair-period-dupes.mjs --write');

  // 写盘后复核：不允许残留同周期重复
  if (WRITE && hit.length) {
    let left = 0;
    for (const f of files) {
      const key = f.replace(/_(1w|1M)\.json$/, '');
      if (ONLY && !ONLY.includes(key)) continue;
      const doc = JSON.parse(await readFile(path.join(KLINE, f), 'utf8'));
      const bars = doc.bars || [];
      const seen = new Set();
      for (const b of bars) {
        const k = periodKey(barTimeOf(b), unitOf(f));
        if (seen.has(k)) left++;
        seen.add(k);
      }
    }
    console.log(`[period-dupes] 复核：剩余同周期重复 ${left} 根${left === 0 ? ' ✅' : ' ❌'}`);
  }
}

main().catch((err) => {
  console.error('[period-dupes] 致命错误', err);
  process.exit(1);
});
