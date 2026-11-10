// src/quota.mjs
// 2.4.21：当日归档的配额选择（官方 / 宏观 / 时间填充）。
// 2.11.0：当日上限 800 → 1600（唯一常量，见下面 DAY_TOTAL 的说明）。
// 2.12.0：1600 → 1800（仍是临时值）+ 触顶画像 capState()。

// ⚠ 临时值：1800。待 5~7 个交易日实测后再定终值，当前目标是保证不淘汰早盘条目。
//
// 为什么不再用 800：2.4.21 起 selectDayItems 每轮都对「合并后的全量候选」重排后取前 N 条，
// 满载后新条目会按时间倒序挤掉当天最早的条目（静默淘汰，日志里看不到）。
// 实测 2026-11-10：全天唯一条目 1,146 条，09:38 起触顶 800，之后 18 轮里 329 条
// 上午 08:00–12:00 的条目被挤掉、永久从当天归档消失（只在 git 历史里）。
//
// 为什么是 1800（保守，不到 2000）：2.11.1 把 40 天归档恢复后，实测单日上界是
// 2026-11-04 的 1,720 条（突发大新闻日），普通交易日约 1,100~1,200 条。
// 1800 = 已观测上界 + 80 条余量，只够兜住「已经见过的极端值」——11-04 那种日子
// 再来一次仍可能触顶，所以本版同时加了 capState()：触顶必须留痕（见 collect.mjs
// 的 _last-run.json news.capped 与页脚健康灯），不能只靠抬高上限。
export const DAY_TOTAL = 1800;

// 配额桶：官方四源 ≤40、宏观频道 ≤120，其余（普通档）填满到 DAY_TOTAL。
// 普通档没有独立常量，等于 DAY_TOTAL - OFFICIAL_QUOTA - MACRO_QUOTA（1800 → 1640），
// 这样上限只有一个来源，改 DAY_TOTAL 不会漏改第二个数。
export const OFFICIAL_QUOTA = 40;
export const MACRO_QUOTA = 120;
export const OFFICIAL_RECENT_DAYS = 7;

export const OFFICIAL_SOURCES = new Set([
  '中国人民银行', '美联储', '欧洲央行', '国家统计局',
]);

export const MACRO_CHANNELS = new Set([
  '国内财经', '全球', '外汇', '大宗', '美股',
]);

const tsOf = (it) => Number(it && it.ts) || 0;
const byTsDesc = (a, b) => tsOf(b) - tsOf(a);

export const isOfficial = (it) =>
  !!it && OFFICIAL_SOURCES.has(String(it.source || ''));

export const isRecent = (t, now = Date.now(), days = OFFICIAL_RECENT_DAYS) =>
  Number.isFinite(t) && t >= now - days * 86400000;

/**
 * 配额优先选择。
 * @param {Array} items 已去重的当日条目（可乱序）
 * @param {{total?:number,officialQuota?:number,macroQuota?:number}} [opts]
 * @returns {Array} 按 ts 倒序，长度 ≤ total
 */
export function selectDayItems(items, opts = {}) {
  const total = Math.max(0, Number.isFinite(Number(opts.total)) ? Number(opts.total) : DAY_TOTAL);
  const officialQuota = Math.max(0, Number.isFinite(Number(opts.officialQuota)) ? Number(opts.officialQuota) : OFFICIAL_QUOTA);
  const macroQuota = Math.max(0, Number.isFinite(Number(opts.macroQuota)) ? Number(opts.macroQuota) : MACRO_QUOTA);
  const list = (Array.isArray(items) ? items.slice() : []).sort(byTsDesc);

  const picked = [];
  const chosen = new Set();

  // 1) 官方四源：无条件保留（上限 officialQuota，余量参与普通填充）
  for (const it of list) {
    if (picked.length >= officialQuota) break;
    if (!isOfficial(it)) continue;
    picked.push(it);
    chosen.add(it);
  }

  // 2) 宏观频道：排除已选官方，最多 macroQuota
  let macroCount = 0;
  for (const it of list) {
    if (macroCount >= macroQuota) break;
    if (chosen.has(it) || !MACRO_CHANNELS.has(String(it.channel || ''))) continue;
    picked.push(it);
    chosen.add(it);
    macroCount++;
  }

  // 3) 其余按时间倒序填满
  for (const it of list) {
    if (picked.length >= total) break;
    if (chosen.has(it)) continue;
    picked.push(it);
    chosen.add(it);
  }

  return picked.sort(byTsDesc).slice(0, total);
}

/**
 * 2.12.0：本轮是否发生「触顶淘汰」——只要有一天 evicted > 0 就算。
 * 触顶必须留痕：collect 把它写进 _last-run.json 的 news.capped / news.evicted，
 * 页脚健康灯据此亮「归档触顶」，不再只靠翻日志。
 * @param {Array<{evicted?:number}>} dayStats 本轮逐日统计
 * @param {number} [cap] 当日上限（默认 DAY_TOTAL）
 * @returns {{cap:number, capped:boolean, evicted:number}}
 */
export function capState(dayStats, cap = DAY_TOTAL) {
  const list = Array.isArray(dayStats) ? dayStats : [];
  const evicted = list.reduce((n, d) => n + Math.max(0, Number(d && d.evicted) || 0), 0);
  return { cap, capped: evicted > 0, evicted };
}
