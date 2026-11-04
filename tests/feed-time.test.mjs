// tests/feed-time.test.mjs
// 2.4.8：RSS 时间解析不得依赖 runner 的本地时区。
//
// 事故：国家统计局 pubDate = `2026-11-04 09:30:00`（北京时间、无时区）。
// 云端 Actions 的 TZ=UTC 会把它当成 09:30Z，前端再 +8 显示成 17:30。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeedDate } from '../src/sources.mjs';
import { parseNbsPubDate, nbsFixMs } from '../scripts/repair-nbs-time.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = fs.readFileSync(path.join(ROOT, 'src', 'sources.mjs'), 'utf8');

test('国家统计局无时区 pubDate：必须按北京时间解释（09:30 → 01:30Z）', () => {
  const ms = parseFeedDate('2026-11-04 09:30:00', 'Asia/Shanghai');
  assert.equal(ms, Date.parse('2026-11-04T09:30:00+08:00'));
  assert.equal(new Date(ms).toISOString(), '2026-11-04T01:30:00.000Z');
});

test('同一字符串在 UTC runner 下也不得偏移（显式传入来源时区）', () => {
  // 不依赖 process.env.TZ；tz 参数直接决定换算
  assert.equal(parseFeedDate('2026-11-04 09:30:00', 'UTC'), Date.parse('2026-11-04T09:30:00Z'));
  assert.equal(parseFeedDate('2026-11-04 09:30:00', 'Asia/Shanghai'), Date.parse('2026-11-04T01:30:00Z'));
});

test('带显式时区的时间戳必须原样解析：+0800 / GMT / Z', () => {
  const cn = 'Wed, 4 Nov 2026 11:17:53 +0800';
  assert.equal(parseFeedDate(cn, 'Asia/Shanghai'), Date.parse(cn));
  assert.equal(new Date(parseFeedDate(cn)).toISOString(), '2026-11-04T03:17:53.000Z');

  const gmt = 'Thu, 29 Oct 2026 20:30:00 GMT';
  assert.equal(parseFeedDate(gmt), Date.parse(gmt));
  assert.equal(new Date(parseFeedDate(gmt)).toISOString(), '2026-10-29T20:30:00.000Z');

  const z = '2026-11-04T09:30:00Z';
  assert.equal(parseFeedDate(z), Date.parse(z));
});

test('空值/非法值安全返回 null', () => {
  assert.equal(parseFeedDate(''), null);
  assert.equal(parseFeedDate(null), null);
  assert.equal(parseFeedDate('not-a-date'), null);
});

test('历史回填只认「约 +480 分钟」：-720/0/其它一律不动', () => {
  const html = '<meta name="PubDate" content="2026/11/04 09:30">';
  const actual = parseNbsPubDate(html);
  assert.equal(actual, Date.parse('2026-11-04T09:30:00+08:00'));
  assert.equal(nbsFixMs(actual + 480 * 60 * 1000, actual), actual, '+8h 才修');
  assert.equal(nbsFixMs(actual + 480 * 60 * 1000 + 6000, actual), actual + 6000, '允许 RSS 秒差，保留秒');
  assert.equal(nbsFixMs(actual - 720 * 60 * 1000, actual), null, '-12h 不动');
  assert.equal(nbsFixMs(actual, actual), null, '已正确不动');
  assert.equal(nbsFixMs(actual + 483 * 60 * 1000, actual), null, '超过 ±2 分钟不猜');
  assert.equal(parseNbsPubDate('<html></html>'), null);
});

test('sources 源码锁定：rssSource 用 parseFeedDate，国家统计局显式 tz', () => {
  assert.match(SOURCES, /function rssSource\(\{ name, channel, url, urls, limit = 30, tag = '', timeout = 15000, retries = 0, tz = DEFAULT_FEED_TZ \}\)/);
  assert.match(SOURCES, /const ms = parseFeedDate\(i\.date, tz\)/);
  assert.ok(!/const d = new Date\(i\.date\)/.test(SOURCES), '不得再用进程时区解析 RSS 日期');
  assert.match(SOURCES, /name: '国家统计局',[\s\S]{0,400}tz: 'Asia\/Shanghai'/);
});
