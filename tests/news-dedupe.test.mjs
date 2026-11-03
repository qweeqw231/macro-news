// tests/news-dedupe.test.mjs
// 2.4.5：同一条新闻被多频道收录时的合并规则。
// 纯函数；覆盖真实事故（华尔街见闻同一快讯两个 id/两个频道）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedupeItems, normalizeUrl, normalizeText, channelRank } from '../src/news-dedupe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLLECT = fs.readFileSync(path.join(ROOT, 'src', 'collect.mjs'), 'utf8');

const TS = 1793685758;
const TEXT_A = '科创50跌超5%，创业板指跌近3%，算力硬件、算力芯片股持续下挫，深南电路、景旺电子、光迅科技午后跌停，寒武纪、沐曦股份、天孚通信、中际旭创等多股跌超10%。';
const TEXT_B = '科创50跌超5%，创业板指跌近3%，算力硬件股持续下挫，深南电路、景旺电子、光迅科技午后跌停，蘅东光跌超23%，杰普特、联特科技、长芯博创、光库科技、天孚通信、中际旭创、联讯仪器等十余股跌超10%。';

function wscn(id, channel, text) {
  // 实测：同一版本在「全球」是 3193103、「A股」是 3193102；改写后的版本复用同一 URL
  const liveId = channel === 'A股' ? 3193102 : 3193103;
  return {
    id,
    ts: TS,
    time: '2026-11-03T14:02:38.000+08:00',
    source: '华尔街见闻',
    channel,
    title: text.slice(0, 40),
    summary: '',
    content: text,
    url: `https://wallstreetcn.com/livenews/${liveId}`,
    kind: 'news',
  };
}

test('真实事故：同文两个 id、A股/全球双频道 ⇒ 只留一条且归 A股', () => {
  const global = wscn('1ph482g', '全球', TEXT_A);
  const aStock = wscn('1wlvxal', 'A股', TEXT_A);
  const out = dedupeItems([global, aStock]);
  assert.equal(out.length, 1);
  assert.equal(out[0].channel, 'A股');
  assert.equal(out[0].id, '1wlvxal');
});

test('同文被改写后再发（简版 + 完整版，四个条目）⇒ 合并成完整版一条', () => {
  const items = [
    wscn('1ph482g', '全球', TEXT_A),
    wscn('1wlvxal', 'A股', TEXT_A),
    wscn('2lde1x', '全球', TEXT_B),
    wscn('ksq44s', 'A股', TEXT_B),
  ];
  const out = dedupeItems(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].channel, 'A股');
  assert.equal(out[0].content, TEXT_B, '保留信息更全的完整版');
});

test('同一 URL 不同标题 ⇒ 合并为一条', () => {
  const a = { id: 'a', ts: TS, source: 'A', channel: '全球', title: '标题一', content: '正文一', url: 'https://x.com/p/1?utm_source=rss' };
  const b = { id: 'b', ts: TS, source: 'B', channel: '中国', title: '标题二', content: '正文二', url: 'https://x.com/p/1/' };
  const out = dedupeItems([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].channel, '中国');
});

test('不同正文、不同时间 ⇒ 不误合并', () => {
  const a = { id: 'a', ts: TS, source: 'S', channel: '全球', title: '甲', content: '甲文', url: 'https://x.com/1' };
  const b = { id: 'b', ts: TS + 60, source: 'S', channel: '全球', title: '甲', content: '甲文', url: 'https://x.com/2' };
  assert.equal(dedupeItems([a, b]).length, 2);
  const c = { id: 'c', ts: TS, source: 'S', channel: '全球', title: '乙', content: '乙文', url: 'https://x.com/3' };
  assert.equal(dedupeItems([a, c]).length, 2);
});

test('非重复项顺序不变；空数组安全', () => {
  const a = { id: 'a', ts: TS, source: 'S1', channel: 'A股', title: 'A', content: 'A', url: 'https://x.com/a' };
  const b = { id: 'b', ts: TS, source: 'S2', channel: '全球', title: 'B', content: 'B', url: 'https://x.com/b' };
  const out = dedupeItems([a, b]);
  assert.deepEqual(out.map((x) => x.id), ['a', 'b']);
  assert.deepEqual(dedupeItems([]), []);
  assert.deepEqual(dedupeItems(null), []);
});

test('频道优先级：A股/中国 > 国内财经 > 外汇/大宗/美股 > 全球', () => {
  assert.equal(channelRank('A股'), 0);
  assert.equal(channelRank('中国'), 0);
  assert.equal(channelRank('国内财经'), 1);
  assert.equal(channelRank('美股'), 2);
  assert.equal(channelRank('全球'), 3);
  assert.equal(channelRank('未知'), 1.5);
});

test('URL 归一化：去追踪参数与末尾斜杠；保留业务参数', () => {
  assert.equal(normalizeUrl('https://x.com/p/1/?utm_source=rss#top'), 'https://x.com/p/1');
  assert.equal(normalizeUrl('https://x.com/a?id=123'), 'https://x.com/a?id=123');
  assert.equal(normalizeUrl(''), null);
});

test('文本归一化：空白与标点不算差异', () => {
  assert.equal(normalizeText('科创50 跌超5%，创业板指跌近3%'), normalizeText('科创50跌超5%,创业板指跌近3%。'));
});

test('collect 源码锁定：合并候选与写归档两处都调用 dedupeItems', () => {
  assert.match(COLLECT, /import \{ dedupeItems \} from '\.\/news-dedupe\.mjs'/);
  assert.match(COLLECT, /const fresh = dedupeItems\(\[\.\.\.merged\.values\(\)\]\)/);
  assert.match(COLLECT, /dedupeItems\(\[\.\.\.items, \.\.\.existing\.items\]\)/);
});
