// tests/index-sse50.test.mjs
// 2.3.1：上证50（000016）配置与数据落盘的离线回归。
// 只读仓库文件、不写盘、不联网。
//
// 锁定四件事：
//   1. 配置真值：INDICES 里 sse50 = 1.000016 / sh000016，且紧邻沪深300；
//   2. 前端/Worker 三处映射没有漏（cards、K 线、搜索、代理）；
//   3. 全量 K 线与当日 pm 快照确实有上证50，且 pm 的 asOf 是 15:00 收盘；
//   4. quotes.json 的卡片含上证50。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDICES } from '../src/sources.mjs';
import { snapshotTargets } from '../src/snapshot.mjs';

// 2.12.1：行情条数不写死，直接与代码里的目标清单对齐（加标的/加 ETF 会自己长大）。
const TARGET_COUNT = snapshotTargets('am').length;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

test('INDICES：sse50 = 上证50 / 1.000016 / sh000016，位置紧邻沪深300', () => {
  const i = INDICES.findIndex((x) => x.key === 'sse50');
  assert.ok(i >= 0, '缺少 sse50');
  const x = INDICES[i];
  assert.equal(x.name, '上证50');
  assert.equal(x.market, 'CN');
  assert.equal(x.secid, '1.000016');
  assert.equal(x.sina, 'sh000016');
  assert.equal(x.tx, 'sh000016');
  assert.equal(INDICES[i - 1].key, 'csi300', 'sse50 应紧跟在沪深300之后');
});

test('前端与 Worker：卡片 / K 线 / 搜索 / 代理都认识 sse50', () => {
  const market = read('assets/market.js');
  assert.ok(market.includes("{ key: 'sse50',   secid: '1.000016', market: 'CN', name: '上证50' }"),
    'market.js META 缺少 sse50');
  assert.ok(market.includes("sse50: 'sh000016'"), 'market.js 腾讯/新浪代码缺少 sse50');

  const app = read('assets/app.js');
  assert.ok(app.includes("sse50: '000016'"), 'app.js CODE_MAP 缺少 000016');
  assert.ok(app.includes('sse50: \'上证50 上证 蓝筹 sse50 sse 50\''), 'app.js 搜索别名缺少 sse50');

  const worker = read('worker/worker.js');
  assert.ok(worker.includes("sse50: { secid: '1.000016', sina: 'sh000016', tx: 'sh000016', market: 'CN' }"),
    'worker.js 缺少 sse50');
});

test('K 线：全量文件 1000+ 根，从 2004 年起，末根不早于 2026-11-02', () => {
  const full = json('data/kline/sse50_full.json');
  assert.equal(full.name, '上证50');
  assert.ok(Array.isArray(full.bars) && full.bars.length > 1000, '全量 K 线根数不足');
  const first = String(full.bars[0][0]);
  const last = String(full.bars[full.bars.length - 1][0]);
  assert.ok(first <= '2004-01-03', `全量起点过早/过晚：${first}`);
  assert.ok(last >= '2026-11-02', `全量终点过旧：${last}`);

  for (const [file, period, min] of [
    ['data/kline/sse50.json', '1d', 900],
    ['data/kline/sse50_1w.json', '1w', 1000],
    ['data/kline/sse50_1M.json', '1M', 200],
  ]) {
    const j = json(file);
    assert.equal(j.name, '上证50');
    assert.equal(j.period, period);
    assert.ok(j.bars.length >= min, `${file} 根数不足`);
  }
});

test('当日 pm 快照：sse50 存在，asOf=15:00，priceSource=dailyK', () => {
  const snap = json('data/snapshots/2026-11-02_pm.json');
  const q = snap.quotes.sse50;
  assert.ok(q, 'pm 快照缺少 sse50');
  assert.equal(q.name, '上证50');
  assert.equal(q.market, 'CN');
  assert.ok(q.price > 0);
  assert.equal(q.asOf, '2026-11-02T15:00:00+08:00');
  assert.equal(q.priceSource, 'dailyK');
  assert.equal(q.note, '');
  // 组合日频值（cgb_1y）不是日 K，pm 闸门必须放行，否则 17:00 后补 pm 会被误杀
  const cgb = snap.quotes.cgb_1y;
  assert.ok(cgb, 'pm 快照缺少 cgb_1y');
  assert.equal(cgb.kind, 'portfolio');
  assert.equal(cgb.priceSource, 'daily');
});

test('当日 am 快照保持新增标的前的 57 项（时点快照不重写，缺口如实保留）', () => {
  const snap = json('data/snapshots/2026-11-02_am.json');
  assert.equal(snap.coverage.total, 57);
  assert.equal(snap.quotes.sse50, undefined);
  assert.equal(snap.capturedAt, '2026-11-02T12:14:00+08:00');
});

test('quotes.json：卡片含上证50，条数与代码里的标的数量自洽', () => {
  const doc = json('data/quotes.json');
  assert.equal(doc.quotes.length, TARGET_COUNT);
  const q = doc.quotes.find((x) => x.key === 'sse50');
  assert.ok(q, 'quotes.json 缺少 sse50');
  assert.equal(q.name, '上证50');
  assert.equal(q.market, 'CN');
  assert.ok(q.price > 0);
});
