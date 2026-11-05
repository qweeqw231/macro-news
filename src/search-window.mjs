// src/search-window.mjs
// 2.4.19：search.json 的窗口与字段压缩（纯函数，便于测试）。

import { newsToday, addDays } from './news-day.mjs';

export const SEARCH_WINDOW_DAYS = 62;

/** 窗口包含今天 + 前 61 个新闻日 */
export function searchCutoff(now = Date.now()) {
  return addDays(newsToday(now), -(SEARCH_WINDOW_DAYS - 1));
}

export function inSearchWindow(day, now = Date.now()) {
  return String(day) >= searchCutoff(now);
}

/** 只保留检索必需的 6 个字段：标题/来源/时间/链接/ID/时间戳 */
export function compactSearchItem(it) {
  return {
    id: it && it.id,
    ts: it && it.ts,
    time: it && it.time,
    source: it && it.source,
    title: it && it.title,
    url: it && it.url,
  };
}
