// tests/quote-status.test.mjs
// 2.4.0：行情三态 / 源时间 / 陈旧度 / K线头部标记。
// 纯函数测试；不联网、不写盘。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QS = require('../assets/quote-status.js');

const NOW = Date.parse('2026-11-03T10:00:00+08:00');
const at = (hm) => `2026-11-03T${hm}:00+08:00`;

test('无源时间永远不能是 realtime', () => {
  const r = QS.quoteStatus({ sourceTime: null, now: NOW });
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
  assert.equal(r.card, '本地快照');
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
  assert.equal(year.state, 'realtime');
  assert.equal(year.full, '东财 · 2026 · 今年 · 实时');
});

test('K线本地预生成：来源与三态必须写本地快照', () => {
  const local = QS.klineMarker({
    src: '本地预生成（近 4 年）', bars: [{ t: '2026-11-02' }], period: '1d', now: NOW,
  });
  assert.equal(local.state, 'local');
  assert.equal(local.full, '本地预生成 · 11-02 · 昨日收盘 · 本地快照');
  assert.ok(local.short.includes('本地快照'));
});

test('worstState：local > delayed > realtime', () => {
  assert.equal(QS.worstState(['realtime', 'delayed']), 'delayed');
  assert.equal(QS.worstState(['realtime', 'local']), 'local');
  assert.equal(QS.worstState([]), 'realtime');
});
