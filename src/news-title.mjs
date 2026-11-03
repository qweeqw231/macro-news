// src/news-title.mjs
// 2.4.6：标题生成与短版截断（纯函数、无 IO）。
//
// 事故：华尔街见闻快讯没有独立标题，旧实现用 `text.slice(0, 40)` 硬截，
// 把「…光迅科技午后跌停」切成「…光迅」，既切断了专有名词，也没有省略号。
//
// 规则：
//   1. 存储层保留**完整标题**：无独立标题时取正文**第一整句**（到 。！？； 为止）；
//   2. 确需短版时只在标点边界断开：优先句末（。！？；），其次分句（，、），
//      截断后加 `…` 显式表示「还有内容」；
//   3. 窗口内找不到标点 ⇒ **不切**（宁可长，不可在专有名词中间切断）。

const SENTENCE_END = '。！？；';
const CLAUSE_END = '，、';
const TITLE_MAX = 200;      // 第一整句超过这个长度才需要短版
const SHORT_MAX = 60;       // 短版目标长度（软上限）

export function normalizeTitleText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/**
 * 在标点边界截断，加省略号；找不到边界就返回原文（不硬切）。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function shortenTitle(text, max = SHORT_MAX) {
  const t = normalizeTitleText(text);
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const min = Math.floor(max * 0.5);
  for (let i = head.length - 1; i >= min; i--) {
    if (SENTENCE_END.includes(head[i])) return head.slice(0, i + 1) + '…';
  }
  for (let i = head.length - 1; i >= min; i--) {
    if (CLAUSE_END.includes(head[i])) return head.slice(0, i + 1) + '…';
  }
  return t;
}

/**
 * 无独立标题的快讯：用正文第一整句作为标题。
 * 第一句过长时退化为「标点边界短版 + …」；没有标点则保留全文。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function titleFromText(text, max = TITLE_MAX) {
  const t = normalizeTitleText(text);
  if (!t) return '';
  const m = /^[\s\S]*?[。！？；]/.exec(t);
  if (m && m[0].length <= max) return m[0].trim();
  if (t.length <= max) return t;
  return shortenTitle(t, SHORT_MAX);
}
