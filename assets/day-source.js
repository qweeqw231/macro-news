/* assets/day-source.js
 * 归档页「同一天用 archive 全文还是 history 切片」的显式规则（2.5.0）。
 * 纯函数；浏览器挂到 window.MacroDaySource，Node 测试可 require。
 *
 * 规则（阈值 20，明确写在这里，不藏在渲染逻辑里）：
 *   · archive 条数 >= 20 → 用归档全文；
 *   · archive < 20 且 history > 0 → 用历史切片（仅标题/来源/时间），并说明原因；
 *   · archive < 20 且无 history → 仍用 archive（没有可替代的切片）；
 *   · 两边都没有 → none。
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
