// scripts/backfill-macro-series.mjs
// 回补宏观指标的完整历史序列（data/macro/<key>.json）并重建 index.json。
//
// 日常增量由 src/portfolio-collect.mjs 与 scripts/backfill-macro.mjs 负责；
// 本脚本用于「首次建库」或换源/补历史，人工执行：
//   node scripts/backfill-macro-series.mjs                 # 全量回补 5 个指标
//   node scripts/backfill-macro-series.mjs --only=margin,us10y
//   node scripts/backfill-macro-series.mjs --dry-run       # 只抓不算写盘
//
// 源与口径（2026-11-22 实测）：
//   · 两融余额：东财 RPT_MARGIN_DATASTATISTICS，4041 条（2010-03 起），元 → 亿元
//   · 10Y 美债：东财 RPTA_WEB_TREASURYYIELD（EMG00001310），9393 条（1989 起）
//   · CPI 同比：东财 RPT_ECONOMY_CPI（NATIONAL_SAME），226 个月（2008-01 起）
//   · 制造业 PMI：东财 RPT_ECONOMY_PMI（MAKE_INDEX），226 个月
//   · 社融增量：商务部数据中心 shrzgmQuery（2015-01 ~ 2025-12，已停更）
//     + 人民银行当年增量表（2026-01 起，含修订）⇒ 重叠月份以央行表为准
//   ⚠ 东财数据中心（datacenter-web）与 push2his 行情主机是两套域名：
//     后者在本机常被 socket 级拒绝，前者实测可用。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MACRO_SERIES, seriesMeta, monthKey, upsertSeries, seriesDoc, buildMacroIndex,
} from '../src/macro-series.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'macro');
const DRY = process.argv.includes('--dry-run');
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  const raw = i >= 0 ? process.argv[i + 1] : '';
  return raw ? new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)) : null;
})();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const EM = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const pace = (ms = 350) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, opts = {}, retries = 2) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
      if (i < retries) await pace(800);
    }
  }
  throw last;
}

async function fetchJson(url, opts) {
  const buf = await fetchText(url, opts);
  return JSON.parse(buf.toString('utf8'));
}

/** 东财数据中心分页拉全量 */
async function emAll({ reportName, columns, sortColumns, token = '', pageSize = 500 }) {
  const rows = [];
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const qs = new URLSearchParams({
      reportName, columns, pageNumber: String(page), pageSize: String(pageSize),
      sortColumns, sortTypes: '-1', source: 'WEB', client: 'WEB',
      ...(token ? { token } : {}),
    });
    const j = await fetchJson(`${EM}?${qs}`);
    if (!j || !j.success || !j.result) {
      throw new Error(`${reportName} 第 ${page} 页失败：${j && j.message}`);
    }
    pages = Number(j.result.pages) || 1;
    rows.push(...(j.result.data || []));
    if (page < pages) await pace();
  }
  return rows;
}

const n = (v) => {
  // ⚠ 不能直接 Number('')：空单元格会变成 0，社融表里 11/12 月的「—」会被写成 0。
  const s = String(v == null ? '' : v).replace(/,/g, '').trim();
  if (!s || /^[-—–]+$/.test(s)) return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};

async function loadMargin() {
  const rows = await emAll({
    reportName: 'RPT_MARGIN_DATASTATISTICS',
    columns: 'TRADE_DATE,MARGIN_BALANCE',
    sortColumns: 'TRADE_DATE',
  });
  const out = [];
  for (const r of rows) {
    const t = String(r.TRADE_DATE || '').slice(0, 10);
    const v = n(r.MARGIN_BALANCE);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || v === null) continue;
    out.push({ t, v: Number((v / 1e8).toFixed(2)) });
  }
  return out;
}

async function loadUs10y() {
  const rows = await emAll({
    reportName: 'RPTA_WEB_TREASURYYIELD',
    columns: 'SOLAR_DATE,EMG00001310',
    sortColumns: 'SOLAR_DATE',
    token: '894050c76af8597a853f5b408b759f5d',
  });
  const out = [];
  for (const r of rows) {
    const t = String(r.SOLAR_DATE || '').slice(0, 10);
    const v = n(r.EMG00001310);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || v === null) continue;
    out.push({ t, v: Number(v.toFixed(2)) });
  }
  return out;
}

async function loadMonthly(reportName, field) {
  const rows = await emAll({
    reportName,
    columns: `REPORT_DATE,TIME,${field}`,
    sortColumns: 'REPORT_DATE',
  });
  const out = [];
  for (const r of rows) {
    const t = monthKey(r.TIME) || monthKey(String(r.REPORT_DATE || '').slice(0, 7));
    const v = n(r[field]);
    if (!t || v === null) continue;
    out.push({ t, v });
  }
  return out;
}

