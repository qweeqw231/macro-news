// tests/kline-close-only.test.mjs
// 2.18.0：「仅收盘」（closeOnly）bar 的标记、写库防回归与落盘核对。
// 只读仓库文件、不写盘、不联网。
//
// 背景：新浪长历史接口对 2005 年底之前的中证指数只返回 open/high/low="0.000"、
//   volume="0"，只有 close 有效。其他源补不到（已实测），所以不造值 ——
//   保留数据但必须显式标记，前端才能按「只有收盘」画，而不是把 0 当真实高低。
//   ⚠ 这一组断言是防回归：任何让 o=h=l=0 的 bar 静默当正常 bar 进库的改动都必须红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isCloseOnlyBar, markCloseOnly, markCloseOnlyBars, CLOSE_ONLY_FLAG,
} from '../src/kline-guard.mjs';
import { aggregateDaily } from '../src/aggregate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

const zeroObj = { t: '2003-01-02', o: 0, h: 0, l: 0, c: 979.431, v: 0 };
const okObj = { t: '2006-01-04', o: 990, h: 1010, l: 985, c: 1005, v: 1234 };
const zeroArr = ['2003-01-02', 0, 979.431, 0, 0, 0];
const okArr = ['2006-01-04', 990, 1005, 1010, 985, 1234];

test('判据：o=h=l=0 且收盘有效才算 closeOnly；收盘也无效的不原谅', () => {
  assert.equal(isCloseOnlyBar(zeroObj), true);
  assert.equal(isCloseOnlyBar(zeroArr), true);
  assert.equal(isCloseOnlyBar(okObj), false);
  assert.equal(isCloseOnlyBar(okArr), false);
  // 已标记的也认（对象 z:1 / 数组第 7 位 1）
  assert.equal(isCloseOnlyBar({ ...zeroObj, o: 1, h: 1, l: 1, z: 1 }), true);
  assert.equal(isCloseOnlyBar(['2003-01-02', 1, 979, 1, 1, 10, 1]), true);
  // 收盘为 0：整根无效，不能借 closeOnly 混过去
  assert.equal(isCloseOnlyBar({ t: 'x', o: 0, h: 0, l: 0, c: 0, v: 0 }), false);
});

test('标记格式：对象行 z:1、紧凑数组行第 7 位 1；普通 bar 不留标记', () => {
  const o = markCloseOnly(zeroObj);
  assert.equal(o.z, 1);
  assert.equal(o.c, 979.431);
  assert.equal(zeroObj.z, undefined, '不能改入参');
  const a = markCloseOnly(zeroArr);
  assert.equal(a.length, 7);
  assert.equal(a[6], CLOSE_ONLY_FLAG);
  assert.equal(markCloseOnly(okObj).z, undefined);
  assert.equal(markCloseOnly(okArr).length, 6);
  // 数据修好后要能自动去标记
  assert.equal(markCloseOnly({ ...zeroObj, o: 1000, h: 1000, l: 1000 }).z, undefined);
});

test('markCloseOnlyBars：统计正确、幂等', () => {
  const one = markCloseOnlyBars([zeroObj, okObj]);
  assert.equal(one.count, 1);
  assert.equal(one.bars[0].z, 1);
  const again = markCloseOnlyBars(one.bars);
  assert.equal(again.count, 1);
  assert.deepEqual(again.bars, one.bars);
  const arr = markCloseOnlyBars([zeroArr, okArr]);
  assert.equal(arr.count, 1);
  assert.deepEqual(arr.bars[0], [...zeroArr, 1]);
});

test('写库那一环必须打标：collect / 全量 / 增量 / 国债四处都在调用', () => {
  for (const [file, label] of [
    ['src/collect.mjs', '日/周/月 K'],
    ['scripts/update-kline-full.mjs', '全量日K'],
    ['scripts/update-kline-last.mjs', '盘中增量'],
    ['src/portfolio-collect.mjs', '国债日K'],
  ]) {
    const src = read(file);
    assert.ok(src.includes('markCloseOnlyBars'), `${label}（${file}）写库前没有打标`);
  }
});

