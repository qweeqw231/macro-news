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
  var STATE_LABEL = { realtime: '实时', delayed: '延迟', local: '本地快照' };
  var STATE_RANK = { realtime: 0, delayed: 1, local: 2 };
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
    var c = classifyState(opts.sourceTime, now, !!opts.fromLocal);
    var tm = clock(opts.sourceTime, now, false);
    var age = relativeAge(opts.sourceTime, now, {});
    var label = STATE_LABEL[c.state];
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
    classifyState: classifyState,
    worstState: worstState,
    relativeAge: relativeAge,
    clock: clock,
    quoteStatus: quoteStatus,
    shortSource: shortSource,
    klineMarker: klineMarker,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.MacroQuoteStatus = API;
})(typeof window !== 'undefined' ? window : globalThis);
