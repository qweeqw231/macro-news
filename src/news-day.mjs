// src/news-day.mjs
// 2.4.19：服务端统一入口。实现只有一份（assets/news-day.js），避免两边算法漂移。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ND = require('../assets/news-day.js');

export const DAY_MS = ND.DAY_MS;
export const newsDay = ND.newsDay;
export const newsToday = ND.newsToday;
export const addDays = ND.addDays;
export const newsDayStart = ND.newsDayStart;

/**
 * 2.13.0：新闻日窗口，返回 epoch 秒。
 * 起点 = 新闻日 from 的起点（北京 from 08:00）；
 * 终点 = min(now, 新闻日 to 的起点 + spanMs)，spanMs 默认 1 小时（早报 09:00 出报）。
 * 早报不能用自然日边界 T00:00:00+08:00——那会把新闻日 D-2 的 08:00–24:00 也算进来。
 */
export function newsDayWindow(from, to, now = Date.now(), spanMs = 3600000) {
  const fromTs = Math.floor(newsDayStart(from) / 1000);
  const toTs = Math.floor(Math.min(now, newsDayStart(to) + spanMs) / 1000);
  return { fromTs, toTs };
}
