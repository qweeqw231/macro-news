// scripts/news-db/backfill-external.mjs
// 外源历史补录：华尔街见闻 + 东方财富 → .local/news.db，再由 export-history.mjs 出切片。
//
// 背景：2026-05-24~2026-10-04 这段历史当初只有中新网 + 官方四源（100~300 条/天）。
// 这里按「新闻日」（北京 08:00 起算，等价 UTC 日期）回补两家外源。
//
// 已实测的源端边界（2026-11-15）：
//   · 华尔街见闻 lives 接口只保留约 180 天，05-19 及更早返回空，05-20 起有数据。
//     limit 上限 100；cursor 严格小于语义（取 next_cursor = 本页最老 display_time），
//     这里用 oldest+1 以把同秒条目一并取回，再按源 id 去重。
//   · 东方财富 column=350 用 page_index+page_size 翻页，page_size 可到 200，
//     总可用偏移约 20 万条（≈2025-08-02），本窗口够用；顺序从新到旧单次扫完。
//   · 新浪 roll 接口约 59 页封顶（≈10 天），不能用于本窗口，这里不接。
//
// 用法：
//   node scripts/news-db/backfill-external.mjs --from 2026-06-10 --to 2026-06-10
//   node scripts/news-db/backfill-external.mjs --from 2026-05-24 --to 2026-10-04
//   node scripts/news-db/backfill-external.mjs --from 2026-05-24 --to 2026-10-04 --dry-run
//
// 断点：backfill_state 表
//   · wscn-api:<channel> / cursor=新闻日   —— 单个频道单日抓完即记账
//   · em-api / cursor=pos                 —— 东财翻页游标（page + 最后时间）
// 台账：.local/backfill-external.jsonl（每行一个统计单元，仅本机）
//
// 只写库，不碰 data/ 下任何文件。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, insertItems, setState, getState, stats, sha1, DEFAULT_DB } from './db.mjs';
import { newsDay, addDays } from '../../src/news-day.mjs';
import { dedupeItems, normalizeUrl, normalizeText } from '../../src/news-dedupe.mjs';
import { titleFromText } from '../../src/news-title.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : dflt;
};
const flag = (name) => process.argv.includes('--' + name);

