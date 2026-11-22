// tests/macro-series.test.mjs
// 2.36.0：宏观历史序列的纯函数与前端接线契约。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MACRO_SERIES, monthKey, periodKey, pointsFromItems, upsertSeries,
  buildMacroIndex, validMacroValue, syncMacroSeries,
} from '../src/macro-series.mjs';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('月份归一：统计局的「2026年10月份」与东财的 2026-10 同键', () => {
  assert.equal(monthKey('2026年10月份'), '2026-10');
  assert.equal(monthKey('2026年09月份'), '2026-09');
  assert.equal(monthKey('2026-10'), '2026-10');
  assert.equal(monthKey('2026.10'), '2026-10');
  assert.equal(monthKey('202610'), '2026-10');
  assert.equal(monthKey('2026-13'), '');
  assert.equal(monthKey(''), '');
});

test('时间键：日频用 note 的日期，缺 note 用采集日；月频绝不能用采集日', () => {
  assert.equal(periodKey({ key: 'margin', note: '2026-11-19' }), '2026-11-19');
  assert.equal(periodKey({ key: 'margin', note: '' }, '2026-11-20'), '2026-11-20');
  assert.equal(periodKey({ key: 'cpi', note: '2026年10月份' }, '2026-11-20'), '2026-10');
  // 月频缺所属期 → 空（不能把 10 月 CPI 记到采集日 11-20）
  assert.equal(periodKey({ key: 'cpi', note: '' }, '2026-11-20'), '');
  assert.equal(periodKey({ key: 'nope', note: '2026-11-19' }), '');
});

test('量级护栏：明显不属于该指标的值被丢弃', () => {
  assert.equal(validMacroValue('margin', 22222.85), true);
  assert.equal(validMacroValue('margin', 2.2), false);        // 把「亿元」写成「万亿元」
  assert.equal(validMacroValue('us10y', 4.92), true);
  assert.equal(validMacroValue('pmi', 49.3), true);
  assert.equal(validMacroValue('pmi', 493), false);
  const pts = pointsFromItems([
    { key: 'margin', value: 22222.85, note: '2026-11-19', unit: '亿元' },
    { key: 'margin', value: 0.2, note: '2026-11-18' },        // 坏值
    { key: 'cpi', value: 0.7, note: '2026年10月份' },
    { key: 'unknown', value: 1, note: '2026-10' },
  ]);
  assert.deepEqual(pts, [
    { key: 'margin', t: '2026-11-19', v: 22222.85 },
    { key: 'cpi', t: '2026-10', v: 0.7 },
  ]);
});

test('upsertSeries：按时间升序、同键覆盖（源会修订）、坏行丢弃', () => {
  const old = [
    { t: '2026-11-18', v: 22378.3 },
    { t: '2026-11-19', v: 22200 },
    { t: '', v: 1 },
    { t: '2026-11-17', v: Number.NaN },
  ];
  const out = upsertSeries(old, [
    { t: '2026-11-19', v: 22222.85 },
    { t: '2026-11-20', v: 22100 },
  ]);
  assert.deepEqual(out, [
    { t: '2026-11-18', v: 22378.3 },
    { t: '2026-11-19', v: 22222.85 },
    { t: '2026-11-20', v: 22100 },
  ]);
});

test('buildMacroIndex：latest/prev/count/first/last 与序列一致，顺序固定', () => {
  const docs = {
    margin: { bars: [{ t: '2026-11-18', v: 1 }, { t: '2026-11-19', v: 2 }] },
    cpi: { bars: [{ t: '2026-09', v: 0.9 }, { t: '2026-10', v: 0.7 }] },
  };
  const idx = buildMacroIndex(docs, '2026-11-22T00:00:00Z');
  assert.deepEqual(idx.items.map((x) => x.key), MACRO_SERIES.map((x) => x.key));
  const m = idx.items.find((x) => x.key === 'margin');
  assert.deepEqual(m.latest, { t: '2026-11-19', v: 2 });
  assert.deepEqual(m.prev, { t: '2026-11-18', v: 1 });
  assert.equal(m.count, 2);
  assert.equal(m.first, '2026-11-18');
  assert.equal(m.last, '2026-11-19');
  // 没有序列的指标保留占位，前端显示「暂无数据」
  const pmi = idx.items.find((x) => x.key === 'pmi');
  assert.equal(pmi.latest, null);
  assert.equal(pmi.count, 0);
});

