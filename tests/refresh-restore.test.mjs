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
  assert.ok(APP.includes('function buildQuotes(quotes, statusOf, openMap)'), '缺少 buildQuotes');
  // 两条渲染路径都必须走 buildQuotes：结构失效时的整体重建 + 刷新时的快照回填
  assert.ok(APP.includes('box.replaceChildren(buildQuotes(quotes, statusOf))'), '整体重建没走 buildQuotes');
  assert.ok(APP.includes('box.replaceChildren(buildQuotes(snap.quotes, statusOf, snap.groups))'), '快照回填没走 buildQuotes');
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

// 2.7.2：要闻流也要「刷新不重绘」——首帧用快照画列表 + 定滚动，新数据只补插顶部。
test('要闻流：renderFeed 存快照、paintFeedFromCache 首帧回填', () => {
  assert.match(APP, /const FEED_CACHE_KEY = 'macroNewsFeed\.v1'/);
  assert.ok(/list\.forEach\(\(it\) => box\.appendChild\(itemNode\(it\)\)\);[\s\S]{0,200}saveFeedCache\(\)/.test(APP),
    'renderFeed 没有存快照');
  const paint = APP.slice(APP.indexOf('function paintFeedFromCache()'), APP.indexOf('function patchFeed()'));
  assert.ok(paint.length > 0, '缺少 paintFeedFromCache');
  assert.match(paint, /renderFilters\(\)[\s\S]{0,400}renderFeed\(\)/, '回填要先把筛选/列表画出来');
  assert.match(paint, /window\.scrollTo\(\{ top: uiState\.y/, '回填时要同步定位滚动位置');
  // 搜索结果与归档某天不进缓存，否则刷新会回到错误的内容
  assert.match(APP, /if \(S\.q \|\| openedDay \|\| !S\.items/, '缓存没排除搜索结果/归档天');
});

test('要闻流：对齐一致时一个节点都不动，只在顶部补插', () => {
  const patch = APP.slice(APP.indexOf('function patchFeed()'), APP.indexOf('// ---------- 站内阅读器 ----------'));
  assert.ok(patch.length > 0, '缺少 patchFeed');
  assert.match(patch, /if \(!off && !drop\) return true;/, '一致时必须直接返回，不碰 DOM');
  assert.match(patch, /box\.insertBefore\(frag, box\.firstChild\)/, '新增条目只插到顶部');
  assert.doesNotMatch(patch, /box\.innerHTML\s*=|box\.replaceChildren\(/, '增量路径不得整块重建');
  // 条目下标改成点击时按 id 反查：补插后旧节点的闭包下标会错位
  assert.match(APP, /a\.onclick = \(\) => openReader\(idxOfItem\(it\)\)/);
});

test('boot 顺序：要闻流回填早于假日表与新数据', () => {
  const feedAt = bootBody.indexOf('paintFeedFromCache()');
  const calAt = bootBody.indexOf('await ensureCalendar()');
  const latestAt = bootBody.indexOf("await jget('latest.json')");
  assert.ok(feedAt > 0, 'boot 没有调用 paintFeedFromCache');
  assert.ok(feedAt < calAt, '要闻流回填必须在 await 之前（否则首帧已画过骨架）');
  assert.ok(feedAt < latestAt, '要闻流回填必须在取 latest.json 之前');
  assert.match(bootBody, /if \(!patchFeed\(\)\) runSearch\(''\)/, '新数据到达时应先尝试增量对齐');
});

// 2.7.3：阅读器同样要在首帧打开，不能挂在 latest.json 之后（晚 0.5~16s 才弹出＝一次重绘）。
test('阅读器：随快照首帧打开，重复调用不重绘', () => {
  const paint = APP.slice(APP.indexOf('function paintFeedFromCache()'), APP.indexOf('function patchFeed()'));
  assert.match(paint, /restoreReaderUI\(\)/, '首帧回填要一并恢复阅读器');
  // 回填顺序：列表 → 滚动 → 阅读器
  assert.ok(paint.indexOf('renderFeed()') < paint.indexOf('restoreReaderUI()'));
  const restore = APP.slice(APP.indexOf('function restoreReaderUI()'), APP.indexOf('let filtersSig'));
  assert.match(restore, /!\$\('#readerModal'\)\.hidden\) return false/, '已打开就不要重复渲染');
  assert.match(restore, /openReader\(idx, Number\(uiState\.reader\.y\) \|\| 0\)/, '连阅读器视口一起还原');
  // 补插后下标整体后移：阅读器按 id 重新定位，否则上/下一条会跳错
  assert.match(APP, /syncReader\(\);/, '增量对齐后要校正阅读器下标');
  assert.match(APP, /readerKey = itemKey\(list\[n\]\);/, '翻页时同步记下当前条目 id');
});

test('要闻流快照：存整份列表，归档天与搜索结果不入缓存', () => {
  const save = APP.slice(APP.indexOf('function saveFeedCache()'), APP.indexOf('function paintFeedFromCache()'));
  assert.match(save, /S\.items !== S\.base/, '归档某天不能写进缓存');
  // 只存当前显示的 40 条会让刷新后的分类计数（全部 40）与快照条数（200）对不上
  assert.doesNotMatch(save, /S\.items\.slice\(0, want\)/);
  assert.match(save, /S\.items\.map\(/);
  assert.match(save, /qMeta: feedMetaText\(\)/, '母集说明按数据算，别抄 DOM 里的旧值');
});
