// tests/kline-partial.test.mjs
// 2.9.0：当日 bar / 行情卡片的「盘中值·未定稿」标记。
// 纯函数；不联网、不写盘。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const QS = require('../assets/quote-status.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'market-calendar.json'), 'utf8'));

const BJ = (s) => Date.parse(s + '+08:00');
const bars = [{ t: '2026-11-06', o: 1, c: 2, h: 3, l: 1, v: 1 }];

test('K线：港股盘中，当日 bar 不得标实时', () => {
  const m = QS.klineMarker({
    src: '东财直连', bars, period: '1d',
    now: BJ('2026-11-06T14:00:00'), market: 'HK', calendar: CAL,
  });
  assert.equal(m.partial, true);
  assert.ok(m.full.includes('盘中值·未定稿'));
  assert.equal(m.state, 'delayed');
});

test('K线：收盘后，直连的当日 bar 是定稿 → 收盘（日线）', () => {
  const m = QS.klineMarker({
    src: '东财直连', bars, period: '1d',
    now: BJ('2026-11-06T17:00:00'), market: 'HK', calendar: CAL,
  });
  assert.equal(m.partial, undefined);
  assert.equal(m.state, 'closed');
  assert.ok(m.full.includes('收盘（日线）'));
});

test('K线：收盘后但本地日K 生成于收盘前 → 仍是盘中值', () => {
  const m = QS.klineMarker({
    src: '本地预生成（近 4 年）', bars, period: '1d',
    dataAt: '2026-11-06T07:48:24Z',           // 15:48 北京，早于 16:00 收盘
    now: BJ('2026-11-06T16:05:00'), market: 'HK', calendar: CAL,
  });
  assert.equal(m.partial, true);
  assert.ok(m.full.includes('盘中值·未定稿'));

  const done = QS.klineMarker({
    src: '本地预生成（近 4 年）', bars, period: '1d',
    dataAt: '2026-11-06T08:20:00Z',           // 16:20 北京，收盘后
    now: BJ('2026-11-06T17:00:00'), market: 'HK', calendar: CAL,
  });
  assert.equal(done.state, 'closed');
  assert.ok(done.full.includes('收盘（日线）'));
});

test('K线：收盘后但来自 _full 全量兜底（12:18 生成）仍是盘中值', () => {
  const m = QS.klineMarker({
    src: '本地全量（服务端预生成）', bars, period: '1d',
    now: BJ('2026-11-06T17:00:00'), market: 'HK', calendar: CAL,
  });
  assert.equal(m.partial, true);
  assert.ok(m.full.includes('盘中值·未定稿'));
});

test('行情卡：收盘后源时间停在收盘前 → 盘中值·未定稿', () => {
  const r = QS.quoteStatus({
    sourceTime: '2026-11-06T15:53:10+08:00',
    now: BJ('2026-11-06T17:00:00'),
    market: 'HK', calendar: CAL,
  });
  assert.equal(r.state, 'delayed');
  assert.equal(r.card, '15:53 · 盘中值·未定稿');
  assert.equal(r.partial, true);
});

test('行情卡：源时间已到收盘之后 → 正常已收盘', () => {
  const r = QS.quoteStatus({
    sourceTime: '2026-11-06T16:09:10+08:00',
    now: BJ('2026-11-06T17:00:00'),
    market: 'HK', calendar: CAL,
  });
  assert.equal(r.state, 'closed');
  assert.equal(r.card, '已收盘 · 11-06 16:09');
  assert.equal(r.partial, undefined);
});

test('K线：半日市提前收盘后 → 收盘（日线）', () => {
  const half = [{ t: '2026-12-24', o: 1, c: 2, h: 3, l: 1, v: 1 }];
  const m = QS.klineMarker({
    src: '东财直连', bars: half, period: '1d',
    now: BJ('2026-12-24T12:30:00'), market: 'HK', calendar: CAL,
  });
  assert.equal(m.state, 'closed');
  assert.ok(m.full.includes('收盘（日线）'));
});

test('K线：休市日却出现当日 bar → 不标实时', () => {
  const holidayBar = [{ t: '2026-11-03', o: 1, c: 2, h: 3, l: 1, v: 1 }];
  const m = QS.klineMarker({
    src: '东财直连', bars: holidayBar, period: '1d',
    now: BJ('2026-11-03T12:00:00'), market: 'JP', calendar: CAL,
  });
  assert.equal(m.state, 'delayed');
  assert.ok(m.full.includes('休市日无当日 bar'));
});

test('K线：跨时区（美股）北京次日凌晨 → 收盘（日线）', () => {
  const usBar = [{ t: '2026-11-05', o: 1, c: 2, h: 3, l: 1, v: 1 }];
  const m = QS.klineMarker({
    src: '东财直连', bars: usBar, period: '1d',
    now: BJ('2026-11-06T06:00:00'), market: 'US', calendar: CAL,
  });
  assert.equal(m.state, 'closed');
  assert.ok(m.full.includes('收盘（日线）'));
});
