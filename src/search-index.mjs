// src/search-index.mjs
// 2.33.1：把 search.json（热段）的构建从 collect.mjs 抽成共用实现。
//
// 为什么要抽：检索索引自 2.33.1 起**不进 git**，改由 Pages 部署时现算
//   （scripts/build-search.mjs，见 docs/search-index-build.md）。
//   若「采集期写盘」与「部署期生成」各写一套，total / fromHistory / hotFrom
//   这类口径必然漂移——2.30.0 已经踩过一次「全库 N 条」退化成热段条数。
//   这里只做纯计算 + 读盘，不写盘，由调用方决定落哪。
//
// 口径与 2.30.0 完全一致：
//   · items 只放热段（最近 HOT_WINDOW_DAYS 个新闻日）；
//   · windowDays / from / total 仍按 62 天窗口统计；
//   · 窗口内「归档页判定走 history」的日期，这里也从 history 切片取条目；
//   · 跨日重复 id 保留更早那天的归属（与 2.29.0 同一判据）。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { searchCutoff, compactSearchItem, SEARCH_WINDOW_DAYS } from './search-window.mjs';
import { historyItemToSearch, hotCutoff, HOT_WINDOW_DAYS } from './search-history.mjs';
import { newsDay } from './news-day.mjs';

const requireCjs = createRequire(import.meta.url);
// assets/day-source.js 是 UMD 纯函数，与归档卡片共用同一套「archive 还是 history」阈值。
const { decideDaySource } = requireCjs('../assets/day-source.js');

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 构建 data/search.json 的内容。
 *
 * @param {{ dataDir: string, now?: number, generatedAt?: string }} opts
 *   dataDir      data 目录（测试可指向临时目录）
 *   now          窗口基准时刻，默认当前时间；newsDay 边界以北京 08:00 为日界
 * @returns {{ doc: object, stats: {
 *   days: number, fromHistory: number, total: number, hotTotal: number, dupMerged: number
 * } }}
 */
export function buildHotSearchDoc({ dataDir, now = Date.now(), generatedAt = new Date(now).toISOString() }) {
  const archiveDir = path.join(dataDir, 'archive');
  const files = fs.existsSync(archiveDir)
    ? fs.readdirSync(archiveDir).filter((f) => f.endsWith('.json'))
    : [];

  const searchFrom = searchCutoff(now);
  const hotFrom = hotCutoff(now);

  // 2.22.0：窗口内「归档页判定走 history」的日期，search.json 也要从 history 取条目。
  // 不这么做就会出现「卡片 260 条、搜索只命中 3 条」（09-15~10-04 实测）。
  const histIdx = readJSON(path.join(dataDir, 'history', 'index.json'), { days: [] });
  const histCount = new Map((histIdx.days || []).map((x) => [x.d, Number(x.n) || 0]));

  const searchItems = [];
  let searchDays = 0;
  let searchFromHistory = 0;
  // 日期集合取「archive ∪ history」：只有 history 切片、没有 archive 文件的日期也要进循环。
  const archiveDays = files.map((f) => f.replace('.json', '')).filter((d) => d >= searchFrom);
  const historyOnly = [...histCount.keys()].filter((d) => d >= searchFrom && !archiveDays.includes(d));
  for (const day of [...archiveDays, ...historyOnly].sort().reverse()) {
    const d = readJSON(path.join(archiveDir, `${day}.json`), { items: [] });
    const h = histCount.get(day) || 0;
    const dec = decideDaySource({ archiveCount: d.items.length, historyCount: h });
    if (dec.kind === 'history') {
      const hist = readJSON(path.join(dataDir, 'history', `${day}.json`), null);
      if (hist && Array.isArray(hist.items)) {
        for (const it of hist.items) searchItems.push(historyItemToSearch(it));
        searchDays++;
        searchFromHistory++;
        continue;
      }
    }
    for (const it of d.items) searchItems.push(compactSearchItem(it));
    searchDays++;
  }

  // 2.29.0：同一 id 只保留一次。历史 archive 里存在跨日重复（同一 url 的 showTime 漂移，
  //   让同一 id 同时写进相邻两个新闻日，实测 315 组）。迭代顺序是新→旧，后来的（更早那天）
  //   覆盖前面的，即保留更早那天的归属；位置沿用首次出现处，排序行为不变。
  const idxById = new Map();
  const searchDeduped = [];
  for (const it of searchItems) {
    const id = it && it.id;
    if (!id) {
      searchDeduped.push(it);
      continue;
    }
    const at = idxById.get(id);
    if (at === undefined) {
      idxById.set(id, searchDeduped.length);
      searchDeduped.push(it);
    } else {
      searchDeduped[at] = it;
    }
  }

  // 热段 = 新闻日 >= hotFrom 的条目。去重时若同一 id 跨了热段边界，保留的是更早那天
  // ⇒ 它落在分片侧，热段里不再重复出现。
  const hotItems = searchDeduped.filter((it) => newsDay(it.time || generatedAt) >= hotFrom);

  const doc = {
    generatedAt,
    windowDays: SEARCH_WINDOW_DAYS,
    hotDays: HOT_WINDOW_DAYS,
    from: searchFrom,
    hotFrom,
    days: searchDays,
    fromHistory: searchFromHistory,
    total: searchDeduped.length,
    hotTotal: hotItems.length,
    items: hotItems,
  };
  return {
    doc,
    stats: {
      days: searchDays,
      fromHistory: searchFromHistory,
      total: searchDeduped.length,
      hotTotal: hotItems.length,
      dupMerged: searchItems.length - searchDeduped.length,
    },
  };
}
