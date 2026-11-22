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
import { FX_DAY_CUT_BJ_MINUTES, FX_DAY_CUT_BJ_HM } from './fx-calendar.mjs';

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
 * 无交易时段配置的市场（FX / CMDTY）：日线收盘口径。
 *
 * 这两类市场没有交易所式的开收盘，所以**不能**给它们伪造 MARKET_SESSIONS 配置
 * （那会让 sessionAt/假日表把 24 小时市场判成「休市」）。这里单独定义：
 *
 *   · FX（离岸 CNH / 在岸即期 / 美元对各主要货币）：24 小时连续。
 *     **切日口径的唯一真源是 src/fx-calendar.mjs**：固定 22:00 UTC = 北京 06:00
 *     （实测东财 119.* / 133.* 日 K 开盘价 == 当天 06:01 的 1 分钟 K 开盘价）。
 *     这里只做派生，不再单独写死时刻。
 *   · CMDTY（伦敦金/银、布伦特原油）：准 24 小时，每日约 06:00-07:00 北京短暂休市。
 *     沿用仓库既有口径：**北京 05:00 收盘**（见 assets/market.js 的 klineNote：
 *     「报价源 04:55 冻结，官方 05:00 收盘」）⇒ D 日 bar 到 D+1 05:00 定稿。
 *
 * closeHm 的含义：**D 日那根 bar 的收盘时刻在 D+1 的北京时间分钟数**。
 */
export const NO_SESSION_CLOSE = {
  FX: { closeHm: FX_DAY_CUT_BJ_MINUTES, label: `24h 连续 · 北京 ${FX_DAY_CUT_BJ_HM} 切日 · D+1 ${FX_DAY_CUT_BJ_HM} 定稿` },
  CMDTY: { closeHm: 5 * 60, label: '24h 准连续 · 北京 05:00 收盘 · D+1 05:00 定稿' },
};

/**
 * 日 K 末根「盘中更新」的固定窗口（北京小时，2026-11-22）。
 *
 * 为什么不是每个小时都写：末根每轮重写整个文件，实测 38 个日 K 文件每天 5~13 次
 * 重写，占 data/kline 对象体积的 57%。把**盘中更新**压到每天 4 轮后，末根最多滞后
 * 约 6 小时；而**收盘定稿**不受此窗口限制（仍在收盘后第一轮执行，最坏滞后约 1 小时），
 * 所以收盘价不会晚 6 小时。
 */
export const OPEN_REFRESH_BJ_HOURS = [2, 8, 14, 20];

/** now 是否落在盘中更新窗口内（北京时间整点小时） */
export function inOpenRefreshWindow(nowMs = Date.now()) {
  return OPEN_REFRESH_BJ_HOURS.includes(Math.floor(bjNow(nowMs).minutes / 60));
}

/** 同一窗口内 :02 / :17 两次触发的最小间隔；挡住第二次，避免一天写出 8 版 */
export const OPEN_REFRESH_MIN_GAP_MS = 5 * 3600 * 1000;

/**
 * 盘中更新是否放行：既要在 4 个窗口内，又要距上次写入 ≥5 小时。
 * 收盘定稿不走这里（不受窗口与间隔限制）。
 */
export function openRefreshAllowed(nowMs, generatedAt) {
  if (!inOpenRefreshWindow(nowMs)) return false;
  const t = Date.parse(generatedAt || '');
  if (Number.isFinite(t) && nowMs - t < OPEN_REFRESH_MIN_GAP_MS) return false;
  return true;
}

/**
 * 无时段市场「最近一根已经收完的 bar 日期」。
 * 与 lastClosedBarDate 的区别：只处理 FX / CMDTY，不查 MARKET_SESSIONS。
 */
export function lastClosedNoSessionDate(market, nowMs = Date.now()) {
  const rule = NO_SESSION_CLOSE[market];
  if (!rule) return null;
  const bj = bjNow(nowMs);
  // 今天的 closeHm 已过 ⇒ 昨天那根已收完；未过 ⇒ 前天那根才是最后一根已收完的
  return shiftDate(bj.date, bj.minutes >= rule.closeHm ? -1 : -2);
}

/**
 * 某根 bar 的收盘时刻（UTC 毫秒）。
 *   · 有交易时段配置的市场：交给 QS.dayCloseMs；
 *   · FX / CMDTY：D+1 的 closeHm（北京）换算成 UTC。
 */
