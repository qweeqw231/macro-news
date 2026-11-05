// scripts/news-db/brief-candidates.mjs
// 给「每日早报」准备候选清单：按宏观关键词打分、跨源去重、压缩到 N 条。
//
// 用法：
//   node scripts/news-db/brief-candidates.mjs --from 2026-10-31 --to 2026-11-01 --limit 120
// 输出 JSON（stdout）。
//
// 2.2.1 起同时作为**库函数**被 scripts/briefing/generate.mjs 复用：
//   import { buildCandidates } from './brief-candidates.mjs'
//   buildCandidates({ db, from, to, limit })
// 直接运行（CLI）行为保持不变。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newsToday } from '../../src/news-day.mjs';
import { openDb, DEFAULT_DB, normalizePublishedAt } from './db.mjs';

export const KEYWORDS = [
  ['央行', 5], ['降息', 5], ['加息', 5], ['降准', 5], ['利率', 4], ['lpr', 4],
  ['美联储', 5], ['鲍威尔', 4], ['fomc', 5], ['欧洲央行', 4], ['日本央行', 4],
  ['cpi', 5], ['ppi', 4], ['gdp', 5], ['pmi', 5], ['非农', 5], ['社融', 5],
  ['m2', 4], ['出口', 4], ['关税', 5], ['财政', 4], ['政策', 3], ['会议', 2],
  ['原油', 4], ['opec', 4], ['黄金', 3], ['美元', 3], ['人民币', 4], ['汇率', 3],
  ['a股', 4], ['上证', 3], ['港股', 3], ['恒生', 3], ['美股', 4], ['纳斯达克', 4],
  ['标普', 4], ['道琼斯', 3], ['国债', 3], ['收益率', 3], ['楼市', 3], ['房地产', 3],
];
export const SOFT =
  /娱乐|明星|综艺|电影|电视剧|球赛|足球|篮球|体育|彩票|网红|主播|婚礼|离婚|美食|旅游|游戏|天气|气温|台风|车祸|火灾/;
export const SOURCE_SCORE = {
  中国人民银行: 7, 美联储: 7, 欧洲央行: 7, 国家统计局: 7,
  华尔街见闻: 5, 东方财富: 4, 新浪财经: 3, 中新网: 3,
};

export const addDays = (day, n) =>
  new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

export const beijingToday = (now = Date.now()) => newsToday(now);

/**
 * 候选清单。
 * @param {object} o
 * @param {import('node:sqlite').DatabaseSync} [o.db] 已打开的库（不传则按 dbFile 打开/关闭）
 * @param {string} [o.dbFile]
 * @param {string} o.from
 * @param {string} [o.to]
 * @param {number} [o.limit]
 */
export function buildCandidates({ db = null, dbFile = DEFAULT_DB, from, to = beijingToday(), limit = 120 } = {}) {
  const own = !db;
  const h = db || openDb(path.resolve(dbFile));
  try {
    const fromTs = Math.floor(Date.parse(from + 'T00:00:00+08:00') / 1000);
    const toTs = Math.floor(Date.parse(to + 'T23:59:59+08:00') / 1000);
    const rows = h.prepare(`
      SELECT published_at, published_ts, source, channel, title,
             substr(summary, 1, 400) AS summary, url, content_status, hash, kind
      FROM items
      WHERE published_ts >= ? AND published_ts <= ?
      ORDER BY published_ts DESC
      LIMIT 3000
    `).all(fromTs, toTs).map((r) => ({ ...r }));

    // 同一 hash（同一天同标题）只留一条：优先官方、全文、更早的来源
    const best = new Map();
    for (const r of rows) {
      if (SOFT.test(r.title || '')) continue;
      const text = `${r.title || ''} ${r.summary || ''}`.toLowerCase();
      let score = SOURCE_SCORE[r.source] || 0;
      if (r.content_status === 'full') score += 3;
      else if (r.content_status === 'summary') score += 1;
      for (const [kw, w] of KEYWORDS) if (text.includes(kw)) score += w;
      const item = { ...r, score };
      const key = r.hash || r.title;
      const prev = best.get(key);
      if (!prev || item.score > prev.score) best.set(key, item);
    }

    const items = [...best.values()]
      .sort((a, b) => b.score - a.score || b.published_ts - a.published_ts)
      .slice(0, limit)
      .map((r, i) => ({
        rank: i + 1,
        // 统一成北京时间再截断：库里混着 Z（UTC）与 +08:00 两种写法，
        // 直接 slice 会让 UTC 行整体差 8 小时（AI 早报会把它当成「昨晚」的旧闻）。
        date: normalizePublishedAt(r.published_at).slice(0, 16),
        source: r.source,
        channel: r.channel,
        title: r.title,
        summary: r.summary,
        url: r.url,
        score: r.score,
        content_status: r.content_status,
        published_ts: r.published_ts,
      }));

    return { from, to, candidates: rows.length, selected: items.length, items };
  } finally {
    if (own) {
      try { h.close(); } catch { /* ignore */ }
    }
  }
}

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const to = arg('to', beijingToday());
  const from = arg('from', addDays(to, -1));
  const out = buildCandidates({
    dbFile: path.resolve(arg('db', DEFAULT_DB)),
    from,
    to,
    limit: Number(arg('limit', '120')),
  });
  console.log(JSON.stringify(out));
}