const FROM = arg('from', '2026-05-24');
const TO = arg('to', FROM);
const SOURCES = String(arg('sources', 'wscn,em')).split(',').map((s) => s.trim()).filter(Boolean);
const DELAY = Number(arg('delay', '350'));
const MAX_DAYS = Number(arg('max-days', '9999'));
const DRY = flag('dry-run');
const FORCE = flag('force');
const DB = path.resolve(ROOT, arg('db', DEFAULT_DB));
const LEDGER = path.join(ROOT, '.local', 'backfill-external.jsonl');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stripTags = (s) =>
  String(s == null ? '' : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

// 与 src/sources.mjs 同一口径：摘要优先在句末断开，正文截断 4000
const SUMMARY_LEN = 220;
function summarize(s) {
  const t = stripTags(s);
  if (t.length <= SUMMARY_LEN) return t;
  const head = t.slice(0, SUMMARY_LEN);
  const min = Math.floor(SUMMARY_LEN * 0.45);
  for (let i = head.length - 1; i >= min; i--) {
    if ('。！？；!?;'.includes(head[i])) return head.slice(0, i + 1) + '…';
  }
  return head + '…';
}
const clip = (s, n) => {
  const t = stripTags(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
};
const isoCN = (sec) => new Date((sec + 8 * 3600) * 1000).toISOString().slice(0, 19) + '+08:00';

let REQ = 0;
async function getJson(url, headers = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, ...headers } });
      REQ++;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 2) return { __err: e.message };
      await sleep(1200 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

function ledger(line) {
  if (DRY) return;
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(
    LEDGER,
    JSON.stringify({ at: new Date().toISOString(), ...line }) + '\n',
    'utf8'
  );
}

// ---------- 华尔街见闻 ----------
const WSCN_CH = [
  ['global-channel', '全球'],
  ['a-stock-channel', 'A股'],
  ['forex-channel', '外汇'],
  ['us-stock-channel', '美股'],
  ['commodity-channel', '大宗'],
];

function wscnUrl(ch, cursor) {
  return (
    // 2026-11-24：api-one.wallstcn.com 已从 DNS 消失，改用同一路径的现行域名
    'https://api-one-wscn.awtmt.com/apiv1/content/lives' +
    `?channel=${ch}&limit=100&cursor=${cursor}`
  );
}

async function fetchWscnChannelDay(db, ch, label, day) {
  const start = Date.parse(day + 'T00:00:00Z') / 1000;
  const end = start + 86400;
  let cursor = end;
  const out = [];
  let req = 0;
  for (let guard = 0; guard < 50; guard++) {
    const body = await getJson(wscnUrl(ch, cursor));
    req++;
    if (body && body.__err) return { ok: false, err: body.__err, out, req };
    const items = body?.data?.items || [];
    if (!items.length) break;
    for (const it of items) {
      const ts = Number(it.display_time) || 0;
      if (ts < start || ts >= end) continue;
      out.push(toWscnItem(it, label));
    }
    const oldest = Math.min(...items.map((x) => Number(x.display_time) || 0));
    if (items.length < 100 || oldest < start) break;
    // cursor 是严格小于语义：+1 把同一秒的条目也带回本页，靠 id 去重
    const next = oldest + 1;
    if (next >= cursor) break;
    cursor = next;
    await sleep(DELAY);
  }
  return { ok: true, out, req };
}

function toWscnItem(it, label) {
  const text = stripTags(it.content_text || it.content || '');
  const rawTitle = stripTags(it.title || '');
  const ts = Number(it.display_time) || 0;
  const uri = String(it.uri || '');
  return {
    id: sha1('wscn|' + String(it.id || ts)),
    ts,
    time: ts ? isoCN(ts) : '',
    source: '华尔街见闻',
    channel: label,
    title: rawTitle || titleFromText(text),
    summary: rawTitle ? summarize(text) : '',
    content: clip(text, 4000),
    url: /^https?:\/\//i.test(uri)
      ? uri
      : 'https://wallstreetcn.com/livenews/' + label.toLowerCase(),
    kind: 'news',
  };
}

// ---------- 东方财富 ----------
const EM_BASE = 'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns';
const emUrl = (page) =>
  `${EM_BASE}?client=web&biz=web_news_col&column=350&order=1&needInteractData=0` +
  `&page_index=${page}&page_size=200&req_trace=1`;

function emTs(showTime) {
  const t = Date.parse(String(showTime || '').replace(' ', 'T') + '+08:00');
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

function toEmItem(it) {
  const ts = emTs(it.showTime);
  const url = String(it.url || it.uniqueUrl || '');
  const raw = it.summary == null ? '' : it.summary;
  return {
    id: sha1('em|' + String(it.code || url || it.title)),
    ts,
    time: ts ? isoCN(ts) : '',
    source: '东方财富',
    channel: '国内财经',
    title: stripTags(it.title),
    summary: summarize(raw),
    content: clip(raw, 4000),
    url: /^https?:\/\//i.test(url) ? url : 'https://finance.eastmoney.com/',
    kind: 'news',
  };
}

/** 从最新页顺序扫到 fromTs 之前；返回按新闻日分桶的条目 */
async function sweepEm(db, fromDay, toDay) {
  const fromTs = Date.parse(fromDay + 'T00:00:00Z') / 1000;
  const toTs = Date.parse(addDays(toDay, 1) + 'T00:00:00Z') / 1000;
  const buckets = new Map();
  const pos = getState(db, 'em-api', 'pos');
  let page = 1;
  let started = false;
  if (pos && !FORCE) {
    try {
      const p = JSON.parse(pos.note || '{}');
      if (Number(p.page) > 1 && Number(p.lastTs) > fromTs) {
        page = Number(p.page);
        started = true;
      }
    } catch { /* 旧记录格式，从头扫 */ }
  }
  let req = 0;
  for (; page < 1200; page++) {
    const body = await getJson(emUrl(page), { Referer: 'https://finance.eastmoney.com/' });
    req++;
    if (body && body.__err) return { ok: false, err: body.__err, buckets, req };
    const list = body?.data?.list || [];
    if (!list.length) break;
    let newest = 0;
    let oldest = Infinity;
    for (const it of list) {
      const row = toEmItem(it);
      if (!row.ts || !row.title) continue;
      newest = Math.max(newest, row.ts);
      oldest = Math.min(oldest, row.ts);
      if (row.ts < fromTs || row.ts >= toTs) continue;
      const d = newsDay(row.ts * 1000);
      if (!buckets.has(d)) buckets.set(d, []);
      buckets.get(d).push(row);
    }
    if (!DRY) {
      setState(db, 'em-api', 'pos', JSON.stringify({ page: page + 1, lastTs: oldest, at: new Date().toISOString() }));
    }
    if (newest < fromTs) break;
    await sleep(DELAY);
  }
  if (!DRY) setState(db, 'em-api', 'pos', JSON.stringify({ page: 1, lastTs: 0, at: new Date().toISOString() }));
  return { ok: true, buckets, req, resumed: started };
}

// ---------- 写库 ----------
/** 同源同日已有条目的两个查重键（归一化 url / 同刻同题） */
function existingKeys(db, day) {
  const start = Math.floor(Date.parse(day + 'T00:00:00Z') / 1000);
  const end = start + 86400;
  const rows = db
    .prepare('SELECT source, url, title, published_ts FROM items WHERE published_ts >= ? AND published_ts < ?')
    .all(start, end);
  const byUrl = new Set();
  const byTitle = new Set();
  for (const r of rows) {
    const u = normalizeUrl(r.url);
    if (u) byUrl.add(`${r.source}|${u}`);
    byTitle.add(`${r.source}|${r.published_ts}|${normalizeText(r.title)}`);
  }
  return { byUrl, byTitle };
}

function insertDay(db, day, items) {
  const { byUrl, byTitle } = existingKeys(db, day);
  const fresh = [];
  let dupExisting = 0;
  for (const it of items) {
    const u = normalizeUrl(it.url);
    const key = `${it.source}|${it.ts}|${normalizeText(it.title)}`;
    if ((u && byUrl.has(`${it.source}|${u}`)) || byTitle.has(key)) {
      dupExisting++;
      continue;
    }
    byTitle.add(key);
    if (u) byUrl.add(`${it.source}|${u}`);
    fresh.push({
      id: it.id,
      source: it.source,
      channel: it.channel,
      title: it.title,
      summary: it.summary,
      content: it.content,
      url: it.url,
      published_at: it.time,
      published_ts: it.ts,
      date_precision: 'second',
      fetched_at: new Date().toISOString(),
      kind: 'news',
      tags: [],
      content_status: it.content ? 'full' : it.summary ? 'summary' : 'title_only',
    });
  }
  if (!fresh.length) return { inserted: 0, dupExisting, total: items.length };
  const r = insertItems(db, fresh);
  return { inserted: r.inserted, dupExisting, total: items.length };
}

// ---------- 主流程 ----------
const db = openDb(DB);
let dayCount = 0;
const report = [];

for (let day = FROM; SOURCES.includes('wscn') && day <= TO && dayCount < MAX_DAYS; day = addDays(day, 1)) {
  dayCount++;
  const line = { day, wscn: null, em: null };

  {
    const all = [];    let req = 0;
    let failed = '';
    for (const [ch, label] of WSCN_CH) {
      if (!FORCE && getState(db, 'wscn-api:' + ch, day)) continue;
      const r = await fetchWscnChannelDay(db, ch, label, day);
      req += r.req;
      if (!r.ok) {
        failed = `${ch}:${r.err}`;
        break;
      }
      all.push(...r.out);
      if (!DRY) setState(db, 'wscn-api:' + ch, day, `items=${r.out.length} req=${r.req}`);
      await sleep(DELAY);
    }
    if (failed) {
      line.wscn = { ok: false, err: failed, req };
      console.log(`${day} wscn 失败 ${failed}（不记账，下轮重试）`);
    } else {
      // 跨频道同文（同一快讯挂 global + a-stock，id 不同）按频道优先级合并
      const deduped = dedupeItems(all);
      const res = DRY
        ? { inserted: 0, dupExisting: 0, total: deduped.length }
        : insertDay(db, day, deduped);
      line.wscn = { ok: true, raw: all.length, deduped: deduped.length, req, ...res };
      console.log(
        `${day} wscn 原始 ${all.length} → 跨频道去重 ${deduped.length} → 入库 ${res.inserted}` +
          `（库内已有 ${res.dupExisting}）· req ${req}`
      );
    }
  }

  // 东财不逐日抓：翻页是一次性从新到旧扫，见下方单次扫描
  ledger(line);
  report.push(line);
}

if (SOURCES.includes('em')) {
  const fromDay = FROM;
  const r = await sweepEm(db, FROM, TO);
  if (!r.ok) {
    console.log(`东财失败 ${r.err}（已抓到 ${r.buckets.size} 天，游标已保存，可重跑续抓）`);
    ledger({ day: '*', em: { ok: false, err: r.err, req: r.req } });
  } else {
    let totalIns = 0;
    let totalDedup = 0;
    let totalDup = 0;
    for (const [day, items] of [...r.buckets.entries()].sort()) {
      const uniq = dedupeItems(items);
      const res = DRY
        ? { inserted: 0, dupExisting: 0, total: uniq.length }
        : insertDay(db, day, uniq);
      totalIns += res.inserted;
      totalDedup += uniq.length;
      totalDup += res.dupExisting;
      if (!DRY) setState(db, 'em-api:day', day, `items=${res.inserted}`);
      ledger({ day, em: { raw: items.length, deduped: uniq.length, ...res } });
      if (res.inserted || res.dupExisting) {
        console.log(`  ${day} 东财 原始 ${items.length} → 去重 ${uniq.length} → 入库 ${res.inserted}（已有 ${res.dupExisting}）`);
      }
    }
    console.log(
      `东财合计：${r.buckets.size} 天 · 去重后 ${totalDedup} 条 · 入库 ${totalIns}（库内已有 ${totalDup}）· req ${r.req}`
    );
    ledger({ day: '*', em: { ok: true, days: r.buckets.size, deduped: totalDedup, inserted: totalIns, req: r.req } });
  }
}

console.log(`\n本次请求总数 ${REQ}${DRY ? '（dry-run，未写库）' : ''}`);
if (!DRY) {
  const s = stats(db, DB);
  console.log(
    `库内合计 ${s.items} 条 · ${s.mb} MB · ` +
      s.sources.map((x) => `${x.source}:${x.n}`).join(' ') +
      ` · 范围 ${s.min}..${s.max}`
  );
}
db.close();
