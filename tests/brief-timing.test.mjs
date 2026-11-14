// tests/brief-timing.test.mjs
// 2.20.0：早报生成时点四档（按时 / 同日明显晚到 / 跨日 / 补写）。
// 用例直接取 data/briefings/ 里的真实时刻，防止阈值或文案漂移。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { briefTiming, bjStamp, lateSpan, BRIEF_LATE_MIN } = require('../assets/brief-timing.js');

test('按时：09:00 起 30 分钟内只给时分，不加噪音', () => {
  const r = briefTiming('2026-11-13', '2026-11-13T09:11:17+08:00', false);
  assert.equal(r.kind, 'on-time');
  assert.equal(r.text, '09:11 生成');
  assert.equal(r.lateMin, 11);
  // 实测正常批次的边界：09:02 与 09:11 都应按时
  assert.equal(briefTiming('2026-11-02', '2026-11-02T09:02:00+08:00', false).kind, 'on-time');
  assert.equal(briefTiming('2026-11-05', '2026-11-05T09:04:27+08:00', false).kind, 'on-time');
});

test('同日晚到：晚于 09:30 才算，文案带「晚到 X」', () => {
  assert.equal(BRIEF_LATE_MIN, 30);
  // 09:30 整仍在按时一侧（判据是 > 30 分钟）
  assert.equal(briefTiming('2026-11-02', '2026-11-02T09:30:00+08:00', false).kind, 'on-time');
  assert.equal(briefTiming('2026-11-02', '2026-11-02T09:31:00+08:00', false).kind, 'late-same');
  // 实测：11-01 12:12（3h12m）、11-11 18:43（9h43m）、11-12 13:22（4h22m）
  const a = briefTiming('2026-11-01', '2026-11-01T12:12:00+08:00', false);
  assert.equal(a.kind, 'late-same');
  assert.equal(a.text, '12:12 生成 · 晚到 3 小时 12 分');
  const b = briefTiming('2026-11-11', '2026-11-11T18:43:31+08:00', false);
  assert.equal(b.text, '18:43 生成 · 晚到 9 小时 43 分');
  assert.equal(b.lateMin, 583);
  assert.equal(briefTiming('2026-11-12', '2026-11-12T13:22:02+08:00', false).text,
    '13:22 生成 · 晚到 4 小时 22 分');
});

test('跨日：必须带日期，且与「补写」分属不同档', () => {
  // 实测：11-14 的早报在 11-15 00:12:44 生成（912 分钟）
  const r = briefTiming('2026-11-14', '2026-11-15T00:12:44+08:00', false);
  assert.equal(r.kind, 'late-cross');
  assert.equal(r.text, '11-15 00:12 生成 · 跨日 晚到 15 小时 12 分');
  assert.equal(r.lateMin, 912);
  // 跨日但不足 1 小时（00:30 生成）：仍必须带日期，不能被「00:30」骗成当日凌晨
  const s = briefTiming('2026-11-14', '2026-11-15T00:30:00+08:00', false);
  assert.equal(s.kind, 'late-cross');
  assert.equal(s.text, '11-15 00:30 生成 · 跨日 晚到 15 小时 30 分');
});

test('补写：只说「补写于」，不写「晚到」', () => {
  const r = briefTiming('2026-10-30', '2026-11-15T00:51:59+08:00', true);
  assert.equal(r.kind, 'backfill');
  assert.equal(r.text, '补写于 11-15 00:51');
  assert.ok(!r.text.includes('晚到'), '补写不是迟到，不能出现「晚到」');
  // 补写优先于跨日：同一时刻不带补写章时是 late-cross，带上就是 backfill
  assert.equal(briefTiming('2026-10-30', '2026-11-15T00:51:59+08:00', false).kind, 'late-cross');
});

test('时区无关：同一瞬间用 Z 表示，文案不变', () => {
  const local = briefTiming('2026-11-14', '2026-11-15T00:12:44+08:00', false);
  const utc = briefTiming('2026-11-14', '2026-11-14T16:12:44Z', false);
  assert.equal(utc.text, local.text);
  assert.equal(utc.kind, 'late-cross');
});

test('异常输入：不可解析返回 null，不抛错', () => {
  assert.equal(briefTiming('2026-11-14', '', false), null);
  assert.equal(briefTiming('2026-11-14', 'not-a-date', false), null);
  assert.equal(bjStamp(''), '');
});

test('辅助：分钟数与补写时刻的格式化', () => {
  assert.equal(lateSpan(15), '15 分');
  assert.equal(lateSpan(60), '1 小时');
  assert.equal(lateSpan(912), '15 小时 12 分');
  assert.equal(bjStamp('2026-11-15T00:51:59+08:00'), '11-15 00:51');
});
