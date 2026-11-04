// tests/kline-guard.test.mjs
// 2.4.10：K 线短序列覆盖守卫。纯函数，离线。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideBars, mergeBars, barTime } from '../src/kline-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const obj = (t, c = 100) => ({ t, o: c, h: c, l: c, c, v: 1 });
const arr = (t, c = 100) => [t, c, c, c, c, 1];

test('短且首根更晚 ⇒ 拒绝，保留现有', () => {
  const old = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'].map((t) => obj(t));
  const next = ['2026-02-01', '2026-02-02'].map((t) => obj(t));
  const d = decideBars(old, next);
  assert.equal(d.action, 'reject');
  assert.equal(d.reason, 'shorter');
  assert.equal(d.bars, old);
});

test('等长但末根更新 ⇒ 接受', () => {
  const old = ['2026-01-01', '2026-01-02', '2026-01-03'].map((t) => obj(t));
  const next = ['2026-01-01', '2026-01-02', '2026-01-03'].map((t) => obj(t));
  next[2].c = 120;
  const d = decideBars(old, next);
  assert.equal(d.action, 'accept');
  assert.equal(d.reason, 'same-length-newer');
  assert.equal(d.bars[2].c, 120);
  assert.equal(barTime(d.bars[d.bars.length - 1]), '2026-01-03');
});

test('更长且覆盖现有 ⇒ 接受', () => {
  const old = ['2026-01-01', '2026-01-02'].map((t) => obj(t));
  const next = ['2026-01-01', '2026-01-02', '2026-01-03'].map((t) => obj(t));
  const d = decideBars(old, next);
  assert.equal(d.action, 'accept');
  assert.equal(d.reason, 'longer');
  assert.equal(d.bars.length, 3);
});

test('更长但中间有缺口 ⇒ 合并（union，时间升序）', () => {
  const old = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'].map((t) => obj(t));
  const next = ['2026-01-01', '2026-01-02', '2026-01-04', '2026-01-05'].map((t) => obj(t));
  const d = decideBars(old, next);
  assert.equal(d.action, 'merge');
  assert.equal(d.reason, 'gap-merge');
  assert.deepEqual(d.bars.map(barTime), ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']);
});

test('空结果 ⇒ 拒绝；现有为空 ⇒ 接受', () => {
  const old = [obj('2026-01-01')];
  assert.equal(decideBars(old, []).action, 'reject');
  assert.equal(decideBars([], [obj('2026-01-01')]).action, 'accept');
  assert.equal(decideBars(undefined, []).action, 'reject');
});

test('兼容紧凑数组行（分钟/全量）', () => {
  const old = ['2026-01-01 09:00', '2026-01-01 09:05', '2026-01-01 09:10'].map((t) => arr(t));
  const next = ['2026-01-02 09:00', '2026-01-02 09:05'].map((t) => arr(t));
  assert.equal(decideBars(old, next).action, 'reject');
  const merged = mergeBars(old, ['2026-01-01 09:10', '2026-01-01 09:15'].map((t) => arr(t)));
  assert.equal(merged.length, 4);
  assert.equal(barTime(merged[3]), '2026-01-01 09:15');
});

test('写 K 线的脚本都接入共享守卫', () => {
  assert.match(read('src/collect.mjs'), /import \{ decideBars \} from '\.\/kline-guard\.mjs'/);
  assert.match(read('src/collect.mjs'), /const decision = decideBars\(prev && prev\.bars, incoming\)/);
  assert.match(read('scripts/update-kline-minute.mjs'), /decideBars\(oldDoc\.bars, incoming\)/);
  assert.match(read('scripts/update-kline-full.mjs'), /decideBars\(old\.bars, incoming\)/);
  assert.match(read('scripts/backfill-cgb1y.mjs'), /decideBars\(old\.bars, bars\)/);
});
