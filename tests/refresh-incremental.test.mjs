// tests/refresh-incremental.test.mjs
// 2.4.12：刷新/轮询不推倒重绘 —— 静态断言（不需要浏览器）。
// 锁住的是「结构不变就原地更新、结构变了才重建」这条判据，
// 以及 K 线视窗与归档展开状态跨刷新的恢复链路。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const app = read('assets/app.js');
const kline = read('assets/kline.js');

function between(src, start, end) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `缺少起点：${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b > a, `缺少终点：${end}`);
  return src.slice(a, b);
}

test('轮询：结构不变时先 patch，整块重建只作兜底', () => {
  const body = between(app, 'function renderQuotes()', 'function startQuotePolling()');
  const patchCall = body.indexOf('if (patchQuotes(quotes, statusOf))');
  const rebuild = body.indexOf('box.replaceChildren(buildQuotes(quotes, statusOf))');
  assert.ok(patchCall >= 0, 'renderQuotes 必须先尝试 patchQuotes');
  assert.ok(rebuild > patchCall, 'patchQuotes 必须在 replaceChildren 之前');
  const branch = body.slice(patchCall, rebuild);
  assert.match(branch, /applyQuoteFilter\(\)/, '原地更新后要保持当前筛选结果');
  assert.match(branch, /return;/, 'patch 成功就不应继续走整块重建');
});

test('patchQuotes：只改数值/颜色/时间，结构不一致时返回 false', () => {
  const body = between(app, 'function patchQuotes(', 'let lastQuoteSig');
  assert.match(body, /groupEls\.length !== mks\.length\) return false/);
  assert.match(body, /cards\.length !== list\.length\) return false/);
  assert.match(body, /card\.dataset\.key !== q\.key\) return false/);
  for (const sel of ['.q-px', '.q-chg', '.q-time']) {
    assert.ok(body.includes(`card.querySelector('${sel}')`), `缺少原地字段 ${sel}`);
  }
  assert.match(body, /classList\.toggle\('up'/, '涨跌色按 class 切换');
  assert.match(body, /classList\.toggle\('state-ok'/, '状态色按 class 切换');
  assert.match(body, /return true;/);
});

test('K 线：setData 保留缩放/offset，getView/setView 可存取', () => {
  assert.match(kline, /getView\(\)\s*\{\s*return \{ barsShown: this\.barsShown, offset: this\.offset \};/);
  assert.match(kline, /setView\(v\)/);
  const setData = between(kline, 'setData(bars, period) {', 'setMAEnabled(');
  assert.doesNotMatch(setData, /this\.barsShown\s*=/, 'setData 不得重置 barsShown');
  assert.doesNotMatch(setData, /this\.offset\s*=\s*0/, 'setData 不得重置 offset');
  assert.match(setData, /Math\.min\(this\.offset, this\._maxOffset\(\)\)/, 'offset 只做越界钳制');
  // 切换标的仍要 reset：这是「新标的从默认视窗开始」的既有行为
  const reset = between(kline, 'reset() {', '_bind()');
  assert.match(reset, /this\.barsShown = 90;/);
  assert.match(reset, /this\.offset = 0;/);
});

test('K 线：刷新后等首帧落图再恢复视窗', () => {
  const apply = between(app, "kChart.setData(bars, period);", 'maBars = bars.length;');
  assert.match(apply, /pendingKlineView\.key === key && pendingKlineView\.period === period/);
  assert.match(apply, /kChart\.setView\(v\)/);
  const restore = between(app, 'function restoreKlineUI()', 'async function boot()');
  assert.match(restore, /pendingKlineView = uiState\.kline/);
  assert.match(restore, /openKline\(uiState\.kline\.key/);
});

test('状态存储：K 线视窗与打开的天都写进同一份 sessionStorage', () => {
  assert.match(app, /const UI_KEY = 'macroNewsUI\.v1';/);
  assert.match(app, /sessionStorage\.getItem\(UI_KEY\)/);
  const save = between(app, 'function saveUI()', 'async function jget');
  assert.match(save, /barsShown: pendingKlineView\.barsShown, offset: pendingKlineView\.offset/);
  assert.match(save, /kChart\.getView\(\)/);
  assert.match(save, /day: S\.view === 'feed' && openedDay/);
  // 恢复途中不能被 reset() 的默认视窗覆盖
  assert.match(save, /pendingKlineView\.key === klineKey && pendingKlineView\.period === klinePeriod/);
});

test('归档页：刷新后原地不动，早报保持展开并重新载入正文', () => {
  assert.match(app, /det\.open = true;/, '恢复展开状态，不能收起');
  assert.match(app, /box\.classList\.add\('expanded'\)/);
  const archive = between(app, 'async function renderArchive()', 'async function openDay(');
  assert.match(archive, /restoreBriefOpen\(\)\.then\(restoreArchiveScroll, restoreArchiveScroll\)/);
  const scroll = between(app, 'function restoreArchiveScroll()', 'async function renderArchive()');
  assert.match(scroll, /uiState\.view !== 'archive'/);
  assert.match(scroll, /window\.scrollTo\(\{ top: uiState\.y/);
  assert.match(scroll, /alignState\.userMoved = true/, '停掉自动纠偏，别把页面拽回顶部');
});

test('归档某天：刷新后仍停在当天，不回最新要闻流', () => {
  const feed = between(app, 'async function restoreFeedUI()', 'function restoreKlineUI()');
  assert.match(feed, /const savedDay = uiState\.day;/);
  assert.match(feed, /await openDay\(savedDay\.day, savedDay\.kind \|\| 'live'\)/);
  assert.match(feed, /wantShown > S\.shown/);
  assert.match(app, /openedDay = \{ day, kind \};/);
});
