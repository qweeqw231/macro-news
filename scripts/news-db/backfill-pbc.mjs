// scripts/news-db/backfill-pbc.mjs
// 中国人民银行「新闻发布」列表按页回补：
//   https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html
//   https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/11040-N.html
//
// 列表页自带标题 + 日期；正文页暂不抓（content_status=title_only）。
// 5 年约 100 页 / 2000 条，后续可按需补正文。
//
// 用法：
//   node scripts/news-db/backfill-pbc.mjs --from 2021-11-01 --to 2026-10-31
//   node scripts/news-db/backfill-pbc.mjs --max-pages 20

import path from 'node:path';
import { openDb, insertItems, setState, getState, stats, sha1, DEFAULT_DB } from './db.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const DB = path.resolve(arg('db', DEFAULT_DB));
const DELAY = Number(arg('delay', '400'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const BASE = 'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/';

const addDays = (day, n) =>
  new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const bjToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const to = arg('to', addDays(bjToday(), -1));
const from = arg('from', addDays(to, -365 * 5));
const maxPages = Number(arg('max-pages', '9999'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getHtml(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Referer: 'https://www.pbc.gov.cn/' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

function parse(html) {
  const re = /<a\s+href="(\/goutongjiaoliu\/113456\/113469\/\d+\/index\.html)"([^>]*)>([\s\S]*?)<\/a>([\s\S]{0,240}?)<span class="hui12">(\d{4}-\d{2}-\d{2})<\/span>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const attr = m[2].match(/title="([^"]*)"/);
    const title = String(attr ? attr[1] : m[3]).replace(/<[^>]+>/g, '').trim();
    if (!title) continue;
    const date = m[5];
    const publishedAt = `${date}T12:00:00+08:00`;
    const url = 'https://www.pbc.gov.cn' + m[1];
    out.push({
      id: sha1('pbc|' + url),
      source: '中国人民银行',
      channel: '政策/监管',
      title,
      summary: '',
      content: '',
      url,
      published_at: publishedAt,
      published_ts: Math.floor(Date.parse(publishedAt) / 1000),
      date_precision: 'day',
      kind: 'official',
      tags: ['央行', '政策'],
      content_status: 'title_only',
    });
  }
  return out;
}

const db = openDb(DB);
const index = await getHtml(BASE + 'index.html');
const nums = [...index.matchAll(/11040-(\d+)\.html/g)].map((m) => Number(m[1]));
const lastPage = nums.length ? Math.max(...nums) : 1;
console.log(`PBC 列表：${lastPage} 页，范围 ${from} ~ ${to}`);

let pages = 0;
let inserted = 0;
for (let p = 1; p <= lastPage && pages < maxPages; p++) {
  const cursor = `page=${p}`;
  if (getState(db, 'pbc', cursor)) { pages++; continue; }
  const url = BASE + (p === 1 ? 'index.html' : `11040-${p}.html`);
  try {
    const items = parse(await getHtml(url));
    const dates = items.map((x) => x.published_at.slice(0, 10));
    const minDate = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : '';
    const maxDate = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : '';
    if (minDate && minDate < from && maxDate < from) {
      console.log(`第 ${p} 页已早于 ${from}（${minDate}），停止`);
      break;
    }
    const keep = items.filter((x) => {
      const d = x.published_at.slice(0, 10);
      return d >= from && d <= to;
    });
    const r = insertItems(db, keep);
    inserted += r.inserted;
    setState(db, 'pbc', cursor, `items=${keep.length}`);
    console.log(`第 ${p} 页：${items.length} 条（入库 ${keep.length}，新增 ${r.inserted}）`);
  } catch (e) {
    console.log(`第 ${p} 页失败 ${e.message}（不标记）`);
  }
  pages++;
  await sleep(DELAY);
}

console.log(`\n完成：${pages} 页，新增 ${inserted} 条`);
console.log(stats(db, DB));
