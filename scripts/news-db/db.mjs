// scripts/news-db/db.mjs
// 本地新闻库：SQLite + FTS5（bigram 中文分词），独立于静态站，数据库放 .local/news.db。
//
// 为什么不用 search.json：它现在 10.7MB / 1.9 万条，浏览器 Fuse 还能撑；
// 5 年回补会到几十万条，必须交给 SQLite，静态站只保留最近窗口。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_DB = path.join(ROOT, '.local', 'news.db');

export function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

/** 中文 bigram + 英文单词，零依赖，够本地检索用 */
export function tokenize(text) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ');
  const out = new Set();
  for (const run of s.split(/\s+/)) {
    if (!run) continue;
    if (/^[\u3400-\u9fff]+$/.test(run)) {
      for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
      if (run.length === 1) out.add(run);
    } else if (run.length >= 2) {
      out.add(run);
    }
  }
  return [...out].join(' ');
}

export function titleHash(title, date) {
  const n = String(title || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  return sha1(n + '|' + String(date || '').slice(0, 10));
}

export function openDb(file = DEFAULT_DB) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS items (
      rowid         INTEGER PRIMARY KEY AUTOINCREMENT,
      id            TEXT UNIQUE NOT NULL,
      source        TEXT NOT NULL,
      channel       TEXT,
      title         TEXT NOT NULL,
      summary       TEXT,
      content       TEXT,
      url           TEXT,
      published_at  TEXT,
      published_ts  INTEGER,
      date_precision TEXT,
      fetched_at    TEXT,
      kind          TEXT,
      tags          TEXT,
      content_status TEXT,
      hash          TEXT,
      dup_group     TEXT,
      ai_summary    TEXT,
      topics        TEXT,
      importance    INTEGER,
      read          INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_items_pub ON items(published_ts);
    CREATE INDEX IF NOT EXISTS idx_items_source ON items(source);
    CREATE INDEX IF NOT EXISTS idx_items_hash ON items(hash);
    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(title, tokens);
    CREATE TABLE IF NOT EXISTS backfill_state (
      source     TEXT NOT NULL,
      cursor     TEXT NOT NULL,
      updated_at TEXT,
      note       TEXT,
      PRIMARY KEY (source, cursor)
    );
  `);
  return db;
}

/** 批量写入；重复 id 跳过。返回 { inserted, skipped } */
export function insertItems(db, items, { batch = 1000 } = {}) {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO items
      (id, source, channel, title, summary, content, url, published_at, published_ts,
       date_precision, fetched_at, kind, tags, content_status, hash, dup_group)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const fts = db.prepare('INSERT INTO items_fts(rowid, title, tokens) VALUES (?, ?, ?)');
  let inserted = 0;
  let skipped = 0;
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const it of items) {
      const date = String(it.published_at || it.time || '').slice(0, 10);
      const id = it.id || sha1(`${it.source || ''}|${it.url || ''}|${it.title || ''}`);
      const hash = it.hash || titleHash(it.title, date);
      const info = ins.run(
        id,
        it.source || '',
        it.channel || '',
        it.title || '',
        it.summary || '',
        it.content || '',
        it.url || '',
        it.published_at || it.time || '',
        Number(it.published_ts || it.ts || 0),
        it.date_precision || 'second',
        it.fetched_at || new Date().toISOString(),
        it.kind || 'news',
        Array.isArray(it.tags) ? it.tags.join(',') : (it.tags || ''),
        it.content_status || (it.content ? 'full' : (it.summary ? 'summary' : 'title_only')),
        hash,
        it.dup_group || hash
      );
      if (Number(info.changes) > 0) {
        fts.run(Number(info.lastInsertRowid), it.title || '', tokenize(`${it.title} ${it.summary || ''} ${it.content || ''}`));
        inserted++;
      } else {
        skipped++;
      }
      n++;
      if (n % batch === 0) { db.exec('COMMIT'); db.exec('BEGIN'); }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  return { inserted, skipped };
}

export function setState(db, source, cursor, note = '') {
  db.prepare(`
    INSERT INTO backfill_state(source, cursor, updated_at, note) VALUES (?, ?, ?, ?)
    ON CONFLICT(source, cursor) DO UPDATE SET updated_at=excluded.updated_at, note=excluded.note
  `).run(source, String(cursor), new Date().toISOString(), note);
}

export function getState(db, source, cursor) {
  return db.prepare('SELECT * FROM backfill_state WHERE source=? AND cursor=?').get(source, String(cursor)) || null;
}

export function stats(db, file = DEFAULT_DB) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  const fts = db.prepare('SELECT COUNT(*) AS n FROM items_fts').get().n;
  const range = db.prepare('SELECT MIN(published_at) AS min, MAX(published_at) AS max FROM items').get();
  const src = db.prepare('SELECT source, COUNT(*) AS n FROM items GROUP BY source ORDER BY n DESC').all();
  let mb = 0;
  try { mb = fs.statSync(file).size / 1024 / 1024; } catch { /* ignore */ }
  return { items: n, fts, min: range.min, max: range.max, sources: src, mb: Math.round(mb * 10) / 10 };
}

export { ROOT };
