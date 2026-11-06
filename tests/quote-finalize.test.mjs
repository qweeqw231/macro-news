// tests/quote-finalize.test.mjs
// 2.9.1：收盘后源时间滞后的指数改用日 K 收盘定稿（不按市场写分支）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closedQuoteNeedsDaily, applyDailyClose, finalizeClosedQuotes,
} from '../src/quote-finalize.mjs';

const BJ = (s) => Date.parse(s + '+08:00');

test('印度 20:00：源时间 17:45 < 收盘 18:00 → 需要日 K 定稿', () => {
  const need = closedQuoteNeedsDaily(
    { key: 'sensex', market: 'IN', updatedAt: '2026-11-06T17:45:00+08:00' },
    'IN', BJ('2026-11-06T20:00:00')
  );
  assert.ok(need);
  assert.equal(need.date, '2026-11-06');
  assert.equal(need.asOf, '2026-11-06T18:00:00+08:00');
});

test('源时间已到收盘 / 还没收盘 → 不需要定稿', () => {
  assert.equal(closedQuoteNeedsDaily(
    { market: 'IN', updatedAt: '2026-11-06T18:00:00+08:00' },
    'IN', BJ('2026-11-06T20:00:00')
  ), null);
  assert.equal(closedQuoteNeedsDaily(
    { market: 'IN', updatedAt: '2026-11-06T17:00:00+08:00' },
    'IN', BJ('2026-11-06T17:30:00')
  ), null);
  // 港股午休：不是日线收盘
  assert.equal(closedQuoteNeedsDaily(
    { market: 'HK', updatedAt: '2026-11-06T11:55:00+08:00' },
    'HK', BJ('2026-11-06T12:20:00')
  ), null);
});

test('applyDailyClose：价格/asOf/priceSource/note 与涨跌幅', () => {
  const q = {
    key: 'sensex', market: 'IN', price: 80793.29, prevClose: 79310.01,
    changePct: 1.87, updatedAt: '2026-11-06T17:45:00+08:00',
  };
  const need = { date: '2026-11-06', closeMs: BJ('2026-11-06T18:00:00'), asOf: '2026-11-06T18:00:00+08:00' };
  const n = applyDailyClose(q, { c: 81028.02 }, need);
  assert.equal(n.price, 81028.02);
  assert.equal(n.updatedAt, '2026-11-06T18:00:00+08:00');
  assert.equal(n.priceSource, 'dailyK');
  assert.equal(n.closeDate, '2026-11-06');
  assert.equal(n.note, 'close-daily');
  assert.equal(n.changePct, 2.1662);
});

test('finalizeClosedQuotes：有日 K 就覆盖，取不到保持原样', async () => {
  const quotes = [{
    key: 'sensex', market: 'IN', price: 80793.29,
    prevClose: 79310.01, updatedAt: '2026-11-06T17:45:00+08:00',
  }];
  const meta = new Map([['sensex', { key: 'sensex', market: 'IN', secid: '100.SENSEX' }]]);
  const now = BJ('2026-11-06T20:00:00');

  const ok = await finalizeClosedQuotes(quotes, {
    now, meta,
    fetchDailyK: async () => new Map([['2026-11-06', { c: 81028.02 }]]),
  });
  assert.equal(ok.quotes[0].price, 81028.02);
  assert.equal(ok.quotes[0].priceSource, 'dailyK');
  assert.equal(ok.changes.length, 1);

  const bad = await finalizeClosedQuotes(quotes, {
    now, meta,
    fetchDailyK: async () => { throw new Error('限流'); },
  });
  assert.equal(bad.quotes[0].price, 80793.29);
  assert.equal(bad.quotes[0].priceSource, undefined);
  assert.equal(bad.changes.length, 0);
});

test('卡片文案：dailyK → 收盘（日线）；无日 K → 17:45 盘中值', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const QS = require('../assets/quote-status.js');

  const done = QS.quoteStatus({
    sourceTime: '2026-11-06T18:00:00+08:00',
    now: BJ('2026-11-06T20:00:00'),
    market: 'IN',
    priceSource: 'dailyK',
  });
  assert.equal(done.state, 'closed');
  assert.equal(done.card, '收盘（日线） · 11-06 18:00');

  const partial = QS.quoteStatus({
    sourceTime: '2026-11-06T17:45:00+08:00',
    now: BJ('2026-11-06T20:00:00'),
    market: 'IN',
  });
  assert.equal(partial.state, 'delayed');
  assert.equal(partial.card, '17:45 · 盘中值·未定稿');
});
