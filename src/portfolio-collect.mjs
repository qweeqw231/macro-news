// src/portfolio-collect.mjs
// 宏观指标 + 1Y 国债日 K 采集（每日 16:30 Asia/Shanghai）
//
// 规格：《采集规格.md》§2/§4/§5/§6
//   · 采集 5 个宏观指标
//   · 追加写入 data/macro/daily.json
//   · 运行日志写入 data/_last-run.json
//
// ⚠ 2026-10-31 起：行情（ndx / xau / xag / brent / sge / usdcny / cgb_1y）
//   全部并入 collect.mjs 的 15 分钟采集（portfolio.mjs 的 fetchPortfolioQuotesFast），
//   本任务不再读写 data/quotes.json —— 否则每天 16:30（美股开盘前）会用旧值
//   把高频任务刚更新的卡片覆盖回去。
//   1Y 国债日 K 仍由本任务追加（中债曲线每天只发布一次）。
//
// 用法：
//   node src/portfolio-collect.mjs            # 正常采集
//   node src/portfolio-collect.mjs --dry-run  # 只采集并打印，不写盘

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchMacroIndicators, fetchCgbCurveOneY } from './portfolio.mjs';
import { aggregateDaily } from './aggregate.mjs';

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

  // ---- 采集：宏观指标 + 1Y 国债日 K ----
  // ⚠ 2026-10-31 起，xau/xag/brent/ndx 等全部行情改由 collect.mjs 的 15 分钟采集负责
  //   （见 portfolio.mjs 的 fetchPortfolioQuotesFast）。本任务不再读写 quotes.json ——
  //   否则每天 16:30（美股开盘前）会把高频任务刚更新的卡片用旧值覆盖回去。
  const mRes = await fetchMacroIndicators();
  const { items: macroItems, ok: mOk, fail: mFail } = mRes;
  console.log(`  宏观成功 ${mOk.length}/5：${mOk.join(', ') || '无'}`);
  for (const [k, v] of Object.entries(mFail)) console.log(`  ❌ 宏观 ${k}：${v}`);

  // 运行日志的 at 按规格 §6 的示例用 +08:00。
  const at = new Date().toISOString();
  const atCN = isoCN();
  const day = dayKey();

  if (DRY_RUN) {
    console.log('\n[dry-run] 采集结果（不写盘）：');
    console.log(JSON.stringify({ macroItems }, null, 2));
    return;
  }

  // ---- 1Y 国债收益率的 K 线：每天追加一根到 data/kline/cgb_1y.json ----
  // 站点上「1Y国债收益率」这张卡片的 K 线**只有这一个源**（中债逐日曲线），
  // 没有东财 secid、没有腾讯代码 ⇒ 前端只能读本地预生成文件。
  // 收益率没有开高低收，o=h=l=c=收益率，v=0。
  let cgbDate = day, cgbVal = null;
  for (let back = 0; back <= 7 && cgbVal === null; back++) {
    const tryDay = dayKey(new Date(Date.now() - back * 86400000));
    try {
      const c = await fetchCgbCurveOneY(tryDay);
      if (c) { cgbVal = c.oneY; cgbDate = c.srcDate; }
    } catch { /* 当天没有曲线就继续往前找 */ }
  }
  if (Number.isFinite(cgbVal)) {
    const klineFile = path.join(DATA, 'kline', 'cgb_1y.json');
    const old = await readJSON(klineFile, { bars: [] });
    const bars = Array.isArray(old.bars) ? old.bars.slice() : [];
    const srcDay = cgbDate;
    const bar = { t: srcDay, o: cgbVal, c: cgbVal, h: cgbVal, l: cgbVal, v: 0 };
    const i = bars.findIndex((b) => b.t === srcDay);
    if (i >= 0) bars[i] = bar;
    else bars.push(bar);
    bars.sort((a, b) => String(a.t).localeCompare(String(b.t)));
    const klineChanged = await writeJSONIfChanged(klineFile, {
      key: 'cgb_1y',
      name: '1Y国债收益率',
      market: 'CN',
      period: '1d',
      generatedAt: at,
      source: '中债国债收益率曲线（queryGjqxInfo）',
      bars,
    });
    console.log(
      `  kline/cgb_1y.json：${bars.length} 根（最新 ${bars[bars.length - 1]?.t} = ` +
      `${bars[bars.length - 1]?.c}%）${klineChanged ? '' : ' · 内容未变，跳过写盘'}`
    );

    // ---- 顺带预生成周K / 月K ----
    // 前端点「周K / 月K」时会读 `data/kline/cgb_1y_1w.json` / `_1M.json`；
    // 没有这两个文件就得回退到「在浏览器端用日K 聚合」，
    // 而日K 文件有 500KB —— 线上按本机 5~30 KB/s 的带宽重下一次要 20~100 秒。
    // ⇒ 后端提前聚合好（口径见 src/aggregate.mjs），前端点一下就能开。
    for (const [period, unit] of [['1w', 'week'], ['1M', 'month']]) {
      const sub = aggregateDaily(bars, unit);
      if (!sub.length) continue;
      const f = path.join(DATA, 'kline', `cgb_1y_${period}.json`);
      const changed = await writeJSONIfChanged(f, {
        key: 'cgb_1y',
        name: '1Y国债收益率',
        market: 'CN',
        period,
        generatedAt: at,
        source: '中债国债收益率曲线（queryGjqxInfo）· 由日K聚合',
        bars: sub,
      });
      console.log(
        `  kline/cgb_1y_${period}.json：${sub.length} 根` +
        `${changed ? '' : ' · 内容未变，跳过写盘'}`
      );
    }
  }

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
  // 本任务只更新宏观相关字段（行情字段归 collect.mjs）。
  const logFile = path.join(DATA, '_last-run.json');
  const prevLog = await readJSON(logFile, {});
  const nextLog = { ...prevLog, at: atCN, macroOk: mOk, macroFail: mFail, macroDurationMs: Date.now() - started };
  delete nextLog.portfolioQuotes;
  delete nextLog.portfolioDurationMs;
  await writeJSONIfChanged(logFile, nextLog);
  console.log('  _last-run.json：已更新 at/macroOk/macroFail');

  console.log(`[portfolio] 完成 · ${Date.now() - started}ms`);

  // 宏观全部失败才算整轮失败（部分成功仍应落盘）
  if (mOk.length === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[portfolio] 致命错误', err);
  process.exit(1);
});
