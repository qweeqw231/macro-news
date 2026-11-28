// tests/archive-timeline.test.mjs
// 3.0.0：归档页「时间轴缩放」的接线静态校验（浏览器 IIFE，node 侧没有 DOM）。
// 3.4.0：补上体验审计（2026-11-28）几处行为锁 —— 切层落层头、周期报告折叠入口、
//   层内不重复展开同期报告、锚点不改写 hash、sticky 补偿由实测高度派生。
// 锁住的是：四层容器与时间尺存在、hash 是唯一状态源、默认落当前月、
// 「全部日期」按月分页、以及既有能力（60s TTL / 日卡仍能进阅读器）不被顺手改掉。

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
  assert.match(month, /periodicEntry\(box, 'month', key\)/, '月层顶部应有月报一行入口');
  const week = APP.slice(APP.indexOf('function renderWeekLayer('), APP.indexOf('function renderDayLayer('));
  assert.match(week, /periodicEntry\(box, 'week', key\)/, '周层顶部应有周报一行入口');
  // 日层不内嵌条目：层头按钮把读者交给要闻流，日卡本身也走同一条出口
  const day = APP.slice(APP.indexOf('function renderDayLayer('), APP.indexOf('function renderYearLayer('));
  assert.match(day, /openDay\(d\.day, d\.kind\)/);
  assert.match(day, /dayCard\(d, \{ toLayer: false \}\)/, '日层里点日卡等于「打开」，不再二次跳层');
  assert.doesNotMatch(day, /renderFeed\(/, '日层不得在归档内渲染要闻列表');
});

test('3.4.0 层级切换落点：切层后对齐新层层头，首帧才对齐视图顶部', () => {
  // 没有历史滚动位置时，切层渲染必须调用 scrollToLayerHead，而不是 alignToView('archive')
  const restore = APP.slice(APP.indexOf('function restoreArchiveState('), APP.indexOf('function renderArchiveChrome('));
  assert.match(restore, /focusLayer/, '缺少「本次是切层」的判定');
  assert.match(restore, /scrollToLayerHead\(\)/, '切层没有落到新层层头');
  assert.match(restore, /alignToView\('archive', true\)/, '首帧仍要对齐归档视图顶部');
  assert.match(APP, /function scrollToLayerHead\(\)[\s\S]{0,220}querySelector\('\.arch-layer-hd'\)/,
    '层头定位应指向 .arch-layer-hd');
  // 只有 hash 驱动的渲染才算切层
  assert.match(APP, /archFocusLayer = !!opts\.nav;/);
  assert.match(APP, /renderArchive\(r, \{ nav: true \}\)/, 'hashchange 切层未标记 nav');
});

