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
