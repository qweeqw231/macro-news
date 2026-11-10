// tests/quota.test.mjs
// 2.4.21：结构化配额（官方 / 宏观 / 时间填充）；2.11.0：上限 800 → 1600；2.12.0：1600 → 1800。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  selectDayItems, isRecent, capState,
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

test('2.12.0：上限是 1800，普通档 = 1800-40-120 = 1640', () => {
  assert.equal(DAY_TOTAL, 1800);
  assert.equal(OFFICIAL_QUOTA, 40);
  assert.equal(MACRO_QUOTA, 120);
  assert.equal(DAY_TOTAL - OFFICIAL_QUOTA - MACRO_QUOTA, 1640);
});

// 2.12.0 回归：2026-11-04 恢复后实测 1,720 条（2.11.1 的全区间上界）。
// 1600 会淘汰 120 条，1800 必须一条不少 —— 这正是本版抬上限的直接依据。
test('2.12.0：1720 条（11-04 恢复后实测上界）在 1800 下不淘汰', () => {
  const items = Array.from({ length: 1720 }, (_, i) =>
    item(`e${i}`, 1794300000 + i, { channel: i % 4 ? '全球' : 'A股' }));
  const out = selectDayItems(items);
  assert.equal(out.length, 1720);
});

// 2.12.0：触顶必须留痕。capState 是 _last-run.json news.capped 的唯一来源，
// 任何「有淘汰但没置标记」的回归都会在这里挂掉。
test('2.12.0：触顶必须置标记（capState）', () => {
  assert.deepEqual(capState([]), { cap: 1800, capped: false, evicted: 0 });
  assert.deepEqual(capState(undefined), { cap: 1800, capped: false, evicted: 0 });
  // 正常日：没有淘汰就不该报触顶
  assert.equal(capState([{ day: '2026-11-10', candidates: 1233, kept: 1233, evicted: 0 }]).capped, false);
  // 突发日：候选超过上限
  const hit = capState([{ day: '2026-11-04', candidates: 1860, kept: 1800, evicted: 60 }]);
  assert.equal(hit.capped, true);
  assert.equal(hit.evicted, 60);
  assert.equal(hit.cap, 1800);
  // 多天求和
  assert.equal(capState([{ evicted: 5 }, { evicted: 7 }]).evicted, 12);
  // 与 selectDayItems 联动：1802 条候选 → 留 1800、报 2 条淘汰
  const many = Array.from({ length: 1802 }, (_, i) => item(`x${i}`, 2000 + i, { channel: 'A股' }));
  const kept = selectDayItems(many);
  const st = capState([{ day: 'x', candidates: many.length, kept: kept.length, evicted: many.length - kept.length }]);
  assert.equal(kept.length, 1800);
  assert.equal(st.capped, true);
  assert.equal(st.evicted, 2);
});

test('2.12.0：collect 写 capped / app 读 capped（页脚健康灯）', () => {
  const src = read('src/collect.mjs');
  assert.match(src, /capped:\s*cap\.capped/, 'collect 必须把 capped 写进 _last-run.json');
  assert.match(src, /evicted:\s*cap\.evicted/);
  assert.match(src, /触顶：候选/, '触顶必须有一条显式日志');
  const app = read('assets/app.js');
  assert.match(app, /newsMeta\.capped/, '页脚必须读 news.capped 亮灯');
  assert.match(app, /归档触顶/, '页脚要有一眼可见的「归档触顶」文案');
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
