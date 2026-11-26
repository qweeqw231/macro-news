// scripts/build-search-history.mjs
// 2.22.0：由 data/history/*.json 生成「按月分片」的站内搜索索引。
// 2.30.0（M 档）：分片 = 热段以外的全部日期 —— history 切片 ∪ archive 中 history 未覆盖的日期。
//   history 停在 2026-10-04，10-05 之后只有 archive，不补进来就会出现「热段之外搜不到」的空洞。
//
//   node scripts/build-search-history.mjs            # 全量重建
//   node scripts/build-search-history.mjs --dry-run   # 只算体积，不写盘
//   node scripts/build-search-history.mjs --check     # 校验线上文件是否与 history 一致（CI/提交前）
//
// 产物：data/search-history/manifest.json + data/search-history/YYYY-MM.json
// 约束：只读 data/history 与 data/archive，绝不写回；与前端 assets/search-history.js 共用同一套字段约定。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { addDays } from '../src/news-day.mjs';
import {
  buildChunk,
  buildManifest,
  groupByMonth,
  toSearchItem,
  validateChunk,
  CHUNK_MAX_GZIP,
  HOT_WINDOW_DAYS,
  hotCutoff,
  HISTORY_SEARCH_VERSION,
} from '../src/search-history.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATA = path.join(ROOT, 'data');
// 2.30.0：热段拆出去后，分片要承接 archive 里 history 未覆盖的 40 天（+约 3 MB gzip），
//   实测 2026-11-20 从 13.02 MB 涨到约 16 MB。预算同时上调，否则每次重建都会 exit 8。
// 3.2.1：2026-11-26 15:27 接入 2024-01-01~2025-11-01 历史标题切片（+1008 天）后，
//   实测合计 26.68 MB > 24 MB ⇒ 部署期 build-search 恒 exit 8 ⇒ Pages 从 15:27 起
//   连续失败 3.5 小时（站点停在 eeef5e67，页脚误报「采集/K线停摆」）。预算随数据量上调。
const BUDGET_TOTAL_GZIP = 32 * 1024 * 1024;

const gz = (text) => zlib.gzipSync(Buffer.from(text), { level: 9 }).length;
// generatedAt 每次都会变，比较内容时应剔除，否则 --check 永远报过期
const stripVolatile = (text) => text.replace(/"generatedAt":"[^"]*",?/, '').replace(/"generatedAt": "[^"]*",?/, '');
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

export function buildSearchHistory({ dryRun = false, check = false, generatedAt = new Date().toISOString(), dataDir = DEFAULT_DATA, outDir = path.join(dataDir, 'search-history') } = {}) {
  const HISTORY = path.join(dataDir, 'history');
  const ARCHIVE = path.join(dataDir, 'archive');
  const OUT = outDir;
  const idx = readJSON(path.join(HISTORY, 'index.json'), { days: [] });
  const histDays = new Set((idx.days || []).map((x) => x.d).filter(Boolean));
  if (!histDays.size) {
    console.error('[search-history] data/history/index.json 没有 days，无法构建');
    return 4;
  }

  // 2.30.0：热段（最近 7 个新闻日）由 search.json 承担，分片不再重复收录。
  const hotFrom = hotCutoff(new Date(generatedAt).getTime() || Date.now());
  const hotTo = addDays(hotFrom, HOT_WINDOW_DAYS - 1);

  const archiveDays = fs.existsSync(ARCHIVE)
    ? fs.readdirSync(ARCHIVE).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10))
    : [];
  const allDays = [...new Set([...histDays, ...archiveDays])]
    .filter((d) => d < hotFrom)
    .sort();

  const dayDocs = [];
  const seen = new Set(); // 跨日重复 id：保留更早那天（与 search.json 构建期去重同一口径）
  let fromHistory = 0;
  let fromArchive = 0;
  let dupSkipped = 0;
  for (const day of allDays) {
    const src = histDays.has(day) ? path.join(HISTORY, `${day}.json`) : path.join(ARCHIVE, `${day}.json`);
    if (!fs.existsSync(src)) continue;
    const doc = readJSON(src, null);
    if (!doc || !Array.isArray(doc.items)) {
      // 另一个会话可能正在写这个文件；宁可失败也不发布半份索引
      console.error(`[search-history] 读取失败（可能正在写入）：${day}.json`);
      return 5;
    }
    const items = [];
    for (const raw of doc.items) {
      const it = toSearchItem(raw);
      if (!it.id) continue;
      if (seen.has(it.id)) { dupSkipped++; continue; }
      seen.add(it.id);
      items.push(it);
    }
    if (!items.length) continue;
    dayDocs.push({ day, items });
    if (histDays.has(day)) fromHistory++;
    else fromArchive++;
  }

  if (fromArchive) {
    console.log(
      `[search-history] 热段 ${hotFrom}~${hotTo} 由 search.json 承担；分片补入 archive ${fromArchive} 天` +
        `（history ${fromHistory} 天，跨日重复 id 跳过 ${dupSkipped} 条）`
    );
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

  const manifest = buildManifest(chunks, {
    generatedAt,
    from: idx.from || allDays[0],
    to: allDays[allDays.length - 1] || '',
    hot: { days: HOT_WINDOW_DAYS, from: hotFrom, to: hotTo },
  });
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
    )} · gzip ${mb(totalGzip)} · manifest ${kb(Buffer.byteLength(manifestText))}` +
      ` · 热段 ${hotFrom}~${hotTo}（${HOT_WINDOW_DAYS} 天，由 search.json 承担）`
  );

  const stale =
    !fs.existsSync(path.join(OUT, 'manifest.json')) ||
    stripVolatile(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')) !== stripVolatile(manifestText);

  if (check) {
    const mismatched = chunks.filter(
      (c) => !fs.existsSync(path.join(OUT, `${c.m}.json`)) ||
        stripVolatile(fs.readFileSync(path.join(OUT, `${c.m}.json`), 'utf8')) !== stripVolatile(texts.get(c.m))
    );
    if (stale || mismatched.length) {
      console.error(
        `[search-history] 索引已过期：manifest ${stale ? '不一致' : '一致'}，` +
          `分片不一致 ${mismatched.length} 个（${mismatched.map((x) => x.m).join(' ') || '无'}）`
      );
      return 1;
    }
    console.log('[search-history] 校验通过：分片与 data/history + archive 一致');
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
