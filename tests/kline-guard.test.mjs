// tests/kline-guard.test.mjs
// 2.4.10：K 线短序列覆盖守卫。纯函数，离线。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideBars, mergeBars, barTime, barVolume, upsertBars } from '../src/kline-guard.mjs';

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

test('成交量保护：上金所 v=0 不得覆盖东财已有成交量', () => {
  const old = [
    { t: '2026-10-28', o: 1, h: 1, l: 1, c: 1, v: 800 },
    { t: '2026-10-29', o: 1, h: 1, l: 1, c: 1, v: 900 },
    { t: '2026-10-30', o: 1, h: 1, l: 1, c: 1, v: 1000 },
  ];
  const sge = [
    { t: '2026-10-28', o: 2, h: 2, l: 2, c: 2, v: 0 },
    { t: '2026-10-29', o: 2, h: 2, l: 2, c: 2, v: 0 },
    { t: '2026-10-30', o: 2, h: 2, l: 2, c: 2, v: 0 },
  ];
  const d = decideBars(old, sge);
  assert.equal(d.action, 'accept');
  assert.deepEqual(d.bars.map(barVolume), [800, 900, 1000], 'volume 必须保留');
  assert.equal(d.bars[0].c, 2, 'OHLC 仍按新数据更新');
});

test('成交量保护也适用于数组行（分钟/全量）', () => {
  const old = [[ '2026-11-04 09:00', 1, 1, 1, 1, 500 ]];
  const next = [[ '2026-11-04 09:00', 2, 2, 2, 2, 0 ]];
  const d = decideBars(old, next);
  assert.equal(d.action, 'accept');
  assert.equal(d.bars[0][5], 500);
  assert.equal(d.bars[0][1], 2);
});

test('增量 upsert：只刷新最后几根时保留历史与成交量', () => {
  const old = [
    { t: '2026-10-28', o: 1, h: 1, l: 1, c: 1, v: 800 },
    { t: '2026-10-29', o: 1, h: 1, l: 1, c: 1, v: 900 },
    { t: '2026-10-30', o: 1, h: 1, l: 1, c: 1, v: 1000 },
  ];
  const latest = [
    { t: '2026-10-29', o: 2, h: 2, l: 2, c: 2, v: 0 },
    { t: '2026-10-30', o: 2, h: 2, l: 2, c: 2, v: 0 },
    { t: '2026-11-02', o: 2, h: 2, l: 2, c: 2, v: 0 },
  ];
  const out = upsertBars(old, latest);
  assert.deepEqual(
    out.map(barTime),
    ['2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02']
  );
  assert.equal(barVolume(out[1]), 900, '旧的成交量必须保留');
  assert.equal(barVolume(out[2]), 1000, '旧的成交量必须保留');
  assert.equal(out[1].c, 2, 'OHLC 仍按新数据更新');
  assert.equal(out[3].c, 2, '新增的最后几根要接上');
});

test('写 K 线的脚本都接入共享守卫', () => {
  assert.match(read('src/collect.mjs'), /import \{ decideBars \} from '\.\/kline-guard\.mjs'/);
  assert.match(read('src/collect.mjs'), /const decision = decideBars\(prev && prev\.bars, incoming\)/);
  assert.match(read('scripts/update-kline-minute.mjs'), /decideBars\(oldDoc\.bars, incoming\)/);
  assert.match(read('scripts/update-kline-full.mjs'), /decideBars\(oldTrimmed, incoming\)/);
  // 2.9.0：存量先裁掉未收盘的当天 bar，否则 decideBars 会把它当缺失历史合并回来
  assert.match(read('scripts/update-kline-full.mjs'), /dropUnclosedBars\(old\.bars/);
  assert.match(read('scripts/backfill-cgb1y.mjs'), /decideBars\(old\.bars, bars\)/);
});

test('只刷新最后一根的脚本也必须经过守卫（2.4.11 漏网点）', () => {
  const src = read('scripts/update-kline-last.mjs');
  assert.match(src, /import \{ upsertBars \} from '\.\.\/src\/kline-guard\.mjs'/);
  assert.match(src, /const bars = upsertBars\(old\.bars, latest\)/);
  // 不能再回到「Map 直接覆盖」：上金所官网无 volume，会抹掉东财成交量
  assert.doesNotMatch(src, /new Map\(\(old\.bars/);
});
