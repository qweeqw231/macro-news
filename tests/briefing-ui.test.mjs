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

// 2.13.2：09:00 整点触发到状态落盘有几十秒~几分钟延迟，那段时间
// "无记录 + 无产物"是正常中间态。若直接判缺失，每天 09:00–09:03 会闪一次告警色。
// 这里锁定"宽限常量 + 宽限内的中性分支"，防止阈值散落或被改回硬编码。
test('页脚早报：09:00–09:10 为宽限期，仍用中性灰', () => {
  assert.match(APP, /const BRIEF_GRACE_MIN = 10;/, '缺少宽限常量');
  assert.match(APP, /const BRIEF_LATE_AT = BRIEF_AT \+ BRIEF_GRACE_MIN;/,
    '宽限阈值应单一来源（由 BRIEF_AT 派生），不得另行硬编码');
  assert.match(APP, /else if \(nowMin < BRIEF_LATE_AT\) \{[\s\S]{0,200}bTxt = '早报 生成中';\s*bLvl = 'mute';/,
    '09:00–09:10 应给中性「生成中」');
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

// 2.19.0：历史缺口与补写。
// 「昨天该有却没有」以前在页面上没有定义：读者只看到今天没早报，昨天的缺失是隐形的。
// 这里锁定四件事：制度起点由索引推导、缺口三判据、三种文案、归档卡片标签。
test('历史缺口：制度起点由索引推导，缺口只认「起点后 + 有新闻 + 无早报」', () => {
  assert.match(APP, /let briefEraDay = '';/, '缺少制度起点变量');
  assert.match(APP, /briefEraDay = list\.filter\(\(x\) => x\.hasBriefing\)\.map\(\(x\) => x\.day\)\.sort\(\)\[0\] \|\| '';/,
    '制度起点应取最早一份早报的日子');
  assert.match(APP, /d\.day < today && d\.day >= eraDay\s*\n?\s*&& Number\(d\.count\) > 0 && !d\.hasBriefing/,
    '缺口判据应为「今天之前 + 制度起点之后 + 有新闻 + 无早报」');
});

test('历史缺口：补写中 / 缺失 / 已补写 三种文案互斥且与今日 token 分开', () => {
  assert.match(APP, /gTxt = `早报 \$\{gapDay\} 补写中`;/);
  assert.match(APP, /gTxt = `早报 \$\{gapDay\} 缺失`;/);
  assert.match(APP, /gTxt = `早报 \$\{doneBackfill\.day\} 已补写 \$\{fmtTime\(doneBackfill\.at\)\}`;/);
  // 三种文案都挂在独立的 g 变量上，不得写进今日的 bTxt
  assert.ok(!/bTxt = `早报 \$\{gapDay\}/.test(APP), '历史缺口不能写进今日 token');
  // 已补写只报 48 小时内，避免永久噪音
  assert.match(APP, /ageMin > 48 \* 60/, '已补写应限制在 48 小时内展示');
});

test('历史缺口：归档卡片区分「补写」与「缺早报」，并透传索引字段', () => {
  assert.match(APP, /briefBackfill: !!base\.briefBackfill,/,
    '索引的 briefBackfill 必须透传到卡片数据');
  assert.match(APP, /if \(d\.briefBackfill\) a\.appendChild\(el\('span', 'day-tag backfill', '补写'\)\);/,
    '补写过的日子应有「补写」标签');
  assert.match(APP, /el\('span', 'day-tag backfill', '缺早报'\)/,
    '该有却没有的日子应有「缺早报」标签');
  assert.ok(CSS.includes('.day-tag.backfill'), '缺少补写标签样式');
});
