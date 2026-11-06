// src/quote-finalize.mjs
// 收盘后「源时间滞后」的指数改用日 K 收盘价定稿。
//
// 背景（2026-11-06）：印度 BSE 18:00（北京）收盘，但东财 SENSEX 的 f124 时间戳
// 停在 17:45，价格直到 18:23 才变成收盘价 81,028.02。前端按「数据时点 < 收盘时刻」
// 判定，于是 20:00 还显示「17:45 · 盘中值·未定稿」——标签没错，错的是源时间。
//
// 规则不按市场写分支：任何有交易时段配置的市场，只要
//   · 当前处于 post（当天日线收盘已过 + 2 分钟缓冲）
//   · 报价源时间早于该市场当日收盘
// 就用日 K 的当日收盘覆盖，并把 asOf 写成收盘时刻、priceSource 标 dailyK。
// 取不到日 K 时保持原样，前端继续标「HH:MM · 盘中值·未定稿」。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const QS = require('../assets/quote-status.js');

export const CAL = JSON.parse(
  readFileSync(new URL('../assets/market-calendar.json', import.meta.url), 'utf8')
);

const pad = (n) => String(n).padStart(2, '0');

/** UTC 毫秒 → 北京时间 ISO（与 quotes.json 的 updatedAt 同口径） */
export function bjIso(ms) {
  const t = new Date(Number(ms) + 8 * 3600 * 1000);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00+08:00`
  );
}

/**
 * 这条报价是否需要在收盘后用日 K 定稿。
 * @returns {{date:string, closeMs:number, asOf:string}|null}
 */
export function closedQuoteNeedsDaily(q, market, nowMs, calendar = CAL) {
  if (!QS.MARKET_SESSIONS[market]) return null;
  const now = Number(nowMs);
  const info = QS.sessionAt(market, now, calendar);
  if (info.phase !== 'post') return null;

  const p = QS.tzParts(now, QS.MARKET_SESSIONS[market].tz);
  const closedDate = QS.lastClosedDailyDate(market, now, calendar);
  if (!closedDate || closedDate !== p.date) return null;   // 今天日线还没收

  const closeMs = QS.dayCloseMs(market, closedDate, calendar);
  if (closeMs == null || now - closeMs < 2 * 60 * 1000) return null; // 收盘缓冲

  const src = Date.parse(q.updatedAt || q.asOf || '');
  if (Number.isFinite(src) && src >= closeMs) return null;  // 源时间已过收盘：本来就对
  return { date: closedDate, closeMs, asOf: bjIso(closeMs) };
}

/** 把日 K 收盘价写进报价（保留 open/high/low/prevClose，重算 changePct） */
export function applyDailyClose(q, bar, need) {
  const price = Number(bar && bar.c);
  if (!Number.isFinite(price)) return q;
  const prev = Number(q.prevClose);
  return {
    ...q,
    price,
    asOf: need.asOf,
    updatedAt: need.asOf,
    priceSource: 'dailyK',
    closeDate: need.date,
    note: 'close-daily',
    changePct: Number.isFinite(prev) && prev > 0
      ? Number((((price - prev) / prev) * 100).toFixed(4))
      : q.changePct,
  };
}

/**
 * 批量定稿。只对有 secid 的标的发请求；上一轮已经定稿且同一天的直接复用，
 * 避免每 15 分钟重复打日 K。
 * @param {object[]} quotes
 * @param {{now:number, prevQuotes?:object[], meta:Map<string,object>, fetchDailyK:Function, calendar?:object}} opts
 * @returns {Promise<{quotes:object[], changes:object[]}>}
 */
export async function finalizeClosedQuotes(quotes, opts) {
  const {
    now, prevQuotes = [], meta, fetchDailyK, calendar = CAL,
  } = opts;
  const prev = new Map((prevQuotes || []).map((q) => [q.key, q]));
  const out = [];
  const changes = [];

  for (const q of quotes || []) {
    const m = meta && meta.get(q.key);
    const need = m && m.secid
      ? closedQuoteNeedsDaily(q, m.market || q.market, now, calendar)
      : null;
    if (!need) { out.push(q); continue; }

    const p = prev.get(q.key);
    if (p && p.priceSource === 'dailyK' && p.closeDate === need.date && p.updatedAt === need.asOf) {
      out.push({
        ...q,
        price: p.price,
        asOf: p.asOf,
        updatedAt: p.updatedAt,
        priceSource: 'dailyK',
        closeDate: p.closeDate,
        note: 'close-daily',
      });
      continue;
    }

    try {
      const map = await fetchDailyK(m.secid, m.tx);
      const bar = map && map.get(need.date);
      if (!bar) { out.push(q); continue; }
      const nq = applyDailyClose(q, bar, need);
      out.push(nq);
      changes.push({ key: q.key, from: q.updatedAt, to: nq.updatedAt, price: nq.price });
    } catch {
      out.push(q);
    }
  }
  return { quotes: out, changes };
}
