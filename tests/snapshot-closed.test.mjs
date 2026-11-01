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
import { barClosedAt, lastClosedBarDate } from '../src/snapshot.mjs';

const BJ_MS = 8 * 3600 * 1000;
/** epoch → 北京时间 'YYYY-MM-DD HH:MM' */
const bjText = (ms) => new Date(ms + BJ_MS).toISOString().slice(0, 16).replace('T', ' ');

test('各市场日 K 的收完时刻（北京时间）', () => {
  assert.equal(bjText(barClosedAt('CN', '2026-10-30')), '2026-10-30 15:00');
  assert.equal(bjText(barClosedAt('ETF', '2026-10-30')), '2026-10-30 15:00');
  assert.equal(bjText(barClosedAt('HK', '2026-10-30')), '2026-10-30 16:00');
  assert.equal(bjText(barClosedAt('JP', '2026-10-30')), '2026-10-30 14:00');
  assert.equal(bjText(barClosedAt('KR', '2026-10-30')), '2026-10-30 14:30');
  // 欧美跨到次日凌晨：夏/冬令时都按更晚的那个收盘时刻算（保守，不会误判为已收）
  assert.equal(bjText(barClosedAt('EU', '2026-10-30')), '2026-10-31 00:30');
  assert.equal(bjText(barClosedAt('UK', '2026-10-30')), '2026-10-31 00:30');
  assert.equal(bjText(barClosedAt('US', '2026-10-30')), '2026-10-31 05:00');
});

test('pm 16:02 采集：A股/ETF/港股/日韩取当天，欧美取前一天', () => {
  const date = '2026-10-30';
  for (const m of ['CN', 'ETF', 'HK', 'JP', 'KR']) {
    assert.equal(lastClosedBarDate(m, date, 'pm'), date, `${m} 当天已收完`);
  }
  for (const m of ['EU', 'UK', 'US']) {
    assert.equal(lastClosedBarDate(m, date, 'pm'), '2026-10-29', `${m} 当天还没收完`);
  }
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
