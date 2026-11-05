// tests/search-window.test.mjs
// 2.4.19：search.json 62 天窗口 + 去摘要字段。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchCutoff, inSearchWindow, compactSearchItem, SEARCH_WINDOW_DAYS } from '../src/search-window.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const NOW = Date.parse('2026-11-05T00:00:00Z');

test('窗口：今天 + 前 61 天，第 63 天淘汰', () => {
  assert.equal(SEARCH_WINDOW_DAYS, 62);
  assert.equal(searchCutoff(NOW), '2026-09-05');
  assert.equal(inSearchWindow('2026-11-05', NOW), true);
  assert.equal(inSearchWindow('2026-09-05', NOW), true);
  assert.equal(inSearchWindow('2026-09-04', NOW), false);
});

test('compactSearchItem 只留 6 个字段，不含 summary/channel', () => {
  const full = {
    id: 'a', ts: 1, time: '2026-11-05T01:00:00+08:00', source: '央行',
    channel: '全球', title: '标题', summary: '摘要'.repeat(200), url: 'https://x',
    content: '正文', kind: 'news',
  };
  const out = compactSearchItem(full);
  assert.deepEqual(Object.keys(out).sort(), ['id', 'source', 'time', 'title', 'ts', 'url']);
  assert.equal(out.title, '标题');
  assert.equal(out.summary, undefined);
  assert.equal(out.channel, undefined);
});

test('collect 按窗口 break，并使用 compactSearchItem', () => {
  const src = read('src/collect.mjs');
  assert.match(src, /searchCutoff\(startedAt\.getTime\(\)\)/);
  assert.match(src, /if \(day < searchFrom\) break;/);
  assert.match(src, /compactSearchItem\(it\)/);
  assert.match(src, /windowDays: SEARCH_WINDOW_DAYS/);
});

test('前端 Fuse 不再索引 summary/channel', () => {
  const app = read('assets/app.js');
  const fuse = app.slice(app.indexOf('new window.Fuse'), app.indexOf('return S.searchIdx'));
  assert.doesNotMatch(fuse, /name: 'summary'/);
  assert.doesNotMatch(fuse, /name: 'channel'/);
  assert.match(fuse, /name: 'title', weight: 0\.8/);
});
