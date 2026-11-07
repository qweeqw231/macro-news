// tests/index-a500.test.mjs
// 2.3.2 演练：中证A500（000510）配置与落盘回归。
// 只读仓库文件、不写盘、不联网。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDICES } from '../src/sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

test('INDICES：a500 = 中证A500 / 1.000510 / sh000510，紧邻上证50', () => {
  const i = INDICES.findIndex((x) => x.key === 'a500');
  assert.ok(i >= 0, '缺少 a500');
  const x = INDICES[i];
  assert.equal(x.name, '中证A500');
  assert.equal(x.market, 'CN');
  assert.equal(x.secid, '1.000510');
  assert.equal(x.sina, 'sh000510');
  assert.equal(x.tx, 'sh000510');
  assert.equal(INDICES[i - 1].key, 'sse50', 'a500 应紧邻上证50');
});

test('前端与 Worker：a500 的代码 / 搜索 / 映射都在', () => {
  const market = read('assets/market.js');
  assert.ok(market.includes("{ key: 'a500',    secid: '1.000510', market: 'CN', name: '中证A500' }"));
  assert.ok(market.includes("a500: 'sh000510'"));

  const app = read('assets/app.js');
  assert.ok(app.includes("a500: '000510'"), 'CODE_MAP 缺少 000510');
  assert.ok(app.includes('a500: \'中证A500 A500 中证 a500 宽基\''), '搜索别名缺少 a500');

  const worker = read('worker/worker.js');
  assert.ok(worker.includes("a500: { secid: '1.000510', sina: 'sh000510', tx: 'sh000510', market: 'CN' }"));
});

test('K 线：日/周/月/全量都存在，全量 5300+ 根', () => {
  for (const [file, period, min] of [
    ['data/kline/a500.json', '1d', 900],
    ['data/kline/a500_1w.json', '1w', 1000],
    ['data/kline/a500_1M.json', '1M', 200],
  ]) {
    const j = json(file);
    assert.equal(j.name, '中证A500');
    assert.equal(j.period, period);
    assert.ok(j.bars.length >= min, `${file} 根数不足`);
  }
  const full = json('data/kline/a500_full.json');
  assert.equal(full.name, '中证A500');
  assert.ok(full.bars.length >= 5000, '全量根数不足');
  assert.ok(String(full.bars[full.bars.length - 1][0]) >= '2026-11-02');
});

test('quotes：a500 有价，总数 62', () => {
  const doc = json('data/quotes.json');
  assert.equal(doc.quotes.length, 62);
  const q = doc.quotes.find((x) => x.key === 'a500');
  assert.ok(q, 'quotes 缺少 a500');
  assert.equal(q.name, '中证A500');
  assert.ok(q.price > 0);
});

test('历史定案：2026-11-02 pm 保持 58 项、不含 a500（不回填）', () => {
  const snap = json('data/snapshots/2026-11-02_pm.json');
  assert.equal(snap.coverage.total, 58);
  assert.equal(snap.quotes.a500, undefined);
});
