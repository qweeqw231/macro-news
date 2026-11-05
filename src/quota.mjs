// src/quota.mjs
// 2.4.21：当日归档的 800 条配额选择（官方 / 宏观 / 时间填充）。

export const DAY_TOTAL = 800;
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
