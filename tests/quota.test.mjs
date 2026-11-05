// tests/quota.test.mjs
// 2.4.21：800 条结构化配额（官方 / 宏观 / 时间填充）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  selectDayItems, isRecent,
  OFFICIAL_QUOTA, MACRO_QUOTA, DAY_TOTAL, OFFICIAL_RECENT_DAYS,
} from '../src/quota.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const item = (id, ts, { source = '华尔街见闻', channel = '全球', kind = 'news' } = {}) =>
  ({ id, ts, source, channel, kind, title: id });

test('官方很少：全部保留，普通条目填满 800', () => {
  const official = [item('o1', 10, { source: '中国人民银行', kind: 'official' }), item('o2', 20, { source: '美联储', kind: 'official' })];
  const macro = Array.from({ length: 10 }, (_, i) => item(`m${i}`, 1000 + i, { channel: '国内财经' }));
  const rest = Array.from({ length: 1000 }, (_, i) => item(`n${i}`, 2000 + i, { channel: 'A股' }));
  const out = selectDayItems([...rest, ...macro, ...official]);
  assert.equal(out.length, DAY_TOTAL);
  assert.ok(out.find((x) => x.id === 'o1'));
  assert.ok(out.find((x) => x.id === 'o2'));
});

test('官方条目不会被更新的普通快讯挤掉', () => {
  const official = Array.from({ length: 21 }, (_, i) => item(`o${i}`, i, { source: '国家统计局', kind: 'official' }));
  const rest = Array.from({ length: 1000 }, (_, i) => item(`n${i}`, 10000 + i, { channel: 'A股' }));
  const out = selectDayItems([...rest, ...official]);
  assert.equal(out.length, 800);
  for (let i = 0; i < 21; i++) assert.ok(out.some((x) => x.id === `o${i}`), `官方 o${i} 必须保留`);
});

test('宏观配额 120：普通条目不能挤占', () => {
  const macro = Array.from({ length: 200 }, (_, i) => item(`m${i}`, 500 + i, { channel: '国内财经' }));
  const rest = Array.from({ length: 900 }, (_, i) => item(`n${i}`, 10000 + i, { channel: 'A股' }));
  const out = selectDayItems([...rest, ...macro]);
  assert.equal(out.length, 800);
  const keptMacro = out.filter((x) => x.channel === '国内财经');
  assert.equal(keptMacro.length, MACRO_QUOTA);
});

test('官方很多（50）：至少保留 40，总量仍 ≤800', () => {
  const official = Array.from({ length: 50 }, (_, i) => item(`o${i}`, i, { source: '欧洲央行', kind: 'official' }));
  const rest = Array.from({ length: 1000 }, (_, i) => item(`n${i}`, 10000 + i, { channel: 'A股' }));
  const out = selectDayItems([...rest, ...official]);
  assert.equal(out.length, 800);
  const kept = out.filter((x) => x.kind === 'official');
  assert.ok(kept.length >= OFFICIAL_QUOTA, `官方保留 ${kept.length} < ${OFFICIAL_QUOTA}`);
});

test('总数不足 800：全部保留，不凑数', () => {
  const items = [item('a', 1), item('b', 2), item('c', 3)];
  const out = selectDayItems(items);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((x) => x.id), ['c', 'b', 'a']);
});

test('7 天保护：windowed:false 只收最近 7 天', () => {
  const now = Date.parse('2026-11-05T00:00:00Z');
  assert.equal(isRecent(now - 6 * 86400000, now), true);
  assert.equal(isRecent(now - 7 * 86400000 + 1, now), true);
  assert.equal(isRecent(now - 7 * 86400000 - 1, now), false);
  assert.equal(OFFICIAL_RECENT_DAYS, 7);
});

test('collect 使用配额与 7 天过滤', () => {
  const src = read('src/collect.mjs');
  assert.match(src, /selectDayItems\(/);
  assert.match(src, /!s\.windowed.*isRecent\(t, startedAt\.getTime\(\), OFFICIAL_RECENT_DAYS\)/);
  assert.doesNotMatch(src, /\.slice\(0,\s*800\)/);
  assert.match(src, /OFFICIAL_RECENT_DAYS/);
});
