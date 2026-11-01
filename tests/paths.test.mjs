// tests/paths.test.mjs
// 离线回归：文件名大小写冲突。
//
// 背景（2026-10-30 事故）：分钟 K 的 `<key>_1m.json` 与月 K 的 `<key>_1M.json`
// 只差一个字母的大小写，**Windows 与 GitHub Pages 都会折叠成同一个名字**，
// 结果 6 个标的的月 K 被 1 分钟数据覆盖。修法是分钟文件一律放 data/kline/min/。
//
// 这里把当时的「自查方法」固化成测试：data/ 下任意两个条目（文件或目录）折叠成小写后
// 不允许重名。运行：node --test tests

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

/** 递归列出 data/ 下所有条目（文件 + 目录）的相对路径 */
function walk(dir, base = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    out.push(rel);
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
  }
  return out;
}

test('data/ 下没有仅大小写不同的条目（Windows / Pages 会折叠成同一个名字）', () => {
  const seen = new Map();
  const clash = [];
  for (const rel of walk(DATA)) {
    const low = rel.toLowerCase();
    if (seen.has(low)) clash.push(`${seen.get(low)} ↔ ${rel}`);
    else seen.set(low, rel);
  }
  assert.deepEqual(clash, [], `发现大小写重名：\n${clash.join('\n')}`);
});

test('分钟 K 不得直接放 data/kline/（<key>_1m 与 <key>_1M 在 Windows 同名）', () => {
  const top = readdirSync(path.join(DATA, 'kline'));
  // 注意这里必须**区分大小写**：`_1M.json` 是月 K，`_1m.json` 才是分钟 K
  const minuteInTop = top.filter((f) => f.endsWith('_1m.json'));
  assert.deepEqual(minuteInTop, [], `这些分钟文件应移到 data/kline/min/：${minuteInTop.join('、')}`);

  // 顶层的月 K 仍然在（放错目录时它们会被 1 分钟数据覆盖，这里顺便确认没被误删）
  const monthInTop = top.filter((f) => f.endsWith('_1M.json'));
  assert.ok(monthInTop.length > 0, 'data/kline/ 下应该有月 K 文件');
});
