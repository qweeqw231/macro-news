/* assets/archive-time.js
 * 3.0.0：归档页「时间轴缩放」（年 → 月 → 周 → 日）的纯函数层。
 *
 * 这里只做时间计算与 hash 语法，不碰 DOM，也不读 data/：
 *   · ISO 周（周一~周日，周年以该周周四所在年为准）；
 *   · 月 / 周 / 日的边界与分组；
 *   · `#archive/...` 路由的解析与生成；
 *   · 「相关报告」的关键词匹配（报告是唯一需要按词筛选的新内容）。
 * 浏览器里挂在 window.MacroArchiveTime，Node 测试可直接 require。
 *
 * 日期一律按「新闻日」键（YYYY-MM-DD，北京 08:00 起算）处理，
 * 与 assets/news-day.js 同一口径；这里只做 UTC 日历运算，不依赖进程时区。
 */
(function (global) {
  'use strict';

  var DAY_MS = 86400000;

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function isDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

  function toMs(day) { return Date.parse(String(day) + 'T00:00:00Z'); }

  function fromMs(ms) { return new Date(ms).toISOString().slice(0, 10); }

  function addDays(day, n) { return fromMs(toMs(day) + Number(n) * DAY_MS); }

  // ISO 星期：周一 = 1 … 周日 = 7
  function isoDayNum(day) {
    var w = new Date(toMs(day)).getUTCDay();
    return w === 0 ? 7 : w;
  }

  function weekStart(day) { return addDays(day, -(isoDayNum(day) - 1)); }

  // ISO 周：先取本周周一，再取本周周四 —— 周四所在年就是 ISO 周年。
  function isoWeek(day) {
    if (!isDay(day)) return null;
    var thursday = addDays(weekStart(day), 3);
    var y = Number(thursday.slice(0, 4));
    var week = Math.floor((toMs(thursday) - Date.UTC(y, 0, 1)) / (7 * DAY_MS)) + 1;
    return { year: y, week: week, key: y + '-W' + pad2(week) };
  }

  // ISO 第 1 周的周一 = 含 1 月 4 日那一周的周一。
  function weekRange(year, week) {
    var jan4 = Date.UTC(Number(year), 0, 4);
    var jan4Day = new Date(jan4).getUTCDay() || 7;
    var monday = jan4 - (jan4Day - 1) * DAY_MS + (Number(week) - 1) * 7 * DAY_MS;
    return { start: fromMs(monday), end: fromMs(monday + 6 * DAY_MS) };
  }

  // 一个 ISO 周横跨两个月时，用周四所在月作为它的「主月」（面包屑与返回目标）。
  function weekMidMonth(year, week) {
    return addDays(weekRange(year, week).start, 3).slice(0, 7);
  }

  function monthKeyOf(day) { return String(day || '').slice(0, 7); }

  function monthLabel(key) {
    return Number(String(key).slice(0, 4)) + ' 年 ' + Number(String(key).slice(5, 7)) + ' 月';
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  }

  function addMonths(key, n) {
    var d = new Date(Date.UTC(Number(String(key).slice(0, 4)), Number(String(key).slice(5, 7)) - 1 + Number(n), 1));
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1);
  }

  // 某自然月涉及的 ISO 周（按日期升序）。
  function monthWeeks(year, month) {
    var y = Number(year);
    var m = Number(month);
    var n = daysInMonth(y, m);
    var out = [];
    var seen = {};
    for (var i = 1; i <= n; i++) {
      var w = isoWeek(y + '-' + pad2(m) + '-' + pad2(i));
      if (!w || seen[w.key]) continue;
      seen[w.key] = 1;
      var r = weekRange(w.year, w.week);
      out.push({ key: w.key, year: w.year, week: w.week, start: r.start, end: r.end });
    }
    return out;
  }

  // ---------- 路由 ----------

  function normWeek(v) {
    var n = Number(String(v || '').replace(/^W/i, ''));
    return n >= 1 && n <= 53 ? pad2(n) : '';
  }

  function routeKey(r) {
    if (!r) return '';
    if (r.level === 'all') return 'archive/all';
    if (r.level === 'year') return 'archive/' + r.year;
    if (r.level === 'month') return 'archive/' + r.year + '/' + r.month;
    if (r.level === 'week') return 'archive/' + r.year + '/W' + pad2(Number(r.week));
    if (r.level === 'day') return 'archive/' + r.year + '/' + r.month + '/' + r.day;
    return 'archive';
  }

  function archiveHash(r) { return '#' + routeKey(r); }

  // 段数 + 第二段格式（W47 vs 11）区分周与日，见调研文档 §7.1。
  function parseArchiveHash(hash) {
    var s = String(hash || '');
    if (s.charAt(0) === '#') s = s.slice(1);
    if (s !== 'archive' && s.indexOf('archive/') !== 0) return null;
    var rest = s.slice(7).replace(/^\/+|\/+$/g, '');
    if (!rest) return { level: 'default' };
    var seg = rest.split('/');
    if (seg.length === 1) {
      if (seg[0] === 'all') return { level: 'all' };
      if (/^\d{4}$/.test(seg[0])) return { level: 'year', year: seg[0] };
      return null;
    }
    if (seg.length === 2) {
      if (!/^\d{4}$/.test(seg[0])) return null;
      if (/^W\d{1,2}$/i.test(seg[1])) {
        var w = normWeek(seg[1]);
        return w ? { level: 'week', year: seg[0], week: w } : null;
      }
      if (/^\d{1,2}$/.test(seg[1])) {
        var mo = Number(seg[1]);
        return mo >= 1 && mo <= 12 ? { level: 'month', year: seg[0], month: pad2(mo) } : null;
      }
      return null;
    }
    if (seg.length === 3) {
      if (!/^\d{4}$/.test(seg[0]) || !/^\d{1,2}$/.test(seg[1]) || !/^\d{1,2}$/.test(seg[2])) return null;
      var y = Number(seg[0]);
      var mm = Number(seg[1]);
      var dd = Number(seg[2]);
      if (mm < 1 || mm > 12 || dd < 1 || dd > daysInMonth(y, mm)) return null;
      return { level: 'day', year: seg[0], month: pad2(mm), day: pad2(dd) };
    }
    return null;
  }

  // ---------- 最近有数据的层 ----------
  // 列表一律「倒序」（最新在前）；以下函数返回最接近目标、且不晚于目标的键，
  // 目标早于全部数据时退回最老的一个，保证快捷入口总能落到有内容的地方。

  function nearestMonth(monthsDesc, target) {
    var list = monthsDesc || [];
    if (!list.length) return '';
    if (list.indexOf(target) >= 0) return target;
    for (var i = 0; i < list.length; i++) if (list[i] <= target) return list[i];
    return list[list.length - 1];
  }

  function nearestWeek(weeksDesc, targetKey) {
    var list = weeksDesc || [];
    if (!list.length) return '';
    if (list.indexOf(targetKey) >= 0) return targetKey;
    for (var i = 0; i < list.length; i++) if (list[i] <= targetKey) return list[i];
    return list[list.length - 1];
  }

  function nearestYear(yearsDesc, target) {
    var list = yearsDesc || [];
    if (!list.length) return '';
    var t = String(target);
    if (list.indexOf(t) >= 0) return t;
    for (var i = 0; i < list.length; i++) {
      if (list[i] <= t) return list[i];
    }
    return list[list.length - 1];
  }

  // 默认落层：当前月；当前月无数据则回退到最近有数据的月。
  function pickDefaultMonth(monthsDesc, today) {
    var cur = monthKeyOf(today);
    if (!monthsDesc || !monthsDesc.length) return cur;
    if (monthsDesc.indexOf(cur) >= 0) return cur;
    var best = '';
    for (var i = 0; i < monthsDesc.length; i++) {
      if (monthsDesc[i] <= cur && (!best || monthsDesc[i] > best)) best = monthsDesc[i];
    }
    return best || monthsDesc[monthsDesc.length - 1];
  }

  // ---------- 搜索「相关报告」 ----------
  // 只作用于报告（周报/月报/年报）；条目级搜索结果保持原排序，不做分组。
  function relatedReports(reports, q, max) {
    var query = String(q || '').trim().toLowerCase();
    if (!query) return [];
    var limit = Number(max) > 0 ? Number(max) : 3;
    var tokens = query.split(/\s+/).filter(function (t) { return t.length >= 2; });
    var hit = function (r) {
      var hay = (String(r.title || '') + ' ' + String(r.summary || '')).toLowerCase();
      if (hay.indexOf(query) >= 0) return true;
      for (var i = 0; i < tokens.length; i++) if (hay.indexOf(tokens[i]) >= 0) return true;
      return false;
    };
    return ['week', 'month', 'year']
      .map(function (type) {
        return {
          type: type,
          list: (reports || []).filter(function (r) { return r && r.type === type && hit(r); }).slice(0, limit),
        };
      })
      .filter(function (g) { return g.list.length; });
  }

  var api = {
    DAY_MS: DAY_MS,
    isDay: isDay,
    addDays: addDays,
    isoDayNum: isoDayNum,
    weekStart: weekStart,
    isoWeek: isoWeek,
    weekRange: weekRange,
    weekMidMonth: weekMidMonth,
    monthKeyOf: monthKeyOf,
    monthLabel: monthLabel,
    daysInMonth: daysInMonth,
    addMonths: addMonths,
    monthWeeks: monthWeeks,
    routeKey: routeKey,
    archiveHash: archiveHash,
    parseArchiveHash: parseArchiveHash,
    nearestMonth: nearestMonth,
    nearestWeek: nearestWeek,
    nearestYear: nearestYear,
    pickDefaultMonth: pickDefaultMonth,
    relatedReports: relatedReports,
  };

  global.MacroArchiveTime = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