test('3.4.0 周期报告：整块折叠入口 + 卡片摘要 + 按年分区 + 不再逐行「补写」', () => {
  // 面板本体是 <details>，默认收起；三组入口（periodic-week/month/year）仍在容器内
  assert.match(HTML, /<details class="periodic" id="periodicPanel" hidden>/, '周期报告应为折叠入口');
  assert.ok(HTML.includes('id="periodicStat"'), '缺少一行汇总（期数统计）');
  assert.match(APP, /pnl\.open = !!\(uiState && uiState\.periodicPanel\)/, '展开状态未随刷新恢复');
  assert.match(APP, /periodicPanel: !!\(\$\('#periodicPanel'\) && \$\(\'#periodicPanel\'\)\.open\)/,
    '展开状态未写入 sessionStorage');
  // 组内按年份分区，默认只展开当前层所在年
  assert.match(APP, /const years = \[\.\.\.new Set\(group\.map\(\(r\) => r\.window\.end\.slice\(0, 4\)\)\)\]/);
  assert.match(APP, /sub\.open = y === openYear/);
  assert.ok(CSS.includes('.pr-year'), '缺少年份分区样式');
  // 卡片渲染 summary，且不再逐行打「补写」
  assert.match(APP, /el\('span', 'pr-sum', r\.summary\)/, '周期卡应渲染 summary');
  const card = APP.slice(APP.indexOf('function periodicCard('), APP.indexOf('function restorePeriodicOpen('));
  assert.doesNotMatch(card, /day-tag backfill/, '周期卡不再逐行打「补写」标签');
  assert.match(APP, /group\.every\(\(r\) => r\.backfill\)/, '补写信息应在组头统一说明一次');
});

test('3.4.0 层内同期报告：一行入口，点开才展开', () => {
  assert.match(APP, /function periodicEntry\(box, type, id\)/);
  const fn = APP.slice(APP.indexOf('function periodicEntry('), APP.indexOf('function renderMonthLayer('));
  assert.match(fn, /body\.hidden = true/, '层内报告默认必须收起');
  assert.match(fn, /if \(show\) loadPeriodicReport/, '正文按需加载');
  assert.doesNotMatch(fn, /openNow/, '层内不再自动展开');
});

test('3.4.0 锚点：点击不改写 hash、补偿值取时间尺实测高度', () => {
  // 三类入口从 <a href="#periodic-*"> 改为按钮
  assert.match(APP, /el\('button', 'fchip', `\$\{PERIODIC_LABEL\[type\]\} \$\{n\}`\)/, '入口应改为按钮');
  assert.match(APP, /b\.onclick = \(\) => focusPeriodicGroup\(type\)/);
  // 旧锚点链接仍可用：展开面板 + 滚到分组 + 把归档层级写回 URL
  assert.match(APP, /match\(\/\^#periodic-\(week\|month\|year\)\$\/\)/, '未兜住旧锚点');
  assert.match(APP, /history\.replaceState\(null, '', AT\.archiveHash\(archRoute\)\)/, '旧锚点不应冲掉层级');
  // sticky 补偿
  assert.match(APP, /getComputedStyle\(bar\)\.top/, '补偿值应取时间尺的计算样式 top');
  assert.match(APP, /style\.setProperty\('--arch-sticky'/, '未把实测高度写进 --arch-sticky');
  assert.match(CSS, /scroll-margin-top: var\(--arch-sticky/, '锚点滚动未使用实测补偿');
  assert.doesNotMatch(CSS, /scroll-margin-top: 136px/, '写死的 136px 应已移除');
});

test('3.4.0 日期跳转：落到归档日层而不是要闻流', () => {
  const form = APP.slice(APP.indexOf("const histForm = $('#histForm')"), APP.indexOf("const fchips"));
  assert.match(form, /navigateArchive\(dayRoute\(hit\.day\)\)/, '日期跳转应进入日层');
  assert.doesNotMatch(form, /openDay\(/, '日期跳转不应直接甩到要闻流');
  assert.match(APP, /function navigateArchive\(route\)[\s\S]{0,200}location\.hash = h/);
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

test('既有能力不变：60s TTL + no-cache、日卡仍能进阅读器', () => {
  assert.ok(APP.includes('Date.now() - indexAt < 60 * 1000'), 'loadIndex 的 60s TTL 被破坏');
  assert.ok(APP.includes("jget('index.json', 'no-cache')"), 'loadIndex 的 no-cache 被破坏');
  // 3.4.0：日卡先落「日」层（保留层级），日层里的「打开当日要闻流」仍是 openDay 进阅读器。
  //   行为意图（点日卡最终能读到当日条目）不变，只是中间多了一层可回退的日层。
  const card = APP.slice(APP.indexOf('function dayCard(d, opts)'), APP.indexOf('const briefCache'));
  assert.match(card, /openDay\(d\.day, d\.kind\)/, '日层的出口必须仍进入要闻流');
  assert.match(card, /navigateArchive\(dayRoute\(d\.day\)\)/, '日卡应先进归档日层');
  assert.match(APP, /'打开当日要闻流'/, '日层缺少进阅读器的显式出口');
});

test('样式：时间尺 / 周组 / 月块 / 相关报告带 / 折叠入口都有定义', () => {
  for (const cls of ['.arch-bar', '.arch-crumb', '.arch-week', '.arch-month', '.wk-chip', '.rel-reports',
    '.periodic-sum', '.pr-year', '.pr-sum', '.arch-rep']) {
    assert.ok(CSS.includes(cls), `缺少样式 ${cls}`);
  }
});
