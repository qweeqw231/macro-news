// tests/stats-range.test.mjs
// 2.13.7：统计局 RSS 限长读取（Range）+ 错误 cause 透传。
//
// 背景：该站 RSS 是 500 条 / 4.5 MB 未压缩全文，云端单轮中位 22.7s、p90 48.5s，
// 紧贴 30s 单次预算。线上 27% 的成功轮落在 24-30s 临界带，另有 14 次拉到一半被断，
// 表现为 3-8 秒就 `fetch failed`（连带 causeCode 因旧实现丢 cause 而永远为空）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rssSource } from '../src/sources.mjs';
import { describeSourceError } from '../src/source-error.mjs';

const URL_STATS = 'https://www.stats.gov.cn/sj/zxfb/rss.xml';
const MAX_BYTES = 393216;

const item = (n, { complete = true } = {}) => `<item>
  <title><![CDATA[第${n}条发布]]></title>
  <channel>数据发布</channel>
  <link>https://www.stats.gov.cn/sj/zxfb/202611/t2026110${n}_196579${n}.html</link>
  <pubDate>2026-11-0${n} 09:30:00</pubDate>
  <description><![CDATA[第${n}条正文]]></description>
  ${complete ? '</item>' : ''}`;

const feed = (items, { close = true } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>数据发布</title>
${items.join('\n')}
${close ? '</channel></rss>' : ''}`;

/** 替换全局 fetch，返回捕获到的请求参数；用完必须 restore */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const respond = (body, status) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
  json: async () => JSON.parse(body),
});

const makeSource = (extra = {}) => rssSource({
  name: '国家统计局',
  channel: '官方数据',
  url: URL_STATS,
  limit: 25,
  timeout: 30000,
  retries: 1,
  maxBytes: MAX_BYTES,
  tz: 'Asia/Shanghai',
  ...extra,
});

test('Range：386KB 上限以 Range 请求头发送，UA 与 30s 超时不变', async () => {
  const stub = stubFetch(() => respond(feed([item(1)]), 200));
  try {
    await makeSource()();
    assert.equal(stub.calls.length, 1);
    const { init } = stub.calls[0];
    assert.equal(init.headers.Range, 'bytes=0-393215', '384KB ⇒ 末字节 393215');
    assert.match(init.headers['User-Agent'], /Chrome\/122/, '必须保留原 UA');
    assert.equal(init.headers.Referer, undefined, '该源本来就不带 Referer，不要新增');
  } finally {
    stub.restore();
  }
});

test('206 分支：正常解析，截断的最后一条被丢弃，不产出半条记录', async () => {
  // 第 3 条缺 </item>，模拟 Range 把它截在半路
  const body = feed([item(1), item(2), item(3, { complete: false })], { close: false });
  const stub = stubFetch(() => respond(body, 206));
  try {
    const items = await makeSource()();
    assert.deepEqual(items.map((i) => i.title), ['第1条发布', '第2条发布']);
    assert.equal(items.length, 2, '残条必须被丢掉');
    assert.ok(items.every((i) => i.url.endsWith('.html')), '不能出现空链接的半条');
  } finally {
    stub.restore();
  }
});

test('206 分支：连一条完整 item 都没有时按「无可解析条目」失败，而不是当成功返回 0 条', async () => {
  const body = '<rss><channel>' + item(1, { complete: false });
  const stub = stubFetch(() => respond(body, 206));
  try {
    await assert.rejects(makeSource({ retries: 0 })(), /无可解析条目/);
  } finally {
    stub.restore();
  }
});

test('200 回退：站点忽略 Range 时按全文解析，不报错、末条保留', async () => {
  const body = feed([item(1), item(2), item(3)]);
  const stub = stubFetch(() => respond(body, 200));
  try {
    const items = await makeSource()();
    assert.equal(items.length, 3, '200 全文不能被截断逻辑误伤');
    assert.deepEqual(items.map((i) => i.title), ['第1条发布', '第2条发布', '第3条发布']);
    assert.ok(items[2].ts > 0, '末条时间要正常解析（北京时间 +08:00）');
    // 北京时间 2026-11-03 09:30 ⇒ UTC 01:30
    assert.equal(new Date(items[2].time).toISOString(), '2026-11-03T01:30:00.000Z');
  } finally {
    stub.restore();
  }
});

test('cause 透传：底层 code 写进消息，且 describeSourceError 能取到 causeCode', async () => {
  const fetchErr = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });
  const stub = stubFetch(() => { throw fetchErr; });
  try {
    let thrown;
    try {
      await makeSource({ retries: 0 })();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, '必须抛错');
    assert.match(thrown.message, /RSS 全部入口失败：\/sj\/zxfb\/rss\.xml → fetch failed（ECONNRESET）/);
    assert.equal(thrown.cause, fetchErr, '原始错误必须作为 cause 保留');
    assert.deepEqual(describeSourceError(thrown), {
      causeCode: 'ECONNRESET',
      causeMessage: 'read ECONNRESET',
    });
  } finally {
    stub.restore();
  }
});

test('cause 透传：多层嵌套（fetcher → cause → AggregateError.errors）也能取到 code', async () => {
  const inner = Object.assign(new Error('connect ETIMEDOUT 219.153.112.95:443'), { code: 'ETIMEDOUT' });
  const agg = Object.assign(new Error('aggregate'), { errors: [inner] });
  const stub = stubFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: agg }); });
  try {
    await assert.rejects(makeSource({ retries: 0 })(), (err) => {
      assert.equal(describeSourceError(err).causeCode, 'ETIMEDOUT');
      return true;
    });
  } finally {
    stub.restore();
  }
});

test('重试预算不变：retries:1 ⇒ 传输失败时最多 2 次尝试，且每次都带 Range', async () => {
  const stub = stubFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }); });
  try {
    await assert.rejects(makeSource()(), /fetch failed（ECONNRESET）/);
    assert.equal(stub.calls.length, 2, '不能超过原有 2 次尝试预算');
    assert.ok(stub.calls.every((c) => c.init.headers.Range === 'bytes=0-393215'));
  } finally {
    stub.restore();
  }
});

test('「无可解析条目」不消耗重试预算：这是站点内容问题，不是传输抖动', async () => {
  const stub = stubFetch(() => respond('<rss><channel></channel></rss>', 206));
  try {
    await assert.rejects(makeSource()(), /无可解析条目/);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('未配置 maxBytes 的 RSS 源不会发出 Range 头（改动不影响其它源）', async () => {
  const stub = stubFetch(() => respond(feed([item(1)]), 200));
  try {
    const src = rssSource({ name: '美联储', channel: '政策/利率', url: URL_STATS, retries: 0 });
    await src();
    assert.equal(stub.calls[0].init.headers.Range, undefined);
  } finally {
    stub.restore();
  }
});