test('syncMacroSeries：首次落 5 个文件 + index，二次运行无变化，dry-run 不写', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-series-'));
  try {
    const records = [
      { date: '2026-11-18', items: [
        { key: 'margin', value: 22378.3, note: '2026-11-18' },
        { key: 'us10y', value: 5.07, note: '2026-11-18' },
        { key: 'cpi', value: 0.7, note: '2026年10月份' },
      ] },
      { date: '2026-11-19', items: [
        { key: 'margin', value: 22222.85, note: '2026-11-19' },
        { key: 'us10y', value: 5.04, note: '2026-11-19' },
      ] },
    ];
    const r1 = await syncMacroSeries(dir, records, { generatedAt: '2026-11-22T00:00:00Z' });
    assert.deepEqual(r1.changed.sort(), ['cpi', 'margin', 'us10y']);
    assert.equal(r1.indexChanged, true);
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    const margin = idx.items.find((x) => x.key === 'margin');
    assert.deepEqual(margin.latest, { t: '2026-11-19', v: 22222.85 });
    assert.deepEqual(margin.prev, { t: '2026-11-18', v: 22378.3 });
    assert.equal(margin.count, 2);

    const r2 = await syncMacroSeries(dir, records, { generatedAt: '2026-11-22T01:00:00Z' });
    assert.deepEqual(r2.changed, []);
    assert.equal(r2.indexChanged, false);

    const before = fs.readFileSync(path.join(dir, 'margin.json'), 'utf8');
    await syncMacroSeries(dir, [
      { date: '2026-11-20', items: [{ key: 'margin', value: 22000, note: '2026-11-20' }] },
    ], { dryRun: true });
    assert.equal(fs.readFileSync(path.join(dir, 'margin.json'), 'utf8'), before, 'dry-run 不能写盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('采集管线接入：每日采集与跨天回补都要沉淀序列', () => {
  assert.match(read('src/portfolio-collect.mjs'), /import \{ syncMacroSeries \} from '\.\/macro-series\.mjs'/);
  assert.match(read('src/portfolio-collect.mjs'), /await syncMacroSeries\(path\.join\(DATA, 'macro'\), trimmed/);
  assert.match(read('scripts/backfill-macro.mjs'), /import \{ syncMacroSeries \} from '\.\.\/src\/macro-series\.mjs'/);
  assert.match(read('scripts/backfill-macro.mjs'), /await syncMacroSeries\(path\.join\(ROOT, 'data', 'macro'\), list/);
});

test('前端接线：导航/视图/弹窗/脚本都存在，macro 进入 VIEWS 与 hash 正则', () => {
  const html = read('index.html');
  assert.match(html, /data-view="macro"/);
  assert.match(html, /id="view-macro"/);
  assert.match(html, /id="macroModal"/);
  assert.match(html, /assets\/macro\.js/);
  assert.match(html, /assets\/macro-chart\.js/);
  const app = read('assets/app.js');
  assert.match(app, /const VIEWS = \['feed', 'market', 'macro', 'archive', 'sources'\]/);
  assert.match(app, /#view-\(feed\|market\|macro\|archive\|sources\)/);
  assert.match(app, /function openMacro\(/);
  assert.match(app, /function restoreMacroUI\(/);
  assert.match(app, /macro: macroOpen && macroKey/);
});

test('前端默认 5 年；社融用柱状、其余折线', () => {
  const app = read('assets/app.js');
  assert.match(app, /return years >= 5 \? '5y' : 'all'/);
  assert.match(app, /item\.key === 'social_financing' \? 'bar' : 'line'/);
  const mj = read('assets/macro.js');
  assert.match(mj, /id: '5y', label: '5年'/);
  assert.match(mj, /function fmtValue\(v, item\)/);
  assert.match(mj, /function fmtChange\(item\)/);
});

test('数据文件：index.json 的 5 项与序列文件一致、时间升序', () => {
  const dir = path.join(ROOT, 'data', 'macro');
  if (!fs.existsSync(path.join(dir, 'index.json'))) return; // 未回补时跳过（CI 首跑）
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(idx.items.length, MACRO_SERIES.length);
  for (const it of idx.items) {
    const file = path.join(dir, it.series || `${it.key}.json`);
    assert.ok(fs.existsSync(file), `缺少 ${file}`);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(doc.bars) && doc.bars.length > 0, `${it.key} 没有 bars`);
    const bars = doc.bars;
    for (let i = 1; i < bars.length; i++) {
      assert.ok(bars[i - 1].t < bars[i].t, `${it.key} 时间未严格升序：${bars[i - 1].t} / ${bars[i].t}`);
    }
    assert.deepEqual(it.latest, { t: bars[bars.length - 1].t, v: bars[bars.length - 1].v });
    assert.equal(it.count, bars.length);
  }
});
