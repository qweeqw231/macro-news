// tests/quota.test.mjs
// 2.4.21：结构化配额（官方 / 宏观 / 时间填充）；2.11.0：上限 800 → 1600。

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

test('官方很少：全部保留，普通条目填满当日上限', () => {
  const official = [item('o1', 10, { source: '中国人民银行', kind: 'official' }), item('o2', 20, { source: '美联储', kind: 'official' })];
  const macro = Array.from({ length: 10 }, (_, i) => item(`m${i}`, 1000 + i, { channel: '国内财经' }));
  const rest = Array.from({ length: 2000 }, (_, i) => item(`n${i}`, 2000 + i, { channel: 'A股' }));
  const out = selectDayItems([...rest, ...macro, ...official]);
  assert.equal(out.length, DAY_TOTAL);
  assert.ok(out.find((x) => x.id === 'o1'));
  assert.ok(out.find((x) => x.id === 'o2'));
});

test('中新网 kind:official 不占官方四源配额', () => {
  const strict = [
    item('s1', 1, { source: '国家统计局', kind: 'official' }),
    item('s2', 2, { source: '欧洲央行', kind: 'official' }),
    item('s3', 3, { source: '中国人民银行', kind: 'official' }),
  ];
  const zx = Array.from({ length: 50 }, (_, i) =>
    item(`z${i}`, 5000 + i, { source: '中新网', channel: '国内财经', kind: 'official' }));
  const rest = Array.from({ length: 2000 }, (_, i) => item(`n${i}`, 10000 + i, { channel: 'A股' }));
  const out = selectDayItems([...rest, ...zx, ...strict]);
  for (const s of strict) assert.ok(out.some((x) => x.id === s.id), `四源 ${s.id} 必须保留`);
  assert.equal(out.length, DAY_TOTAL);
});

test('官方条目不会被更新的普通快讯挤掉', () => {
  const official = Array.from({ length: 21 }, (_, i) => item(`o${i}`, i, { source: '国家统计局', kind: 'official' }));
  const rest = Array.from({ length: 2000 }, (_, i) => item(`n${i}`, 10000 + i, { channel: 'A股' }));
  const out = selectDayItems([...rest, ...official]);
  assert.equal(out.length, DAY_TOTAL);
  for (let i = 0; i < 21; i++) assert.ok(out.some((x) => x.id === `o${i}`), `官方 o${i} 必须保留`);
});

test('宏观配额 120：普通条目不能挤占', () => {
  const macro = Array.from({ length: 200 }, (_, i) => item(`m${i}`, 500 + i, { channel: '国内财经' }));
  const rest = Array.from({ length: 2000 }, (_, i) => item(`n${i}`, 10000 + i, { channel: 'A股' }));
  const out = selectDayItems([...rest, ...macro]);
  assert.equal(out.length, DAY_TOTAL);
  const keptMacro = out.filter((x) => x.channel === '国内财经');
  assert.equal(keptMacro.length, MACRO_QUOTA);
});

test('官方很多（50）：至少保留 40，总量仍 ≤ 当日上限', () => {
  const official = Array.from({ length: 50 }, (_, i) => item(`o${i}`, i, { source: '欧洲央行', kind: 'official' }));
  const rest = Array.from({ length: 2000 }, (_, i) => item(`n${i}`, 10000 + i, { channel: 'A股' }));
  const out = selectDayItems([...rest, ...official]);
  assert.equal(out.length, DAY_TOTAL);
  const kept = out.filter((x) => x.kind === 'official');
  assert.ok(kept.length >= OFFICIAL_QUOTA, `官方保留 ${kept.length} < ${OFFICIAL_QUOTA}`);
});

test('总数不足上限：全部保留，不凑数', () => {
  const items = [item('a', 1), item('b', 2), item('c', 3)];
  const out = selectDayItems(items);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((x) => x.id), ['c', 'b', 'a']);
});

// 2.11.0 回归：2026-11-10 全天真实唯一条目 1,146 条，旧上限 800 会把早盘 329 条挤掉。
// 现在 1,146 < 1600，必须一条不少地保留（这是「早盘不再消失」的最小断言）。
test('2.11.0：1146 条（11-10 实测体量）不触发任何淘汰', () => {
  const items = Array.from({ length: 1146 }, (_, i) =>
    item(`d${i}`, 1794270000 + i, { channel: i % 3 ? '全球' : '国内财经' }));
  const out = selectDayItems(items);
  assert.equal(out.length, 1146);
  assert.equal(new Set(out.map((x) => x.id)).size, 1146);
});

test('2.11.0：上限是 1600，普通档 = 1600-40-120 = 1440', () => {
  assert.equal(DAY_TOTAL, 1600);
  assert.equal(OFFICIAL_QUOTA + MACRO_QUOTA, 160);
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
