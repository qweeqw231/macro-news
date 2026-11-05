// tests/footer-source-ratio.test.mjs
// 2.5.0：页脚 x/y 的语义必须是“成功源数/总源数 = 源正常”。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('页脚 x/y 文案为“源正常”，且不再出现“源失败”', () => {
  const src = read('assets/app.js');
  assert.match(src, /`\$\{srcs\.length - srcBad\.length\}\/\$\{srcs\.length\} 源正常`/);
  assert.doesNotMatch(src, /srcs\.length - srcBad\.length\}\/\$\{srcs\.length\} 源失败/);
  // 悬停标题仍逐源列出失败原因，语义未被破坏
  assert.match(src, /srcBad\.forEach\(\(s\) => why\.push\(`\$\{s\.label\}/);
});

test('2.4.17 验收描述同步为“7/8 源正常”', () => {
  const doc = read('docs/superpowers/specs/2026-11-05-local-sync-visibility-2.4.17-design.md');
  assert.match(doc, /7\/8 源正常/);
  assert.doesNotMatch(doc, /7\/8 源失败/);
});
