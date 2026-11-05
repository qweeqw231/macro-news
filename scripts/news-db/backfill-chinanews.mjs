// scripts/news-db/backfill-chinanews.mjs
// 中新网「滚动新闻」按日归档回补：https://www.chinanews.com.cn/scroll-news/YYYY/MMDD/news.shtml
//
// 只存标题 / 链接 / 日期（content_status=title_only）。5 年约 60 万条，
// 逐篇抓正文会是几十万请求，先不做；需要时再按日期/关键词挑着抓。
//
// 用法：
//   node scripts/news-db/backfill-chinanews.mjs --from 2021-11-01 --to 2026-10-31
//   node scripts/news-db/backfill-chinanews.mjs --max-days 30          # 先试 30 天
//   node scripts/news-db/backfill-chinanews.mjs --dry-run

import path from 'node:path';
import { newsToday } from '../../src/news-day.mjs';
import { openDb, insertItems, setState, getState, stats, sha1, DEFAULT_DB } from './db.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const DRY = process.argv.includes('--dry-run');
const DB = path.resolve(arg('db', DEFAULT_DB));
const DELAY = Number(arg('delay', '650'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const pad = (n) => String(n).padStart(2, '0');
const addDays = (day, n) =>
  new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// 只保留偏宏观/财经的频道；社会、体育、娱乐、文化等不进库
const CHANNELS = (arg('channels', 'cj,gn,gj,ga,tw,hr,house,business,fortune,stock,ny')).split(',');

const to = arg('to', addDays(newsToday(), -1));
const from = arg('from', addDays(to, -365 * 5));
const maxDays = Number(arg('max-days', '99999'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPage(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Referer: 'https://www.chinanews.com.cn/' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(1200 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

function decode(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function parseDay(html, day) {
  const re = /<a[^>]+href="(\/([a-z]+[0-9]*)\/(\d{4})\/(\d{2})-(\d{2})\/([0-9]+)\.shtml)"[^>]*>([\s\S]*?)<\/a>/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(html))) {
    const channel = m[2];
    if (!CHANNELS.includes(channel)) continue;
    const date = `${m[3]}-${m[4]}-${m[5]}`;
    if (date !== day) continue;
    const url = 'https://www.chinanews.com.cn' + m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    const title = decode(m[7].replace(/<[^>]+>/g, '')).trim();
    if (!title) continue;
    const publishedAt = `${date}T12:00:00+08:00`;
    out.push({
      id: sha1('chinanews|' + url),
      source: '中新网',
      channel,
      title,
      summary: '',
      content: '',
      url,
      published_at: publishedAt,
      published_ts: Math.floor(Date.parse(publishedAt) / 1000),
      date_precision: 'day',
      kind: 'news',
      tags: ['国内'],
      content_status: 'title_only',
    });
  }
  return out;
}

const db = openDb(DB);
let days = 0;
let inserted = 0;
let totalItems = 0;

for (let day = from; day <= to && days < maxDays; day = addDays(day, 1)) {
  if (getState(db, 'chinanews', day)) {
    days++;
    continue;
  }
  const y = day.slice(0, 4);
  const md = day.slice(5, 7) + day.slice(8, 10);
  const url = `https://www.chinanews.com.cn/scroll-news/${y}/${md}/news.shtml`;
  try {
    const html = await getPage(url);
    const items = parseDay(html, day);
    if (DRY) {
      console.log(`${day}: ${items.length} 条（dry-run）`);
    } else {
      const r = insertItems(db, items);
      inserted += r.inserted;
      totalItems += items.length;
      setState(db, 'chinanews', day, `items=${items.length}`);
      console.log(`${day}: ${items.length} 条，新增 ${r.inserted}（累计 ${inserted}）`);
    }
  } catch (e) {
    console.log(`${day}: 失败 ${e.message}（不标记，下次重试）`);
  }
  days++;
  await sleep(DELAY);
}

console.log(`\n完成：${days} 天，新增 ${inserted} 条，页面解析 ${totalItems} 条`);
if (!DRY) console.log(stats(db, DB));
