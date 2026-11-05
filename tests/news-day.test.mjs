// tests/news-day.test.mjs
// 2.4.19：新闻日边界（北京 08:00 起算，等价 UTC 日期），锁死 TZ 无关性。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { newsDay, newsToday } from '../src/news-day.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const T = (s) => Date.parse(s);

test('边界：07:59:59 / 08:00:00 / 08:00:01', () => {
  assert.equal(newsDay(T('2026-11-04T23:59:59Z')), '2026-11-04');
  assert.equal(newsDay(T('2026-11-05T00:00:00Z')), '2026-11-05');
  assert.equal(newsDay(T('2026-11-05T00:00:01Z')), '2026-11-05');
});

test('09:30 官方发布、00:00 央行日期型时间戳、23:59', () => {
  assert.equal(newsDay(T('2026-11-05T01:30:00Z')), '2026-11-05'); // 北京 09:30
  assert.equal(newsDay(T('2026-11-04T16:00:00Z')), '2026-11-04'); // 北京 11-05 00:00
  assert.equal(newsDay(T('2026-11-05T15:59:59Z')), '2026-11-05'); // 北京 23:59
});

test('newsToday 与 newsDay(Date) 一致', () => {
  const now = T('2026-11-05T00:00:00Z');
  assert.equal(newsToday(now), '2026-11-05');
  assert.equal(newsDay(new Date(now)), '2026-11-05');
  assert.equal(newsDay('2026-11-05T00:00:00Z'), '2026-11-05');
  assert.equal(newsDay('not-a-date'), '');
});

test('TZ=UTC 与 TZ=Asia/Shanghai 结果完全相同', () => {
  const importUrl = pathToFileURL(path.join(ROOT, 'src', 'news-day.mjs')).href;
  const code = `import('${importUrl}').then(({ newsDay }) => {
    console.log([
      '2026-11-04T23:59:59Z',
      '2026-11-05T00:00:00Z',
      '2026-11-05T00:00:01Z',
      '2026-11-05T01:30:00Z',
      '2026-11-04T16:00:00Z',
      '2026-11-05T15:59:59Z',
    ].map((s) => newsDay(Date.parse(s))).join(','));
  });`;
  const run = (tz) => execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  }).trim();
  const utc = run('UTC');
  const shanghai = run('Asia/Shanghai');
  assert.equal(utc, shanghai);
  assert.equal(utc, '2026-11-04,2026-11-05,2026-11-05,2026-11-05,2026-11-04,2026-11-05');
});

test('实现不使用本地时区日期 API', () => {
  const src = read('assets/news-day.js');
  assert.doesNotMatch(src, /getFullYear|getMonth\(|getDate\(/);
  assert.match(src, /toISOString\(\)\.slice\(0, 10\)/);
});

test('所有新闻日调用点都走统一入口', () => {
  assert.match(read('src/collect.mjs'), /from '\.\/news-day\.mjs'/);
  assert.match(read('src/collect.mjs'), /newsDay\(it\.time \|\| startedAt\)/);
  assert.match(read('scripts/news-db/history-slice.mjs'), /ND\.newsDay\(n \* 1000\)/);
  assert.match(read('scripts/news-db/history-slice.mjs'), /ND\.newsToday\(now\)/);
  assert.match(read('src/snapshot.mjs'), /date: newsDay\(d\)/);
  assert.match(read('scripts/briefing/core.mjs'), /date: newsDay\(now\)/);
  assert.match(read('assets/app.js'), /MacroNewsDay\.newsDay/);
  assert.match(read('index.html'), /assets\/news-day\.js\?v=/);
  assert.doesNotMatch(read('src/collect.mjs'), /getFullYear\(\).*getMonth\(\).*getDate\(/s);
});
