// src/macro-series.mjs
// 宏观指标历史序列（2.36.0）：把 data/macro/daily.json 的「每日快照」沉淀成
// 「一指标一文件」的历史序列，供前端「宏观」视图画图。
//
// 为什么单独一套文件：
//   · daily.json 每天一份快照（5 个指标 × 最多 400 天），适合 AI 做月度/事件分析；
//     画图需要的是**每个指标自己的时间轴**，日频和月频不能混在一个数组里。
//   · 与 K 线同构：列表读 index.json（对应 quotes.json），点开读 <key>.json（对应 kline/<key>.json）。
//
// 口径（前端标题/浮窗直接用）：
//   · 两融余额、社融增量：亿元；10Y 美债、CPI 同比：%；制造业 PMI：指数点。
//   · 日频 t = YYYY-MM-DD；月频 t = YYYY-MM（所属期，不是采集日）。
//
// 纯函数在前（单测直接 import），文件 IO 在 syncMacroSeries()。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const MACRO_SERIES = [
  { key: 'margin', name: '两融余额', unit: '亿元', freq: 'D', decimals: 2, source: '东方财富（三市两融）' },
  { key: 'us10y', name: '10Y美债', unit: '%', freq: 'D', decimals: 2, source: '东方财富（中美国债收益率）' },
  { key: 'social_financing', name: '社融增量', unit: '亿元', freq: 'M', decimals: 0, source: '人民银行 / 商务部数据中心' },
  { key: 'cpi', name: 'CPI同比', unit: '%', freq: 'M', decimals: 2, source: '国家统计局（东方财富）' },
  { key: 'pmi', name: '制造业PMI', unit: '', freq: 'M', decimals: 1, source: '国家统计局（东方财富）' },
];

export const MACRO_SERIES_KEYS = MACRO_SERIES.map((m) => m.key);
const META = new Map(MACRO_SERIES.map((m) => [m.key, m]));

export function seriesMeta(key) {
  return META.get(String(key)) || null;
}

/** 月份归一：`2026年10月份` / `2026-10` / `2026.10` / `202610` → `2026-10` */
export function monthKey(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  let m = /^(\d{4})[-/.年](\d{1,2})/.exec(s);
  if (!m) m = /^(\d{4})(\d{2})$/.exec(s);
  if (!m) return '';
  const mo = Number(m[2]);
  if (!(mo >= 1 && mo <= 12)) return '';
  return `${m[1]}-${String(mo).padStart(2, '0')}`;
}

/**
 * 一条 daily.json item → 序列的时间键。
 * 日频：note 里的日期；没有 note（回退源）用 fallbackDate（采集日）兜底。
 * 月频：note 的所属期月份 —— 不能用采集日，否则 11-19 采到的 10 月 CPI 会被记成 11 月。
 */
export function periodKey(item, fallbackDate = '') {
  const meta = seriesMeta(item && item.key);
  if (!meta) return '';
  const note = String((item && item.note) || '').trim();
  if (meta.freq === 'M') return monthKey(note);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(note);
  if (m) return m[1];
  return /^\d{4}-\d{2}-\d{2}$/.test(String(fallbackDate)) ? String(fallbackDate) : '';
}

// 量级护栏：只拦「明显不是这个指标」的值（防止源改字段后把价格/成交量写进曲线）。
// 区间按 2026 年真实量级放到很宽，不做业务判断。
const VALID_RANGE = {
  margin: [1000, 100000],
  us10y: [-5, 30],
  social_financing: [-100000, 200000],
  cpi: [-20, 50],
  pmi: [10, 90],
};

export function validMacroValue(key, v) {
  const r = VALID_RANGE[key];
  if (!r || !Number.isFinite(v)) return false;
  return v >= r[0] && v <= r[1];
}

const round = (v, d) => Number(Number(v).toFixed(d));

/** daily.json 的 items → 序列点（无效值丢弃；带 key 便于按指标分组） */
export function pointsFromItems(items, fallbackDate = '') {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const meta = seriesMeta(it && it.key);
    if (!meta) continue;
    const t = periodKey(it, fallbackDate);
    const v = Number(it && it.value);
    if (!t || !validMacroValue(meta.key, v)) continue;
    out.push({ key: meta.key, t, v: round(v, meta.decimals) });
  }
  return out;
}

/**
 * 按时间键合并：同键以 incoming 覆盖（源会修订历史），结果升序。
 * 旧序列里不合格的行（缺 t / v 非数）直接丢弃，避免一条坏行把前端画崩。
 */
