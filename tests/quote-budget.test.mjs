// tests/quote-budget.test.mjs
// 2.4.0：报价超时预算（东财 1.2s → 腾讯 0.8s，总 2s）。
// 用假 promise，不联网、不写盘。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QS = require('../assets/quote-status.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('东财成功：直接返回，腾讯不被调用', async () => {
  let txCalled = false;
  const r = await QS.runQuoteBudget({
    em: async () => { await sleep(10); return ['em']; },
    tx: async () => { txCalled = true; return ['tx']; },
    totalBudget: 100, emBudget: 50, txBudget: 50,
  });
  assert.deepEqual(r, ['em']);
  assert.equal(txCalled, false);
});

test('东财失败：腾讯在剩余预算内返回', async () => {
  const r = await QS.runQuoteBudget({
    em: async () => { throw new Error('em down'); },
    tx: async () => { await sleep(5); return ['tx']; },
    totalBudget: 50, emBudget: 20, txBudget: 30,
  });
  assert.deepEqual(r, ['tx']);
});

test('东财挂起：1.2s 预算到点后腾讯接管（测试用 20ms 预算）', async () => {
  const r = await QS.runQuoteBudget({
    em: () => new Promise(() => {}),
    tx: async () => ['tx'],
    totalBudget: 40, emBudget: 20, txBudget: 20,
  });
  assert.deepEqual(r, ['tx']);
});

test('两者都失败：抛错，总耗时不超过预算量级', async () => {
  const t0 = Date.now();
  await assert.rejects(
    QS.runQuoteBudget({
      em: () => new Promise(() => {}),
      tx: () => new Promise(() => {}),
      totalBudget: 40, emBudget: 20, txBudget: 20,
    }),
    /报价均失败/
  );
  const ms = Date.now() - t0;
  assert.ok(ms <= 80, `应在 2 个预算周期内结束，实际 ${ms}ms`);
});

test('withTimeout：超时 reject，晚到的结果不覆盖', async () => {
  await assert.rejects(
    QS.withTimeout((async () => { await sleep(30); return ['late']; })(), 10, '测试'),
    /超时/
  );
  const ok = await QS.withTimeout(Promise.resolve(['ok']), 50, '测试');
  assert.deepEqual(ok, ['ok']);
});
