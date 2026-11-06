// src/kline-finalize.mjs
// 「收盘定稿」的纯逻辑：判断某市场最近一次收盘是哪一天、哪些 bar 还不能入库。
//
// 2026-11-06 事故：kline 的当日 bar 一直是盘中值——
//   · <key>_full.json 每天 12:18 生成，港股 16:00 才收盘 ⇒ 24,533.33 是午盘价；
//   · <key>.json 由 update-kline-last 维护，它只在「当前处于交易时段」时写，
//     16:19 港股已收盘 ⇒ 收盘那一根永远不落。
//
// 这里复用 assets/quote-status.js 的时区 / 交易时段 / 假日 / 半日市模型，
// 不另造一套（这是 2.4.1 以来唯一的时段真源）。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QS = require('../assets/quote-status.js');

export const CAL = JSON.parse(
  readFileSync(new URL('../assets/market-calendar.json', import.meta.url), 'utf8')
);

const pad = (n) => String(n).padStart(2, '0');

/** 北京时间（UTC+8）的日期 / 分钟 */
export function bjNow(nowMs = Date.now()) {
  const t = new Date(Number(nowMs) + 8 * 3600 * 1000);
  return {
    date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
  };
}

function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * 某市场「最近一次已经收完的交易日」。
 * 直接复用 QS.lastCloseBefore：它已经处理了跨日（上海金夜盘）、半日市、假日。
 * @returns {{ms:number,date:string,hm:string}|null}
 */
export function lastCompletedClose(market, nowMs = Date.now(), calendar = CAL) {
  if (!QS.MARKET_SESSIONS[market]) return null;
  return QS.lastCloseBefore(market, Number(nowMs), calendar);
}

/**
 * 某个市场在 now 时刻「允许写进日 K 的最后一根 bar 日期」。
 *   · 有交易时段配置的市场：最近一次收盘的日期；
 *   · CMDTY（伦敦金/银/布伦特，24h）：05:00 北京收盘，05:00 前连昨天的 bar 都没收完；
 *   · FX（人民币中间价）：09:15 发布，发布后当天的 bar 就是定稿。
 * @returns {string|null} null = 无法判定，调用方不要过滤
 */
export function lastClosedBarDate(market, nowMs = Date.now(), calendar = CAL) {
  if (QS.MARKET_SESSIONS[market]) {
    // 用「日线收盘」而不是「最近一次收盘」：
    //   · 港股 12:00 午休不是日线收盘；
    //   · 上海金 02:30 是昨夜盘尾巴，日线要等 15:30。
    return QS.lastClosedDailyDate(market, Number(nowMs), calendar);
  }
  const bj = bjNow(nowMs);
  if (market === 'FX') return bj.date;
  if (market === 'CMDTY') {
    // 一天一根的 24h 品种：05:00 收盘。05:00 前，昨天那根也还没收完。
    return shiftDate(bj.date, bj.minutes < 5 * 60 ? -2 : -1);
  }
  return null;
}

/** 时间键：对象行取 t，数组行取 [0] */
export const barDate = (b) => String(Array.isArray(b) ? b[0] : (b && b.t) || '');

/**
 * 剔除「尚未收盘」的当天 bar。
 * @returns {{bars:Array, dropped:string[], cutoff:string|null}}
 */
export function dropUnclosedBars(bars, market, nowMs = Date.now(), calendar = CAL) {
  const list = Array.isArray(bars) ? bars : [];
  const cutoff = lastClosedBarDate(market, nowMs, calendar);
  if (!cutoff) return { bars: list, dropped: [], cutoff: null };
  const kept = list.filter((b) => barDate(b) <= cutoff);
  const dropped = list.filter((b) => barDate(b) > cutoff).map(barDate);
  return { bars: kept, dropped, cutoff };
}

/**
 * update-kline-last 的写盘计划。
 *   open     ：当前在交易时段 → 照旧每轮 upsert（含夜盘“未来蜡烛”）
 *   finalize ：已收盘，且这根收盘 bar 还没在收盘后写过 → 补一次
 *   skip     ：其余
 * @param {string} market
 * @param {number} nowMs
 * @param {{generatedAt?:string, lastBar?:string}} state 现有文件的状态
 */
export function writePlan(market, nowMs, state = {}, calendar = CAL) {
  if (!QS.MARKET_SESSIONS[market]) return { action: 'skip', reason: 'no-session' };
  const now = Number(nowMs);
  const info = QS.sessionAt(market, now, calendar);
  if (info.known && info.phase === 'open') return { action: 'open', reason: 'in-session' };

  // 只有「今天这个交易日已经走完日盘收盘」才谈得上定稿：
  //   午休 / 盘前 / 周末 / 假日时，最近一次日线收盘是昨天，不该在今天补写。
  const p = QS.tzParts(now, QS.MARKET_SESSIONS[market].tz);
  const closedDate = QS.lastClosedDailyDate(market, now, calendar);
  if (!closedDate || closedDate !== p.date) {
    return { action: 'skip', reason: 'no-day-close-today' };
  }
  const closeMs = QS.dayCloseMs(market, closedDate, calendar);
  // 收盘后 2 分钟缓冲：给源侧最后一笔成交留出落地时间
  if (closeMs == null || now - closeMs < 2 * 60 * 1000) {
    return { action: 'skip', reason: 'close-buffer' };
  }
  const writtenAt = Date.parse(state.generatedAt || '');
  const barDone = state.lastBar === closedDate
    && Number.isFinite(writtenAt)
    && writtenAt >= closeMs;
  if (barDone) {
    return { action: 'skip', reason: 'already-finalized', close: { date: closedDate, ms: closeMs } };
  }
  return { action: 'finalize', reason: 'post-close-missing', close: { date: closedDate, ms: closeMs } };
}
