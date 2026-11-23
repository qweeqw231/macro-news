// tests/archive-timeline.test.mjs
// 3.0.0：归档页「时间轴缩放」的接线静态校验（浏览器 IIFE，node 侧没有 DOM）。
// 锁住的是：四层容器与时间尺存在、hash 是唯一状态源、默认落当前月、
// 「全部日期」按月分页、以及既有能力（60s TTL / 点日卡进要闻流）不被顺手改掉。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'assets', 'style.css'), 'utf8');

test('页面骨架：时间尺、分层容器、相关报告带都在归档视图内', () => {
  for (const id of ['archBar', 'archCrumb', 'archYears', 'archQuick', 'days']) {
    assert.ok(HTML.includes(`id="${id}"`), `缺少 ${id}`);
  }
  assert.ok(HTML.includes('id="relReports"'), '缺少搜索结果「相关报告」容器');
  // 周期报告三组入口仍在按日容器之前（既有能力保留）
  assert.ok(HTML.indexOf('id="periodicPanel"') < HTML.indexOf('id="days"'));
  // 先加载纯函数模块，再加载 app.js
  assert.ok(HTML.indexOf('src="assets/archive-time.js') > 0, '缺少 archive-time.js');
  assert.ok(HTML.indexOf('src="assets/archive-time.js') < HTML.indexOf('src="assets/app.js'),
    'archive-time.js 必须先于 app.js');
});

test('hash 是唯一状态源：层级路由可解析、可写回，旧 #view-archive 仍有效', () => {
  assert.ok(APP.includes('const AT = window.MacroArchiveTime;'), '未接入 archive-time 纯函数');
  assert.ok(APP.includes('AT.parseArchiveHash(location.hash)'), 'hashchange 未解析层级');
  assert.match(APP, /if \(!r \|\| r\.level === 'default'\) \{ renderArchive\(null\); return; \}/,
    '旧的 #view-archive / 裸 #archive 应回到默认月并规范化 URL');
  assert.ok(APP.includes("history.replaceState(null, '', h)"), '层级未写回 URL');
  // 旧的视图级链接继续被识别为归档视图
  assert.match(APP, /#view-\(feed\|market\|macro\|archive\|sources\)/);
  assert.match(APP, /#archive\(\\\/\|\$\)/);
});

test('默认落层：没指定层级时按「当前月 → 最近有数据的月」解析', () => {
  assert.ok(APP.includes('AT.pickDefaultMonth(archCtx.months, newsDay())'), '默认月没有走当前月/最近月规则');
  assert.ok(APP.includes('function resolveArchiveRoute(route)'), '缺少默认路由解析');
});

test('四层钻取各自有渲染入口，月层按周分组', () => {
  for (const fn of ['renderMonthLayer', 'renderWeekLayer', 'renderYearLayer', 'renderDayLayer', 'renderAllLayer']) {
    assert.ok(APP.includes(`function ${fn}(`), `缺少 ${fn}`);
  }
  const month = APP.slice(APP.indexOf('function renderMonthLayer('), APP.indexOf('function renderWeekLayer('));
  assert.match(month, /groupDaysByWeek\(days\)/, '月层必须按 ISO 周分组');
  assert.match(month, /periodicBlock\(box, 'month', key, true\)/, '月层顶部应有月报');
  const week = APP.slice(APP.indexOf('function renderWeekLayer('), APP.indexOf('function renderDayLayer('));
  assert.match(week, /periodicBlock\(box, 'week', key, true\)/, '周层顶部应有周报');
  // 日层仍不内嵌条目：唯一入口是 openDay
  const day = APP.slice(APP.indexOf('function renderDayLayer('), APP.indexOf('function renderYearLayer('));
  assert.match(day, /openDay\(d\.day, d\.kind\)/);
  assert.doesNotMatch(day, /renderFeed\(/, '日层第一阶段不得在归档内渲染要闻列表');
});

test('「全部日期」按月分页，不一次渲染全部日卡', () => {
  const all = APP.slice(APP.indexOf('function renderAllLayer('), APP.indexOf('function renderArchiveLayer('));
  assert.match(all, /archAllShown/, '缺少按月分页游标');
  assert.match(all, /months\.slice\(0, archAllShown\)/, '必须按游标截取月份');
  assert.match(all, /加载更早的 3 个月/);
});

test('刷新恢复：按路由存滚动与展开，保留旧 key', () => {
  assert.match(APP, /routeStates\[key\] = \{ y: scrollY, briefOpen/, '未按路由保存');
  assert.match(APP, /routes: routeStates/, 'sessionStorage 未写入按路由状态');
  assert.match(APP, /uiState\.view === 'archive' && Number\.isFinite\(uiState\.y\)/, '旧 key 的兜底被删掉');
  const save = APP.slice(APP.indexOf('function saveUI()'), APP.indexOf('async function jget'));
  assert.match(save, /briefOpen,\n\s*periodicOpen,/, '旧展开状态 key 仍要写一份');
});

test('既有能力不变：60s TTL + no-cache、点日卡进要闻流', () => {
  assert.ok(APP.includes('Date.now() - indexAt < 60 * 1000'), 'loadIndex 的 60s TTL 被破坏');
  assert.ok(APP.includes("jget('index.json', 'no-cache')"), 'loadIndex 的 no-cache 被破坏');
  const card = APP.slice(APP.indexOf('function dayCard(d)'), APP.indexOf('const briefCache'));
  assert.match(card, /openDay\(d\.day, d\.kind\)/, '点日卡必须仍进入要闻流');
});

test('样式：时间尺 / 周组 / 月块 / 相关报告带都有定义', () => {
  for (const cls of ['.arch-bar', '.arch-crumb', '.arch-week', '.arch-month', '.wk-chip', '.rel-reports']) {
    assert.ok(CSS.includes(cls), `缺少样式 ${cls}`);
  }
});
