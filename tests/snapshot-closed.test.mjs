// tests/snapshot-closed.test.mjs
// 离线回归：快照「日 K 是否已收完」的判定。
//
// 背景（2026-10-30 事故）：14:24 就生成了 pm 快照，把盘中日 K 当成 15:00 收盘价
// （csi300 4002.41 vs 官方 3985.50）。修法是 `BAR_CLOSED_AT` 规格表：只取
// 「采集时点已经收完」的最后一根日 K。这些边界一旦被人改动，收盘价会静默出错，
// 所以固定成测试。
//
// 运行：node --test tests

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barClosedAt, lastClosedBarDate, snapshotTargets } from '../src/snapshot.mjs';
import { INDICES } from '../src/sources.mjs';

const BJ_MS = 8 * 3600 * 1000;
/** epoch → 北京时间 'YYYY-MM-DD HH:MM' */
const bjText = (ms) => new Date(ms + BJ_MS).toISOString().slice(0, 16).replace('T', ' ');

test('各市场日 K 的收完时刻（北京时间）', () => {
  assert.equal(bjText(barClosedAt('CN', '2026-10-30')), '2026-10-30 15:00');
  assert.equal(bjText(barClosedAt('ETF', '2026-10-30')), '2026-10-30 15:00');
  assert.equal(bjText(barClosedAt('HK', '2026-10-30')), '2026-10-30 16:00');
  assert.equal(bjText(barClosedAt('JP', '2026-10-30')), '2026-10-30 14:00');
  assert.equal(bjText(barClosedAt('KR', '2026-10-30')), '2026-10-30 14:30');
  // 2.9.1：越南 14:45 ICT = 15:45；印度不进 pm（BSE 18:00 才收盘），am 走 T-1
  assert.equal(bjText(barClosedAt('VN', '2026-10-30')), '2026-10-30 15:45');
  // 欧美跨到次日凌晨：夏/冬令时都按更晚的那个收盘时刻算（保守，不会误判为已收）
  assert.equal(bjText(barClosedAt('EU', '2026-10-30')), '2026-10-31 00:30');
  assert.equal(bjText(barClosedAt('UK', '2026-10-30')), '2026-10-31 00:30');
  assert.equal(bjText(barClosedAt('US', '2026-10-30')), '2026-10-31 05:00');
});

test('pm 16:12 采集：A股/ETF/港股/日韩/越南取当天，欧美取前一天；印度不进 pm', () => {
  const date = '2026-10-30';
  for (const m of ['CN', 'ETF', 'HK', 'JP', 'KR', 'VN']) {
    assert.equal(lastClosedBarDate(m, date, 'pm'), date, `${m} 当天已收完`);
  }
  for (const m of ['EU', 'UK', 'US']) {
    assert.equal(lastClosedBarDate(m, date, 'pm'), '2026-10-29', `${m} 当天还没收完`);
  }
});

test('am 12:05 采集：印度与欧美同一套 T-1 判定', () => {
  const date = '2026-10-30';
  for (const m of ['IN', 'DE', 'US', 'EU', 'UK']) {
    assert.equal(lastClosedBarDate(m, date, 'am'), '2026-10-29', `${m} 取前一交易日`);
  }
});

test('pm 目标清单不含印度；am 仍包含', () => {
  const pm = snapshotTargets('pm');
  assert.equal(pm.some((t) => t.market === 'IN'), false);
  const am = snapshotTargets('am');
  assert.equal(am.some((t) => t.market === 'IN'), true);
});

test('新增标的自动进入 am/pm 快照集合（靠 INDICES 派生，不靠硬编码清单）', () => {
  const am = snapshotTargets('am');
  const pm = snapshotTargets('pm');
  const amKeys = new Set(am.map((t) => t.key));
  const pmKeys = new Set(pm.map((t) => t.key));
  for (const i of INDICES) {
    assert.ok(amKeys.has(i.key), `${i.key} 缺失于 am 目标集合`);
    // pm 只排除印度（BSE 18:00 才收盘），其它指数一个都不能少
    if (i.market === 'IN') assert.equal(pmKeys.has(i.key), false, `${i.key} 不应进 pm`);
    else assert.ok(pmKeys.has(i.key), `${i.key} 缺失于 pm 目标集合`);
  }
  // a100 的取价字段必须齐全，否则进了集合也取不到价
  const a100 = pm.find((t) => t.key === 'a100');
  assert.ok(a100, 'pm 目标集合缺少 a100');
  assert.equal(a100.market, 'CN');
  assert.equal(a100.kind, 'index');
  assert.equal(a100.secid, '1.000903');
  assert.equal(a100.tx, 'sh000903');
  // am 与 pm 的唯一差异只能是「pm 排除印度」
  const onlyAm = am.filter((t) => !pmKeys.has(t.key)).map((t) => t.market);
  assert.deepEqual([...new Set(onlyAm)], ['IN']);
});

test('am 12:05 采集：所有市场都只能取前一交易日（当天日 K 一律没收盘）', () => {
  assert.equal(lastClosedBarDate('CN', '2026-10-30', 'am'), '2026-10-29');
  assert.equal(lastClosedBarDate('HK', '2026-10-30', 'am'), '2026-10-29');
  assert.equal(lastClosedBarDate('JP', '2026-10-30', 'am'), '2026-10-29');
  assert.equal(lastClosedBarDate('US', '2026-10-30', 'am'), '2026-10-29');
});

test('未知市场按 A 股 15:00 兜底', () => {
  assert.equal(bjText(barClosedAt('XX', '2026-10-30')), '2026-10-30 15:00');
});
