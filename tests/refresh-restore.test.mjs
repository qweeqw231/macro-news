// tests/refresh-restore.test.mjs
// 2.7.1：刷新（F5）恢复时不再「先空一屏、再让 K 线窗口重现」。
// 做法：① 行情网格用 sessionStorage 快照在首帧同步画回来，随后的实时数据只 patch 数值；
//       ② K 线弹窗在取行情之前就打开，头部名称/现价取快照。
//
// 这里只做静态断言：app.js 是浏览器 IIFE，node 侧没有 DOM，无法直接跑 boot。
// 轻一点，但能兜住「把恢复顺序又挪回 renderQuotes 之后」这类回退。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');

const bootBody = (() => {
  const i = APP.indexOf('async function boot()');
  assert.ok(i > 0, '找不到 boot()');
  const j = APP.indexOf('\n  window.addEventListener(\'pagehide\'', i);
  return APP.slice(i, j > i ? j : i + 6000);
})();

test('行情网格：快照缓存与整体重建共用 buildQuotes', () => {
  assert.ok(APP.includes('function buildQuotes(quotes, statusOf)'), '缺少 buildQuotes');
  // 两条渲染路径都必须走 buildQuotes：结构失效时的整体重建 + 刷新时的快照回填
  assert.ok(APP.includes('box.replaceChildren(buildQuotes(quotes, statusOf))'), '整体重建没走 buildQuotes');
  assert.ok(APP.includes('box.replaceChildren(buildQuotes(snap.quotes, statusOf))'), '快照回填没走 buildQuotes');
});

test('行情快照：renderQuotes 存、paintQuotesFromCache 取', () => {
  assert.match(APP, /const QUOTE_CACHE_KEY = 'macroNewsQuotes\.v1'/);
  assert.ok(APP.includes('saveQuoteCache(quotes, statusOf, globalStatus.summary)'), 'renderQuotes 没有存快照');
  // 必须在「结构未变」的早返回之前存，否则轮询只在价格变化时才写缓存
  const saveAt = APP.indexOf('saveQuoteCache(quotes, statusOf, globalStatus.summary)');
  const patchAt = APP.indexOf('if (patchQuotes(quotes, statusOf))');
  assert.ok(saveAt > 0 && patchAt > saveAt, '存快照应在 patch 之前');
  // 取快照时要复位 lastQuoteSig，否则新数据到达时会被「行情没变」直接跳过
  assert.ok(/function paintQuotesFromCache[\s\S]{0,900}lastQuoteSig = ''/.test(APP), '没复位 lastQuoteSig');
});

test('boot 顺序：先画缓存与 K 线弹窗，再去取新行情', () => {
  const cacheAt = bootBody.indexOf('paintQuotesFromCache()');
  const klineAt = bootBody.indexOf('restoreKlineUI()');
  const quotesAt = bootBody.indexOf('renderQuotes()');
  assert.ok(cacheAt > 0, 'boot 没有调用 paintQuotesFromCache');
  assert.ok(klineAt > 0, 'boot 没有调用 restoreKlineUI');
  assert.ok(quotesAt > 0, 'boot 没有调用 renderQuotes');
  assert.ok(cacheAt < quotesAt, '缓存回填必须在取行情之前');
  assert.ok(klineAt < quotesAt, 'K 线弹窗恢复必须在取行情之前');
  // 回归守卫：恢复不能再挂回 renderQuotes().then(...) 链尾
  assert.ok(!/renderQuotes\(\)[\s\S]{0,120}then\(restoreKlineUI\)/.test(bootBody), 'restoreKlineUI 又挂回链尾');
});

test('K 线弹窗头部：刷新时用快照里的名称/现价撑住首帧', () => {
  assert.ok(/name: \(\$\('#kmName'\) \|\| \{\}\)\.textContent/.test(APP), 'saveUI 没存弹窗名称');
  assert.ok(/price: \(\$\('#kmPrice'\) \|\| \{\}\)\.textContent/.test(APP), 'saveUI 没存弹窗现价');
  assert.ok(/saved && saved\.name \? saved\.name : key/.test(APP), 'openKline 没用快照名称兜底');
  assert.ok(/saved && saved\.price \? saved\.price/.test(APP), 'openKline 没用快照现价兜底');
});
