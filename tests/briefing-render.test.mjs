// tests/briefing-render.test.mjs
// 2.4.3：归档早报折叠去重、全文渲染、按需加载、失败重试、缺字段降级。
// 只读源码；不联网、不写盘。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'assets', 'style.css'), 'utf8');

test('展开后摘要替换为中性信息，收起时恢复 briefLine', () => {
  assert.match(APP, /det\.dataset\.brief = briefLine/);
  assert.match(APP, /sum\.textContent = meta/);
  assert.match(APP, /sum\.textContent = det\.dataset\.brief/);
  assert.match(APP, /function briefMetaText/);
  assert.match(APP, /当日早报\$\{n \? ' · ' \+ n \+ ' 条' : ''\}/);
  assert.match(APP, /brief-loaded/);
});

test('全文渲染：overview → items → watch，含 rank/title/summary/why/source/url/refs', () => {
  assert.match(APP, /renderBriefItems/);
  assert.match(APP, /'brief-items'/);
  assert.match(APP, /it\.title/);
  assert.match(APP, /it\.summary/);
  assert.match(APP, /为什么重要：/);
  assert.match(APP, /it\.refs/);
  assert.match(APP, /'观察项'/);
  // 顺序：loadBriefing 内部 overview 先于 items
  const seg = APP.slice(APP.indexOf('async function loadBriefing'));
  assert.ok(
    seg.indexOf("body.appendChild(el('p', 'brief-overview'") < seg.indexOf('renderBriefItems(body, items)')
  );
});

test('按需加载：只在展开时取 briefings，历史 default / 当日 no-store', () => {
  assert.match(APP, /if \(det\.open\) \{\s*loadBriefing\(d\.day, body\)/);
  assert.match(APP, /today \? 'no-store' : 'default'/);
  // 首屏/归档索引不得出现 briefings 预取
  assert.ok(!/loadIndex[\s\S]{0,200}briefings/.test(APP));
});

test('失败态：显示错误并给重试按钮，不写 loaded', () => {
  assert.match(APP, /早报载入失败：/);
  assert.match(APP, /const retry = el\('button', 'mchip', '重试'\)/);
  assert.match(APP, /delete body\.dataset\.loaded/);
});

test('缺字段降级：提示正文缺失并保留摘要，不伪造', () => {
  assert.match(APP, /该日早报正文缺失（只有摘要）/);
  assert.match(APP, /det\.dataset\.brief/);
});

test('排版层级：摘要小字、overview 大字；窄屏可断行', () => {
  assert.match(CSS, /\.day-brief\.brief-loaded summary \{ color: var\(--ink-faint\); font-size: 0\.72rem; \}/);
  assert.match(CSS, /\.brief-overview \{[\s\S]*?font-size: 0\.95rem/);
  assert.match(CSS, /\.brief-item-title, \.brief-item-summary, \.brief-why, \.brief-refs \{[\s\S]*?overflow-wrap: anywhere/);
});
