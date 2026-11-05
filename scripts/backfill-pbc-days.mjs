#!/usr/bin/env node
// scripts/backfill-pbc-days.mjs
// 2.5.0：把 PBOC 归档条目按 URL 的真实时间移回正确的新闻日。
//
// 幂等：第二次运行 moved=0，不写任何文件。
// 显式路径：必须传 --root <仓库根目录>，不提供默认根路径，避免误写其它目录。
//
// 用法：
//   node scripts/backfill-pbc-days.mjs --root C:\Work\Minimax_Work\macro-news
//   node scripts/backfill-pbc-days.mjs --root ... --dry-run
//   node scripts/backfill-pbc-days.mjs --root ... --as-of 2026-11-05T20:00:00+08:00

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pbcTimeFromUrl } from '../src/pbc-time.mjs';
import { compactSearchItem, searchCutoff, SEARCH_WINDOW_DAYS } from '../src/search-window.mjs';

export const PBC_SOURCE = '中国人民银行';
const DAY_RE = /^\d{4}-\d{2}-\d{2}\.json$/;

async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJSON(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
}
const tsOf = (it) => Number(it && it.ts) || 0;

/**
 * 回填 PBOC 错日条目。
 * @param {{root:string, asOf?:Date|string, dryRun?:boolean}} opts
 */
export async function backfillPbcDays({ root, asOf = new Date(), dryRun = false } = {}) {
  if (!root) throw new Error('必须显式传入 root（--root <仓库根目录>）');
  const when = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(when.getTime())) throw new Error(`as-of 非法：${asOf}`);

  const dataDir = path.join(root, 'data');
  const archiveDir = path.join(dataDir, 'archive');
  const files = (await fs.readdir(archiveDir)).filter((f) => DAY_RE.test(f)).sort();
  if (!files.length) throw new Error(`archive 目录为空：${archiveDir}`);

  const docs = new Map();
  for (const f of files) {
    const day = f.replace('.json', '');
    const doc = await readJSON(path.join(archiveDir, f), { day, items: [] });
    docs.set(day, { day, items: Array.isArray(doc.items) ? doc.items : [] });
  }

  const before = new Map([...docs].map(([d, doc]) => [d, doc.items.length]));
  const uniqueBefore = countUniquePbc(docs);
  let pbcBefore = 0;
  const moves = [];
  for (const [day, doc] of docs) {
    for (const it of doc.items) {
      if (it.source !== PBC_SOURCE) continue;
      pbcBefore++;
      const exact = pbcTimeFromUrl(it.url);
      if (!exact) continue;
      const needsMove = exact.day !== day;
      const needsTime = it.ts !== exact.ts || it.time !== exact.time;
      if (!needsMove && !needsTime) continue;
      moves.push({
        from: day,
        to: exact.day,
        id: it.id,
        title: it.title || '',
        item: { ...it, ts: exact.ts, time: exact.time },
      });
    }
  }

  if (!moves.length) {
    return {
      moved: 0, updated: 0, timeOnly: 0, merged: 0, dryRun, changed: [], pbcBefore, pbcAfter: pbcBefore,
      uniqueBefore, uniqueAfter: uniqueBefore,
      totalBefore: sumCounts(docs), totalAfter: sumCounts(docs), overflow: [],
    };
  }
  const dayMoves = moves.filter((m) => m.from !== m.to).length;
  const timeOnly = moves.length - dayMoves;

  const changed = new Set();
  let merged = 0;
  for (const mv of moves) {
    const fromDoc = docs.get(mv.from);
    const idx = fromDoc.items.findIndex((x) => x.id === mv.id);
    if (idx < 0) throw new Error(`源文件 ${mv.from}.json 找不到条目 ${mv.id}`);
    fromDoc.items.splice(idx, 1);
    changed.add(mv.from);

    const toDoc = docs.get(mv.to) || { day: mv.to, items: [] };
    docs.set(mv.to, toDoc);
    const dupIdx = toDoc.items.findIndex((x) => x.id === mv.id);
    if (dupIdx >= 0) {
      // 同一篇文章已在正确日存在（旧版重复写盘）：用真实时间覆盖那一份，删掉错日副本。
      // 这不会丢文章，只合并同 id 的重复副本；PBOC 唯一条目数保持不变。
      toDoc.items[dupIdx] = mv.item;
      merged++;
    } else {
      toDoc.items.push(mv.item);
    }
    changed.add(mv.to);
  }

  for (const day of changed) docs.get(day).items.sort((a, b) => tsOf(b) - tsOf(a));

  const totalBefore = [...before.values()].reduce((a, b) => a + b, 0);
  const totalAfter = sumCounts(docs);
  const pbcAfter = countPbc(docs);
  const uniqueAfter = countUniquePbc(docs);
  if (uniqueAfter !== uniqueBefore) {
    throw new Error(`PBOC 唯一文章数变化：${uniqueBefore} → ${uniqueAfter}；为保守起见中止`);
  }
  if (totalAfter !== totalBefore - merged) {
    throw new Error(`归档总条数变化异常：${totalBefore} → ${totalAfter}，合并 ${merged} 对；为保守起见中止`);
  }

  const changedRows = [...changed].sort().map((day) => ({
    day,
    before: before.get(day) || 0,
    after: docs.get(day).items.length,
    delta: docs.get(day).items.length - (before.get(day) || 0),
  }));
  const overflow = [...docs].filter(([, doc]) => doc.items.length > 800)
    .map(([day, doc]) => ({ day, count: doc.items.length }));

  if (dryRun) {
    return { moved: dayMoves, updated: moves.length, timeOnly, merged, dryRun, changed: changedRows, pbcBefore, pbcAfter, uniqueBefore, uniqueAfter, totalBefore, totalAfter, overflow };
  }

  for (const day of changed) {
    await writeJSON(path.join(archiveDir, `${day}.json`), docs.get(day));
  }
  await rebuildDerived({ docs, dataDir, when });
  return { moved: dayMoves, updated: moves.length, timeOnly, merged, dryRun, changed: changedRows, pbcBefore, pbcAfter, uniqueBefore, uniqueAfter, totalBefore, totalAfter, overflow };
}

