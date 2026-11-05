/* assets/news-day.js
 * 2.4.18：统一的「新闻日」边界。
 *
 * 定义：新闻日 D = [D 08:00 北京, D+1 08:00 北京) 的窗口。
 * 因为北京 08:00 正好是 UTC 00:00，等价的显式算法是：
 *   newsDay(t) = 取 t 的 UTC 日历日期（YYYY-MM-DD）
 * 不使用任何本地时区日期 API，也不依赖进程 TZ。
 */
(function (global) {
  'use strict';

  var DAY_MS = 86400000;

  function toMs(ts) {
    if (ts instanceof Date) return ts.getTime();
    if (typeof ts === 'number') return ts;
    return Date.parse(ts);
  }

  function newsDay(ts) {
    var n = toMs(ts === undefined ? Date.now() : ts);
    if (!Number.isFinite(n)) return '';
    // 北京 08:00 = UTC 00:00 ⇒ 新闻日就是该时刻的 UTC 日期
    return new Date(n).toISOString().slice(0, 10);
  }

  function newsToday(now) {
    return newsDay(now === undefined ? Date.now() : now);
  }

  function addDays(day, n) {
    var t = Date.parse(String(day) + 'T00:00:00Z') + Number(n) * DAY_MS;
    return new Date(t).toISOString().slice(0, 10);
  }

  var api = { DAY_MS: DAY_MS, newsDay: newsDay, newsToday: newsToday, addDays: addDays };
  global.MacroNewsDay = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
