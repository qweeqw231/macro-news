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
  for (const b of daily) {
    const k = unit === 'month' ? String(b.t).slice(0, 7) : weekKey(b.t);
    if (!cur || k !== curKey) {
      cur = { t: b.t, o: b.o, c: b.c, h: b.h, l: b.l, v: b.v };
      curKey = k;
      out.push(cur);
    } else {
      cur.c = b.c;
      cur.t = b.t;
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.v += b.v;
    }
  }
  return out;
}
