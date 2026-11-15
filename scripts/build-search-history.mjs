// scripts/build-search-history.mjs
// 2.22.0：由 data/history/*.json 生成「按月分片」的站内搜索索引。
//
//   node scripts/build-search-history.mjs            # 全量重建
//   node scripts/build-search-history.mjs --dry-run   # 只算体积，不写盘
//   node scripts/build-search-history.mjs --check     # 校验线上文件是否与 history 一致（CI/提交前）
//
// 产物：data/search-history/manifest.json + data/search-history/YYYY-MM.json
// 约束：只读 data/history，绝不写回；与前端 assets/search-history.js 共用同一套字段约定。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  buildChunk,
  buildManifest,
  groupByMonth,
  validateChunk,
  CHUNK_MAX_GZIP,
  HISTORY_SEARCH_VERSION,
} from '../src/search-history.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY = path.join(ROOT, 'data/history');
const OUT = path.join(ROOT, 'data/search-history');
const BUDGET_TOTAL_GZIP = 16 * 1024 * 1024;

const gz = (text) => zlib.gzipSync(Buffer.from(text), { level: 9 }).length;
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeIfChanged(file, text) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (old === text) return false;
  fs.writeFileSync(file, text, 'utf8');
  return true;
}

export function buildSearchHistory({ dryRun = false, check = false, generatedAt = new Date().toISOString() } = {}) {
  const idx = readJSON(path.join(HISTORY, 'index.json'), { days: [] });
  const days = (idx.days || []).map((x) => x.d).filter(Boolean).sort();
  if (!days.length) {
    console.error('[search-history] data/history/index.json 没有 days，无法构建');
    return 4;
  }

  const dayDocs = [];
  for (const day of days) {
    const file = path.join(HISTORY, `${day}.json`);
    if (!fs.existsSync(file)) continue;
    const doc = readJSON(file, null);
    if (!doc || !Array.isArray(doc.items)) {
      // 另一个会话可能正在写这个文件；宁可失败也不发布半份索引
      console.error(`[search-history] 读取失败（可能正在写入）：${day}.json`);
      return 5;
    }
    dayDocs.push({ day, items: doc.items });
  }

  const byMonth = groupByMonth(dayDocs);
  const chunks = [];
  const texts = new Map();
  for (const [month, items] of [...byMonth.entries()].sort()) {
    const chunk = buildChunk(month, items, { generatedAt });
    const bad = validateChunk(chunk);
    if (bad) {
      console.error(`[search-history] ${month} 分片校验失败：${bad}`);
      return 6;
    }
    const text = JSON.stringify(chunk);
    const g = gz(text);
    if (g > CHUNK_MAX_GZIP) {
      console.error(`[search-history] ${month} 分片 ${kb(g)} 超过上限 ${kb(CHUNK_MAX_GZIP)}`);
      return 7;
    }
    chunks.push({ m: month, n: items.length, bytes: Buffer.byteLength(text), gzip: g });
    texts.set(month, text);
  }

  const manifest = buildManifest(chunks, { generatedAt, from: idx.from || days[0], to: idx.to || days[days.length - 1] });
  const manifestText = JSON.stringify(manifest, null, 2);
  const totalGzip = chunks.reduce((a, c) => a + c.gzip, 0);
  if (totalGzip > BUDGET_TOTAL_GZIP) {
    console.error(`[search-history] 合计 gzip ${mb(totalGzip)} 超过预算 ${mb(BUDGET_TOTAL_GZIP)}`);
    return 8;
  }

  for (const c of chunks) {
    console.log(`  ${c.m}  ${String(c.n).padStart(6)} 条  ${kb(c.bytes).padStart(9)} / ${kb(c.gzip)} gzip`);
  }
  console.log(
    `[search-history] ${chunks.length} 个月 · ${manifest.total} 条 · raw ${mb(
      chunks.reduce((a, c) => a + c.bytes, 0)
    )} · gzip ${mb(totalGzip)} · manifest ${kb(Buffer.byteLength(manifestText))}`
  );

  const stale =
    !fs.existsSync(path.join(OUT, 'manifest.json')) ||
    fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8').replace(/"generatedAt": "[^"]*",?/, '') !==
      manifestText.replace(/"generatedAt": "[^"]*",?/, '');

  if (check) {
    const mismatched = chunks.filter(
      (c) => !fs.existsSync(path.join(OUT, `${c.m}.json`)) ||
        fs.readFileSync(path.join(OUT, `${c.m}.json`), 'utf8') !== texts.get(c.m)
    );
    if (stale || mismatched.length) {
      console.error(
        `[search-history] 索引已过期：manifest ${stale ? '不一致' : '一致'}，` +
          `分片不一致 ${mismatched.length} 个（${mismatched.map((x) => x.m).join(' ') || '无'}）`
      );
      return 1;
    }
    console.log('[search-history] 校验通过：分片与 data/history 一致');
    return 0;
  }

  if (dryRun) {
    console.log('[search-history] dry-run，未写盘');
    return 0;
  }

  fs.mkdirSync(OUT, { recursive: true });
  let written = 0;
  for (const [month, text] of texts) if (writeIfChanged(path.join(OUT, `${month}.json`), text)) written++;
  const wroteManifest = writeIfChanged(path.join(OUT, 'manifest.json'), manifestText);
  console.log(
    `[search-history] 写入 ${written} 个分片${wroteManifest ? ' + manifest' : ''}（schema v${HISTORY_SEARCH_VERSION}）`
  );
  return 0;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const argv = process.argv.slice(2);
  process.exitCode = buildSearchHistory({ dryRun: argv.includes('--dry-run'), check: argv.includes('--check') });
}
