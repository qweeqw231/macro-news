// src/news-dedupe.mjs
// 2.4.5：同一条新闻被多频道收录时的合并规则。
//
// 背景：华尔街见闻把同一篇快讯同时挂在「全球」和「A股」两个频道，
// 返回两条**不同 id、不同 url、相同 display_time 与正文**的记录
// （实测 2026-11-03 14:02：id 3193102 A股 / id 3193103 全球）。
// 采集侧原先只按 id 去重，于是同一条新闻在要闻流出现两次。
//
// 规则（纯函数，无 IO）：
//   1. 同一 url（忽略协议/末尾斜杠/utm 参数）⇒ 同一条；
//   2. 同一来源 + 同一时间戳 + 同一正文（或标题）⇒ 同一条；
//   3. 合并时按频道具体度取舍：A股/中国 > 国内财经 > 外汇/大宗/美股 > 全球；
//      同频道再比正文长度（长的信息更全），仍相同则保留先出现的（稳定）。
//   4. 不同时间戳不合并（同一句话在不同时间发布可能是更新/更正）。

const TRACKING_PARAM = /^(utm_|spm$|from$|ref$|source$|share$)/i;

/** 频道具体度：数字越小越具体 */
export const CHANNEL_RANK = {
  'A股': 0,
  '中国': 0,
  '国内财经': 1,
  '外汇': 2,
  '大宗': 2,
  '美股': 2,
  '全球': 3,
};

export function channelRank(channel) {
  const k = String(channel || '').trim();
  return Object.prototype.hasOwnProperty.call(CHANNEL_RANK, k) ? CHANNEL_RANK[k] : 1.5;
}

/** 去掉标签/空白/标点后比较：中文快讯的差异往往只是空格与标点 */
export function normalizeText(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, '')
    .replace(/[，,。.、；;：:！!？?…·「」『』“”"'（）()【】\[\]]/g, '')
    .trim();
}

/**
 * URL 归一化：只去掉协议、锚点与追踪参数，保留业务参数（?id= / ?p= 可能是文章 id）。
 * @returns {string|null}
 */
export function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    }
    u.hash = '';
    let out = u.href.replace(/\/+$/, '');
    return out.toLowerCase();
  } catch {
    return null;
  }
}

function textOf(it) {
  return (it.content && String(it.content).length > String(it.title || '').length)
    ? it.content
    : (it.title || it.summary || '');
}

/** 同一来源 + 同一时间 + 同一正文（前 300 字的归一化） */
export function contentKey(it) {
  const ts = Number(it && it.ts) || 0;
  const text = normalizeText(textOf(it)).slice(0, 300);
  if (!ts || !text) return null;
  return `t|${it.source || ''}|${ts}|${text}`;
}

/**
 * 同一来源 + 同一时间 + 同一标题。
 * 用于「同一条快讯被改写后再发一次」：正文从简版更新为完整版，
 * 内容键不同但标题（华尔街见闻取正文前 40 字）相同、时间相同 ⇒ 同一条。
 */
export function titleKey(it) {
  const ts = Number(it && it.ts) || 0;
  const title = normalizeText(it && it.title);
  if (!ts || !title) return null;
  return `h|${it.source || ''}|${ts}|${title}`;
}

function better(a, b) {
  const ra = channelRank(a.channel);
  const rb = channelRank(b.channel);
  if (ra !== rb) return ra < rb;
  const la = String(a.content || '').length;
  const lb = String(b.content || '').length;
  if (la !== lb) return la > lb;
  return false; // 保留先出现的，保证顺序稳定
}

/**
 * 合并重复新闻，保持首次出现的位置。
 * @param {object[]} items
 * @returns {object[]}
 */
export function dedupeItems(items) {
  const out = [];
  const byUrl = new Map();
  const byContent = new Map();
  const byTitle = new Map();
  for (const it of items || []) {
    if (!it) continue;
    const uk = normalizeUrl(it.url);
    const ck = contentKey(it);
    const hk = titleKey(it);
    let idx = -1;
    if (uk && byUrl.has(uk)) idx = byUrl.get(uk);
    else if (ck && byContent.has(ck)) idx = byContent.get(ck);
    else if (hk && byTitle.has(hk)) idx = byTitle.get(hk);
    if (idx < 0) {
      idx = out.length;
      out.push(it);
    } else if (better(it, out[idx])) {
      out[idx] = it;
    }
    const slot = idx;
    if (uk) byUrl.set(uk, slot);
    if (ck) byContent.set(ck, slot);
    if (hk) byTitle.set(hk, slot);
  }
  return out;
}
