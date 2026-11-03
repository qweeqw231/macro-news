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

// ---------- 2.4.4：补齐 CN / HK / DE / FR / UK 后的逐市场假日用例 ----------
// 每个市场至少一条：假日当天、源时间停在最近一次收盘 ⇒ holiday（不是 delayed）。
test('A股 2026-10-01 国庆：休市', () => {
  const r = QS.quoteStatus({
    sourceTime: '2026-09-30T15:00:00+08:00',
    now: BJ('2026-10-01T10:00:00'),
    market: 'CN',
    calendar: CAL,
  });
  assert.equal(r.state, 'holiday');
  assert.equal(r.card, '休市 · 09-30 15:00');
});

test('港股 2026-10-19 重阳：休市；2027-01-01 新年：休市', () => {
  const a = QS.quoteStatus({
    sourceTime: '2026-10-16T16:00:00+08:00',
    now: BJ('2026-10-19T12:00:00'),
    market: 'HK',
    calendar: CAL,
  });
  assert.equal(a.state, 'holiday');
  const b = QS.sessionAt('HK', BJ('2027-01-01T12:00:00'), CAL);
  assert.equal(b.phase, 'holiday');
});

test('德/法 2026-05-01 劳动节：休市', () => {
  const cases = [
    ['DE', '2026-04-30T23:30:00+08:00'],
    ['FR', '2026-04-30T23:30:00+08:00'],
  ];
  for (const [market, sourceTime] of cases) {
    const r = QS.quoteStatus({
      sourceTime,
      now: BJ('2026-05-01T12:00:00'),
      market,
      calendar: CAL,
    });
    assert.equal(r.state, 'holiday', market);
  }
});

test('英股 2026-08-31 夏季银行假日：休市；2027-05-03 五月假日：休市', () => {
  const r = QS.quoteStatus({
    sourceTime: '2026-08-28T23:30:00+08:00',
    now: BJ('2026-08-31T12:00:00'),
    market: 'UK',
    calendar: CAL,
  });
  assert.equal(r.state, 'holiday');
  assert.equal(QS.sessionAt('UK', BJ('2027-05-03T12:00:00'), CAL).phase, 'holiday');
});

test('假日表：逐市场覆盖终点不得早于 2026-12-31，KR 无官方表时保持空表', () => {
  for (const m of ['JP', 'US', 'CN', 'HK', 'DE', 'FR', 'UK']) {
    const c = CAL.coverageByMarket && CAL.coverageByMarket[m];
    assert.ok(c, m + ' 缺少 coverageByMarket');
    assert.ok(c.to >= '2026-12-31', m + ' 覆盖终点过早：' + c.to);
  }
  assert.equal((CAL.markets.KR || []).length, 0, 'KR 未取得官方完整表，不得编造');
  assert.match(CAL.gaps.KR, /未能取得/);
});

test('假日表：所有日期都是工作日（周末不重复登记）', () => {
  for (const [market, dates] of Object.entries(CAL.markets)) {
    for (const d of dates) {
      const wd = new Date(d + 'T00:00:00Z').getUTCDay();
      assert.ok(wd >= 1 && wd <= 5, `${market} ${d} 是周末，不应写入假日表`);
    }
  }
});

// ---------- 2.4.7：半日市 ----------
test('港股 2026-12-24 平安夜：收市前实时，12:00 后已收盘（半日市）', () => {
  const before = QS.quoteStatus({
    sourceTime: '2026-12-24T11:48:00+08:00',
    now: BJ('2026-12-24T11:50:00'),
    market: 'HK',
    calendar: CAL,
  });
  assert.equal(before.state, 'realtime');
  assert.equal(before.card, '11:48 · 实时');
  const after = QS.quoteStatus({
    sourceTime: '2026-12-24T12:00:00+08:00',
    now: BJ('2026-12-24T12:10:00'),
    market: 'HK',
    calendar: CAL,
  });
  assert.equal(after.state, 'closed');
  assert.equal(after.card, '已收盘（半日市） · 12-24 12:00');
  assert.equal(after.halfDay, true);
  assert.equal(QS.sessionAt('HK', BJ('2026-12-24T12:05:00'), CAL).phase, 'post');
});

