// scripts/news-db/import-archive.mjs
// 把现有 data/archive/*.json 导入本地 SQLite（一次性 / 可重复执行，按 id 去重）。
//
// 2.2.1 起同时作为库函数被 scripts/briefing/generate.mjs 复用：
//   import { importArchive } from './import-archive.mjs'
// 直接运行（CLI）行为保持不变。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, insertItems, stats, DEFAULT_DB, ROOT } from './db.mjs';

/**
 * 导入整个 archive 目录。
 * @param {object} o
 * @param {string} [o.dbFile]
 * @param {string} [o.archiveDir]
 * @param {boolean} [o.quiet] 不打印逐日明细
 * @returns {{files:number,total:number,inserted:number}}
 */
export function importArchive({
  dbFile = DEFAULT_DB,
  archiveDir = path.join(ROOT, 'data', 'archive'),
  quiet = false,
} = {}) {
  const db = openDb(path.resolve(dbFile));
  const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.json')).sort();
  let total = 0;
  let inserted = 0;
  try {
    for (const f of files) {
      const doc = JSON.parse(fs.readFileSync(path.join(archiveDir, f), 'utf8'));
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
      if (!quiet) console.log(`${f}: ${rows.length} 条，新增 ${r.inserted}，跳过 ${r.skipped}`);
    }
    return { files: files.length, total, inserted };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const dbFile = path.resolve(arg('db', DEFAULT_DB));
  const archiveDir = path.resolve(arg('archive', path.join(ROOT, 'data', 'archive')));
  const r = importArchive({ dbFile, archiveDir });
  const db = openDb(dbFile);
  console.log(`\n导入完成：${r.files} 天 / ${r.total} 条，新增 ${r.inserted}`);
  console.log(stats(db, dbFile));
  try { db.close(); } catch { /* ignore */ }
}
