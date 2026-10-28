// src/portfolio-collect.mjs
// 组合行情 + 宏观指标采集（每日 16:30 Asia/Shanghai）
//
// 规格：《采集规格.md》§1/§2/§4/§5/§6
//   · 采集 5 个新增行情 key + 5 个宏观指标
//   · 合并写入 data/quotes.json（保留原有 17 个 key）
//   · 追加写入 data/macro/daily.json
//   · 运行日志写入 data/_last-run.json
//
// 与 collect.mjs 的关系：
//   collect.mjs         每 5 分钟跑（GitHub Actions），负责新闻 + 17 个指数行情
//   portfolio-collect   每日跑一次，负责组合行情 + 宏观指标
// 两者都会写 quotes.json 与 _last-run.json，因此都必须「读改写」，
// 保留对方写入的字段，否则高频任务会把低频任务的结果覆盖掉。
//
// 用法：
//   node src/portfolio-collect.mjs            # 正常采集
//   node src/portfolio-collect.mjs --dry-run  # 只采集并打印，不写盘

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPortfolioQuotes, fetchMacroIndicators } from './portfolio.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const DRY_RUN = process.argv.includes('--dry-run');

// 规格 §1：超时 60 秒。留 5 秒给写盘，留出余量。
const DEADLINE_MS = 55000;
const started = Date.now();
const remaining = () => DEADLINE_MS - (Date.now() - started);

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 北京时间 ISO 串（+08:00）。规格 §6 的运行日志示例用的是这个口径。 */
function isoCN(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+08:00`;
}

async function readJSON(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJSON(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * 写盘前比对：内容没变就不写。
 * 时间戳类字段每次都变，若无条件写盘，git 会为同一份数据反复存新 blob
 * （这条在 collect.mjs 里已经踩过：12 个 K 线文件仅因时间戳就多出 109KB/次）。
 *
 * ⚠ 这里刻意**不剥 `at`**：_last-run.json 的 `at` 就是「本轮运行时间」，
 *   剥掉它会导致「ok/fail 与上次完全相同」时整份文件被判为未变化而跳过写入，
 *   磁盘上的运行时间就会停在上一轮。每天写一次，开销可忽略。
 */
const TIME_FIELDS = '(generatedAt|updatedAt|startedAt|endedAt|durationMs)';
const reTime = new RegExp(`"${TIME_FIELDS}"\\s*:\\s*"[^"]*"`, 'g');
const reNum = new RegExp('"(durationMs|ms)"\\s*:\\s*[^,\\n}]*', 'g');
const stripVolatile = (text) =>
  String(text).replace(reTime, '"_":"_"').replace(reNum, '"_":0');

async function writeJSONIfChanged(file, obj) {
  const text = JSON.stringify(obj, null, 2);
  if (existsSync(file)) {
    try {
      const old = await readFile(file, 'utf8');
      if (stripVolatile(old) === stripVolatile(text)) return false;
    } catch { /* 读不了就照常写 */ }
  }
  // 目标目录可能尚不存在（如首次写入 data/macro/daily.json）
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
  return true;
}

async function main() {
  console.log(`[portfolio] 开始 · 预算 ${DEADLINE_MS}ms`);

  // ---- 采集：行情 + 宏观（各自独立容错）----
  // 先读旧 quotes.json：§3.3 的 estimated 回退需要上一次已写入的上海金收盘价。
  const quotesFile = path.join(DATA, 'quotes.json');
  const existingQuotes = await readJSON(quotesFile, { quotes: [] });

  const [qRes, mRes] = await Promise.all([
    fetchPortfolioQuotes(existingQuotes.quotes || []),
    fetchMacroIndicators(),
  ]);
  const { quotes, ok, fail } = qRes;
  const { items: macroItems, ok: mOk, fail: mFail } = mRes;

  console.log(`  行情成功 ${ok.length}/5：${ok.join(', ') || '无'}`);
  console.log(`  宏观成功 ${mOk.length}/5：${mOk.join(', ') || '无'}`);
  for (const [k, v] of Object.entries(fail)) console.log(`  ❌ ${k}：${v}`);
  for (const [k, v] of Object.entries(mFail)) console.log(`  ❌ 宏观 ${k}：${v}`);

  // quotes.json 的 generatedAt 按规格 §4.1 用 UTC；
  // 运行日志的 at 按规格 §6 的示例用 +08:00。
  const at = new Date().toISOString();
  const atCN = isoCN();
  const day = dayKey();

  if (DRY_RUN) {
    console.log('\n[dry-run] 采集结果（不写盘）：');
    console.log(JSON.stringify({ quotes, macroItems }, null, 2));
    return;
  }

  // ---- §4.1 合并写入 quotes.json：保留原有 key ----
  // 原有 17 个 key 由 collect.mjs 维护，本任务只更新/追加这 5 个。
  // 这里按 key 做合并：既保留本任务上次写入的值，也保留其它任务写入的 key。
  const byKey = new Map((existingQuotes.quotes || []).map((q) => [q.key, q]));
  for (const q of quotes) byKey.set(q.key, q);
  const mergedQuotes = [...byKey.values()];
  const quotesChanged = await writeJSONIfChanged(quotesFile, {
    generatedAt: at,
    quotes: mergedQuotes,
  });
  console.log(
    `  quotes.json：${mergedQuotes.length} 个 key（新增/更新 ${quotes.length}）` +
    `${quotesChanged ? '' : ' · 内容未变，跳过写盘'}`
  );

  // ---- §4.2 追加写入 data/macro/daily.json ----
  // 每条记录形如 {"date":"2026-10-28","items":[...]}，按日期去重（同日重跑覆盖）。
  const macroFile = path.join(DATA, 'macro', 'daily.json');
  const macroDoc = await readJSON(macroFile, []);
  const list = Array.isArray(macroDoc) ? macroDoc : [];
  const record = {
    date: day,
    items: macroItems.map((m) => ({
      key: m.key,
      name: m.name,
      value: m.value,
      unit: m.unit,
      source: m.source,
      ...(m.note ? { note: m.note } : {}),
    })),
  };
  const idx = list.findIndex((d) => d.date === day);
  if (idx >= 0) list[idx] = record;
  else list.push(record);
  list.sort((a, b) => (a.date < b.date ? 1 : -1));
  // 只保留最近 400 天，避免文件无限增长
  const trimmed = list.slice(0, 400);
  const macroChanged = await writeJSONIfChanged(macroFile, trimmed);
  console.log(`  macro/daily.json：${trimmed.length} 天${macroChanged ? '' : ' · 内容未变，跳过写盘'}`);

  // ---- §6 运行日志写入 data/_last-run.json ----
  // 读改写：保留 collect.mjs 写的字段（前端「来源」页依赖 sources/startedAt/...），
  // 只更新本任务负责的 at / ok / fail。
  const logFile = path.join(DATA, '_last-run.json');
  const prevLog = await readJSON(logFile, {});
  await writeJSONIfChanged(logFile, {
    ...prevLog,
    at: atCN,
    ok,
    fail,
    macroOk: mOk,
    macroFail: mFail,
    portfolioQuotes: quotes.length,
    portfolioDurationMs: Date.now() - started,
  });
  console.log('  _last-run.json：已更新 at/ok/fail');

  console.log(`[portfolio] 完成 · ${Date.now() - started}ms`);

  // 全部源都失败才算整轮失败（部分成功仍应落盘）
  if (ok.length === 0 && mOk.length === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[portfolio] 致命错误', err);
  process.exit(1);
});
