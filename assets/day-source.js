/* assets/day-source.js
 * 归档页「同一天用 archive 全文还是 history 切片」的显式规则（2.4.10 / 2.21.0）。
 * 纯函数；浏览器挂到 window.MacroDaySource，Node 测试可 require。
 *
 * 规则（阈值 20，明确写在这里，不藏在渲染逻辑里）：
 *   · history 条数 > archive 条数 → 用历史切片（2.21.0；见下）；
 *   · archive 条数 >= 20 → 用归档全文；
 *   · archive < 20 且 history > 0 → 用历史切片（仅标题/来源/时间），并说明原因；
 *   · archive < 20 且无 history → 仍用 archive（没有可替代的切片）；
 *   · 两边都没有 → none。
 *
 * 2.21.0：为什么「更多」优先于阈值——
 *   阈值只看 archive 是否"像个完整的一天"，挡不住两种"archive 更薄"的情况：
 *   ① 早期只写入官方源条目的占位归档（0~7 条，如 08-17~09-18）；
 *   ② 够 20 条但仍比切片少（10-01 31 vs 119、10-02 122 vs 204、10-04 103 vs 137）。
 *   条数取大者，是用户唯一能直接看见的口径。
 */
(function (global) {
  'use strict';

  var ARCHIVE_MIN_COUNT = 20;

  /**
   * @param {{archiveCount?:number, historyCount?:number, threshold?:number}} o
   * @returns {{kind:'archive'|'history'|'none', count:number, reason:string}}
   */
  function decideDaySource(o) {
    var opts = o || {};
    var a = Number(opts.archiveCount) || 0;
    var h = Number(opts.historyCount) || 0;
    var min = opts.threshold == null ? ARCHIVE_MIN_COUNT : Number(opts.threshold);

    if (a <= 0 && h <= 0) {
      return { kind: 'none', count: 0, reason: '该日无归档与历史数据' };
    }
    // 2.21.0：切片更全时优先切片，不再被「archive >= 20」的阈值挡住
    if (h > a) {
      return {
        kind: 'history',
        count: h,
        reason: a < min
          ? '该日归档仅 ' + a + ' 条，已改用历史切片 ' + h + ' 条（仅标题/来源/时间，正文请点原文）'
          : '该日归档 ' + a + ' 条，少于历史切片 ' + h + ' 条，已改用历史切片（仅标题/来源/时间，正文请点原文）',
      };
    }
    if (a >= min) {
      return { kind: 'archive', count: a, reason: '归档全文' };
    }
    if (h > 0) {
      return {
        kind: 'history',
        count: h,
        reason: '该日归档仅 ' + a + ' 条，已改用历史切片 ' + h + ' 条（仅标题/来源/时间，正文请点原文）',
      };
    }
    return { kind: 'archive', count: a, reason: '归档全文（该日无历史切片可补）' };
  }

  var API = { ARCHIVE_MIN_COUNT: ARCHIVE_MIN_COUNT, decideDaySource: decideDaySource };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.MacroDaySource = API;
})(typeof window !== 'undefined' ? window : globalThis);
