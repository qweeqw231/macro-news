// tests/quote-status.test.mjs
// 2.4.0：行情三态 / 源时间 / 陈旧度 / K线头部标记。
// 纯函数测试；不联网、不写盘。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const QS = require('../assets/quote-status.js');
const CAL = JSON.parse(readFileSync(new URL('../assets/market-calendar.json', import.meta.url), 'utf8'));
const { lastClosedBarDate } = await import('../src/kline-finalize.mjs');

const NOW = Date.parse('2026-11-03T10:00:00+08:00');
const at = (hm) => `2026-11-03T${hm}:00+08:00`;

test('无源时间永远不能是 realtime', () => {  const r = QS.quoteStatus({ sourceTime: null, now: NOW });
  assert.equal(r.state, 'delayed');
  assert.equal(r.card, '延迟（无源时间）');
  assert.equal(r.summary, '数据时间未知 · 延迟');
  assert.equal(r.footer, '行情 延迟（无源时间）');
});

test('阈值 5 分钟：4/5 分钟实时，6 分钟延迟', () => {
  assert.equal(QS.classifyState(at('09:56'), NOW).state, 'realtime');
  assert.equal(QS.classifyState(at('09:55'), NOW).state, 'realtime');
  assert.equal(QS.classifyState(at('09:54'), NOW).state, 'delayed');
  const late = QS.quoteStatus({ sourceTime: at('09:54'), now: NOW });
  assert.equal(late.state, 'delayed');
  assert.equal(late.card, '09:54 · 延迟');
  assert.equal(late.summary, '更新于 09:54 · 6 分钟前 · 延迟');
  assert.equal(late.footer, '行情 延迟 6 分钟前');
});

test('实时文案与页脚口径一致', () => {
  const r = QS.quoteStatus({ sourceTime: at('09:58'), now: NOW });
  assert.equal(r.state, 'realtime');
  assert.equal(r.card, '09:58 · 实时');
  assert.equal(r.summary, '更新于 09:58 · 2 分钟前 · 实时');
  assert.equal(r.footer, '行情 实时');
});

test('本地快照：卡片与汇总都必须写本地快照', () => {
  const r = QS.quoteStatus({ sourceTime: at('09:52'), now: NOW, fromLocal: true });
  assert.equal(r.state, 'local');
  assert.equal(r.card, '本地快照 · 11-03 09:52');
  assert.equal(r.summary, '本地快照 · 数据时间 09:52 · 8 分钟前');
  assert.equal(r.footer, '行情 本地快照 8 分钟前');
  const noTime = QS.quoteStatus({ sourceTime: null, now: NOW, fromLocal: true });
  assert.equal(noTime.summary, '本地快照 · 数据时间未知');
});

test('相对陈旧度：刚刚 / 分钟 / 小时 / 昨日收盘 / 天', () => {
  assert.equal(QS.relativeAge('2026-11-03T09:59:30+08:00', NOW), '刚刚');
  assert.equal(QS.relativeAge(at('09:57'), NOW), '3 分钟前');
  assert.equal(QS.relativeAge(at('08:00'), NOW), '2 小时前');
  assert.equal(
    QS.relativeAge('2026-11-02T00:00:00+08:00', NOW, { daily: true, date: '2026-11-02' }),
    '昨日收盘'
  );
  assert.equal(
    QS.relativeAge('2026-10-31T00:00:00+08:00', NOW, { daily: true, date: '2026-10-31' }),
    '3 天前'
  );
});

