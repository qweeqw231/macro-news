// tests/sge-intraday.test.mjs
// 2.6.0：上海金盘中要跟着实时价走 —— 前端交易时段 / 卡片状态 / 采集端取数时机。
// 背景：营业日 15:30 之前 quotes.json 里的上海金一直是上一交易日收盘（11-06 盘中实测 884.09 = 11-05 收盘），
// 前端又因为 META 没有 secid 从不走实时批，卡片长期显示「本地快照」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dueInFastFetch } from '../src/portfolio.mjs';

const require = createRequire(import.meta.url);
const QS = require('../assets/quote-status.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const at = (d, hm) => Date.parse(`2026-11-${d}T${hm}:00+08:00`);
const cardAt = (d, hm) => QS.quoteStatus({
  sourceTime: `2026-11-${d}T${hm}:00+08:00`, now: at(d, hm), market: 'SGE',
});

test('上海金日盘/夜盘都是 realtime，收盘后归「已收盘」', () => {
  // 11-06 是周五
  assert.equal(cardAt('06', '10:00').state, 'realtime');       // 日盘
  assert.equal(cardAt('06', '01:00').state, 'realtime');       // 夜盘（20:00-次日 02:30）
  assert.equal(cardAt('06', '21:00').state, 'realtime');
  assert.equal(cardAt('07', '01:00').state, 'realtime');       // 周六凌晨 = 周五夜盘尾巴
  const post = cardAt('06', '16:00');
  assert.equal(post.state, 'closed');
  assert.match(post.card, /已收盘/);
});

test('收盘时间按「当日最近的那次收盘」算，跨日也不能写成 26:30', () => {
  const afterDay = QS.lastCloseBefore('SGE', at('06', '16:00'));
  assert.deepEqual([afterDay.date, afterDay.hm], ['2026-11-06', '15:30']);
  const afterNight = QS.lastCloseBefore('SGE', at('06', '03:00'));
  assert.deepEqual([afterNight.date, afterNight.hm], ['2026-11-06', '02:30']);
});

test('15:30-20:00 的空档算「已收盘」，不是「午间休市」', () => {
  const r = cardAt('06', '17:00');
  assert.equal(r.phase, 'post');
  assert.doesNotMatch(r.card, /午间休市/);
});

test('采集端：盘中每轮取，15:30 后只补一次官方收盘价', () => {
  const now = (d, hm) => {
    const [hh, mm] = hm.split(':').map(Number);
    return { date: `2026-11-${d}`, hm, hh, mm, wd: new Date(`2026-11-${d}T00:00:00Z`).getUTCDay() };
  };
  const prevDay = { updatedAt: '2026-11-05T15:30:00+08:00' };
  const today = { updatedAt: '2026-11-06T15:30:00+08:00' };

  assert.equal(dueInFastFetch('sge_au9999', prevDay, now('06', '10:00')), true, '日盘每轮取');
  assert.equal(dueInFastFetch('sge_au9999', prevDay, now('06', '21:00')), true, '夜盘每轮取');
  assert.equal(dueInFastFetch('sge_au9999', prevDay, now('06', '16:00')), true, '收盘后补官方价');
  assert.equal(dueInFastFetch('sge_au9999', today, now('06', '16:00')), false, '已写入今天 15:30 → 不再取');
  assert.equal(dueInFastFetch('sge_au9999', prevDay, now('06', '08:00')), false, '开盘前不取');
  assert.equal(dueInFastFetch('sge_au9999', prevDay, now('07', '12:00')), false, '周六不补官方价');
  assert.equal(dueInFastFetch('sge_au9999', prevDay, now('08', '21:00')), false, '周日不开盘');
});

test('前端把上海金并入东财实时批（有 secid 才会被 fetchQuotesEM 取回）', () => {
  const src = read('assets/market.js');
  const line = src.split('\n').find((l) => l.includes("key: 'sge_au9999'"));
  assert.ok(line, 'market.js 里找不到 sge_au9999');
  assert.match(line, /secid:\s*'118\.AU9999'/, '必须带 secid，否则永远只能读 quotes.json → 本地快照');
});

test('quotes.json 不再把上海金锁在「15:30 才取一次」', () => {
  const src = read('src/portfolio.mjs');
  assert.doesNotMatch(src, /DAILY_PUBLISH = \{[^}]*sge_au9999/);
  assert.match(src, /function sgeInSession/);
});