function countUniquePbc(docs) {
  const ids = new Set();
  for (const doc of docs.values()) {
    for (const it of doc.items) if (it.source === PBC_SOURCE) ids.add(it.id);
  }
  return ids.size;
}

function sumCounts(docs) {
  let n = 0;
  for (const doc of docs.values()) n += doc.items.length;
  return n;
}
function countPbc(docs) {
  let n = 0;
  for (const doc of docs.values()) {
    for (const it of doc.items) if (it.source === PBC_SOURCE) n++;
  }
  return n;
}

/** 从全部 archive 重建 index.json / latest.json / search.json（不跑配额选材） */
async function rebuildDerived({ docs, dataDir, when }) {
  const sorted = [...docs.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  const total = sumCounts(docs);

  // index：保留已有的早报字段，只更新 count/total/generatedAt
  const prevIndex = await readJSON(path.join(dataDir, 'index.json'), { days: [] });
  const meta = new Map((prevIndex.days || []).map((d) => [d.day, d]));
  const days = sorted.map((doc) => {
    const m = meta.get(doc.day) || {};
    return {
      day: doc.day,
      count: doc.items.length,
      hasBriefing: !!m.hasBriefing,
      ...(m.briefLine ? { briefLine: m.briefLine } : {}),
      ...(m.source ? { source: m.source } : {}),
    };
  });
  await writeJSON(path.join(dataDir, 'index.json'), {
    generatedAt: when.toISOString(), total, days,
  });

  // latest：与 collect.mjs 相同口径，最近 200 条
  const allItems = [];
  for (const doc of sorted) {
    allItems.push(...doc.items);
    if (allItems.length >= 200) break;
  }
  const latest = allItems.sort((a, b) => tsOf(b) - tsOf(a)).slice(0, 200);
  await writeJSON(path.join(dataDir, 'latest.json'), {
    generatedAt: when.toISOString(), total, items: latest,
  });

  // search：最近 62 个新闻日，字段与 collect.mjs 一致
  const from = searchCutoff(when.getTime());
  const searchItems = [];
  let searchDays = 0;
  for (const doc of sorted) {
    if (doc.day < from) break;
    for (const it of doc.items) searchItems.push(compactSearchItem(it));
    searchDays++;
  }
  await writeJSON(path.join(dataDir, 'search.json'), {
    generatedAt: when.toISOString(),
    windowDays: SEARCH_WINDOW_DAYS,
    from,
    days: searchDays,
    total: searchItems.length,
    items: searchItems,
  });
}

// ---------- CLI ----------
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : dflt;
};
const isDirectRun = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  const root = arg('root', null);
  if (!root) {
    console.error('必须显式传 --root <仓库根目录>（不提供默认路径，避免误写）');
    process.exit(2);
  }
  const asOf = arg('as-of', null);
  const dryRun = process.argv.includes('--dry-run');
  try {
    const r = await backfillPbcDays({ root: path.resolve(root), asOf: asOf ? new Date(asOf) : new Date(), dryRun });
    console.log(`PBOC 回填：跨日 ${r.moved} 条，仅更新时间 ${r.timeOnly} 条（合计 ${r.updated}），合并同 id 重复 ${r.merged} 对${r.dryRun ? '（dry-run，未写盘）' : ''}`);
    console.log(`PBOC 条目 ${r.pbcBefore} → ${r.pbcAfter}，唯一文章 ${r.uniqueBefore} → ${r.uniqueAfter}，总条数 ${r.totalBefore} → ${r.totalAfter}`);
    for (const row of r.changed) {
      console.log(`${row.day}  ${row.before} → ${row.after}  (${row.delta >= 0 ? '+' : ''}${row.delta})`);
    }
    if (r.overflow.length) {
      console.log('⚠ 超过 800 的日（回填脚本不裁剪）：' + r.overflow.map((x) => `${x.day}=${x.count}`).join('，'));
    }
  } catch (err) {
    console.error(`回填失败：${err.message}`);
    process.exitCode = 1;
  }
}
