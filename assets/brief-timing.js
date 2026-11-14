/* assets/brief-timing.js
 * 早报「生成时点」分档（2.20.0）。纯函数；浏览器挂到 window.MacroBriefTiming，Node 测试可 require。
 *
 * 为什么单独拿出来：11-14 的早报卡片只写「00:12 生成」，而它实际是 11-15 00:12 生成的
 * （晚 15 小时 12 分）。读者会把「00:12」理解成 11-14 凌晨，跨日迟到则完全静默。
 * 判据以「该新闻日 D 的 09:00」为准（cron `0 9 * * *`），四档互斥，优先级从高到低：
 *
 *   ① backfill   产物带 backfill 章 ⇒「补写于 MM-DD HH:MM」
 *                补写是事后追认，不是迟到，所以这一档**不写「晚到」**；
 *   ② late-cross 实际生成日 > D    ⇒「MM-DD HH:MM 生成 · 跨日 晚到 X」
 *                必须带日期，否则和 D 日当天分不开；
 *   ③ late-same  同日，但晚于 09:00 超过 30 分钟 ⇒「HH:MM 生成 · 晚到 X」
 *   ④ on-time    09:00 起 30 分钟内 ⇒「HH:MM 生成」（正常情况不加任何噪音）
 *
 * 30 分钟的依据：正常批次实测落在 09:02–09:11（11 天样本），阈值是最坏值的近 3 倍，
 * 排队抖动不会误报；而实测异常的 11-01(3h12m)、11-11(9h43m)、11-12(4h22m)、
 * 11-14(跨日 15h12m) 都远超 30 分钟，不会被吞进「按时」。
 *
 * 所有时分一律按**北京墙钟**（+08:00）取：产物时间是 +08:00，window 区间也是这个口径，
 * 且跨日判定不能随读者浏览器时区漂移。
 */
(function (global) {
  'use strict';

  var LATE_MIN = 30;
  var p2 = function (n) { return String(n).padStart(2, '0'); };

  /** ISO → 北京墙钟的 {day, md, hm}；不可解析返回 null */
  function bjWall(iso) {
    var t = Date.parse(iso || '');
    if (!isFinite(t)) return null;
    var d = new Date(t + 8 * 3600 * 1000);
    return {
      day: d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()),
      md: p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()),
      hm: p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()),
    };
  }

  /** 分钟数 → 「9 小时 43 分」/「12 分」 */
  function lateSpan(min) {
    var m = Math.max(0, Math.floor(min));
    var h = Math.floor(m / 60);
    var r = m % 60;
    return h ? h + ' 小时' + (r ? ' ' + r + ' 分' : '') : r + ' 分';
  }

  /**
   * @param {string} day 早报的新闻日键（YYYY-MM-DD）
   * @param {string} at  实际生成时刻（ISO，带时区）
   * @param {boolean} backfill 产物是否带补写章
   * @returns {{kind:string, lateMin:number, text:string}|null}
   */
  function briefTiming(day, at, backfill) {
    var w = bjWall(at);
    if (!w) return null;
    if (backfill) return { kind: 'backfill', lateMin: 0, text: '补写于 ' + w.md + ' ' + w.hm };
    var key = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? String(day) : '';
    var exp = key ? Date.parse(key + 'T09:00:00+08:00') : NaN;
    var t = Date.parse(at);
    var late = isFinite(exp) && isFinite(t) ? Math.floor((t - exp) / 60000) : 0;
    if (key && w.day > key) {
      return {
        kind: 'late-cross',
        lateMin: late,
        text: w.md + ' ' + w.hm + ' 生成 · 跨日 晚到 ' + lateSpan(late),
      };
    }
    if (late > LATE_MIN) {
      return { kind: 'late-same', lateMin: late, text: w.hm + ' 生成 · 晚到 ' + lateSpan(late) };
    }
    return { kind: 'on-time', lateMin: Math.max(0, late), text: w.hm + ' 生成' };
  }

  /** ISO → 「MM-DD HH:MM」（补写时刻用，跨日时不至于写成「今天 00:51」） */
  function bjStamp(iso) {
    var w = bjWall(iso);
    return w ? w.md + ' ' + w.hm : '';
  }

  var API = { BRIEF_LATE_MIN: LATE_MIN, bjWall: bjWall, lateSpan: lateSpan, briefTiming: briefTiming, bjStamp: bjStamp };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.MacroBriefTiming = API;
})(typeof window !== 'undefined' ? window : globalThis);