export function upsertSeries(bars, incoming) {
  const map = new Map();
  for (const b of Array.isArray(bars) ? bars : []) {
    const t = String((b && b.t) || '').slice(0, 10);
    const v = Number(b && b.v);
    if (!t || !Number.isFinite(v)) continue;
    map.set(t.length === 7 ? t.slice(0, 7) : t, { t, v });
  }
  for (const p of Array.isArray(incoming) ? incoming : []) {
    const t = String((p && p.t) || '');
    const v = Number(p && p.v);
    if (!t || !Number.isFinite(v)) continue;
    map.set(t, { t, v });
  }
  return [...map.values()].sort((a, b) => a.t.localeCompare(b.t));
}

/** 序列 doc（写盘用） */
export function seriesDoc(key, bars, generatedAt) {
  const meta = seriesMeta(key);
  return {
    key,
    name: meta.name,
    unit: meta.unit,
    freq: meta.freq,
    decimals: meta.decimals,
    source: meta.source,
    generatedAt,
    bars: Array.isArray(bars) ? bars : [],
  };
}

/**
 * 从 5 份序列构建列表索引。
 * docs：{ [key]: { bars, ... } } 或 [{key,bars}]。
 * 没有数据的指标也保留一项（latest=null），前端据此显示「暂无数据」。
 */
export function buildMacroIndex(docs, generatedAt) {
  const byKey = new Map();
  if (Array.isArray(docs)) {
    docs.forEach((d) => { if (d && d.key) byKey.set(d.key, d); });
  } else if (docs && typeof docs === 'object') {
    Object.keys(docs).forEach((k) => byKey.set(k, docs[k]));
  }
  const items = MACRO_SERIES.map((meta) => {
    const doc = byKey.get(meta.key) || {};
    const bars = Array.isArray(doc.bars) ? doc.bars : [];
    const last = bars.length ? bars[bars.length - 1] : null;
    const prev = bars.length > 1 ? bars[bars.length - 2] : null;
    return {
      key: meta.key,
      name: meta.name,
      unit: meta.unit,
      freq: meta.freq,
      decimals: meta.decimals,
      source: doc.source || meta.source,
      latest: last ? { t: last.t, v: last.v } : null,
      prev: prev ? { t: prev.t, v: prev.v } : null,
      first: bars.length ? bars[0].t : null,
      last: last ? last.t : null,
      count: bars.length,
      series: `${meta.key}.json`,
    };
  });
  return { generatedAt, items };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 把 daily.json 的记录沉淀进 5 份序列文件，并重建 index.json。
 *
 * @param {string} dir data/macro 目录
 * @param {Array<{date:string, items:Array}>} records daily.json 风格的记录（顺序不限）
 * @param {{dryRun?:boolean, generatedAt?:string, log?:Function}} [opts]
 * @returns {Promise<{changed:string[], indexChanged:boolean}>}
 */
export async function syncMacroSeries(dir, records, opts = {}) {
  const dryRun = !!opts.dryRun;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const list = (Array.isArray(records) ? records : [])
    .filter((r) => r && Array.isArray(r.items))
    .slice()
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

  const docs = {};
  const changed = [];
  // 先把所有记录展开成点：records 已按日期升序，后出现的（较新记录）覆盖较旧值。
  const allPoints = [];
  for (const rec of list) allPoints.push(...pointsFromItems(rec.items, rec.date));

  for (const meta of MACRO_SERIES) {
    const file = path.join(dir, `${meta.key}.json`);
    let old = null;
    if (existsSync(file)) {
      try { old = JSON.parse(await readFile(file, 'utf8')); } catch { old = null; }
    }
    const oldBars = Array.isArray(old && old.bars) ? old.bars : [];
    const nextBars = upsertSeries(oldBars, allPoints.filter((p) => p.key === meta.key));
    const doc = seriesDoc(meta.key, nextBars, (old && old.generatedAt) || generatedAt);
    docs[meta.key] = doc;
    const barsChanged = !sameJson(oldBars, nextBars);
    if (barsChanged) {
      changed.push(meta.key);
      doc.generatedAt = generatedAt;
      if (!dryRun) {
        await mkdir(dir, { recursive: true });
        await writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
      }
      log(
        `${meta.key}：${oldBars.length} → ${nextBars.length} 根` +
        `（${nextBars.length ? nextBars[nextBars.length - 1].t : '空'}）`
      );
    }
  }

  const index = buildMacroIndex(docs, generatedAt);
  const indexFile = path.join(dir, 'index.json');
  let oldIndex = null;
  if (existsSync(indexFile)) {
    try { oldIndex = JSON.parse(await readFile(indexFile, 'utf8')); } catch { oldIndex = null; }
  }
  const indexChanged = !sameJson(
    oldIndex && oldIndex.items,
    index.items
  );
  if (indexChanged && !dryRun) {
    await mkdir(dir, { recursive: true });
    await writeFile(indexFile, JSON.stringify(index, null, 2), 'utf8');
    log(`index.json：${index.items.filter((x) => x.latest).length}/${index.items.length} 项有数据`);
  }
  return { changed, indexChanged: indexChanged && !dryRun };
}