test('腾讯时间 / K线 bar 时间解析', () => {
  assert.equal(QS.parseTencentTime('20261102161500'), '2026-11-02T16:15:00+08:00');
  // 港股实际返回 'YYYY/MM/DD HH:mm:ss'；美股返回 'YYYY-MM-DD HH:mm:ss' 且是美东时间
  assert.equal(QS.parseTencentTime('2026/11/20 18:31:27'), '2026-11-20T18:31:27+08:00');
  assert.equal(
    QS.parseTencentTime('2026-11-20 10:18:40', 'US'),
    '2026-11-20T15:18:40.000Z'
  );
  assert.equal(QS.parseTencentTime('bad'), null);
  assert.deepEqual(QS.parseBarTime('2026-11-02'), {
    date: '2026-11-02', hm: '', iso: '2026-11-02T00:00:00+08:00', year: '2026',
  });
  assert.equal(QS.parseBarTime('2026-11-02 15:00').hm, '15:00');
});

test('K线标记：日K 昨日收盘、分钟 3 分钟前、年K 今年', () => {
  const daily = QS.klineMarker({
    src: '东财直连', bars: [{ t: '2026-11-02' }], period: '1d', now: NOW,
  });
  assert.equal(daily.state, 'delayed');
  assert.equal(daily.full, '东财 · 11-02 · 昨日收盘 · 延迟');
  assert.equal(daily.short, '东财 11-02 · 昨日收盘 · 延迟');

  const minute = QS.klineMarker({
    src: '东财直连', bars: [{ t: '2026-11-03 09:57' }], period: '5m', now: NOW,
  });
  assert.equal(minute.state, 'realtime');
  assert.equal(minute.full, '东财 · 11-03 09:57 · 3 分钟前 · 实时');
  assert.equal(minute.short, '东财 09:57 · 3 分钟前 · 实时');

  const year = QS.klineMarker({
    src: '东财直连', bars: [{ t: '2026-01-01' }], period: '1y', now: NOW,
  });
  assert.equal(year.state, 'delayed');
  assert.equal(year.full, '东财 · 2026 · 今年 · 进行中');
  const oldYear = QS.klineMarker({
    src: '东财直连', bars: [{ t: '2024-01-01' }], period: '1y', now: NOW,
  });
  assert.equal(oldYear.state, 'closed');
  assert.equal(oldYear.full, '东财 · 2024 · 2 年前 · 收盘');
});

test('行情卡：无源时间按市场阶段给终值语义，不一律报延迟', () => {
  // 2026-11-20（周五）22:53 北京：港股 16:00 已收盘，美股 09:53 ET 盘中
  const now = Date.parse('2026-11-20T22:53:00+08:00');
  const hk = QS.quoteStatus({ sourceTime: null, now, market: 'HK', calendar: CAL });
  assert.equal(hk.state, 'closed');
  assert.equal(hk.card, '已收盘（无源时间）');

  const us = QS.quoteStatus({ sourceTime: null, now, market: 'US', calendar: CAL });
  assert.equal(us.state, 'delayed');
  assert.equal(us.card, '延迟（无源时间）');

  const jp = QS.quoteStatus({
    sourceTime: null, now: Date.parse('2026-11-03T12:20:00+08:00'),
    market: 'JP', calendar: CAL,
  });
  assert.equal(jp.state, 'holiday');
  assert.equal(jp.card, '休市（无源时间）');
});

test('K线标记：周/月必须写周线/月线，不是日线', () => {
  const now = Date.parse('2026-11-03T16:00:00+08:00');
  const week = QS.klineMarker({
    src: '东财直连', bars: [{ t: '2026-11-03' }], period: '1w',
    now, market: 'CN', calendar: CAL,
  });
  assert.equal(week.full, '东财 · 11-03 · 收盘（周线）');
  const month = QS.klineMarker({
    src: '东财直连', bars: [{ t: '2026-11-03' }], period: '1M',
    now, market: 'CN', calendar: CAL,
  });
  assert.equal(month.full, '东财 · 11-03 · 收盘（月线）');
});

