// scripts/news-db/export-history-range.mjs
// 把一个日期区间从本地库导出成 data/history 切片 + 重建 data/history/index.json。
//
// 为什么单独一个脚本，而不是直接用 scripts/export-history.mjs：
//   · export-history.mjs 是「按需铺满近 365 天」的常规导出器，还会连带重建
//     data/search-history 分片；历史补录只该动 data/history，不能碰到搜索索引；
//   · 补录日的单日条数远超常规（1000+ 条），需要单独放宽单日上限与体积预算，
//     且需要 --summary-chars 便于对比体积口径。
//
// 用法：
//   node scripts/news-db/export-history-range.mjs --from 2026-06-10 --to 2026-06-10 --force
//   node scripts/news-db/export-history-range.mjs --from 2026-05-24 --to 2026-10-04 --force
//   ... --dry-run --limit-per-day 3000 --summary-chars 160
//
// 退出码：0 成功 / 1 参数或数据库错误 / 3 超体积预算（未写任何文件）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  addDays,
  beijingDay,
  briefIndexFlags,
  buildDayDoc,
  buildIndex,
  dayFromFilename,
  HISTORY_VERSION,
} from './history-slice.mjs';
import { readBriefingMeta } from '../../src/brief-meta.mjs';
import { sharedLockPath, withSharedLock } from '../briefing/core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : dflt;
};
const flag = (name) => process.argv.includes('--' + name);
const num = (name, dflt) => {
  const v = Number(arg(name, dflt));
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};

const FROM = arg('from', '');
const TO = arg('to', FROM);
const DB = path.resolve(ROOT, arg('db', '.local/news.db'));
const OUT = path.resolve(ROOT, arg('out', 'data/history'));
const LIMIT = num('limit-per-day', 3000);
const SUMMARY = num('summary-chars', 160);
const BUDGET_DAY = num('budget-day-kb', 600) * 1024;
const BUDGET_TOTAL = num('budget-total-mb', 60) * 1024 * 1024;
const FORCE = flag('force');
const DRY = flag('dry-run');

const fmtKB = (n) => (n / 1024).toFixed(1) + ' KB';
const fmtMB = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

function nowCN() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return t.toISOString().slice(0, 19) + '+08:00';
}

const stripVolatile = (s) => String(s).replace(/"generatedAt":\s*"[^"]*"/g, '"generatedAt":"_"');

function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) {
    console.error('[export] --from / --to 需要 YYYY-MM-DD');
    return 1;
  }
  if (FROM > TO) {
    console.error(`[export] 窗口非法：${FROM} 晚于 ${TO}`);
    return 1;
  }
  if (!fs.existsSync(DB)) {
    console.error(`[export] 找不到数据库：${path.relative(ROOT, DB)}`);
    return 1;
  }

  const fromTs = Math.floor(Date.parse(FROM + 'T00:00:00Z') / 1000);
  const toTs = Math.floor(Date.parse(addDays(TO, 1) + 'T00:00:00Z') / 1000);

  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT id, source, channel, title, summary, url, published_ts, kind, content_status, hash
       FROM items
       WHERE published_ts >= ? AND published_ts < ?
       ORDER BY published_ts DESC`
    )
    .all(fromTs, toTs);
  db.close();

  const byDay = new Map();
  for (const r of rows) {
    const d = beijingDay(r.published_ts);
    if (!d || d < FROM || d > TO) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  }

  const gen = nowCN();
  const planned = [];
  let selected = 0;
  let empty = 0;

  for (let day = TO; day >= FROM; day = addDays(day, -1)) {
    const list = byDay.get(day) || [];
    if (!list.length) {
      empty++;
      continue;
    }
    const doc = buildDayDoc(day, list, { limit: LIMIT, summaryChars: SUMMARY, generatedAt: gen });
    const text = JSON.stringify(doc);
    planned.push({ day, doc, text, bytes: Buffer.byteLength(text) });
    selected += doc.n;
  }

  const briefs = readBriefingMeta(path.join(ROOT, 'data/briefings'));
  const entries = new Map();
  let unreadable = 0;
  if (fs.existsSync(OUT)) {
    for (const f of fs.readdirSync(OUT)) {
      const d = dayFromFilename(f);
      if (!d) continue;
      const file = path.join(OUT, f);
      try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        entries.set(d, { d, n: Number(doc.n) || 0, b: fs.statSync(file).size });
      } catch {
        unreadable++;
      }
    }
  }
  for (const p of planned) entries.set(p.day, { d: p.day, n: p.doc.n, b: p.bytes });

  const totalAfter = [...entries.values()].reduce((a, x) => a + x.b, 0);
  const maxDay = planned.reduce((a, p) => (p.bytes > a.bytes ? p : a), { bytes: 0, day: '' });

  if (maxDay.bytes > BUDGET_DAY || totalAfter > BUDGET_TOTAL) {
    console.error(
      `[export] 超体积预算：单日最大 ${maxDay.day} ${fmtKB(maxDay.bytes)} / ${fmtKB(BUDGET_DAY)}，` +
        `总量 ${fmtMB(totalAfter)} / ${fmtMB(BUDGET_TOTAL)}（未写任何文件）`
    );
    return 3;
  }

  let written = 0;
  let skipped = 0;
  if (!DRY) fs.mkdirSync(OUT, { recursive: true });
  for (const p of planned) {
    const file = path.join(OUT, `${p.day}.json`);
    if (fs.existsSync(file) && !FORCE) {
      skipped++;
      continue;
    }
    if (!DRY) fs.writeFileSync(file, p.text, 'utf8');
    written++;
  }

  const dayEntries = [...entries.values()].map((x) => ({
    ...x,
    ...briefIndexFlags(briefs.get(x.d)),
  }));
  const index = buildIndex(dayEntries, { generatedAt: gen });
  const indexText = JSON.stringify(index, null, 2);
  if (!DRY) {
    const idxFile = path.join(OUT, 'index.json');
    // 2.28.3：补写线（`patchIndexFiles`）也在改这份索引。重建必须落在同一把共享锁内，
    // 否则「整份重建」会把并发写入的日期标记覆盖掉。
    withSharedLock(sharedLockPath(idxFile), () => {
      const old = fs.existsSync(idxFile) ? fs.readFileSync(idxFile, 'utf8') : '';
      if (stripVolatile(old) !== stripVolatile(indexText)) fs.writeFileSync(idxFile, indexText, 'utf8');
    });
  }

  console.log(
    `[export] ${DRY ? 'dry-run（未写盘）· ' : ''}${FROM}..${TO} · 覆盖 ${planned.length} 天 / 空 ${empty} 天` +
      ` · 选中 ${selected} 条 · 写入 ${written} 个切片（跳过已存在 ${skipped}）`
  );
  if (maxDay.day) {
    console.log(`[export] 单日最大 ${maxDay.day} ${fmtKB(maxDay.bytes)}（预算 ${fmtKB(BUDGET_DAY)}）`);
  }
  console.log(
    `[export] index ${index.days.length} 天 · ${fmtKB(Buffer.byteLength(indexText))}` +
      ` · 覆盖 ${index.from}..${index.to} · 共 ${index.total} 条 · 切片总量 ${fmtMB(totalAfter)}` +
      `（预算 ${fmtMB(BUDGET_TOTAL)}）${unreadable ? ` · 损坏切片 ${unreadable}` : ''}`
  );
  console.log(`[export] schema v${HISTORY_VERSION} · summary ≤ ${SUMMARY} 字 · 单日上限 ${LIMIT}`);
  return 0;
}

process.exitCode = main();
