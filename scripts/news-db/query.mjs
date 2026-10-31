// scripts/news-db/query.mjs
// 本地新闻库检索 / 统计
//
// 用法：
//   node scripts/news-db/query.mjs --stats
//   node scripts/news-db/query.mjs 降息
//   node scripts/news-db/query.mjs 美联储 降息

import path from 'node:path';
import { openDb, tokenize, stats, DEFAULT_DB } from './db.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const DB = path.resolve(arg('db', DEFAULT_DB));
const LIMIT = Number(arg('limit', '20'));

const db = openDb(DB);

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
