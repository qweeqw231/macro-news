// scripts/export-history.mjs
// 把本地新闻库（.local/news.db）的近一年历史导出为静态每日切片：
//   data/history/YYYY-MM-DD.json  +  data/history/index.json
//
// 设计文档：docs/superpowers/specs/2026-11-02-history-news-design.md
//
// 关键约定：
//   · 只导出**未被 data/archive/ 覆盖**的日期（gap-only）—— archive 那 60 多天带全文，
//     再导一份摘要版是纯重复，同一天还会出现两个真相；
//   · 导出窗口默认「到昨天为止的 365 天」，不含今天（今天还在增长，由 archive 负责）；
//   · 历史切片**写一次就不覆盖**（默认跳过已存在文件），需要重导加 --force；
//   · 超体积预算（单日 300 KB / 总量 30 MB）直接以退出码 3 停下，不静默写爆仓库。
//
// 用法：
//   node scripts/export-history.mjs --from 2025-11-09 --to 2025-11-15   # 样本周
//   node scripts/export-history.mjs --days 365 --dry-run                 # 全年测算，不写盘
//   node scripts/export-history.mjs --days 365                           # 铺满缺口（默认）
//   node scripts/export-history.mjs --days 365 --force                   # 重写已有切片
//
// 退出码：0 成功 / 1 参数或数据库错误 / 3 超体积预算

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  addDays,
  beijingDay,
  buildDayDoc,
  buildIndex,
  dayFromFilename,
  dayWindow,
  HISTORY_VERSION,
} from './news-db/history-slice.mjs';
import { readBriefingMeta } from '../src/brief-meta.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : dflt;
};
const flag = (name) => process.argv.includes('--' + name);
const num = (name, dflt) => {
  const v = Number(arg(name, dflt));
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const DB = path.resolve(ROOT, arg('db', '.local/news.db'));
const OUT = path.resolve(ROOT, arg('out', 'data/history'));
const ARCHIVE = path.resolve(ROOT, arg('archive', 'data/archive'));
const LIMIT = num('limit-per-day', 400);
const SUMMARY = num('summary-chars', 160);
const BUDGET_DAY = num('budget-day-kb', 300) * 1024;
const BUDGET_TOTAL = num('budget-total-mb', 30) * 1024 * 1024;
const FORCE = flag('force');
const INCLUDE_ARCHIVED = flag('include-archived');
const DRY = flag('dry-run');
const ALLOW_OVER = flag('allow-over-budget');
const QUIET = flag('quiet');

const fmtMB = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
const fmtKB = (n) => (n / 1024).toFixed(1) + ' KB';

/** 北京时间 ISO（只用于 gen 字段，便于排查导出批次） */
function nowCN() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return t.toISOString().slice(0, 19) + '+08:00';
}

/** 目录下已有的日期文件集合（只看文件名，不解析内容） */
function listDays(dir) {
  if (!fs.existsSync(dir)) return new Set();
  const out = new Set();
  for (const f of fs.readdirSync(dir)) {
    const d = dayFromFilename(f);
    if (d) out.add(d);
  }
  return out;
}

/** 索引内容比对：忽略 generatedAt，避免每次运行都产生一个无意义的提交 */
const stripVolatile = (s) => String(s).replace(/"generatedAt":\s*"[^"]*"/g, '"generatedAt":"_"');

