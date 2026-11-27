// scripts/periodic/validate.mjs
// 周期报告（周报/月报）落盘校验：对照 docs/periodic-report.md 与本轮的输入快照
// （.local/periodic-inputs/<id>.meta.json + partNN.tsv）检查产物是否合规。
//
// 用法：
//   node scripts/periodic/validate.mjs 2024-W06
//   node scripts/periodic/validate.mjs --all
//
// 退出码：0 全部通过 / 1 有失败项 / 2 参数问题

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PERIODIC = path.join(ROOT, 'data', 'periodic');
const INPUTS = path.join(ROOT, '.local', 'periodic-inputs');
const IDX_FILE = path.join(PERIODIC, 'index.json');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const isIsoBj = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(String(s || ''));
const len = (s) => Array.from(String(s == null ? '' : s)).length;

function loadInput(id) {
  const metaFile = path.join(INPUTS, `${id}.meta.json`);
  if (!fs.existsSync(metaFile)) return null;
  const meta = readJson(metaFile);
  const urls = new Set();
  for (const p of meta.parts || []) {
    const file = path.join(INPUTS, p.file);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const cols = line.split('\t');
      if (cols[5]) urls.add(cols[5].trim());
    }
  }
  return { meta, urls };
}

function validateOne(id, index) {
  const errs = [];
  const warns = [];
  const add = (m) => errs.push(m);
  const file = path.join(PERIODIC, `${id}.json`);
  if (!fs.existsSync(file)) return [`正文不存在：data/periodic/${id}.json`];

  let doc;
  try {
    doc = readJson(file);
  } catch (e) {
    return [`正文 JSON 解析失败：${e.message}`];
  }

  if (doc.date !== id) add(`date 应为 ${id}，实际 ${doc.date || '空'}`);
  const expectType = /^\d{4}-W\d{2}$/.test(id) ? 'week' : /^\d{4}-\d{2}$/.test(id) ? 'month' : 'year';
  if (doc.type !== expectType) add(`type 应为 ${expectType}，实际 ${doc.type || '空'}`);
  if (doc.source !== 'ai') add(`source 应为 ai，实际 ${doc.source}`);
  if (doc.generator !== 'minimaxcode') add(`generator 应为 minimaxcode，实际 ${doc.generator}`);
  for (const k of ['generatedAt', 'endedAt']) {
    if (!isIsoBj(doc[k])) add(`${k} 不是 YYYY-MM-DDTHH:MM:SS+08:00：${doc[k]}`);
  }
  if (!doc.title || len(doc.title) > 40) add(`title 缺失或超过 40 字（${len(doc.title)}）`);
  if (!doc.overview || len(doc.overview) < 150 || len(doc.overview) > 300) {
    add(`overview 应在 150~300 字，实际 ${len(doc.overview)}`);
  }

  const input = loadInput(id);
  const meta = input ? input.meta : null;
  const strict = !!meta; // 有输入快照 = 本轮 2024 标题-only 批次，按更严口径校验
  if (!meta) {
    warns.push('缺少输入快照 .local/periodic-inputs/<id>.meta.json，只做通用校验（不核对 window/coverage/链接）');
  } else {
    const w = doc.window || {};
    for (const k of ['from', 'to', 'fromAt', 'toAt', 'days']) {
      if (w[k] !== meta.window[k]) add(`window.${k} 应为 ${meta.window[k]}，实际 ${w[k]}`);
    }
    const c = doc.coverage || {};
    for (const k of ['archiveDays', 'newsItems']) {
      if (c[k] !== meta.coverage[k]) add(`coverage.${k} 应为 ${meta.coverage[k]}，实际 ${c[k]}`);
    }
    const miss = Array.isArray(c.missingDays) ? c.missingDays.join(',') : '（非数组）';
    const want = (meta.coverage.missingDays || []).join(',');
    if (miss !== want) add(`coverage.missingDays 应为 [${want}]，实际 [${miss}]`);
  }

  const items = Array.isArray(doc.items) ? doc.items : [];
  if (items.length < 6 || items.length > 10) add(`items 应为 6~10 条，实际 ${items.length}`);
  items.forEach((it, i) => {
    const at = `items[${i + 1}]`;
    if (it.rank !== i + 1) add(`${at}.rank 应为 ${i + 1}，实际 ${it.rank}`);
    if (!it.title || len(it.title) > 40) add(`${at}.title 缺失或超过 40 字（${len(it.title)}）`);
    if (strict) {
      if (len(it.summary) < 40 || len(it.summary) > 90) add(`${at}.summary 应在 40~90 字，实际 ${len(it.summary)}`);
    } else if (len(it.summary) < 60 || len(it.summary) > 150) {
      add(`${at}.summary 应在 60~150 字，实际 ${len(it.summary)}`);
    }
    if (!it.why || len(it.why) > 40) add(`${at}.why 缺失或超过 40 字（${len(it.why)}）`);
    if (strict && !['中新网', '中国人民银行'].includes(it.source)) {
      add(`${at}.source 不在允许来源内：${it.source}`);
    }
    if (strict) {
      // 标题-only 归档的时间统一为当日 12:00:00+08:00；年份随期次走（2024 / 2025 / …），
      // 不能写死 2024 —— 否则 2025 之后的期次会被整批误判为不合规。
      // 日期是否落在本期窗口，由下面的 window 检查兜底。
      if (!/^\d{4}-\d{2}-\d{2}T12:00:00\+08:00$/.test(String(it.publishedAt || ''))) {
        add(`${at}.publishedAt 应形如 YYYY-MM-DDT12:00:00+08:00，实际 ${it.publishedAt}`);
      }
    } else if (!isIsoBj(it.publishedAt)) {
      add(`${at}.publishedAt 不是 YYYY-MM-DDTHH:MM:SS+08:00：${it.publishedAt}`);
    }
    if (doc.window && it.publishedAt) {
      const day = String(it.publishedAt).slice(0, 10);
      if (day < doc.window.from || day > doc.window.to) add(`${at}.publishedAt 落在 window 之外：${day}`);
    }
    if (!/^https?:\/\//.test(String(it.url || ''))) add(`${at}.url 不是 http(s) 绝对地址：${it.url}`);
    if (input && it.url && !input.urls.has(String(it.url).trim())) add(`${at}.url 不在本期输入快照里：${it.url}`);
    if (it.refs != null) {
      if (!Array.isArray(it.refs)) add(`${at}.refs 不是数组`);
      else if (it.refs.length > 4) add(`${at}.refs 超过 4 条`);
      else for (const r of it.refs) {
        if (input && !input.urls.has(String(r).trim())) add(`${at}.refs 不在本期输入快照里：${r}`);
      }
    }
  });

  if (doc.watch != null) {
    if (!Array.isArray(doc.watch)) add('watch 不是数组');
    else if (doc.watch.length > 5) add('watch 超过 5 条');
  }

  const bf = doc.backfill;
  if (!bf || typeof bf !== 'object') {
    if (strict) add('缺少 backfill（本轮全部为补写期）');
  } else {
    if (bf.kind !== 'period-backfill') add(`backfill.kind 应为 period-backfill，实际 ${bf.kind}`);
    if (!isIsoBj(bf.at)) add(`backfill.at 不是 ISO+08:00：${bf.at}`);
  }

  if (index) {
    const e = (index.reports || []).find((r) => r.id === id && r.type === doc.type);
    if (!e) add('索引里没有该期');
    else {
      for (const k of ['title', 'generatedAt']) {
        if (e[k] !== doc[k]) add(`索引 ${k} 与正文不一致`);
      }
      if (JSON.stringify(e.window) !== JSON.stringify(doc.window)) add('索引 window 与正文不一致');
      if (e.itemCount !== items.length) add(`索引 itemCount 应为 ${items.length}，实际 ${e.itemCount}`);
      if (e.file !== `periodic/${id}.json`) add(`索引 file 应为 periodic/${id}.json，实际 ${e.file}`);
      const wantBf = !!doc.backfill;
      if (e.backfill !== wantBf) add(`索引 backfill 应为 ${wantBf}，实际 ${e.backfill}`);
      const wantAt = doc.backfill ? doc.backfill.at : null;
      if (e.backfillAt !== wantAt) add(`索引 backfillAt 应为 ${wantAt}，实际 ${e.backfillAt}`);
    }
  }
  return { errs, warns };
}

function validateIndex(index, ids) {
  const errs = [];
  const reports = Array.isArray(index.reports) ? index.reports : [];
  if (index.schema !== 'macro-news/periodic-index@1') errs.push(`index.schema 不对：${index.schema}`);
  if (index.count !== reports.length) errs.push(`index.count 应为 ${reports.length}，实际 ${index.count}`);
  for (let i = 1; i < reports.length; i++) {
    const a = reports[i - 1];
    const b = reports[i];
    const ta = a.window && a.window.to;
    const tb = b.window && b.window.to;
    if (!ta || !tb) continue;
    if (ta < tb || (ta === tb && String(a.id) < String(b.id))) {
      errs.push(`排序错误：${a.id}(${ta}) 应排在 ${b.id}(${tb}) 之后`);
    }
  }
  for (const id of ids) {
    if (!reports.some((r) => r.id === id)) errs.push(`索引缺少本期：${id}`);
  }
  return errs;
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('用法：node scripts/periodic/validate.mjs <id|--all>');
    return 2;
  }
  const all = args.includes('--all');
  let ids = args.filter((a) => !a.startsWith('--'));
  if (all) {
    ids = fs.readdirSync(INPUTS)
      .filter((f) => /\.meta\.json$/.test(f))
      .map((f) => f.replace(/\.meta\.json$/, ''))
      .filter((id) => fs.existsSync(path.join(PERIODIC, `${id}.json`)));
    if (!ids.length) {
      console.log('还没有任何已产出的本轮期次，无需校验');
      return 0;
    }
  }
  const index = fs.existsSync(IDX_FILE) ? readJson(IDX_FILE) : null;
  if (!index) {
    console.error('data/periodic/index.json 不存在');
    return 1;
  }

  let bad = 0;
  for (const id of ids) {
    const { errs, warns } = validateOne(id, index);
    if (warns.length) for (const w of warns) console.log(`! ${id}  ${w}`);
    if (errs.length) {
      bad++;
      console.log(`✗ ${id}`);
      for (const e of errs) console.log(`    - ${e}`);
    } else {
      console.log(`✓ ${id}`);
    }
  }
  const idxErrs = validateIndex(index, ids);
  if (idxErrs.length) {
    bad++;
    console.log('✗ index.json');
    for (const e of idxErrs) console.log(`    - ${e}`);
  } else {
    console.log('✓ index.json');
  }
  console.log(`\n${ids.length} 期，失败 ${bad} 处`);
  return bad ? 1 : 0;
}

process.exitCode = main();