test('行情卡：收盘后展示收盘时刻，源时间作为「更新」', () => {
  const now = Date.parse('2026-11-03T16:11:00+08:00');
  const r = QS.quoteStatus({
    sourceTime: '2026-11-03T16:11:00+08:00', now, market: 'CN', calendar: CAL,
  });
  assert.equal(r.state, 'closed');
  assert.equal(r.card, '已收盘 · 11-03 15:00');
  assert.match(r.summary, /已收盘 · 11-03 15:00 · 更新 16:11/);
});

test('K线本地预生成：来源与三态必须写本地快照', () => {
  const local = QS.klineMarker({
    src: '本地预生成（近 4 年）', bars: [{ t: '2026-11-02' }], period: '1d', now: NOW,
  });
  assert.equal(local.state, 'local');
  assert.equal(local.full, '本地预生成 · 11-02 · 昨日收盘 · 本地快照');
  assert.ok(local.short.includes('本地快照'));
});

// 2026-11-18：CMDTY 原先没有连续时段配置 ⇒ sessionAt 返回 known:false ⇒
//   分组标题降级判成「休市」，而卡片时间是新鲜的。补一段与 05:00 定稿对齐的窗口。
test('CMDTY：盘中 open，05:00-06:00 与周末为休市', () => {
  const at = (s) => Date.parse(s);
  const phase = (s) => QS.sessionAt('CMDTY', at(s), CAL).phase;
  assert.equal(phase('2026-11-18T23:00:00+08:00'), 'open', '周三盘中');
  assert.equal(phase('2026-11-18T12:00:00+08:00'), 'open', '周三午间（24h 品种无午休）');
  assert.equal(phase('2026-11-18T02:00:00+08:00'), 'open', '凌晨仍属前一日那根');
  assert.notEqual(phase('2026-11-18T05:30:00+08:00'), 'open', '05:00-06:00 日间休市');
  assert.notEqual(phase('2026-11-21T05:30:00+08:00'), 'open', '周六 05:00 之后休市');
  assert.equal(phase('2026-11-21T02:00:00+08:00'), 'open', '周六 00:00-05:00 仍是周五那根');
  assert.notEqual(phase('2026-11-22T23:00:00+08:00'), 'open', '周日全天休市');
  assert.notEqual(phase('2026-11-23T05:00:00+08:00'), 'open', '周一 06:00 前休市');
  assert.equal(phase('2026-11-23T06:30:00+08:00'), 'open', '周一 06:00 开盘');
});

test('CMDTY 与 K 线定稿口径一致：05:00 后状态不是 open，且上一根才刚定稿', () => {
  const before = Date.parse('2026-11-18T04:30:00+08:00');
  // 04:30 仍在交易（11-17 那根还在走）⇒ 最后一根已定稿的是 11-16
  assert.equal(QS.sessionAt('CMDTY', before, CAL).phase, 'open');
  assert.equal(lastClosedBarDate('CMDTY', before, CAL), '2026-11-16');
  // 05:30 已过 05:00 ⇒ 状态必须不是 open，且 11-17 那根刚定稿
  const after = Date.parse('2026-11-18T05:30:00+08:00');
  assert.notEqual(QS.sessionAt('CMDTY', after, CAL).phase, 'open');
  assert.equal(lastClosedBarDate('CMDTY', after, CAL), '2026-11-17');
});

test('降级表也必须认识 CMDTY（假日表加载失败时不能退回休市）', () => {
  const src = readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
  assert.match(src, /CMDTY: \[6, 29\]/);
  assert.match(src, /market === 'CMDTY' && h < 5/);
  assert.match(src, /market === 'CMDTY' && wd === 1 && h < 6/);
  // 两处判定共用一套模型：不再以「假日表是否加载」为前提
  assert.doesNotMatch(src, /QSx\.sessionAt && MARKET_CAL/);
});

test('worstState：local > delayed > realtime', () => {
  assert.equal(QS.worstState(['realtime', 'delayed']), 'delayed');
  assert.equal(QS.worstState(['realtime', 'local']), 'local');
  assert.equal(QS.worstState([]), 'realtime');
});
