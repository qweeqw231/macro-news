// tests/kline-period-dupes.test.mjs
// 2.28.0：周/月 K「同一周期多根」的修复与防回归。
// 只读仓库文件、不写盘、不联网。
//
// 背景：未走完的周/月桶，其 bar 的 t 是「桶内最后一根日线」，每天前移
//   （2026-11-18 → 11-19）。kline-guard.decideBars 判成「缺旧末根键」走 merge 并集，
//   新旧两个桶都保留 ⇒ 每天多一根。2026-11-04 上线后，xau_1M 的 2026-11 长到 12 根，
//   全库 82 个周/月文件、448 根重复（全部指数 / FX / 商品 / 上金所）。
//
// 不变量：一个周/月周期只能有一根 bar（保留最后一根 = 该周期最新的累计值）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  periodKey, collapsePeriodDuplicates, barTimeOf,
} from '../src/aggregate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('周期键：month 取 YYYY-MM；week 取 ISO 周一（跨年不串周）', () => {
  assert.equal(periodKey('2026-11-19', 'month'), '2026-11');
  assert.equal(periodKey('2026-11-19', 'week'), '2026-11-16');
  assert.equal(periodKey('2026-11-16', 'week'), '2026-11-16');
  assert.equal(periodKey('2026-11-22', 'week'), '2026-11-16', '周日仍属上一个周一');
  // 2026-01-01 是周四，属于 2025-12-29 那一周
  assert.equal(periodKey('2026-01-01', 'week'), '2025-12-29');
  assert.equal(periodKey('2025-12-31', 'week'), '2025-12-29');
  // 紧凑数组行
  assert.equal(barTimeOf(['2026-11-19', 1, 2, 3, 4, 5]), '2026-11-19');
});

test('月 K：同月多根只保留最后一根，其它月不受影响', () => {
  const bars = [
    { t: '2026-10-30', o: 100, c: 110, h: 112, l: 98, v: 10 },
    { t: '2026-11-02', o: 110, c: 120, h: 130, l: 109, v: 20 },
    { t: '2026-11-10', o: 110, c: 105, h: 130, l: 101, v: 50 },
    { t: '2026-11-19', o: 110, c: 99, h: 130, l: 95, v: 90 },
  ];
  const res = collapsePeriodDuplicates(bars, 'month');
  assert.equal(res.collapsed, 2);
  assert.equal(res.bars.length, 2);
  assert.deepEqual(res.bars[0], bars[0], '上个月那根不能动');
  assert.deepEqual(res.bars[1], bars[3], '必须保留同月最后一根（最新累计值）');
  assert.deepEqual(res.periods, { '2026-11': 3 }, 'periods 记录该周期原有根数');
});

test('周 K：同一周内多根只保留最后一根；紧凑数组行同样适用', () => {
  const bars = [
    ['2026-11-09', 1, 2, 3, 0.5, 7],
    ['2026-11-16', 10, 11, 12, 9, 1],
    ['2026-11-17', 10, 12, 13, 9, 2],
    ['2026-11-19', 10, 13, 14, 8, 3],
    ['2026-11-23', 20, 21, 22, 19, 4],
  ];
  const res = collapsePeriodDuplicates(bars, 'week');
  assert.equal(res.collapsed, 2);
  assert.equal(res.bars.length, 3);
  assert.equal(barTimeOf(res.bars[1]), '2026-11-19');
  assert.equal(barTimeOf(res.bars[2]), '2026-11-23');
});

test('收敛保留 closeOnly 标记（不能把标记丢掉变成 0 高低）', () => {
  const bars = [
    { t: '2026-11-02', o: 0, h: 0, l: 0, c: 100, v: 0, z: 1 },
    { t: '2026-11-19', o: 0, h: 0, l: 0, c: 101, v: 0, z: 1 },
  ];
  const res = collapsePeriodDuplicates(bars, 'month');
  assert.equal(res.bars.length, 1);
  assert.equal(res.bars[0].z, 1);
  assert.equal(res.bars[0].c, 101);
});

test('写盘路径必须收敛：collect.mjs 在 markCloseOnlyBars 之前调用', () => {
  const src = read('src/collect.mjs');
  const collapseAt = src.indexOf('collapsePeriodDuplicates(decision.bars');
  const markAt = src.indexOf('markCloseOnlyBars(collapsed ? collapsed.bars : decision.bars)');
  assert.ok(collapseAt > 0, 'collect.mjs 写盘路径缺少周/月同周期收敛');
  assert.ok(markAt > 0, '收敛结果必须仍经过 markCloseOnlyBars 打标');
  assert.ok(collapseAt < markAt, '收敛必须在打标之前，否则标记会被并发桶覆盖的旧值带走');
});

test('全库防回归：data/kline 里不存在同一周/月多根、也不存在同日重复', () => {
  const dir = path.join(ROOT, 'data', 'kline');
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const unit = f.endsWith('_1w.json') ? 'week' : f.endsWith('_1M.json') ? 'month' : null;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const bars = Array.isArray(doc.bars) ? doc.bars : [];
    if (!bars.length) continue;
    const seen = new Set();
    const dup = [];
    for (const b of bars) {
      // 日 K 按日期、周/月按周期键；周/月的时间戳本身就带日，所以统一取周期键
      const k = unit ? periodKey(barTimeOf(b), unit) : barTimeOf(b).slice(0, 10);
      if (seen.has(k)) dup.push(k);
      seen.add(k);
    }
    if (dup.length) offenders.push(`${f}（${dup.length} 根：${[...new Set(dup)].slice(0, 3).join(',')}）`);
  }
  assert.deepEqual(offenders, [], `存在同周期重复 bar：${offenders.join('; ')}`);
});
