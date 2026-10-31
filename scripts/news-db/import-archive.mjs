// scripts/news-db/import-archive.mjs
// 把现有 data/archive/*.json 导入本地 SQLite（一次性 / 可重复执行）

import fs from 'node:fs';
import path from 'node:path';
import { openDb, insertItems, stats, DEFAULT_DB, ROOT } from './db.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const DB = path.resolve(arg('db', DEFAULT_DB));
const ARCHIVE = path.join(ROOT, 'data', 'archive');

const db = openDb(DB);
const files = fs.readdirSync(ARCHIVE).filter((f) => f.endsWith('.json')).sort();
let total = 0;
let inserted = 0;

for (const f of files) {
  const doc = JSON.parse(fs.readFileSync(path.join(ARCHIVE, f), 'utf8'));
  const items = Array.isArray(doc.items) ? doc.items : [];
  const rows = items.map((it) => ({
    id: it.id,
    source: it.source,
    channel: it.channel,
    title: it.title,
    summary: it.summary || '',
    content: it.content || '',
    url: it.url || '',
    published_at: it.time || it.published_at || '',
    published_ts: it.ts || 0,
    date_precision: 'second',
    kind: it.kind || 'news',
    tags: it.tags || [],
    content_status: it.content ? 'full' : (it.summary ? 'summary' : 'title_only'),
  }));
  const r = insertItems(db, rows);
  total += rows.length;
  inserted += r.inserted;
  console.log(`${f}: ${rows.length} 条，新增 ${r.inserted}，跳过 ${r.skipped}`);
}

console.log(`\n导入完成：${files.length} 天 / ${total} 条，新增 ${inserted}`);
console.log(stats(db, DB));
