// tests/worker-indices.test.mjs
// Worker 代理的标的映射必须与 src/sources.mjs 的 INDICES 完全一致。
// 之前 Worker 漏过 cac40、hs_tech 的 tx、CN 指数的 tx —— 这类漂移会让代理
// 对某些标的静默降级，所以固定成离线回归。
//
// 只读仓库文件、不写盘、不联网。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { INDICES } from '../src/sources.mjs';
import {
  tencentCodeFor,
  yahooCodeFor,
  parseTencentQuotes,
  parseYahooQuote,
} from '../worker/worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = fs.readFileSync(path.join(ROOT, 'worker', 'worker.js'), 'utf8');
const m = WORKER.match(/const INDICES = \{([\s\S]*?)\n\};/);
assert.ok(m, 'worker.js 里找不到 INDICES 对象');
const worker = vm.runInNewContext('({' + m[1] + '})');
const FIELDS = ['secid', 'sina', 'tx', 'market'];

test('Worker INDICES 与 src/sources.mjs 逐项一致', () => {
  assert.equal(Object.keys(worker).length, INDICES.length, '标的数量不一致');
  for (const r of INDICES) {
    const w = worker[r.key];
    assert.ok(w, `Worker 缺少 ${r.key}`);
    for (const f of FIELDS) {
      assert.equal(w[f] ?? null, r[f] ?? null, `${r.key}.${f} 不一致`);
    }
  }
});

test('上证50 / 法国CAC40 / 恒生科技 的映射在 Worker 里存在', () => {
  assert.equal(worker.sse50.secid, '1.000016');
  assert.equal(worker.sse50.sina, 'sh000016');
  assert.equal(worker.sse50.tx, 'sh000016');
  assert.equal(worker.cac40.secid, '100.FCHI');
  assert.equal(worker.hs_tech.tx, 'hkHSTECH');
});

test('腾讯映射：CN/ETF/港/美有代码，CAC40 无腾讯代码', () => {
  assert.equal(tencentCodeFor('1.000300'), 'sh000300');
  assert.equal(tencentCodeFor('1.000016'), 'sh000016');
  assert.equal(tencentCodeFor('1.000510'), 'sh000510');
  assert.equal(tencentCodeFor('0.159819'), 'sz159819');
  assert.equal(tencentCodeFor('100.HSI'), 'hkHSI');
  assert.equal(tencentCodeFor('100.DJIA'), 'usDJI');
  assert.equal(tencentCodeFor('100.FCHI'), null);
});

test('Yahoo 兜底：CAC40/DAX/N225/KOSPI/FTSE 有代码', () => {
  assert.equal(yahooCodeFor('100.FCHI'), '^FCHI');
  assert.equal(yahooCodeFor('100.GDAXI'), '^GDAXI');
  assert.equal(yahooCodeFor('100.N225'), '^N225');
  assert.equal(yahooCodeFor('100.KS11'), '^KS11');
  assert.equal(yahooCodeFor('100.FTSE'), '^FTSE');
});

test('腾讯批量文本解析：价格 / 涨跌幅 / 源时间 / source=tencent', () => {
  const a = Array(40).fill('');
  a[1] = '上证50'; a[3] = '2762.54'; a[4] = '2742.11'; a[5] = '2766.92';
  a[6] = '60371183'; a[30] = '20261102161500'; a[32] = '0.75';
  a[33] = '2766.92'; a[34] = '2738.26';
  const text = `v_sh000016="${a.join('~')}";`;
  const q = parseTencentQuotes(text, [
    { secid: '1.000016', key: 'sse50', code: 'sh000016', name: '上证50' },
  ]);
  assert.equal(q.length, 1);
  assert.equal(q[0].key, 'sse50');
  assert.equal(q[0].name, '上证50');
  assert.equal(q[0].price, 2762.54);
  assert.equal(q[0].changePct, 0.75);
  assert.equal(q[0].updatedAt, '2026-11-02T16:15:00+08:00');
  assert.equal(q[0].source, 'tencent');
});

test('Yahoo chart 解析：source=yahoo，价格/涨跌幅/源时间', () => {
  const j = {
    chart: {
      result: [{
        meta: {
          regularMarketPrice: 7969.42,
          chartPreviousClose: 7900,
          regularMarketTime: 1793607000,
          shortName: 'CAC 40',
          regularMarketOpen: 7920,
          regularMarketDayHigh: 7980,
          regularMarketDayLow: 7890,
        },
      }],
    },
  };
  const q = parseYahooQuote(j, { secid: '100.FCHI', key: 'cac40', name: '法国CAC40' });
  assert.equal(q.key, 'cac40');
  assert.equal(q.name, 'CAC 40');
  assert.equal(q.price, 7969.42);
  assert.equal(q.source, 'yahoo');
  assert.ok(q.updatedAt);
});

test('/quote 源码锁定回退顺序：东财 → 腾讯 → Yahoo', () => {
  const iEm = WORKER.indexOf('// 1) 东财批量');
  const iTx = WORKER.indexOf('// 2) 腾讯备源');
  const iYahoo = WORKER.indexOf('// 3) Yahoo 最后兜底');
  assert.ok(iEm >= 0 && iTx > iEm && iYahoo > iTx, '回退顺序不对');
  assert.ok(WORKER.includes("source: 'tencent'"));
  assert.ok(WORKER.includes("source: 'yahoo'"));
});
