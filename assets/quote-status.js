/* assets/quote-status.js
 * 行情新鲜度三态（实时 / 延迟 / 本地快照）的纯逻辑。
 * 浏览器挂到 window.MacroQuoteStatus；Node 测试可 require（UMD）。
 *
 * 设计文档：docs/superpowers/specs/2026-11-03-market-freshness-2.4.0-design.md
 *
 * 硬规则：
 *   · 没有源时间 → 永远不能是 realtime；
 *   · generatedAt(now) 不是数据时间；
 *   · 本地回落 → local，文案必须写“本地快照”；
 *   · 阈值 5 分钟（REALTIME_MAX_AGE_MS）。
 */
(function (global) {
  'use strict';

  var REALTIME_MAX_AGE_MS = 5 * 60 * 1000;
  var QUOTE_TOTAL_BUDGET_MS = 2000;
  var QUOTE_EM_BUDGET_MS = 1200;
  var QUOTE_TX_BUDGET_MS = 800;
  var STATE_LABEL = {
    realtime: '实时', delayed: '延迟', local: '本地快照',
    closed: '已收盘', holiday: '休市',
  };
  // 全局“最差”排序：本地快照 > 延迟 > 休市 > 已收盘 > 实时
  var STATE_RANK = { realtime: 0, closed: 1, holiday: 2, delayed: 3, local: 4 };
  var BJ_MS = 8 * 3600 * 1000;

  function pad(n) { return String(n).padStart(2, '0'); }

  function bjParts(ms) {
    var d = new Date(ms + BJ_MS);
    return {
      y: d.getUTCFullYear(),
      m: pad(d.getUTCMonth() + 1),
      d: pad(d.getUTCDate()),
      hh: pad(d.getUTCHours()),
      mm: pad(d.getUTCMinutes()),
    };
  }

  /** 'YYYYMMDDHHMMSS'（腾讯字段 30）→ 北京时间 ISO */
  function parseTencentTime(s) {
    var m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
    if (!m) return null;
    return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '+08:00';
  }

  /** epoch 秒 → 北京时间 ISO */
  function fromEpoch(sec) {
    var n = Number(sec);
    if (!Number.isFinite(n) || n <= 0) return null;
    var p = bjParts(n * 1000);
    return p.y + '-' + p.m + '-' + p.d + 'T' + p.hh + ':' + p.mm + ':00+08:00';
  }

  /** K线 bar 时间：'YYYY-MM-DD' / 'YYYY-MM-DD HH:MM' / 'YYYY-MM-DDTHH:MM' → {date,hm,iso} */
  function parseBarTime(t) {
    var s = String(t || '').trim();
    var m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?)?$/);
    if (!m) return null;
    return {
      date: m[1],
      hm: m[2] || '',
      iso: m[1] + 'T' + (m[2] || '00:00') + ':00+08:00',
      year: m[1].slice(0, 4),
    };
  }

  function ageMs(sourceTime, now) {
    var t = Date.parse(sourceTime || '');
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Number(now) - t);
  }

  function classifyState(sourceTime, now, fromLocal) {
    var age = ageMs(sourceTime, now);
    if (fromLocal) return { state: 'local', ageMs: age, hasTime: age != null };
    if (age == null) return { state: 'delayed', ageMs: null, hasTime: false };
    return {
      state: age <= REALTIME_MAX_AGE_MS ? 'realtime' : 'delayed',
      ageMs: age,
      hasTime: true,
    };
  }

  function worstState(states) {
    var out = 'realtime';
    (states || []).forEach(function (s) {
      if (!s) return;
      if (STATE_RANK[s] > STATE_RANK[out]) out = s;
    });
    return out;
  }

  // =============== 交易时段 / 假日（2.4.1 第四态） ===============
  //
  // ⚠ 一律用 IANA 时区换算（Intl），不写死 +08:00：美/欧有夏令时，
  //   写死偏移会在 DST 前后错一小时。
  var MARKET_SESSIONS = {
    CN:    { tz: 'Asia/Shanghai',    windows: [[570, 690], [780, 900]] },  // 09:30-11:30 / 13:00-15:00
    ETF:   { tz: 'Asia/Shanghai',    windows: [[570, 690], [780, 900]] },
    HK:    { tz: 'Asia/Hong_Kong',   windows: [[570, 720], [780, 960]] },  // 09:30-12:00 / 13:00-16:00
    JP:    { tz: 'Asia/Tokyo',       windows: [[540, 690], [750, 930]] },  // 09:00-11:30 / 12:30-15:30
    KR:    { tz: 'Asia/Seoul',       windows: [[540, 930]] },              // 09:00-15:30
    // 印度 BSE：09:15-15:30 IST（孟买）
    IN:    { tz: 'Asia/Kolkata',     windows: [[555, 930]] },              // 09:15-15:30
    // 越南 HOSE：09:00-11:30 / 13:00-14:45 ICT（胡志明市；14:30-14:45 为收盘集合竞价）
    VN:    { tz: 'Asia/Ho_Chi_Minh', windows: [[540, 690], [780, 885]] },  // 09:00-11:30 / 13:00-14:45
    US:    { tz: 'America/New_York', windows: [[570, 960]] },              // 09:30-16:00
    EU:    { tz: 'Europe/Berlin',    windows: [[540, 1050]] },             // 09:00-17:30（德/法）
    DE:    { tz: 'Europe/Berlin',    windows: [[540, 1050]] },             // Xetra 09:00-17:30 CET
    FR:    { tz: 'Europe/Berlin',    windows: [[540, 1050]] },             // Euronext Paris 09:00-17:30 CET
    UK:    { tz: 'Europe/London',    windows: [[480, 990]] },              // 08:00-16:30
    // 上海金（上金所 Au99.99）：日盘 09:00-15:30，夜盘 20:00-次日 02:30。
    //   · 夜盘窗口右端 1590 > 1440，sessionAt 用 minutes / minutes+1440 双判；
    //   · tail:150 → 周六 00:00-02:30 仍算周五夜盘在交易；
    //   · gapAsPost → 15:30-20:00 这段空档是「已收盘」，不是「午间休市」。
    SGE:   {
      tz: 'Asia/Shanghai', windows: [[540, 930], [1200, 1590]],
      tail: 150, gapAsPost: true,
    },
  };
  var WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  // 24 小时连续、没有交易所式开收盘的市场单独放一张表。
  // ⚠ 刻意**不**并进 MARKET_SESSIONS：src/kline-finalize.mjs 用
  //   `MARKET_SESSIONS[market]` 是否存在来区分「交易所日线」与「24h 市场日线」，
  //   并进同一张表会让 FX 的日 K 定稿走错分支。
  //
  // FX：周一 06:00 开盘 → 周六 06:00 收盘（北京），即固定 22:00 UTC 切日。
  //   这个 06:00 的口径真源是 src/fx-calendar.mjs（kline-finalize / snapshot 都从那里派生）；
  //   浏览器端无法 import ESM，所以这里保留一份同值配置，并由
  //   tests/fx-calendar.test.mjs 交叉校验两处一致（改一处必须改另一处）。
  //   用途仅限「周末判成休市/已收盘」，不参与日 K 定稿。
  var CONTINUOUS_SESSIONS = {
    FX: {
      tz: 'Asia/Shanghai', windows: [[360, 1800]],
      tail: 360, openWeekday: 1,
      note: '24h 连续：周一 06:00 开盘 → 周六 06:00 收盘（= 22:00 UTC 日切）',
    },
  };
  var cfgFor = function (market) { return MARKET_SESSIONS[market] || CONTINUOUS_SESSIONS[market]; };

  /** IANA 时区下的本地年月日/时分/星期 */
  function tzParts(ms, tz) {
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short',
    });
    var o = {};
    fmt.formatToParts(new Date(Number(ms))).forEach(function (p) { o[p.type] = p.value; });
    var hh = Number(o.hour) % 24;
    return {
      y: Number(o.year), m: Number(o.month), d: Number(o.day),
      hh: hh, mm: Number(o.minute), wd: WD[o.weekday],
      date: o.year + '-' + o.month + '-' + o.day,
      minutes: hh * 60 + Number(o.minute),
    };
  }

  /** 某毫秒在指定时区的 UTC 偏移（毫秒） */
  function tzOffsetMs(ms, tz) {
    var p = tzParts(ms, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - Number(ms);
  }

  /** 时区本地「日期 + 当日分钟」→ UTC 毫秒（两遍修正 DST） */
  function zonedToUtc(dateStr, minutes, tz) {
    var a = String(dateStr).split('-').map(Number);
    var hh = Math.floor(minutes / 60);
    var mm = minutes % 60;
    var guess = Date.UTC(a[0], a[1] - 1, a[2], hh, mm);
    var t = guess - tzOffsetMs(guess, tz);
    return guess - tzOffsetMs(t, tz);
  }

  function shiftDate(dateStr, deltaDays) {
    var a = String(dateStr).split('-').map(Number);
    var d = new Date(Date.UTC(a[0], a[1] - 1, a[2] + deltaDays));
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }

  function weekdayOf(dateStr) {
    var a = String(dateStr).split('-').map(Number);
    return new Date(Date.UTC(a[0], a[1] - 1, a[2])).getUTCDay();
  }

  function holidaySet(market, calendar) {
    var cal = calendar || {};
    var cov = cal.coverage || {};
    var arr = (cal.markets && cal.markets[market]) || [];
    var set = {};
    // 超出表覆盖范围 ⇒ 不猜：返回空集合，只按交易时段显示“已收盘”
    if (!cov.from || !cov.to || String(cal.updatedAt || '').length === 0) return set;
    arr.forEach(function (d) { if (d >= cov.from && d <= cov.to) set[d] = 1; });
    return set;
  }

  // =============== 半日市（2.4.7） ===============
  // halfDays 条目：{date:'YYYY-MM-DD', closeTime:'12:00', sessionNote, source}
  // 半日市当天只保留 closeTime 之前的交易窗口；收盘后不再显示「交易中」。
  function parseHm(s) {
    var m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    var hh = Number(m[1]);
    var mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  }

  function halfDayFor(market, date, calendar) {
    var arr = (calendar && calendar.halfDays && calendar.halfDays[market]) || [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].date === date) return arr[i];
    }
    return null;
  }

  /** 某日的有效交易窗口（半日市截断到 closeTime） */
  function sessionWindows(market, date, calendar) {
    var cfg = cfgFor(market);
    if (!cfg) return [];
    var hd = halfDayFor(market, date, calendar);
    if (!hd) return cfg.windows;
    var close = parseHm(hd.closeTime);
    if (close == null) return cfg.windows;
    return cfg.windows
      .map(function (w) { return [w[0], Math.min(w[1], close)]; })
      .filter(function (w) { return w[0] < w[1]; });
  }

  /** 某日的收盘分钟（半日市用 closeTime） */
  function closeMinutesFor(market, date, calendar) {
    var hd = halfDayFor(market, date, calendar);
    if (hd) {
      var c = parseHm(hd.closeTime);
      if (c != null) return c;
    }
    var cfg = cfgFor(market);
    return cfg ? cfg.windows[cfg.windows.length - 1][1] : null;
  }

  /**
   * 某日全部收盘时刻（分钟）。跨日市场（上海金夜盘到 1590）一天有两个收盘，
   * 只取最后一个会把 15:30 的日盘收盘吞掉，所以 lastCloseBefore 用这个列表。
   */
  function closeMinutesAll(market, date, calendar) {
    var cfg = cfgFor(market);
    if (!cfg) return [];
    var hd = halfDayFor(market, date, calendar);
    if (hd) {
      var c = parseHm(hd.closeTime);
      if (c != null) return [c];
    }
    return cfg.windows.map(function (w) { return w[1]; });
  }

  function isTradingDay(market, dateStr, calendar) {
    var wd = weekdayOf(dateStr);
    if (!Number.isFinite(wd) || wd === 0 || wd === 6) return false;
    return !holidaySet(market, calendar)[dateStr];
  }

  /**
   * 当前市场阶段：open / lunch / pre / post / weekend / holiday / unknown
   * @returns {{known:boolean, phase:string, local?:object, tz?:string}}
   */
  function sessionAt(market, now, calendar) {
    var cfg = cfgFor(market);
    if (!cfg) return { known: false, phase: 'unknown' };
    var p = tzParts(now, cfg.tz);
    var hd = halfDayFor(market, p.date, calendar);
    var base = {
      known: true, phase: 'post', local: p, tz: cfg.tz, holiday: false,
      halfDay: !!hd,
      closeTime: hd ? hd.closeTime : null,
    };
    if (holidaySet(market, calendar)[p.date]) {
      base.phase = 'holiday';
      base.holiday = true;
      return base;
    }
    if (p.wd === 0 || p.wd === 6) {
      // 上海金周五夜盘会跨到周六 02:30：周六凌晨仍算交易中，周日整日休市
      if (p.wd === 6 && cfg.tail && p.minutes < cfg.tail) { base.phase = 'open'; return base; }
      base.phase = 'weekend';
      return base;
    }
    var wins = sessionWindows(market, p.date, calendar);
    if (!wins.length) { base.phase = 'post'; return base; }
    // 周一 06:00 之前仍属周末（FX）：此时「昨天窗口跨日」的判定会把 00:00-06:00
    // 误算进周日的窗口，必须先按「本周开盘时刻」挡掉。
    if (cfg.openWeekday != null && p.wd === cfg.openWeekday && p.minutes < wins[0][0]) {
      base.phase = 'weekend';
      return base;
    }
    // 先判「在不在盘中」：跨日品种（上海金）凌晨 00:00-02:30 属于昨天窗口的尾巴，
    // 若先做 p.minutes < wins[0][0] 的盘前判断，会把这段夜盘误判成 pre。
    for (var i = 0; i < wins.length; i++) {
      var a = wins[i][0];
      var b = wins[i][1];
      if ((p.minutes >= a && p.minutes < b) ||
          (b > 1440 && p.minutes + 1440 >= a && p.minutes + 1440 < b)) {
        base.phase = 'open';
        return base;
      }
    }
    var crossDay = wins[wins.length - 1][1] > 1440;
    if (!crossDay && p.minutes < wins[0][0]) { base.phase = 'pre'; return base; }
    for (var k = 0; k < wins.length - 1; k++) {
      if (p.minutes >= wins[k][1] && p.minutes < wins[k + 1][0]) {
        if (cfg.gapAsPost) { base.phase = 'post'; return base; }
        base.phase = 'lunch';
        return base;
      }
    }
    base.phase = 'post';
    return base;
  }

  /** 最近一次已完成的收盘（本地日期 + 收盘分钟 → UTC 毫秒） */
  function lastCloseBefore(market, now, calendar) {
    var cfg = cfgFor(market);
    if (!cfg) return null;
    var p = tzParts(now, cfg.tz);
    for (var i = 0; i <= 14; i++) {
      var date = shiftDate(p.date, -i);
      if (!isTradingDay(market, date, calendar)) continue;
      var ends = closeMinutesAll(market, date, calendar);
      // 同日多个收盘要从晚到早找：上海金 16:00 时最近的收盘是当日 15:30，
      // 而不是当日 02:30（那是前一交易日夜盘的尾巴）。
      for (var j = ends.length - 1; j >= 0; j--) {
        var ms = zonedToUtc(date, ends[j], cfg.tz);
        if (ms <= Number(now)) {
          // date/hm 一律从换算后的时刻反推：跨日收盘（1590 → 次日 02:30）不能直接除 60
          var q = tzParts(ms, cfg.tz);
          return { ms: ms, date: q.date, hm: pad(q.hh) + ':' + pad(q.mm) };
        }
      }
    }
    return null;
  }

  /**
   * 某日「日线那根 bar」的收盘时刻（UTC 毫秒）。
   * 与 lastCloseBefore 的区别：只取**当日日盘**的最后一个收盘，
   *   · 港股 12:00 午休不算收盘（日线要等 16:00）；
   *   · 上海金夜盘 26:30 不算当日日线收盘（日线要等 15:30）。
   * 跨日窗口（end > 1440）一律排除。
   */
  function dayCloseMs(market, dateStr, calendar) {
    var cfg = cfgFor(market);
    if (!cfg) return null;
    var ends = sessionWindows(market, dateStr, calendar)
      .map(function (w) { return w[1]; })
      .filter(function (m) { return m <= 1440; });
    if (!ends.length) return null;
    return zonedToUtc(dateStr, Math.max.apply(null, ends), cfg.tz);
  }

  /** 最近一个「日线已收盘」的交易日（按市场本地日期） */
  function lastClosedDailyDate(market, now, calendar) {
    var cfg = MARKET_SESSIONS[market];
    if (!cfg) return null;
    var p = tzParts(now, cfg.tz);
    for (var i = 0; i <= 14; i++) {
      var d = shiftDate(p.date, -i);
      if (!isTradingDay(market, d, calendar)) continue;
      var ms = dayCloseMs(market, d, calendar);
      if (ms != null && ms <= Number(now)) return d;
    }
    return null;
  }

  function classifySession(sourceTime, now, market, calendar) {
    var age = ageMs(sourceTime, now);
    var info = sessionAt(market, now, calendar);
    if (!info.known) return classifyState(sourceTime, now, false);
    if (age == null) return { state: 'delayed', phase: info.phase, hasTime: false, ageMs: null };
    if (info.phase === 'open') {
      return {
        state: age <= REALTIME_MAX_AGE_MS ? 'realtime' : 'delayed',
        phase: info.phase, hasTime: true, ageMs: age,
      };
    }
    var lc = lastCloseBefore(market, now, calendar);
    var src = Date.parse(sourceTime || '');
    var isHalfPost = !!(info.halfDay && info.phase === 'post' && lc
      && info.local && lc.date === info.local.date);
    // 半日市收盘后：哪怕源仍返回上一交易日的旧价，也归「已收盘」，
    // 不能让提前收市被误标成「延迟」。
    if (isHalfPost && Number.isFinite(src)) {
      return {
        state: 'closed', phase: 'post', hasTime: true, ageMs: age,
        lastClose: lc, halfDay: true,
      };
    }
    // 源时间达到/超过最近一次收盘 ⇒ 这是“收盘价”，不是“陈旧延迟”
    if (lc && Number.isFinite(src) && src >= lc.ms - 2 * 60 * 1000) {
      return {
        state: info.phase === 'holiday' ? 'holiday' : 'closed',
        phase: info.phase, hasTime: true, ageMs: age, lastClose: lc,
        halfDay: isHalfPost,
      };
    }
    return { state: 'delayed', phase: info.phase, hasTime: true, ageMs: age, lastClose: lc };
  }

  /** 相对陈旧度：刚刚 / N 分钟前 / N 小时前 / 昨日收盘 / N 天前 */
  function relativeAge(sourceTime, now, opts) {
    var o = opts || {};
    var age = ageMs(sourceTime, now);
    if (age == null) return '时间未知';
    if (o.daily) {
      var p = bjParts(Number(now));
      var today = p.y + '-' + p.m + '-' + p.d;
      var date = String(o.date || '');
      if (date === today) return '刚刚';
      var yesterday = bjParts(Number(now) - 86400000);
      var y = yesterday.y + '-' + yesterday.m + '-' + yesterday.d;
      if (date === y) return '昨日收盘';
      var days = Math.floor((Date.parse(today + 'T00:00:00+08:00') - Date.parse(date + 'T00:00:00+08:00')) / 86400000);
      return Number.isFinite(days) && days > 1 ? days + ' 天前' : '昨日收盘';
    }
    if (o.yearly) {
      var yp = bjParts(Number(now));
      if (String(o.date || '') === yp.y) return '今年';
      var ys = Number(o.date);
      return Number.isFinite(ys) ? (yp.y - ys) + ' 年前' : '时间未知';
    }
    if (age < 60 * 1000) return '刚刚';
    if (age < 60 * 60 * 1000) return Math.floor(age / 60000) + ' 分钟前';
    if (age < 24 * 60 * 60 * 1000) return Math.floor(age / 3600000) + ' 小时前';
    var pp = bjParts(Number(now));
    var today2 = pp.y + '-' + pp.m + '-' + pp.d;
    var dd = String(o.date || '');
    if (dd && dd !== today2) {
      var y2 = bjParts(Number(now) - 86400000);
      if (dd === y2.y + '-' + y2.m + '-' + y2.d) return '昨日';
    }
    return Math.floor(age / 86400000) + ' 天前';
  }

  function clock(sourceTime, now, withDate) {
    var t = Date.parse(sourceTime || '');
    if (!Number.isFinite(t)) return '';
    var p = bjParts(t);
    if (!withDate) return p.hh + ':' + p.mm;
    var n = bjParts(Number(now));
    return (p.y === n.y ? p.m + '-' + p.d : p.y + '-' + p.m + '-' + p.d) + ' ' + p.hh + ':' + p.mm;
  }

  /**
   * 报价状态。返回卡片文案、汇总文案、页脚文案、状态。
   * @param {{sourceTime?:string, now?:number, fromLocal?:boolean}} o
   */
  function quoteStatus(o) {
    var opts = o || {};
    var now = opts.now == null ? Date.now() : opts.now;
    var fromLocal = !!opts.fromLocal;
    var c = fromLocal
      ? classifyState(opts.sourceTime, now, true)
      : classifySession(opts.sourceTime, now, opts.market, opts.calendar);
    var tm = clock(opts.sourceTime, now, false);
    var age = relativeAge(opts.sourceTime, now, {});
    var label = STATE_LABEL[c.state];
    if (c.state === 'closed' || c.state === 'holiday') {
      var stamp = clock(opts.sourceTime, now, true);
      var lbl = c.state === 'holiday' ? '休市'
        : (c.phase === 'lunch' ? '午间休市'
          : (c.halfDay ? '已收盘（半日市）'
            : (opts.priceSource === 'dailyK' ? '收盘（日线）' : '已收盘')));
      var rel0 = relativeAge(opts.sourceTime, now, {});
      return {
        state: c.state,
        card: lbl + (stamp ? ' · ' + stamp : ''),
        summary: lbl + (stamp ? ' · ' + stamp : '') +
          (rel0 !== '时间未知' ? ' · ' + rel0 : ''),
        footer: '行情 ' + lbl,
        label: lbl,
        ageMs: c.ageMs,
        phase: c.phase,
        halfDay: !!c.halfDay,
      };
    }
    if (c.state === 'local') {
      var data = tm ? '数据时间 ' + tm : '数据时间未知';
      return {
        state: c.state,
        card: '本地快照',
        summary: '本地快照 · ' + data + (age !== '时间未知' ? ' · ' + age : ''),
        footer: '行情 本地快照' + (age !== '时间未知' ? ' ' + age : ''),
        label: label,
        ageMs: c.ageMs,
      };
    }
    if (!c.hasTime) {
      return {
        state: 'delayed',
        card: '延迟（无源时间）',
        summary: '数据时间未知 · 延迟',
        footer: '行情 延迟（无源时间）',
        label: '延迟',
        ageMs: null,
      };
    }
    // 2.9.0：收盘后但源时间还停在该市场收盘之前 ⇒ 这是盘中值，不是收盘价。
    //   11-06 事故：本机 15:52 的 quotes.json 里港股是 15:53（收市竞价前），
    //   卡片只写「延迟」，下游与人都看不出它不能当收盘价。
    if (c.phase === 'post' && c.lastClose) {
      var srcMs = Date.parse(opts.sourceTime || '');
      if (Number.isFinite(srcMs) && srcMs < c.lastClose.ms) {
        var sp = bjParts(srcMs);
        var srcDate = sp.y + '-' + sp.m + '-' + sp.d;
        if (srcDate === c.lastClose.date) {
          return {
            state: 'delayed',
            card: (tm ? tm + ' · ' : '') + '盘中值·未定稿',
            summary: '更新于 ' + tm + ' · ' + age + ' · 盘中值·未定稿（早于收盘 ' + c.lastClose.hm + '）',
            footer: '行情 盘中值·未定稿',
            label: '盘中值·未定稿',
            ageMs: c.ageMs,
            partial: true,
          };
        }
      }
    }
    return {
      state: c.state,
      card: tm + ' · ' + label,
      summary: '更新于 ' + tm + ' · ' + age + ' · ' + label,
      // 实时只写“行情 实时”；延迟才带陈旧度，避免“行情 实时 2 分钟前”的自相矛盾
      footer: c.state === 'realtime' ? '行情 实时' : ('行情 延迟' + (age && age !== '刚刚' ? ' ' + age : '')),
      label: label,
      ageMs: c.ageMs,
    };
  }

  /**
   * 全局标题：不再取跨市场最旧时间。
   * @param {{state:string, sourceTime?:string}[]} items
   */
  function aggregateStatus(items, nowMs) {
    var now = nowMs == null ? Date.now() : nowMs;
    var list = (items || []).filter(function (x) { return x && x.state; });
    if (!list.length) {
      return { state: 'delayed', summary: '行情 未记录', footer: '行情 未记录', label: '延迟' };
    }
    var times = [];
    list.forEach(function (x) {
      var t = Date.parse(x.sourceTime || '');
      if (Number.isFinite(t)) times.push(t);
    });
    var latestISO = times.length ? new Date(Math.max.apply(null, times)).toISOString() : null;
    var latestClock = latestISO ? clock(latestISO, now, false) : '';
    var real = list.filter(function (x) { return x.state === 'realtime'; });
    var closed = list.filter(function (x) { return x.state === 'closed' || x.state === 'holiday'; });
    var delayed = list.filter(function (x) { return x.state === 'delayed'; });

    if (real.length) {
      if (closed.length || delayed.length) {
        var suffix = latestClock ? ' · 最新 ' + latestClock : '';
        return {
          state: 'realtime',
          summary: '部分市场已收盘' + suffix,
          footer: '行情 部分已收盘' + suffix,
          label: '实时',
        };
      }
      var age = relativeAge(latestISO, now, {});
      return {
        state: 'realtime',
        summary: '更新于 ' + latestClock + ' · ' + age + ' · 实时',
        footer: '行情 实时',
        label: '实时',
      };
    }
    if (closed.length && !delayed.length) {
      var allHoliday = closed.every(function (x) { return x.state === 'holiday'; });
      var lbl = allHoliday ? '休市' : '全市场已收盘';
      return {
        state: 'closed',
        summary: lbl + (latestClock ? ' · 最近收盘 ' + latestClock : ''),
        footer: '行情 ' + lbl,
        label: '已收盘',
      };
    }
    if (closed.length && delayed.length) {
      var suffix2 = latestClock ? ' · 最新 ' + latestClock : '';
      return {
        state: 'delayed',
        summary: '部分市场已收盘' + suffix2,
        footer: '行情 部分已收盘' + suffix2,
        label: '延迟',
      };
    }
    // 全部延迟：沿用 2.4.0 的“最旧源时间”口径
    var oldestISO = times.length ? new Date(Math.min.apply(null, times)).toISOString() : null;
    if (!oldestISO) {
      return {
        state: 'delayed',
        summary: '数据时间未知 · 延迟',
        footer: '行情 延迟（无源时间）',
        label: '延迟',
      };
    }
    var oldClock = clock(oldestISO, now, false);
    var oldAge = relativeAge(oldestISO, now, {});
    return {
      state: 'delayed',
      summary: '更新于 ' + oldClock + ' · ' + oldAge + ' · 延迟',
      footer: '行情 延迟' + (oldAge !== '刚刚' ? ' ' + oldAge : ''),
      label: '延迟',
    };
  }

  /** 来源短名：东财 / 新浪 / 腾讯 / 新浪外盘 / 本地预生成 */
  function shortSource(src) {
    var s = String(src || '');
    if (/本地/.test(s)) return '本地预生成';
    if (/东财/.test(s)) return '东财';
    if (/新浪外盘/.test(s)) return '新浪外盘';
    if (/新浪/.test(s)) return '新浪';
    if (/腾讯/.test(s)) return '腾讯';
    return s || '未知来源';
  }

  /**
   * K线头部标记。
   * @param {{src:string, bars:Array, period:string, now?:number, market?:string}} o
   */
  function klineMarker(o) {
    var opts = o || {};
    var now = opts.now == null ? Date.now() : opts.now;
    var bars = Array.isArray(opts.bars) ? opts.bars : [];
    var last = bars.length ? bars[bars.length - 1] : null;
    var bt = last ? parseBarTime(last.t) : null;
    var period = String(opts.period || '1d');
    var isYear = period === '1y';
    var daily = ['1d', '1w', '1M'].indexOf(period) >= 0;
    var fromLocal = /本地/.test(String(opts.src || ''));
    var src = shortSource(opts.src);
    if (!bt) {
      return {
        state: fromLocal ? 'local' : 'delayed',
        full: src + ' · 数据时间未知 · ' + (fromLocal ? '本地快照' : '延迟'),
        short: src + ' · 时间未知 · ' + (fromLocal ? '本地快照' : '延迟'),
      };
    }
    if (isYear) {
      var yp = bjParts(Number(now));
      var sameYear = String(bt.year) === String(yp.y);
      var stateY = fromLocal ? 'local' : (sameYear ? 'realtime' : 'delayed');
      var relY = sameYear ? '今年' : (yp.y - Number(bt.year)) + ' 年前';
      return {
        state: stateY,
        full: src + ' · ' + bt.year + ' · ' + relY + ' · ' + STATE_LABEL[stateY],
        short: src + ' ' + bt.year + ' · ' + relY + ' · ' + STATE_LABEL[stateY],
      };
    }
    var sourceTime = bt.iso;
    var state = classifyState(sourceTime, now, fromLocal).state;
    // 日/周/月：按“bar 日期”判新鲜度；今天算刚刚/实时，昨日及更早算延迟
    if (daily) {
      var p = bjParts(Number(now));
      var today = p.y + '-' + p.m + '-' + p.d;
      if (!fromLocal) state = bt.date === today ? 'realtime' : 'delayed';
      var rel = relativeAge(sourceTime, now, { daily: true, date: bt.date });
      var dateText = isYear ? bt.year : bt.date.slice(5);
      var clockText = isYear ? dateText : dateText;
      // 2.9.0：当日 bar 不一定是收盘价。
      //   · 该市场还在盘中（open/lunch/pre）→ 这根 bar 只是盘中值；
      //   · 来自「本地全量」（服务端每天 12:18 生成）且日期是今天 → 一定是午盘值
      //     （11-06 恒指 24,533.33 vs 收盘 24,481.86）；
      //   · 2.9.2：本地普通日 K 若 generatedAt 仍早于当日收盘 → 也还是盘中值。
      // 三种情况都不许标「实时」，统一改成「盘中值·未定稿」。
      var partial = false;
      var cfg = opts.market && cfgFor(opts.market);
      var mktToday = cfg ? tzParts(Number(now), cfg.tz).date : today;
      // 24h 连续市场（FX）在切日时刻之前，「今天这根」还属于昨天那一根 ⇒ 仍算盘中
      if (cfg && cfg.openWeekday != null) {
        var fxP = tzParts(Number(now), cfg.tz);
        if (fxP.minutes < cfg.windows[0][0]) mktToday = shiftDate(fxP.date, -1);
      }
      var phase = (opts.market && opts.calendar)
        ? sessionAt(opts.market, Number(now), opts.calendar)
        : null;
      var isFullLocal = fromLocal && /全量/.test(String(opts.src || ''));
      if (bt.date === mktToday) {
        if (phase && (phase.phase === 'open' || phase.phase === 'lunch' || phase.phase === 'pre')) {
          partial = true;
        }
        if (isFullLocal) partial = true;
        if (!partial && phase && phase.phase === 'post' && fromLocal) {
          var dataAt = Date.parse(opts.dataAt || '');
          var closeMs = dayCloseMs(opts.market, mktToday, opts.calendar);
          if (Number.isFinite(dataAt) && closeMs != null && dataAt < closeMs) partial = true;
        }
      }
      if (partial) {
        return {
          state: 'delayed',
          full: src + ' · ' + clockText + ' · 盘中值·未定稿',
          short: src + ' ' + clockText + ' · 盘中值',
          partial: true,
        };
      }
      // 2.9.2：当日 bar 存在、但该市场今天休市（假日/周末）→ 不视为收盘
      if (bt.date === mktToday && phase && (phase.phase === 'holiday' || phase.phase === 'weekend')) {
        return {
          state: 'delayed',
          full: src + ' · ' + clockText + ' · 休市日无当日 bar',
          short: src + ' ' + clockText + ' · 休市日无当日 bar',
          invalid: true,
        };
      }
      // 2.9.2：该市场当日已收盘（含半日市、跨时区市场的本地日期）→ 收盘（日线）
      if (bt.date === mktToday && phase && phase.phase === 'post') {
        return {
          state: 'closed',
          full: src + ' · ' + clockText + ' · 收盘（日线）',
          short: src + ' ' + clockText + ' · 收盘（日线）',
          closed: true,
        };
      }
      return {
        state: state,
        full: src + ' · ' + clockText + ' · ' + rel + ' · ' + STATE_LABEL[state],
        short: src + ' ' + clockText + ' · ' + rel + ' · ' + STATE_LABEL[state],
      };
    }
    var rel2 = relativeAge(sourceTime, now, { date: bt.date });
    var tm = bt.hm ? bt.date.slice(5) + ' ' + bt.hm : bt.date.slice(5);
    var tmShort = bt.hm || bt.date.slice(5);
    return {
      state: state,
      full: src + ' · ' + tm + ' · ' + rel2 + ' · ' + STATE_LABEL[state],
      short: src + ' ' + tmShort + ' · ' + rel2 + ' · ' + STATE_LABEL[state],
    };
  }

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error(label + '超时 ' + Math.max(0, ms) + 'ms'));
      }, Math.max(0, ms));
      Promise.resolve(promise).then(
        function (v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } }
      );
    });
  }

  /**
   * 报价预算：东财 1.2s → 腾讯最多 0.8s，总预算 2s。
   * @param {{em:Function, tx:Function, now?:Function, totalBudget?:number,
   *          emBudget?:number, txBudget?:number}} o
   */
  async function runQuoteBudget(o) {
    var opts = o || {};
    var now = opts.now || Date.now;
    var total = opts.totalBudget || QUOTE_TOTAL_BUDGET_MS;
    var emBudget = opts.emBudget || QUOTE_EM_BUDGET_MS;
    var txBudgetCfg = opts.txBudget || QUOTE_TX_BUDGET_MS;
    var t0 = now();
    try {
      var em = await withTimeout(opts.em(), emBudget, '东财报价');
      if (em && em.length) return em;
    } catch (e) { /* 东财失败 → 腾讯 */ }
    var remain = Math.max(0, total - (now() - t0));
    var txBudget = Math.min(txBudgetCfg, remain);
    try {
      var tx = await withTimeout(opts.tx(), txBudget, '腾讯报价');
      if (tx && tx.length) return tx;
    } catch (e) { /* 腾讯也失败 → 本地快照 */ }
    throw new Error('东财/腾讯报价均失败（预算 ' + total + 'ms）');
  }

  var API = {
    REALTIME_MAX_AGE_MS: REALTIME_MAX_AGE_MS,
    QUOTE_TOTAL_BUDGET_MS: QUOTE_TOTAL_BUDGET_MS,
    QUOTE_EM_BUDGET_MS: QUOTE_EM_BUDGET_MS,
    QUOTE_TX_BUDGET_MS: QUOTE_TX_BUDGET_MS,
    STATE_LABEL: STATE_LABEL,
    withTimeout: withTimeout,
    runQuoteBudget: runQuoteBudget,
    parseTencentTime: parseTencentTime,
    fromEpoch: fromEpoch,
    parseBarTime: parseBarTime,
    ageMs: ageMs,
    MARKET_SESSIONS: MARKET_SESSIONS,
    CONTINUOUS_SESSIONS: CONTINUOUS_SESSIONS,
    classifyState: classifyState,
    classifySession: classifySession,
    sessionAt: sessionAt,
    lastCloseBefore: lastCloseBefore,
    dayCloseMs: dayCloseMs,
    lastClosedDailyDate: lastClosedDailyDate,
    halfDayFor: halfDayFor,
    sessionWindows: sessionWindows,
    closeMinutesFor: closeMinutesFor,
    tzParts: tzParts,
    worstState: worstState,
    relativeAge: relativeAge,
    clock: clock,
    quoteStatus: quoteStatus,
    aggregateStatus: aggregateStatus,
    shortSource: shortSource,
    klineMarker: klineMarker,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.MacroQuoteStatus = API;
})(typeof window !== 'undefined' ? window : globalThis);