function main() {
  const win = dayWindow({ days: num('days', 365), from: arg('from', null), to: arg('to', null) });
  if (!fs.existsSync(DB)) {
    console.error(`[history] 找不到数据库：${path.relative(ROOT, DB)}`);
    console.error('          先跑 scripts/news-db/import-archive.mjs 或回补脚本。');
    return 1;
  }

  const fromTs = Math.floor(Date.parse(win.from + 'T00:00:00+08:00') / 1000);
  const toTs = Math.floor(Date.parse(addDays(win.to, 1) + 'T00:00:00+08:00') / 1000);
  if (!QUIET) console.log(`[history] 窗口 ${win.from}..${win.to} · ${win.days} 天`);

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

  // 按北京日期分桶；published_ts<=0 的行在 selectDayItems 里会再被滤一次
  const byDay = new Map();
  for (const r of rows) {
    const d = beijingDay(r.published_ts);
    if (!d || d < win.from || d > win.to) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  }

  const archived = listDays(ARCHIVE);
  const existing = listDays(OUT);
  const gen = nowCN();
  const planned = [];
  let skippedArchived = 0;
  let skippedExisting = 0;
  let emptyDays = 0;
  let selected = 0;

  for (let day = win.to; day >= win.from; day = addDays(day, -1)) {
    const list = byDay.get(day) || [];
    if (archived.has(day) && !INCLUDE_ARCHIVED) {
      skippedArchived++;
      continue;
    }
    if (!list.length) {
      emptyDays++;
      continue;
    }
    if (existing.has(day) && !FORCE) {
      skippedExisting++;
      continue;
    }
    const doc = buildDayDoc(day, list, { limit: LIMIT, summaryChars: SUMMARY, generatedAt: gen });
    const text = JSON.stringify(doc);
    const bytes = Buffer.byteLength(text);
    selected += doc.n;
    planned.push({ day, doc, text, bytes });
    if (bytes > BUDGET_DAY) {
      console.error(
        `[history] 单日超预算：${day} ${fmtKB(bytes)} > ${fmtKB(BUDGET_DAY)}（--limit-per-day ${LIMIT}）`
      );
    }
  }

  if (!QUIET) {
    console.log(
      `[history] 库内 ${rows.length} 条 → 选中 ${selected} 条；` +
        `跳过 archive ${skippedArchived} 天 / 已存在 ${skippedExisting} 天 / 空 ${emptyDays} 天`
    );
  }

  // 体积预算必须在写盘**之前**判定：超预算直接停，避免先写一半再报错
  // 早报与天同键：索引里只带 hasBriefing + 一句摘要，正文展开时才取（见 brief-meta.mjs）
  const briefs = readBriefingMeta(path.join(ROOT, 'data/briefings'));
  const entryMap = new Map();
  for (const d of listDays(OUT)) {
    const file = path.join(OUT, `${d}.json`);
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const b = briefs.get(d);
      entryMap.set(d, {
        d,
        n: Number(doc.n) || 0,
        b: fs.statSync(file).size,
        hasBriefing: !!b,
        briefLine: b ? b.briefLine : '',
      });
    } catch (e) {
      console.error(`[history] 跳过损坏的切片 ${d}: ${e.message}`);
    }
  }
  for (const p of planned) {
    const b = briefs.get(p.day);
    entryMap.set(p.day, {
      d: p.day,
      n: p.doc.n,
      b: p.bytes,
      hasBriefing: !!b,
      briefLine: b ? b.briefLine : '',
    });
  }
  const dayEntries = [...entryMap.values()];
  const totalAfter = dayEntries.reduce((a, x) => a + x.b, 0);

  const maxDay = planned.reduce(
    (a, p) => (p.bytes > a.bytes ? { day: p.day, bytes: p.bytes } : a),
    { day: '', bytes: 0 }
  );
  if (!maxDay.bytes) {
    for (const x of dayEntries) if (x.b > maxDay.bytes) maxDay = { day: x.d, bytes: x.b };
  }
  const overDay = maxDay.bytes > BUDGET_DAY;
  const overTotal = totalAfter > BUDGET_TOTAL;
  if (overDay || overTotal) {
    console.error(
      `[history] 超体积预算：单日 ${fmtKB(maxDay.bytes)} / ${fmtKB(BUDGET_DAY)}，` +
        `总量 ${fmtMB(totalAfter)} / ${fmtMB(BUDGET_TOTAL)}`
    );
    if (!ALLOW_OVER) {
      console.error('[history] 已停止（未写任何文件；确认可用 --allow-over-budget 强制继续）');
      return 3;
    }
  }

  if (!DRY) fs.mkdirSync(OUT, { recursive: true });
  let written = 0;
  for (const p of planned) {
    if (DRY) continue;
    const file = path.join(OUT, `${p.day}.json`);
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (old === p.text) continue;
    fs.writeFileSync(file, p.text, 'utf8');
    written++;
  }

  // 索引：用「已有 + 本次」的并集重建（分批导出也不会互相覆盖）
  const index = buildIndex(dayEntries, { generatedAt: gen });
  const indexText = JSON.stringify(index, null, 2);

  if (!DRY) {
    const idxFile = path.join(OUT, 'index.json');
    const oldIdx = fs.existsSync(idxFile) ? fs.readFileSync(idxFile, 'utf8') : '';
    if (stripVolatile(oldIdx) !== stripVolatile(indexText)) {
      fs.writeFileSync(idxFile, indexText, 'utf8');
    }
  }

  console.log(
    `[history] ${DRY ? '（dry-run，未写盘）' : `写入 ${written} 个切片 ·`}` +
      ` 选中 ${selected} 条 · 总量 ${fmtMB(totalAfter)}` +
      `（单日最大 ${fmtKB(maxDay.bytes)}${maxDay.day ? ' ' + maxDay.day : ''}）`
  );
  console.log(
    `[history] index ${index.days.length} 天 · ${fmtKB(Buffer.byteLength(indexText))}` +
      ` · 覆盖 ${index.from || '—'}..${index.to || '—'} · 共 ${index.total} 条`
  );
  console.log(`[history] schema v${HISTORY_VERSION}`);
  return 0;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  process.exitCode = main();
}
