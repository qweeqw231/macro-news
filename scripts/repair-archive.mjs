// scripts/repair-archive.mjs
// 2.4.5 / 2.4.6 的一次性历史数据修复（可重复运行，幂等）。
//
//   node scripts/repair-archive.mjs              # 去重 + 回填标题 + 重建派生文件
//   node scripts/repair-archive.mjs --dedupe     # 只做同文合并
//   node scripts/repair-archive.mjs --titles     # 只回填被 40 字硬截的标题
//
// 修复范围：
//   1. dedupe：对每个 data/archive/<date>.json 跑 dedupeItems（同 URL / 同正文 / 同标题）；
//   2. titles：旧采集器把无标题快讯硬截成 40 字（content 的前 40 字），
//      本次从 content 的第一整句回填完整标题；只处理「title 恰好 40 字且 content 以它开头」，
//      不动真实标题；
//   3. 重建 data/index.json、data/latest.json、data/search.json（与 collect 同口径）。
//
// 不改 archive 之外的任何文件；不联网。

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedupeItems } from '../src/news-dedupe.mjs';
import { titleFromText } from '../src/news-title.mjs';
import { readBriefingMeta } from '../src/brief-meta.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const ARCHIVE = path.join(DATA, 'archive');
const flag = (n) => process.argv.includes('--' + n);
const BOTH = !flag('dedupe') && !flag('titles');
const DO_DEDUPE = BOTH || flag('dedupe');
const DO_TITLES = BOTH || flag('titles');

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJSON(file, obj) {
  await writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * 用归档重建 index / latest / search（与 collect 同口径）。
 * 供 repair-archive 与 repair-nbs-time 共用。
 */
export async function rebuildDerived(docs, dataDir = DATA) {
  const briefs = readBriefingMeta(path.join(dataDir, 'briefings'));
  const days = docs.map((d) => {
    const b = briefs.get(d.day);
    return {
      day: d.day,
      count: d.items.length,
      hasBriefing: !!b,
      ...(b && b.briefLine ? { briefLine: b.briefLine } : {}),
      ...(b ? { source: b.source } : {}),
    };
  }).sort((a, b) => (a.day < b.day ? 1 : -1));
  const allCount = docs.reduce((n, d) => n + d.items.length, 0);

  await writeJSON(path.join(dataDir, 'index.json'), {
    generatedAt: new Date().toISOString(),
    total: allCount,
    days,
  });

  const sorted = [...docs].sort((a, b) => (a.day < b.day ? 1 : -1));
  const latest = sorted.flatMap((d) => d.items).sort((a, b) => b.ts - a.ts).slice(0, 200);
  await writeJSON(path.join(dataDir, 'latest.json'), {
    generatedAt: new Date().toISOString(),
    total: allCount,
    items: latest,
  });

  const searchItems = sorted.flatMap((d) => d.items.map((it) => ({
    id: it.id,
    ts: it.ts,
    time: it.time,
    source: it.source,
    channel: it.channel,
    title: it.title,
    summary: (it.summary || '').slice(0, 220),
    url: it.url,
  })));
  await writeJSON(path.join(dataDir, 'search.json'), {
    generatedAt: new Date().toISOString(),
    total: searchItems.length,
    items: searchItems,
  });
}

const stats = { files: 0, items: 0, deduped: 0, retitled: 0, changedFiles: 0 };

/** 旧采集器的硬截特征：title 恰好 40 字，且正文以它开头 */
function isHardCut(it) {
  return !!it && typeof it.title === 'string' && it.title.length === 40
    && typeof it.content === 'string' && it.content.length > 40
    && it.content.startsWith(it.title);
}

async function main() {
  const files = (await readdir(ARCHIVE)).filter((f) => f.endsWith('.json')).sort();
  const docs = [];
  for (const f of files) {
    const file = path.join(ARCHIVE, f);
    const doc = await readJSON(file, null);
    if (!doc || !Array.isArray(doc.items)) continue;
    stats.files++;
    const before = doc.items.length;
    stats.items += before;
    const beforeJSON = JSON.stringify(doc.items);

    if (DO_DEDUPE) doc.items = dedupeItems(doc.items);
    if (DO_TITLES) {
      for (const it of doc.items) {
        if (!isHardCut(it)) continue;
        const t = titleFromText(it.content);
        if (t && t !== it.title) { it.title = t; stats.retitled++; }
      }
    }

    const removed = before - doc.items.length;
    stats.deduped += removed;
    const changed = beforeJSON !== JSON.stringify(doc.items);
    if (changed) {
      const oldText = await readFile(file, 'utf8');
      const newText = JSON.stringify(doc, null, 2);
      if (oldText !== newText) {
        await writeJSON(file, doc);
        stats.changedFiles++;
      }
    }
    docs.push(doc);
  }

  // 派生文件重建（只在 archive 有变化时才写，避免无谓提交）
  if (stats.changedFiles) await rebuildDerived(docs, DATA);

  console.log(`[repair] ${stats.files} 个归档 / ${stats.items} 条；`
    + `合并重复 -${stats.deduped}；回填标题 ${stats.retitled}；改写 ${stats.changedFiles} 个文件`
    + (stats.changedFiles ? '；已重建 index/latest/search' : '；无变化，未重建'));
}

if (!existsSync(ARCHIVE)) {
  console.error('[repair] 找不到 data/archive');
  process.exit(1);
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('[repair] 失败', e); process.exit(1); });
