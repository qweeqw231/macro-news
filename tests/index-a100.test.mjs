// tests/index-a100.test.mjs
// 中证A100（000903）配置与落盘回归。
// 只读仓库文件、不写盘、不联网。
//
// ⚠ 断言只写不变量 / 下界：根数、末根日期会随时间增长，不写死精确值。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDICES } from '../src/sources.mjs';
import { snapshotTargets } from '../src/snapshot.mjs';

// 行情条数不写死：快照目标清单 = INDICES + ETFS + 组合，加标的时自己跟着长大
const TARGET_COUNT = snapshotTargets('am').length;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

test('INDICES：a100 = 中证A100 / 1.000903 / sh000903，紧邻中证A500', () => {
  const i = INDICES.findIndex((x) => x.key === 'a100');
  assert.ok(i >= 0, '缺少 a100');
  const x = INDICES[i];
  assert.equal(x.name, '中证A100');
  assert.equal(x.market, 'CN');
  assert.equal(x.secid, '1.000903');
  assert.equal(x.sina, 'sh000903');
  assert.equal(x.tx, 'sh000903');
  assert.equal(INDICES[i - 1].key, 'a500', 'a100 应紧邻中证A500');
});

test('前端与 Worker：a100 的代码 / 搜索 / 映射都在', () => {
  const market = read('assets/market.js');
  assert.ok(market.includes("{ key: 'a100',    secid: '1.000903', market: 'CN', name: '中证A100' }"));
  assert.ok(market.includes("a100: 'sh000903'"));

  const app = read('assets/app.js');
  assert.ok(app.includes("a100: '000903'"), 'CODE_MAP 缺少 000903');
  assert.ok(app.includes("a100: '中证A100 A100 中证 a100 宽基'"), '搜索别名缺少 a100');

  const worker = read('worker/worker.js');
  assert.ok(worker.includes("a100: { secid: '1.000903', sina: 'sh000903', tx: 'sh000903', market: 'CN' }"));
});

test('K 线：日/周/月/全量都存在，名称正确、起点在 2003 年', () => {
  for (const [file, period, min] of [
    ['data/kline/a100.json', '1d', 4000],
    ['data/kline/a100_1w.json', '1w', 800],
    ['data/kline/a100_1M.json', '1M', 200],
  ]) {
    const j = json(file);
    assert.equal(j.name, '中证A100');
    assert.equal(j.period, period);
    assert.ok(j.bars.length >= min, `${file} 根数不足`);
  }
  const full = json('data/kline/a100_full.json');
  assert.equal(full.name, '中证A100');
  assert.ok(full.bars.length >= 5000, '全量根数不足');
  assert.ok(String(full.bars[0][0]) <= '2003-01-10', '全量起点应覆盖 2003 年初');
});

test('quotes：a100 有价，总数与代码里的标的数量自洽', () => {
  const doc = json('data/quotes.json');
  assert.equal(doc.quotes.length, TARGET_COUNT);
  const q = doc.quotes.find((x) => x.key === 'a100');
  assert.ok(q, 'quotes 缺少 a100');
  assert.equal(q.name, '中证A100');
  assert.ok(q.price > 0);
  assert.equal(q.market, 'CN');
});

test('历史定案：2026-11-12 pm 不含 a100（新增日前的快照不回填）', () => {
  const snap = json('data/snapshots/2026-11-12_pm.json');
  assert.equal(snap.quotes.a100, undefined);
});