export function barCloseMs(market, date, calendar = CAL) {
  if (QS.MARKET_SESSIONS[market]) return QS.dayCloseMs(market, date, calendar);
  const rule = NO_SESSION_CLOSE[market];
  if (!rule) return null;
  const [y, m, d] = String(date).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d + 1) + rule.closeHm * 60 * 1000 - 8 * 3600 * 1000;
}

/**
 * 某个市场在 now 时刻「允许写进日 K 的最后一根 bar 日期」。
 *   · 有交易时段配置的市场：最近一次收盘的日期；
 *   · CMDTY（伦敦金/银/布伦特，24h）：05:00 北京收盘，05:00 前连昨天的 bar 都没收完；
 *   · FX（离岸/在岸即期，24h）：北京 06:00 切日（见 src/fx-calendar.mjs），
 *     06:00 前今天那根还没收完。
 * @returns {string|null} null = 无法判定，调用方不要过滤
 */
export function lastClosedBarDate(market, nowMs = Date.now(), calendar = CAL) {
  if (QS.MARKET_SESSIONS[market]) {
    // 用「日线收盘」而不是「最近一次收盘」：
    //   · 港股 12:00 午休不是日线收盘；
    //   · 上海金 02:30 是昨夜盘尾巴，日线要等 15:30。
    return QS.lastClosedDailyDate(market, Number(nowMs), calendar);
  }
  return lastClosedNoSessionDate(market, nowMs);
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
 *   open     ：当前在交易时段（或 24h 品种已有「尚未收盘」的新 bar）→ 照旧每轮 upsert
 *   finalize ：已收盘，且这根收盘 bar 还没在收盘后写过 → 补一次
 *   skip     ：其余
 * @param {string} market
 * @param {number} nowMs
 * @param {{generatedAt?:string, lastBar?:string, srcLast?:string}} state 现有文件的状态
 *   srcLast = 源侧当前最后一根 bar 的日期（只有 FX / CMDTY 这类无交易时段的市场需要，
 *   由调用方先抓一次最近几根再传进来；其它市场不看它）
 */
export function writePlan(market, nowMs, state = {}, calendar = CAL) {
  const noSession = NO_SESSION_CLOSE[market];
  if (!QS.MARKET_SESSIONS[market] && !noSession) return { action: 'skip', reason: 'no-session' };

  // ---- FX / CMDTY：24h 或准 24h，没有交易所时段表，按上面的 NO_SESSION_CLOSE 定稿 ----
  if (noSession) {
    const now = Number(nowMs);
    const closedDate = lastClosedNoSessionDate(market, now);
    const lastBar = String(state.lastBar || '');
    const srcLast = String(state.srcLast || '');
    // 文件里已有比「最后一根已收完的 bar」更新的 bar（24h 品种的当天 bar、
    // 上海金夜盘写出的下一交易日 bar）⇒ 它还在变化，走 open 每轮 upsert。
    if (lastBar && closedDate && lastBar > closedDate) {
      return { action: 'open', reason: 'in-progress-bar' };
    }
    // 2026-11-18 事故（xau 缺 11-18 日 K）：CMDTY 在 05:00 后定稿的是昨天那根，
    // 而源侧的「今天这根」往往要到定稿那一轮之后才出现。此时文件 lastBar == closedDate
    // 且已定稿 ⇒ 下面的 already-finalized 会永久 skip，这根在途 bar 再也没有路径被创建。
    // ⇒ 定稿状态不能只看文件，还要看源侧：源侧已经有比 closedDate 更新的 bar 就必须 open。
    //   open 会 upsert 最近几根，顺带把已定稿那根按源侧重述值覆盖（收盘价会被修正）。
    if (srcLast && closedDate && srcLast > closedDate) {
      return { action: 'open', reason: 'source-newer-bar' };
    }
    const closeMs = barCloseMs(market, closedDate, calendar);
    if (closeMs == null || now - closeMs < 2 * 60 * 1000) {
      return { action: 'skip', reason: 'close-buffer' };
    }
    const writtenAt = Date.parse(state.generatedAt || '');
    const barDone = lastBar === closedDate
      && Number.isFinite(writtenAt)
      && writtenAt >= closeMs;
    if (barDone) {
      return { action: 'skip', reason: 'already-finalized', close: { date: closedDate, ms: closeMs } };
    }
    return { action: 'finalize', reason: 'post-close-missing', close: { date: closedDate, ms: closeMs } };
  }

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
