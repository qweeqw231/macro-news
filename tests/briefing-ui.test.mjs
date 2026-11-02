// tests/briefing-ui.test.mjs
// 静态校验：归档卡片「自动摘要」角标与页脚「早报 自动」提示只在 source=rule 时出现。
// 前端没有 DOM 测试环境，这里锁定条件本身，防止有人把角标误加到 AI 产物上。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'assets', 'style.css'), 'utf8');

test('归档角标：rule=自动摘要、draft=事实清单，ai 无角标', () => {
  assert.ok(
    APP.includes("if (d.source === 'rule') a.appendChild(el('span', 'day-tag', '自动摘要'));"),
    '缺少 rule 角标条件'
  );
  assert.ok(
    APP.includes("else if (d.source === 'draft') a.appendChild(el('span', 'day-tag', '事实清单'));"),
    '缺少 draft 角标条件'
  );
  assert.ok(!APP.includes("if (d.source === 'ai') a.appendChild(el('span', 'day-tag'"), 'AI 不应有角标');
  assert.ok(CSS.includes('.day-tag'), '缺少 .day-tag 样式');
});

test('页脚：rule=自动、draft=事实清单、awaiting=待写作/待发布', () => {
  assert.ok(APP.includes("bTxt = '早报 自动 ' +"), '缺少 rule 的「自动」提示');
  assert.ok(APP.includes("if (rec.source === 'rule')"), '缺少 rule 分支');
  assert.ok(APP.includes("bTxt = '早报 事实清单 ' +"), '缺少 draft 的「事实清单」提示');
  assert.ok(APP.includes("else if (rec.source === 'draft')"), '缺少 draft 分支');
  assert.ok(APP.includes("rec.stage === 'awaiting-publish' ? '早报 待发布' : '早报 待写作'"),
    '缺少 awaiting 分支');
  assert.ok(APP.includes("bLvl = 'warn'"), '降级提示应为暖棕（注意级）');
});
