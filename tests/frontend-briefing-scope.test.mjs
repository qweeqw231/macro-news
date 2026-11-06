// tests/frontend-briefing-scope.test.mjs
// 2.5.2：早报正文渲染路径不能引用未声明的辅助函数。
// 背景：2.4.18 把 app.js 里的 beijingDay 重命名为 newsDay，漏改了 getBriefing 里的一处调用，
// 导致归档页每次展开早报都抛 `beijingDay is not defined`，早报正文完全不展示；
// 而单测只覆盖 Node 侧逻辑，页面没有任何静态检查能发现这类「改了声明、漏了调用」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('前端资源里不再残留已改名的 beijingDay', () => {
  const dir = path.join(ROOT, 'assets');
  const offenders = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /\bbeijingDay\b/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(offenders, [], `这些前端脚本仍引用 beijingDay：${offenders.join(', ')}`);
});

test('app.js 里 `day === X()` 的 X 必须在同一文件有声明', () => {
  const src = read('assets/app.js');
  const used = new Set();
  for (const m of src.matchAll(/\bday === ([A-Za-z_$][\w$]*)\(\)/g)) used.add(m[1]);
  assert.ok(used.size > 0, '没有匹配到 `day === X()` 形式的判断，断言失效');
  for (const name of used) {
    const declared = new RegExp(`(?:const|let|var|function)\\s+${name}\\b`).test(src);
    assert.ok(declared, `app.js 使用了 ${name}() 但没有声明`);
  }
});

test('getBriefing 的「今天」判断走 newsDay()', () => {
  const src = read('assets/app.js');
  const fn = src.slice(src.indexOf('function getBriefing('), src.indexOf('function getBriefing(') + 400);
  assert.match(fn, /const today = day === newsDay\(\);/);
});