/** 商务部数据中心：社会融资规模增量（2015-01 起，2025-12 后停更） */
async function loadSocialMofcom() {
  const j = await fetchJson('https://data.mofcom.gov.cn/datamofcom/front/gnmy/shrzgmQuery', {
    method: 'POST',
    headers: { Referer: 'https://data.mofcom.gov.cn/gnmy/shrzgm.shtml' },
  });
  const out = [];
  for (const r of Array.isArray(j) ? j : []) {
    const t = monthKey(r.date);
    const v = n(r.tiosfs);
    if (!t || v === null) continue;
    out.push({ t, v });
  }
  return out;
}

/** 人民银行当年「社会融资规模增量统计表」→ 本年度各月 */
async function loadSocialPbc(year) {
  const idxUrl = `https://www.pbc.gov.cn/diaochatongjisi/116219/116319/${year}ntjsj/shrzgm/index.html`;
  const idxBuf = await fetchText(idxUrl, { headers: { Referer: 'https://www.pbc.gov.cn/' } });
  // 索引页是 UTF-8（meta charset=utf-8）；附件表是 gb2312 —— 两者不能共用一种解码。
  const idx = idxBuf.toString('utf8');
  let href = '';
  for (const m of idx.matchAll(/href="([^"]*attachDir[^"]*\.htm)"[^>]*>\s*htm/gi)) {
    const around = idx.slice(Math.max(0, m.index - 500), m.index);
    if (around.includes('增量统计表')) { href = m[1]; break; }
  }
  if (!href) throw new Error('人民银行：未找到社会融资规模增量表');
  const buf = await fetchText('https://www.pbc.gov.cn' + href, {
    headers: { Referer: 'https://www.pbc.gov.cn/' },
  });
  const html = new TextDecoder('gbk').decode(buf);
  const out = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((c) => c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    const m = /^(\d{4})\.(\d{2})$/.exec(cells[0] || '');
    if (!m) continue;
    const v = n(String(cells[1] || '').replace(/,/g, ''));
    if (v === null) continue;
    out.push({ t: `${m[1]}-${m[2]}`, v });
  }
  return out;
}

async function loadSocial() {
  const out = [];
  try {
    out.push(...await loadSocialMofcom());
  } catch (e) {
    console.log(`  ⚠ 商务部社融历史失败：${e.message}`);
  }
  try {
    // 央行表按年份归档，当前年份即可覆盖 2026 全年（1~10 月已发布）
    const year = new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear();
    out.push(...await loadSocialPbc(year));
  } catch (e) {
    console.log(`  ⚠ 人民银行当年社融失败：${e.message}`);
  }
  return out;
}

const LOADERS = {
  margin: loadMargin,
  us10y: loadUs10y,
  social_financing: loadSocial,
  cpi: () => loadMonthly('RPT_ECONOMY_CPI', 'NATIONAL_SAME'),
  pmi: () => loadMonthly('RPT_ECONOMY_PMI', 'MAKE_INDEX'),
};

function readSeries(key) {
  const file = path.join(DIR, `${key}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const docs = {};
  for (const meta of MACRO_SERIES) {
    const old = readSeries(meta.key) || {};
    docs[meta.key] = { ...old, bars: Array.isArray(old.bars) ? old.bars : [] };
  }

  const targets = MACRO_SERIES.filter((m) => !ONLY || ONLY.has(m.key));
  for (const meta of targets) {
    const started = Date.now();
    let points = [];
    try {
      points = await LOADERS[meta.key]();
    } catch (e) {
      console.log(`  ❌ ${meta.key}：回补失败 ${e.message}`);
      continue;
    }
    const oldBars = docs[meta.key].bars;
    const bars = upsertSeries(oldBars, points);
    const doc = seriesDoc(meta.key, bars, new Date().toISOString());
    docs[meta.key] = doc;
    const changed = JSON.stringify(oldBars) !== JSON.stringify(bars);
    if (changed && !DRY) {
      fs.writeFileSync(path.join(DIR, `${meta.key}.json`), JSON.stringify(doc, null, 2), 'utf8');
    }
    console.log(
      `  ${meta.key}：${bars.length} 根（${bars[0] ? bars[0].t : '空'} ~ ` +
      `${bars[bars.length - 1] ? bars[bars.length - 1].t : '空'}）` +
      `${changed ? '' : ' · 无变化'} · ${Date.now() - started}ms`
    );
    await pace(350);
  }

  const index = buildMacroIndex(docs, new Date().toISOString());
  if (!DRY) {
    fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  }
  console.log(
    `[macro-backfill] ${DRY ? 'dry-run · ' : ''}` +
    index.items.map((x) => `${x.key}=${x.count}`).join(' ') +
    ` → index.json`
  );
}

main().catch((e) => {
  console.error('[macro-backfill] 失败：' + e.message);
  process.exit(1);
});
