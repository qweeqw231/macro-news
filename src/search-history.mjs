// src/search-history.mjs
// 2.22.0：把 data/history 的 337 天切片做成「按月分片」的检索索引。
//
// 为什么按月分片而不是单文件（实测 2026-11-15，见 CHANGELOG 2.22.0）：
//   · 337 天 77,256 条塞进一个 search.json：gzip 7.83 MB，Fuse 查询 705 ms/次；
//   · 按月切 12 片：合计 gzip 5.41 MB，单片 0.35~0.55 MB，单月 Fuse 查询 ~27 ms；
//   · 前端只在用户显式点「在全部历史中搜索」时才拉，首屏与首搜成本为 0。
//
// 本文件是纯函数（构建脚本 + 测试共用），不读写磁盘。

export const HISTORY_SEARCH_VERSION = 1;

// 单个分片 gzip 体积上限。导入期一个月约 0.35~0.55 MB；外源补录（华尔街见闻/东财）
// 会让某个月涨到 0.9~1.5 MB，这里按实测上限留到 2.5 MB（Pages 5~30 KB/s 下约 85 秒，
// 且用户可只选单月）。超过说明条目结构或条数失控，构建应当失败而不是悄悄继续。
export const CHUNK_MAX_GZIP = 2560 * 1024;

/** 历史条目（单字母键）→ 与 search.json 完全一致的 6 字段 */
export function historyItemToSearch(it) {
  const p = Number(it && it.p) || 0;
  return {
    id: it && it.i,
    ts: p,
    time: p ? new Date((p + 8 * 3600) * 1000).toISOString().slice(0, 19) + '+08:00' : '',
    source: it && it.o,
    title: it && it.t,
    url: it && it.u,
  };
}

/** 新闻日 → 月份键（YYYY-MM） */
export function monthOf(day) {
  return String(day || '').slice(0, 7);
}

/**
 * 输入 [{ day, items }]，输出 Map<YYYY-MM, 6 字段条目[]>。
 * 条目顺序保持调用方给的顺序（导出侧已是倒序）。
 */
export function groupByMonth(dayDocs) {
  const out = new Map();
  for (const { day, items } of dayDocs) {
    const m = monthOf(day);
    if (!/^\d{4}-\d{2}$/.test(m)) continue;
    if (!out.has(m)) out.set(m, []);
    for (const it of items || []) out.get(m).push(historyItemToSearch(it));
  }
  for (const k of out.keys()) out.get(k).sort((a, b) => b.ts - a.ts);
  return out;
}

export function buildChunk(month, items, { generatedAt } = {}) {
  return {
    v: HISTORY_SEARCH_VERSION,
    m: month,
    n: items.length,
    ...(generatedAt ? { generatedAt } : {}),
    items,
  };
}

export function buildManifest(chunks, { generatedAt, from, to } = {}) {
  const months = chunks
    .map((c) => ({ m: c.m, n: c.n, b: c.bytes }))
    .sort((a, b) => (a.m < b.m ? 1 : -1));
  return {
    v: HISTORY_SEARCH_VERSION,
    ...(generatedAt ? { generatedAt } : {}),
    from: from || '',
    to: to || '',
    months: months.length,
    total: months.reduce((a, x) => a + x.n, 0),
    chunks: months,
  };
}

/** 前端：月份从新到旧（manifest 已按倒序存，这里再兜一次，防手改） */
export function monthsDesc(manifest) {
  const list = (manifest && manifest.chunks) || [];
  return list.map((x) => x.m).sort((a, b) => (a < b ? 1 : -1));
}

export function chunkUrl(month) {
  return `search-history/${month}.json`;
}

/**
 * 合并「近期命中」与「历史命中」。约束：
 *   · 近期结果顺序原样保留在最前（现有搜索行为不变）；
 *   · 历史结果追加在后，已在近期出现过的 id/url 不再重复；
 *   · 历史结果内部保持调用方给的顺序（按月倒序 + 月内相关度）。
 */
export function mergeResults(recent, hist) {
  const seenId = new Set();
  const seenUrl = new Set();
  const out = [];
  // 近期命中原样保留（2.21 之前的搜索行为不能被改：即使数据里有重复 id 也不在这里删）
  for (const x of recent || []) {
    out.push(x);
    if (x && x.id) seenId.add(x.id);
    if (x && x.url) seenUrl.add(x.url);
  }
  // 历史命中只跟「近期 + 已加进去的历史」去重
  for (const x of hist || []) {
    if (!x) continue;
    if (x.id && seenId.has(x.id)) continue;
    if (x.url && seenUrl.has(x.url)) continue;
    out.push(x);
    if (x.id) seenId.add(x.id);
    if (x.url) seenUrl.add(x.url);
  }
  return out;
}

/** 每月分片自洽校验：条数与去重后的 id 数一致、字段齐全 */
export function validateChunk(chunk) {
  if (!chunk || chunk.v !== HISTORY_SEARCH_VERSION) return 'version';
  if (!/^\d{4}-\d{2}$/.test(chunk.m || '')) return 'month';
  if (!Array.isArray(chunk.items)) return 'items';
  if (chunk.n !== chunk.items.length) return 'count';
  const seen = new Set();
  for (const it of chunk.items) {
    if (!it || !it.id || !it.title || !it.ts) return 'field';
    if (seen.has(it.id)) return 'duplicate';
    seen.add(it.id);
  }
  return '';
}
