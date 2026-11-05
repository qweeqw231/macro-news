// tests/pbc-time.test.mjs
// 2.5.0：PBOC 详情页 URL 的 14 位时间戳解析（含畸形/缺失回退）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pbcTimeFromUrl } from '../src/pbc-time.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('合法 URL：解析真实时分并按 +08:00 输出', () => {
  const r = pbcTimeFromUrl('https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/2026110516262373524/index.html');
  assert.deepEqual(r, {
    ts: Math.floor(Date.parse('2026-11-05T16:26:23+08:00') / 1000),
    time: '2026-11-05T16:26:23.000+08:00',
    day: '2026-11-05',
  });
});

test('午夜边界：00:30 北京 = 前一个新闻日', () => {
  const r = pbcTimeFromUrl('/goutongjiaoliu/113456/113469/2026110500300000001/index.html');
  assert.equal(r.time, '2026-11-05T00:30:00.000+08:00');
  assert.equal(r.day, '2026-11-04');
});

test('畸形/缺失：返回 null，不抛错', () => {
  for (const url of [
    '',
    null,
    'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/2026130516262373524/index.html',
    'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/2026110525612373524/index.html',
    'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/2026110516262/index.html',
    'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/abc/index.html',
  ]) {
    assert.equal(pbcTimeFromUrl(url), null, String(url));
  }
});

test('sources.mjs 使用精确时间，解析失败回退到日期且不抛错', () => {
  const src = read('src/sources.mjs');
  assert.match(src, /pbcTimeFromUrl\(m\[1\]\)/);
  assert.match(src, /exact\s*\?\s*exact\.ts\s*:\s*fallbackTs/s);
  assert.match(src, /exact\s*\?\s*exact\.time\s*:\s*isoFromUnix\(ts\)/s);
  assert.match(src, /Number\.isFinite\(ts\)/);
});
