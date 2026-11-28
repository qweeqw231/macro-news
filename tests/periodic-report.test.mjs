// tests/periodic-report.test.mjs
// 3.0.0：周期报告（周报 / 月报 / 年报）——契约与归档页接入的静态校验。
// 前端是浏览器 IIFE，node 侧没有 DOM；这里锁定契约字段、降级分支与渲染复用，
// 防止以后又给周期报告另造一套条目结构，或把缺数据变成报错/空白。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'assets', 'style.css'), 'utf8');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'periodic-report.md'), 'utf8');
const INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'periodic', 'index.json'), 'utf8'));

test('契约：与日报同构，条目仍是 title/summary/why/publishedAt/url/refs', () => {
  assert.match(DOC, /macro-news\/periodic-report@1/, '缺少报告 schema 标识');
  assert.match(DOC, /data\/periodic\/<date>\.json/, '缺少正文路径');
  assert.match(DOC, /data\/periodic\/index\.json/, '缺少索引路径');
  for (const f of ['"items"', '"overview"', '"window"', '"coverage"', '"backfill"']) {
    assert.ok(DOC.includes(f), `缺少字段 ${f}`);
  }
  // 条目字段必须是日报那一套，不许另造结构
  for (const f of ['`rank`', '`title`', '`summary`', '`why`', '`source`', '`publishedAt`', '`url`', '`refs`']) {
    assert.ok(DOC.includes(f), `条目缺少日报同构字段 ${f}`);
  }
  assert.ok(!DOC.includes('"sections"'), '周期报告不应使用 sections');
  assert.ok(!DOC.includes('"points"'), '周期报告不应使用 points');
});

test('索引：schema/count/reports 自洽，三类 id 规则在契约里写清', () => {
  assert.equal(INDEX.schema, 'macro-news/periodic-index@1');
  assert.ok(Array.isArray(INDEX.reports), 'reports 必须是数组');
  assert.equal(INDEX.count, INDEX.reports.length, 'count 必须等于 reports 长度');
  assert.match(DOC, /2026-W47/, '缺少周报 id 示例');
  assert.match(DOC, /2026-11/, '缺少月报 id 示例');
  assert.ok(DOC.includes('`YYYY`') && DOC.includes('1 月 1 日 ~ 12 月 31 日'), '缺少年报 id 示例');
});

test('归档页：周期报告区块在按日归档之前，且有三类分组入口', () => {
  const p = HTML.indexOf('id="periodicPanel"');
  const d = HTML.indexOf('id="days"');
  assert.ok(p > 0, '缺少周期报告面板');
  assert.ok(d > p, '周期报告必须在按日归档列表之前');
  assert.ok(HTML.includes('id="periodicList"'), '缺少周期报告列表容器');
  assert.ok(HTML.includes('id="periodicJumps"'), '缺少三类入口容器');
  assert.ok(APP.includes("sec.id = `periodic-${type}`"), '分组缺少稳定入口 id');
  assert.ok(APP.includes("const PERIODIC_GROUPS = ['week', 'month', 'year'];"), '三类分组顺序缺失');
  // 3.4.0：整块收成折叠入口，不再 187 期全量铺在日期层之上；三组入口仍在面板内
  assert.match(HTML, /<details class="periodic" id="periodicPanel" hidden>/);
  assert.ok(HTML.indexOf('id="periodicJumps"') > HTML.indexOf('id="periodicPanel"'));
  assert.ok(!HTML.includes('<details class="periodic" id="periodicPanel" hidden open>'), '默认必须收起');
});

test('降级：索引缺失/为空时隐藏区块，坏条目跳过，单条正文失败不影响其他', () => {
  assert.ok(APP.includes("jget('periodic/index.json', 'default')"), '索引读取路径不对');
  assert.match(APP, /catch\(\(\) => \{\s*periodicPromise = null;\s*return \{ reports: \[\] \};/,
    '索引缺失必须降级为空列表且不缓存失败');
  assert.ok(APP.includes('panel.hidden = reps.length === 0'), '三类都空时必须隐藏区块');
  assert.ok(APP.includes('.map(normPeriodic)'), '缺少条目校验/过滤');
  assert.ok(APP.includes('报告正文载入失败'), '正文失败缺少卡片内提示');
  assert.ok(APP.includes('该报告正文缺失（只有标题与摘要）'), '正文缺字段缺少降级文案');
  assert.ok(APP.includes('try { renderPeriodicPanel(per); } catch'), '周期报告渲染失败不能拖垮归档页');
});

test('渲染：条目复用日报 renderBriefItems，展开状态独立保存', () => {
  assert.ok(APP.includes('if (items.length) renderBriefItems(body, items);'),
    '周期报告必须复用日报条目渲染');
  assert.ok(APP.includes('`${r.type}=${r.id}`'), '展开 key 必须带 week=/month=/year= 前缀');
  assert.ok(APP.includes('periodicOpen'), '刷新恢复缺少周期报告展开状态');
  assert.ok(APP.includes('restorePeriodicOpen()'), 'renderArchive 未恢复周期报告展开状态');
  assert.ok(HTML.includes('assets/app.js?v=20261128a'), 'app.js 版本号未更新');
});

test('既有行为：归档索引仍是 60s TTL + no-cache 条件请求', () => {
  assert.ok(APP.includes('Date.now() - indexAt < 60 * 1000'), 'loadIndex 的 60s TTL 被破坏');
  assert.ok(APP.includes("jget('index.json', 'no-cache')"), 'loadIndex 的 no-cache 被破坏');
  assert.ok(CSS.includes('.pr-card'), '缺少周期报告卡片样式');
  assert.ok(CSS.includes('.pr-group'), '缺少周期报告分组样式');
});
