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

// 2.13.1：早报状态按「时间 × 状态」分层判定。
// 起因：11-11 早报 09:00 没触发、人工补跑后页脚仍写「早报 未记录」——
//   ① 09:00 前本来就没有当日早报，却被当成缺失（旧逻辑 09:30 前干脆什么都不显示）；
//   ② 状态文件用 HTTP 缓存读，补跑后的新状态要等 max-age=600 才看得到。
// 前端没有 DOM 测试环境，这里锁定分支形状与读取方式，防止退回旧行为。
test('页脚早报：09:00 前为中性提示，09:00 后才是「今日未生成」', () => {
  assert.ok(!APP.includes('早报 未记录'), '不应再出现「未记录」这种缺失语气');
  assert.match(APP, /const BRIEF_AT = 9 \* 60;/, '缺少 09:00 运行时刻常量');
  assert.match(APP, /else if \(nowMin < BRIEF_AT\) \{[\s\S]{0,200}bTxt = '早报 今日 09:00 后生成'/,
    '09:00 前应给中性提示');
  assert.match(APP, /bTxt = '早报 今日 09:00 后生成';\s*bLvl = 'mute';/,
    '09:00 前不得使用告警色');
  assert.match(APP, /bTxt = '早报 今日未生成';\s*bLvl = 'warn';/,
    '09:00 后无早报应明确提示未生成');
});

test('页脚早报：有产物（index.json hasBriefing）即视为已生成', () => {
  assert.match(APP, /const hasArtifact = !!\(artDay && artDay\.hasBriefing\);/,
    '缺少归档索引的产物证据');
  assert.match(APP, /else if \(hasArtifact\) \{[\s\S]{0,120}bTxt = '早报 已生成';\s*bLvl = 'ok';/,
    '有产物时不应落到「未生成」');
});

test('页脚早报：状态文件不吃 HTTP 缓存（补跑后刷新即可见）', () => {
  assert.ok(APP.includes("jget('_briefing-status.json')"),
    '读取 _briefing-status.json 必须走 no-store（默认），不能传 default');
  assert.ok(!APP.includes("jget('_briefing-status.json', 'default')"), '不应再使用 HTTP 缓存');
  assert.ok(CSS.includes('.ft-state.mute'), '缺少中性态（mute）样式');
});