test('周/月聚合：整桶全 closeOnly 才带 z，混桶不标', () => {
  const daily = [
    { t: '2002-01-04', o: 0, h: 0, l: 0, c: 1316.455, v: 0 },
    { t: '2002-01-07', o: 0, h: 0, l: 0, c: 1300, v: 0 },
    { t: '2002-01-14', o: 1290, h: 1320, l: 1280, c: 1310, v: 100 },
    { t: '2002-01-21', o: 0, h: 0, l: 0, c: 1330, v: 0 },
  ];
  const w = aggregateDaily(daily, 'week');
  assert.equal(w[0].z, 1, '整周都是 closeOnly 的周 K 必须带 z');
  assert.equal(w[0].o, 0);
  assert.equal(w[0].c, 1316.455);
  assert.equal(w[1].z, 1);
  assert.equal(w[1].c, 1300);
  assert.equal(w[2].z, undefined, '有真实开高低的周 K 不能带 z');
  assert.equal(w[2].c, 1310);
  const m = aggregateDaily(daily, 'month');
  assert.equal(m.length, 1);
  assert.equal(m[0].z, undefined, '同月混有真实 bar ⇒ 月 K 不标 closeOnly');
});

test('前端兼容：旧文件无标记也按 closeOnly 画（不能报错/空白）', () => {
  const kline = read('assets/kline.js');
  assert.ok(
    kline.includes('b.z === 1 || b.z === true || (o === 0 && h === 0 && l === 0 && c > 0)'),
    'kline.js 缺少「无标记但 o=h=l=0」的兜底识别'
  );
  assert.ok(kline.includes('b.c : b.h'), 'y 域必须跳过 closeOnly 的 h');
  assert.ok(kline.includes('仅收盘价（开高低/成交量无数据）'), '浮窗缺少口径说明');
  const market = read('assets/market.js');
  assert.ok(market.includes('b[6] === 1 ? { z: 1 }'), '全量文件解析未读取第 7 位标记');
  assert.ok(market.includes('curZ = curZ && isCloseOnly(b)'), '前端聚合未传递 closeOnly');
});

test('落盘核对：a100 / csi300 的 closeOnly 根数与区间', () => {
  const a100 = json('data/kline/a100_full.json');
  const az = a100.bars.filter((b) => b[6] === 1);
  assert.equal(az.length, 726, 'a100_full 应有 726 根仅收盘');
  assert.equal(String(az[0][0]), '2003-01-02');
  assert.equal(String(az[az.length - 1][0]), '2005-12-30');
  assert.ok(az.every((b) => +b[2] > 0 && +b[5] === 0), 'closeOnly 必须有收盘、无成交量');

  const c300 = json('data/kline/csi300_full.json');
  const cz = c300.bars.filter((b) => b[6] === 1);
  assert.equal(cz.length, 721, 'csi300_full 应有 721 根仅收盘');
  assert.equal(String(cz[0][0]), '2002-01-04');
  assert.equal(String(cz[cz.length - 1][0]), '2004-12-31');

  const w = json('data/kline/csi300_1w.json');
  assert.equal(w.bars.filter((b) => b.z === 1).length, 150, 'csi300_1w 应有 150 根仅收盘');
  const m = json('data/kline/csi300_1M.json');
  assert.equal(m.bars.filter((b) => b.z === 1).length, 36, 'csi300_1M 应有 36 根仅收盘');
});

test('全库防回归：data/kline 里不存在「未标记的 o=h=l=0 且收盘有效」的 bar', () => {
  const files = [];
  const dir = path.join(ROOT, 'data', 'kline');
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) files.push(path.join(dir, f));
  const minDir = path.join(dir, 'min');
  if (fs.existsSync(minDir)) {
    for (const f of fs.readdirSync(minDir)) if (f.endsWith('.json')) files.push(path.join(minDir, f));
  }
  const offenders = [];
  for (const p of files) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const bars = Array.isArray(doc.bars) ? doc.bars : [];
    if (!bars.length) continue;
    const arr = Array.isArray(bars[0]);
    const bad = bars.filter((b) => {
      const o = arr ? +b[1] : +b.o, h = arr ? +b[3] : +b.h;
      const l = arr ? +b[4] : +b.l, c = arr ? +b[2] : +b.c;
      const z = arr ? b[6] === 1 : b.z === 1;
      return !z && o === 0 && h === 0 && l === 0 && c > 0;
    });
    if (bad.length) offenders.push(`${path.relative(ROOT, p)} (${bad.length})`);
  }
  assert.deepEqual(offenders, [], `存在未标记的仅收盘 bar：${offenders.join(', ')}`);
});