test('港股半日市：源返回上一交易日旧价也归已收盘，不标延迟', () => {
  const r = QS.quoteStatus({
    sourceTime: '2026-12-23T16:00:00+08:00',
    now: BJ('2026-12-24T18:00:00'),
    market: 'HK',
    calendar: CAL,
  });
  assert.equal(r.state, 'closed');
  assert.equal(r.card, '已收盘（半日市） · 12-23 16:00');
});

test('法股 2026-12-24 半日市：14:00 CET 前实时，之后已收盘', () => {
  const before = QS.quoteStatus({
    sourceTime: '2026-12-24T20:25:00+08:00',
    now: BJ('2026-12-24T20:28:00'),
    market: 'FR',
    calendar: CAL,
  });
  assert.equal(before.state, 'realtime');
  const after = QS.quoteStatus({
    sourceTime: '2026-12-24T21:00:00+08:00',
    now: BJ('2026-12-24T21:10:00'),
    market: 'FR',
    calendar: CAL,
  });
  assert.equal(after.state, 'closed');
  assert.equal(after.card, '已收盘（半日市） · 12-24 21:00');
});

test('英股 2026-12-24 半日市：12:30 London 前实时，之后已收盘', () => {
  const before = QS.quoteStatus({
    sourceTime: '2026-12-24T20:18:00+08:00',
    now: BJ('2026-12-24T20:20:00'),
    market: 'UK',
    calendar: CAL,
  });
  assert.equal(before.state, 'realtime');
  const after = QS.quoteStatus({
    sourceTime: '2026-12-24T20:30:00+08:00',
    now: BJ('2026-12-24T20:35:00'),
    market: 'UK',
    calendar: CAL,
  });
  assert.equal(after.state, 'closed');
  assert.equal(after.card, '已收盘（半日市） · 12-24 20:30');
});

test('美股 2026-11-27 感恩节次日：13:00 ET 前实时，之后已收盘', () => {
  const before = QS.quoteStatus({
    sourceTime: '2026-11-28T01:50:00+08:00',
    now: BJ('2026-11-28T01:55:00'),
    market: 'US',
    calendar: CAL,
  });
  assert.equal(before.state, 'realtime');
  const after = QS.quoteStatus({
    sourceTime: '2026-11-28T02:00:00+08:00',
    now: BJ('2026-11-28T02:15:00'),
    market: 'US',
    calendar: CAL,
  });
  assert.equal(after.state, 'closed');
  assert.equal(after.card, '已收盘（半日市） · 11-28 02:00');
});

test('非半日市日期不受影响：港股 2026-12-23 下午仍交易中', () => {
  const r = QS.sessionAt('HK', BJ('2026-12-23T15:00:00'), CAL);
  assert.equal(r.phase, 'open');
  assert.equal(r.halfDay, false);
});

test('半日市表：日期在覆盖范围内、closeTime 合法、且不与全天休市冲突', () => {
  assert.ok(CAL.halfDays, '缺少 halfDays');
  for (const [market, list] of Object.entries(CAL.halfDays)) {
    const cov = CAL.coverageByMarket[market];
    assert.ok(cov, market + ' 缺少 coverageByMarket');
    for (const h of list) {
      assert.match(h.date, /^\d{4}-\d{2}-\d{2}$/, market);
      assert.ok(h.date >= cov.from && h.date <= cov.to, `${market} ${h.date} 超出覆盖范围`);
      assert.match(h.closeTime, /^\d{2}:\d{2}$/, `${market} ${h.date} closeTime 格式`);
      assert.ok((CAL.markets[market] || []).indexOf(h.date) < 0, `${market} ${h.date} 不能同时是全天休市`);
      assert.ok(h.sessionNote && h.source, `${market} ${h.date} 缺少说明或来源`);
    }
  }
});

test('半日市表：2026-12-24 巴黎/伦敦/香港都在表内，Xetra 不在（全天休市）', () => {
  assert.ok(QS.halfDayFor('HK', '2026-12-24', CAL));
  assert.ok(QS.halfDayFor('FR', '2026-12-24', CAL));
  assert.ok(QS.halfDayFor('UK', '2026-12-24', CAL));
  assert.equal(QS.halfDayFor('DE', '2026-12-24', CAL), null);
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
