// tests/briefing-metadata.test.mjs
// 2.2.3：两份历史 AI 早报只追加 source 元数据，正文内容不得变化。
// 只读仓库文件、不写盘、不联网。
//
// 校验方式：读取文件 → 删除 source → 按原键序 JSON.stringify → sha256 前 16 位，
// 必须等于「只加字段之前」记录下来的内容哈希。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED = {
  '2026-11-01': '2803aca01da6dd5c',
  '2026-11-02': '889ee8f573018a7c',
};

const contentHash = (obj) => {
  const o = JSON.parse(JSON.stringify(obj));
  delete o.source;
  return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
};

test('两份 AI 早报已带 source=ai，剔除后内容哈希与原文一致', () => {
  for (const [day, want] of Object.entries(EXPECTED)) {
    const file = path.join(ROOT, 'data', 'briefings', `${day}.json`);
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(obj.source, 'ai', `${day} 缺少 source=ai`);
    assert.equal(obj.items.length, 10, `${day} 条数被改动`);
    assert.equal(obj.watch.length, 2, `${day} watch 被改动`);
    assert.ok(obj.generatedAt, `${day} generatedAt 丢了`);
    assert.equal(contentHash(obj), want, `${day} 剔除 source 后内容哈希不一致`);
  }
});
