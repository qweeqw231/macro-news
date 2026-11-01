// scripts/news-db/query.mjs
// 本地新闻库检索 / 统计 / 日期窗口（供每日早报）
//
// 用法：
//   node scripts/news-db/query.mjs --stats
//   node scripts/news-db/query.mjs 降息
//   node scripts/news-db/query.mjs 美联储 降息
//   node scripts/news-db/query.mjs --from 2026-10-31 --to 2026-11-01 --limit 400 --json

import path from 'node:path';
import { openDb, tokenize, stats, DEFAULT_DB } from './db.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const DB = path.resolve(arg('db', DEFAULT_DB));
const FROM = arg('from', null);
const TO = arg('to', null);
const JSON_OUT = process.argv.includes('--json');
const LIMIT = Number(arg('limit', FROM || TO ? '500' : '20'));

const db = openDb(DB);

if (process.argv.includes('--vacuum')) {
  db.exec('VACUUM');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log('VACUUM 完成');
}

// 日期窗口：from 当天 00:00 到 to 当天 23:59（北京时间）
if (FROM || TO) {
  const fromTs = FROM ? Math.floor(Date.parse(FROM + 'T00:00:00+08:00') / 1000) : 0;
  const toTs = TO
    ? Math.floor(Date.parse(TO + 'T23:59:59+08:00') / 1000)
    : Math.floor(Date.now() / 1000);
  const rows = db.prepare(`
    SELECT i.published_at, i.source, i.channel, i.title,
           substr(i.summary, 1, 280) AS summary, i.url, i.content_status, i.hash
    FROM items i
    WHERE i.published_ts >= ? AND i.published_ts <= ?
    ORDER BY i.published_ts DESC
    LIMIT ?
  `).all(fromTs, toTs, LIMIT).map((r) => ({ ...r }));
  if (JSON_OUT) {
    console.log(JSON.stringify({
      from: FROM, to: TO, count: rows.length, items: rows,
    }));
  } else {
    console.log(`窗口 ${FROM || '—'} ~ ${TO || '现在'} → ${rows.length} 条（上限 ${LIMIT}）\n`);
    for (const r of rows) {
      console.log(`${String(r.published_at).slice(0, 16)}  [${r.source}] ${r.title}`);
    }
  }
  process.exit(0);
}

const rawArgs = process.argv.slice(2).filter((a, i, arr) => {
  if (a.startsWith('--')) return false;
  if (i > 0 && arr[i - 1].startsWith('--')) return false;
  return true;
});

if (!rawArgs.length || process.argv.includes('--stats')) {
  console.log(stats(db, DB));
  process.exit(0);
}

const q = rawArgs.join(' ');
const tokens = tokenize(q).split(' ').filter(Boolean);
if (!tokens.length) {
  console.log('没有可检索的词');
  process.exit(0);
}
const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');

const rows = db.prepare(`
  SELECT i.published_at, i.source, i.channel, i.title, i.url, i.content_status
  FROM items_fts f JOIN items i ON i.rowid = f.rowid
  WHERE items_fts MATCH ?
  ORDER BY rank
  LIMIT ?
`).all(match, LIMIT);

console.log(`查询「${q}」→ ${rows.length} 条（上限 ${LIMIT}）\n`);
for (const r of rows) {
  console.log(`${String(r.published_at).slice(0, 10)}  [${r.source}] ${r.title}`);
  if (r.url) console.log(`    ${r.url}`);
}
