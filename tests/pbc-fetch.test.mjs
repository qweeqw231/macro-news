// tests/pbc-fetch.test.mjs
// 2.5.1：PBOC 专用 IPv4 HTTPS 取数、降级路径与错误码采集。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { httpsGetText, fetchPbcHtml } from '../src/sources.mjs';
import { describeSourceError } from '../src/source-error.mjs';

const URL_PBC = 'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html';

function fakeRequest(handler) {
  const req = new EventEmitter();
  req.destroy = (err) => { if (err) req.emit('error', err); };
  req.end = () => handler(req);
  return req;
}

function fakeResponse(statusCode, body) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.setEncoding = () => {};
  res.resume = () => {};
  process.nextTick(() => {
    if (body != null) res.emit('data', body);
    res.emit('end');
  });
  return res;
}

test('httpsGetText：强制 family:4、冷连接，并保留 UA/Referer 与 25s 超时', async () => {
  let opts;
  const text = await httpsGetText(URL_PBC, {
    headers: { Referer: 'https://www.pbc.gov.cn/' },
    timeout: 25000,
    _request: (o, cb) => {
      opts = o;
      return fakeRequest(() => cb(fakeResponse(200, '<html>ok</html>')));
    },
  });

  assert.equal(text, '<html>ok</html>');
  assert.equal(opts.family, 4, '必须走 IPv4 单地址路径');
  assert.equal(opts.agent, false, '必须是冷连接，不能复用连接池');
  assert.equal(opts.servername, 'www.pbc.gov.cn');
  assert.equal(opts.timeout, 25000);
  assert.match(opts.headers['User-Agent'], /Chrome\/122/);
  assert.equal(opts.headers.Referer, 'https://www.pbc.gov.cn/');
});

test('httpsGetText：非 2xx 抛 HTTP 状态，且不返回正文', async () => {
  await assert.rejects(
    httpsGetText(URL_PBC, {
      _request: (o, cb) => fakeRequest(() => cb(fakeResponse(403, 'blocked'))),
    }),
    /HTTP 403/
  );
});

test('httpsGetText：连接错误保留 code，describeSourceError 仍能采集', async () => {
  const socketErr = Object.assign(new Error('connect ETIMEDOUT 27.148.154.33:443'), {
    code: 'ETIMEDOUT',
    syscall: 'connect',
  });
  await assert.rejects(
    httpsGetText(URL_PBC, {
      _request: () => fakeRequest((req) => {
        process.nextTick(() => req.emit('error', socketErr));
      }),
    }),
    (err) => err === socketErr
  );
  assert.deepEqual(describeSourceError(socketErr), {
    causeCode: 'ETIMEDOUT',
    causeMessage: 'connect ETIMEDOUT 27.148.154.33:443',
  });
});

test('fetchPbcHtml：首轮 IPv4 失败时，在既有预算内降级到默认 fetch', async () => {
  const calls = [];
  const text = await fetchPbcHtml(URL_PBC, {
    retries: 1,
    _httpsGet: async () => { calls.push('https'); throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }); },
    _fetchOnce: async () => { calls.push('fetch'); return 'fallback-ok'; },
  });

  assert.equal(text, 'fallback-ok');
  assert.deepEqual(calls, ['https', 'fetch'], '只允许 HTTPS + 一次降级，不能多试一轮');
});

test('fetchPbcHtml：降级也失败时最多 2 次尝试，并抛出最后一次错误', async () => {
  const calls = [];
  const first = Object.assign(new Error('https failed'), { code: 'ETIMEDOUT' });
  const second = Object.assign(new Error('fetch failed'), { code: 'ENETUNREACH' });

  await assert.rejects(
    fetchPbcHtml(URL_PBC, {
      retries: 1,
      _httpsGet: async () => { calls.push('https'); throw first; },
      _fetchOnce: async () => { calls.push('fetch'); throw second; },
    }),
    (err) => err === second
  );
  assert.deepEqual(calls, ['https', 'fetch']);
  assert.equal(calls.length, 2, '不能超过原 retries:1 的 2 次预算');
});
