// tests/market-session.test.mjs
// 2.4.1：第四态（已收盘/休市）、交易时段、DST、假日表过期降级、全局标题。
// 纯函数测试；不联网、不写盘。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const QS = require('../assets/quote-status.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'market-calendar.json'), 'utf8'));

const BJ = (s) => Date.parse(s + '+08:00');

test('日本 2026-11-03 文化の日：休市，不再标延迟', () => {
  const now = BJ('2026-11-03T12:20:00');
  const r = QS.quoteStatus({
    sourceTime: '2026-11-02T14:30:00+08:00',
    now,
    market: 'JP',
    calendar: CAL,
  });
  assert.equal(r.state, 'holiday');
  assert.equal(r.card, '休市 · 11-02 14:30');
  assert.ok(r.summary.includes('休市 · 11-02 14:30'));
  assert.ok(r.summary.includes('21 小时前'));
});

test('日本正常交易日开盘：源时间新鲜时为实时', () => {
  const now = BJ('2026-11-04T10:00:00');
  const r = QS.quoteStatus({
    sourceTime: '2026-11-04T09:58:00+08:00',
    now,
    market: 'JP',
    calendar: CAL,
  });
  assert.equal(r.state, 'realtime');
  assert.equal(r.card, '09:58 · 实时');
});

test('港股午休：显示午间休市，带日期时间', () => {
  const now = BJ('2026-11-03T12:20:00');
  const r = QS.quoteStatus({
    sourceTime: '2026-11-03T12:05:00+08:00',
    now,
    market: 'HK',
    calendar: CAL,
  });
  assert.equal(r.state, 'closed');
  assert.equal(r.card, '午间休市 · 11-03 12:05');
});

test('德/法/英/美收盘后：显示已收盘，不显示延迟', () => {
  const now = BJ('2026-11-03T12:20:00');
  const cases = [
    ['EU', '2026-11-03T01:00:00+08:00', '已收盘 · 11-03 01:00'],
    ['UK', '2026-11-03T00:35:00+08:00', '已收盘 · 11-03 00:35'],
    ['US', '2026-11-03T04:59:00+08:00', '已收盘 · 11-03 04:59'],
  ];
  for (const [market, sourceTime, card] of cases) {
    const r = QS.quoteStatus({ sourceTime, now, market, calendar: CAL });
    assert.equal(r.state, 'closed', market);
    assert.equal(r.card, card, market);
  }
});

test('A股交易时段实时；午休显示午间休市', () => {
  const open = QS.quoteStatus({
    sourceTime: '2026-11-03T13:28:00+08:00',
    now: BJ('2026-11-03T13:30:00'),
    market: 'CN',
    calendar: CAL,
  });
  assert.equal(open.state, 'realtime');
  const lunch = QS.quoteStatus({
    sourceTime: '2026-11-03T11:30:00+08:00',
    now: BJ('2026-11-03T12:20:00'),
    market: 'CN',
    calendar: CAL,
  });
  assert.equal(lunch.state, 'closed');
  assert.equal(lunch.card, '午间休市 · 11-03 11:30');
});

test('DST 边界：美东 3 月（EST→EDT）与 11 月（EDT→EST）', () => {
  // 2026-03-06（周五，EST）：22:00 北京 = 09:00 ET，未开盘
  assert.equal(QS.sessionAt('US', BJ('2026-03-06T22:00:00'), CAL).phase, 'pre');
  // 2026-03-10（周二，EDT 已生效）：22:00 北京 = 10:00 ET，开盘
  assert.equal(QS.sessionAt('US', BJ('2026-03-10T22:00:00'), CAL).phase, 'open');
  // 2026-10-30（周五，EDT）：22:00 北京 = 10:00 ET，开盘
  assert.equal(QS.sessionAt('US', BJ('2026-10-30T22:00:00'), CAL).phase, 'open');
  // 2026-11-03（周二，EST 已生效）：22:00 北京 = 09:00 ET，未开盘
  assert.equal(QS.sessionAt('US', BJ('2026-11-03T22:00:00'), CAL).phase, 'pre');
});

test('假日表超出覆盖范围：不猜休市，按交易时段降级', () => {
  const expired = { ...CAL, coverage: { from: '2026-01-01', to: '2026-12-31' } };
  // 2027-01-11 在 JP 表里，但超出覆盖范围 ⇒ 不应判为 holiday
  const now = BJ('2027-01-11T10:00:00');
  assert.equal(QS.sessionAt('JP', now, expired).holiday, false);
  const r = QS.quoteStatus({
    sourceTime: '2027-01-11T09:58:00+08:00',
    now,
    market: 'JP',
    calendar: expired,
  });
  assert.equal(r.state, 'realtime');
});

test('假日表必须覆盖到 2027-12-31（防悄悄过期）', () => {
  assert.ok(CAL.coverage && CAL.coverage.to >= '2027-12-31');
  assert.ok(CAL.updatedAt);
  assert.ok(CAL.sources && CAL.sources.JP && CAL.sources.US);
});

test('全局标题：有实时市场时显示“部分市场已收盘 · 最新”', () => {
  const now = BJ('2026-11-03T12:22:00');
  const items = [
    { state: 'realtime', sourceTime: '2026-11-03T12:22:00+08:00' },
    { state: 'holiday', sourceTime: '2026-11-02T14:30:00+08:00' },
    { state: 'closed', sourceTime: '2026-11-03T01:00:00+08:00' },
  ];
  const g = QS.aggregateStatus(items, now);
  assert.equal(g.summary, '部分市场已收盘 · 最新 12:22');
  assert.equal(g.footer, '行情 部分已收盘 · 最新 12:22');
});

test('全局标题：全市场收盘/休市时显示最近收盘', () => {
  const now = BJ('2026-11-03T12:22:00');
  const closed = QS.aggregateStatus([
    { state: 'closed', sourceTime: '2026-11-03T01:00:00+08:00' },
    { state: 'closed', sourceTime: '2026-11-03T00:35:00+08:00' },
  ], now);
  assert.equal(closed.summary, '全市场已收盘 · 最近收盘 01:00');
  const holiday = QS.aggregateStatus([
    { state: 'holiday', sourceTime: '2026-11-02T14:30:00+08:00' },
  ], now);
  assert.equal(holiday.summary, '休市 · 最近收盘 14:30');
});

test('全局标题：全部延迟仍沿用最旧源时间（2.4.0 口径）', () => {
  const now = BJ('2026-11-03T12:22:00');
  const g = QS.aggregateStatus([
    { state: 'delayed', sourceTime: '2026-11-03T12:00:00+08:00' },
    { state: 'delayed', sourceTime: '2026-11-03T11:40:00+08:00' },
  ], now);
  assert.equal(g.summary, '更新于 11:40 · 42 分钟前 · 延迟');
});

test('无市场信息时保持 2.4.0 旧口径（不破坏既有调用）', () => {
  const r = QS.quoteStatus({ sourceTime: '2026-11-03T09:54:00+08:00', now: BJ('2026-11-03T10:00:00') });
  assert.equal(r.state, 'delayed');
  assert.equal(r.card, '09:54 · 延迟');
});
