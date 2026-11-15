/* assets/search-history.js
 * 2.22.0：全部历史检索（按月分片）的纯函数 + 薄封装。
 * 浏览器挂 window.MacroSearchHistory；Node 测试可 require。
 *
 * 约定与 src/search-history.mjs 保持一致：
 *   · 分片字段 = search.json 的 6 个字段（id/ts/time/source/title/url）；
 *   · 结果合并顺序 = 近期命中原样在前，历史命中追加在后，id/url 去重；
 *   · 月份从新到旧。
 */
(function (global) {
  'use strict';

  function monthsDesc(manifest) {
    var list = (manifest && manifest.chunks) || [];
    return list
      .map(function (x) { return x.m; })
      .sort(function (a, b) { return a < b ? 1 : -1; });
  }

  function chunkUrl(month) {
    return 'search-history/' + month + '.json';
  }

  /** 分片条目 → 列表/阅读器用的统一条目（标记 _hist，正文需回原文） */
  function toItem(x) {
    return {
      id: x.id || '',
      ts: x.ts || 0,
      time: x.time || '',
      source: x.source || '',
      title: x.title || '',
      url: x.url || '',
      channel: '',
      summary: '',
      content: '',
      kind: 'news',
      _hist: 1,
      h: 1,
    };
  }

  function mergeResults(recent, hist) {
    var seenId = {};
    var seenUrl = {};
    var out = [];
    function take(x) {
      if (!x) return false;
      if (x.id) {
        if (seenId[x.id]) return false;
        seenId[x.id] = 1;
      } else if (x.url) {
        if (seenUrl[x.url]) return false;
      }
      if (x.url) seenUrl[x.url] = 1;
      return true;
    }
    (recent || []).forEach(function (x) { if (take(x)) out.push(x); });
    (hist || []).forEach(function (x) { if (take(x)) out.push(x); });
    return out;
  }

  var API = {
    monthsDesc: monthsDesc,
    chunkUrl: chunkUrl,
    toItem: toItem,
    mergeResults: mergeResults,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.MacroSearchHistory = API;
})(typeof window !== 'undefined' ? window : globalThis);
