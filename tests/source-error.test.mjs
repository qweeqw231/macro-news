// tests/source-error.test.mjs
// 2.5.0：采集失败时记录 err.cause 的 code/message（含嵌套与 AggregateError）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeSourceError } from '../src/source-error.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('没有 cause：只返回空对象，保持旧行为', () => {
  assert.deepEqual(describeSourceError(new TypeError('fetch failed')), {});
  assert.deepEqual(describeSourceError(null), {});
});

test('一层 cause：取 code 与 message', () => {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  assert.deepEqual(describeSourceError(err), {
    causeCode: 'ECONNRESET', causeMessage: 'read ECONNRESET',
  });
});

test('嵌套 cause：跳过无 code 的中间层，code 与 message 取同一层', () => {
  const err = new TypeError('fetch failed');
  err.cause = new Error('inner');
  err.cause.cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
  assert.deepEqual(describeSourceError(err), {
    causeCode: 'ENOTFOUND', causeMessage: 'getaddrinfo ENOTFOUND',
  });
});

test('AggregateError：从 errors[] 取第一个 code', () => {
  const agg = new AggregateError([
    Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('other'), { code: 'OTHER' }),
  ], 'aggregate');
  const err = new TypeError('fetch failed');
  err.cause = agg;
  assert.equal(describeSourceError(err).causeCode, 'ECONNREFUSED');
});

test('根错误自带 code 也能记录；循环 cause 不会死循环', () => {
  const err = Object.assign(new Error('boom'), { code: 'E_ROOT' });
  err.cause = err;
  assert.equal(describeSourceError(err).causeCode, 'E_ROOT');
});

test('collect.mjs 写入 causeCode/causeMessage，且旧快照无字段可读', () => {
  const src = read('src/collect.mjs');
  assert.match(src, /describeSourceError\(err\)/);
  assert.match(src, /\.\.\.\(causeCode \? \{ causeCode \} : \{\}\)/, 'causeCode 必须可选');
  assert.match(src, /\.\.\.\(causeMessage \? \{ causeMessage \} : \{\}\)/, 'causeMessage 必须可选');
  // 页面只读 s.error，不依赖新字段
  const app = read('assets/app.js');
  assert.doesNotMatch(app, /causeCode|causeMessage/);
});
