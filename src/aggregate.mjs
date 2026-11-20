// src/aggregate.mjs
// 日 K → 周 K / 月 K 的聚合（**后端预生成**与**前端兜底**共用同一套口径）
//
// 为什么放在共享模块里：
//   · 后端（src/portfolio-collect.mjs、scripts/backfill-cgb1y.mjs）把日K 聚合成
//     `data/kline/<key>_1w.json` / `<key>_1M.json`，前端点「周K/月K」直接读小文件
//     （1Y 国债的日K 文件有 500KB，线上按本机 5~30 KB/s 的带宽重下一次要 20~100 秒）；
//   · 前端（assets/market.js）在本地没有对应周期文件时仍会用同一套规则在浏览器端聚合
//     —— 两边口径必须一致，所以规则只写一份。
//
// 口径：
//   · 周：按**周一**分桶（ISO 周），键取该周的周一日期；
//   · 月：按 `YYYY-MM` 分桶；
//   · 每根 bar：开=区间首日开、收=区间末日收、高=区间内最高、低=区间内最低、量=累加。
//
// 2.18.0：`z`（仅收盘）向上聚合 —— 只有**整根聚合 bar 的所有日线都是 closeOnly** 时才带 z。
//   否则 0 会被当成真实高低，把周/月 K 的 y 轴拉平（csi300_1w 150 根、_1M 36 根就是这样来的）。

/** 日线是否 closeOnly（与 src/kline-guard.mjs 的口径一致，这里避免循环依赖） */
const isCloseOnly = (b) => (b && (b.z === 1 || b.z === true)) ||
  (b && +b.o === 0 && +b.h === 0 && +b.l === 0 && +b.c > 0);

/** 时间键：对象行取 t、紧凑数组行取 [0]（与 kline-guard.barTime 同口径，这里避免循环依赖） */
export const barTimeOf = (b) => (Array.isArray(b) ? String(b[0]) : String((b && b.t) || ''));

/**
 * 周/月 K 的「周期键」：同一周期只能有一根 bar。
 *   · month → `YYYY-MM`
 *   · week  → 该周周一的 `YYYY-MM-DD`（ISO 周）
 */
export function periodKey(t, unit) {
  const s = String(t || '');
  if (unit === 'month') return s.slice(0, 7);
  const d = new Date(s.slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d)) return s;
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * 2.28.0：收敛同一周/月内的重复 bar（只保留最后一根）。
 *
 * 背景：未走完的周/月桶，其 bar 的 `t` 是「该桶内最后一根日线」，每天前移
 *   （2026-11-18 → 11-19）。kline-guard.decideBars 因此认为新序列「缺旧末根键」，
 *   走 merge 并集 ⇒ 新旧两个桶都保留 ⇒ 每天多一根，逐日累积。
 *   xau_1M 的 2026-11 从 1 根长到 12 根就是这么来的（2026-11-04 引入）。
 *   `t` 每天变是数据源口径，不能改；能保证的不变量是「一个周期只有一根」。
 *
 * 为什么保留最后一根：重复桶的 o/h 固定为区间首日开与区间最高、l 逐日下探、
 *   c 是当日收、v 累加 ⇒ 最后一根就是该周期最新的累计值（与 aggregateDaily 口径一致）。
 *
 * @param {Array} bars 周/月 bars（对象行或紧凑数组行，按时间升序）
 * @param {'week'|'month'} unit
 * @returns {{bars:Array, collapsed:number, periods:Object<string,number>}} periods = 发生重复的周期 → 该周期原有根数（便于日志/报告）
 */
export function collapsePeriodDuplicates(bars, unit) {
  const list = Array.isArray(bars) ? bars : [];
  const out = [];
  const seen = new Map(); // 周期键 → out 下标
  let collapsed = 0;
  const periods = {};
  for (const b of list) {
    const k = periodKey(barTimeOf(b), unit);
    if (seen.has(k)) {
      out[seen.get(k)] = b; // 同周期：保留最后（最新）一根，位置不变
      collapsed++;
      periods[k] = (periods[k] || 1) + 1;
    } else {
      seen.set(k, out.length);
      out.push(b);
    }
  }
  return { bars: out, collapsed, periods };
}

/**
 * 把日 K 序列聚合成周 K 或月 K。
 * @param {Array<{t:string,o:number,c:number,h:number,l:number,v:number}>} daily 日K（按时间升序）
 * @param {'week'|'month'} unit
 * @returns {Array<{t:string,o:number,c:number,h:number,l:number,v:number}>}
 */
export function aggregateDaily(daily, unit) {
  const weekKey = (t) => {
    const d = new Date(String(t).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(d)) return String(t);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // 该周的周一
    return d.toISOString().slice(0, 10);
  };
  const out = [];
  let cur = null;
  let curKey = '';
  let curZ = false;
  for (const b of daily) {
    const k = unit === 'month' ? String(b.t).slice(0, 7) : weekKey(b.t);
    if (!cur || k !== curKey) {
      cur = { t: b.t, o: b.o, c: b.c, h: b.h, l: b.l, v: b.v };
      curKey = k;
      curZ = isCloseOnly(b);
      out.push(cur);
    } else {
      cur.c = b.c;
      cur.t = b.t;
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.v += b.v;
      curZ = curZ && isCloseOnly(b);
    }
    if (curZ) cur.z = 1;
    else delete cur.z;
  }
  return out;
}
