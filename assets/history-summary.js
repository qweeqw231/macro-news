/* assets/history-summary.js
 * 归档页「历史切片」文案（2.4.9）。
 * 纯函数；浏览器挂到 window.MacroHistorySummary，Node 测试可 require。
 *
 * 为什么单独抽出来：原来文案直接写在 app.js 的 IIFE 里，无法在 Node 测试中验证
 * 「索引范围变了，文案必须跟着变」。这里只做字符串拼装，不读全局状态。
 */
(function (global) {
  'use strict';

  function fmt(n) {
    return Number(n || 0).toLocaleString('zh-CN');
  }

  /**
   * @param {{days?:Array, from?:string, to?:string, total?:number}} hist
   * @param {Array<{day:string,kind?:string}>} [list] 合并后的完整日期列表（含归档卡片）
   * @returns {string} 空索引时返回空串
   */
  function summary(hist, list) {
    const days = hist && Array.isArray(hist.days) ? hist.days.length : 0;
    const from = hist && hist.from ? String(hist.from) : '';
    const to = hist && hist.to ? String(hist.to) : '';
    if (!days || !from || !to) return '';
    const total = Number(hist && hist.total) || 0;
    const newer = Array.isArray(list)
      ? list.filter((x) => x && x.day > to && x.kind !== 'hist').length
      : 0;
    const tail = newer
      ? `${to} 之后另有 ${newer} 天在下方归档卡片（带全文）`
      : `${to} 之后暂无归档卡片`;
    return `归档前历史 ${days} 天 · ${from} ~ ${to} · ${fmt(total)} 条 · 仅标题/来源/时间，不含正文；${tail}`;
  }

  const API = { summary };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.MacroHistorySummary = API;
})(typeof window !== 'undefined' ? window : globalThis);
