// tests/quote-time.test.mjs
// 腾讯行情源时间解析：三种实际格式 + 与前端 assets/quote-status.js 对齐。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseTencentTime, isoCNFromMs } from '../src/quote-time.mjs';
import { isoCNFromEpoch } from '../src/quotes.mjs';

const require = createRequire(import.meta.url);
const front = require('../assets/quote-status.js');

test('东财 f124（epoch 秒）→ 北京时间 ISO(+08:00)', () => {
  const s = isoCNFromEpoch(1795133408);
  assert.equal(s.slice(-6), '+08:00');
  assert.equal(Date.parse(s), 1795133408 * 1000);
});

test('腾讯港股 YYYY/MM/DD HH:mm:ss → 北京时间 ISO', () => {
  assert.equal(parseTencentTime('2026/11/20 14:30:05', 'HK'), '2026-11-20T14:30:05+08:00');
  // 连字符格式（部分代码返回）与紧凑格式也要认
  assert.equal(parseTencentTime('2026-11-20 14:30:05', 'HK'), '2026-11-20T14:30:05+08:00');
  assert.equal(parseTencentTime('20261120143005', 'HK'), '2026-11-20T14:30:05+08:00');
});

test('腾讯美股 YYYY/MM/DD HH:mm:ss（美东）→ 换算成同一时刻的北京时间', () => {
  // 2026-11-20 14:30:05 EST（UTC-5）= 2026-11-21 03:30:05 +08:00
  const s = parseTencentTime('2026/11/20 14:30:05', 'US');
  assert.equal(s, '2026-11-21T03:30:05+08:00');
  assert.equal(Date.parse(s), Date.parse('2026-11-20T19:30:05Z'));
});

test('无法识别的时间返回 null，由调用方回落', () => {
  assert.equal(parseTencentTime('', 'HK'), null);
  assert.equal(parseTencentTime('--', 'US'), null);
  assert.equal(parseTencentTime('2026/11/20', 'HK'), null);
});

test('与前端 parseTencentTime 逐条对齐（含夏令时边界）', () => {
  const samples = [
    ['2026/11/20 14:30:05', 'US'],
    ['2026/11/20 09:30:00', 'US'],
    ['2026/03/09 09:30:00', 'US'], // 美东刚切夏令时（UTC-4）
    ['2026/11/02 09:30:00', 'US'], // 刚切回冬令时（UTC-5）
    ['2026/01/15 16:00:00', 'US'],
    ['2026/11/20 15:59:59', 'HK'],
    ['20261120155959', 'HK'],
  ];
  for (const [s, m] of samples) {
    const a = parseTencentTime(s, m);
    const b = front.parseTencentTime(s, m);
    assert.ok(a && b, `${s} 两侧都应能解析`);
    assert.equal(Date.parse(a), Date.parse(b), `${s}(${m}) 采集侧与前端算出的时刻不一致`);
  }
});
