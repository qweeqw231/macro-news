// tests/published-at.test.mjs
// 离线回归：新闻库 published_at 的时区归一化。
//
// 背景（2026-11-01 早报实测）：库里 published_at 的写法是混的 ——
// 本地采集写 `+08:00`，部分回填/接口给的是以 `Z` 结尾的 UTC。
// 直接 `slice(0, 16)` 展示会让 UTC 行整体差 8 小时（跨零点还会差一天）。
//
// 运行：node --test tests

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublishedAt } from '../scripts/news-db/db.mjs';

test('Z 结尾的 UTC 按 +8 小时换算', () => {
  assert.equal(normalizePublishedAt('2026-11-01T07:40:57Z'), '2026-11-01T15:40:57+08:00');
});

test('已经是 +08:00 的原样保留（毫秒被裁掉）', () => {
  assert.equal(
    normalizePublishedAt('2026-11-01T15:40:57.000+08:00'),
    '2026-11-01T15:40:57+08:00'
  );
  assert.equal(normalizePublishedAt('2026-11-01T15:40:57+08:00'), '2026-11-01T15:40:57+08:00');
});

test('UTC 跨零点换算后日期跟着变', () => {
  // 北京 11-02 01:30 = UTC 11-01 17:30
  assert.equal(normalizePublishedAt('2026-11-01T17:30:00Z'), '2026-11-02T01:30:00+08:00');
});

test('只有年月日的按当天 00:00（北京）', () => {
  assert.equal(normalizePublishedAt('2026-11-01'), '2026-11-01T00:00:00+08:00');
});

test('空值与非法值返回空串，不抛错', () => {
  assert.equal(normalizePublishedAt(''), '');
  assert.equal(normalizePublishedAt(null), '');
  assert.equal(normalizePublishedAt('not-a-date'), '');
});
