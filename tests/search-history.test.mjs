// tests/search-history.test.mjs
// 2.22.0：全部历史检索（按月分片）的构建、合并与「范围不回退」断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  HISTORY_SEARCH_VERSION,
  CHUNK_MAX_GZIP,
  HOT_WINDOW_DAYS,
  monthOf,
  groupByMonth,
  historyItemToSearch,
  buildChunk,
  buildManifest,
  monthsDesc,
  mergeResults,
  validateChunk,
  toSearchItem,
  hotCutoff,
} from '../src/search-history.mjs';
import { SEARCH_WINDOW_DAYS, searchCutoff, compactSearchItem } from '../src/search-window.mjs';
import { addDays } from '../src/news-day.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WEB = require('../assets/search-history.js');
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

test('historyItemToSearch：单字母键 → search.json 同构 6 字段', () => {
  const it = { i: 'abc', t: '标题', u: 'https://x/1', o: '中新网', p: 1789444800 };
  const x = historyItemToSearch(it);
  assert.deepEqual(Object.keys(x).sort(), ['id', 'source', 'time', 'title', 'ts', 'url']);
  assert.equal(x.id, 'abc');
  assert.equal(x.ts, 1789444800);
  assert.equal(x.time, '2026-09-15T12:00:00+08:00');
  assert.equal(x.title, '标题');
  assert.deepEqual(Object.keys(compactSearchItem({ id: 'a' })).sort(), Object.keys(x).sort());
});

test('hotCutoff：热段 = 今天 + 前 6 个新闻日（共 7 天）', () => {
  assert.equal(HOT_WINDOW_DAYS, 7);
  assert.equal(hotCutoff(Date.parse('2026-11-05T02:00:00Z')), '2026-10-30');
});

test('toSearchItem：history 单字母键与 archive 全字段都归一到 6 字段', () => {
  const h = toSearchItem({ i: 'a', p: 1789444800, t: 'T', o: 'S', u: 'u' });
  const a = toSearchItem({ id: 'b', ts: 1789444800, time: 'x', source: 'S', title: 'T', url: 'u', content: '正文' });
  assert.deepEqual(Object.keys(h).sort(), Object.keys(a).sort());
  assert.equal(a.id, 'b');
  assert.equal(a.ts, 1789444800);
  assert.equal(a.content, undefined);
});

test('groupByMonth：按月分组、月内按 ts 倒序', () => {
  const map = groupByMonth([
    { day: '2026-08-17', items: [{ i: 'a', t: 'A', p: 100 }, { i: 'b', t: 'B', p: 300 }] },
    { day: '2026-08-18', items: [{ i: 'c', t: 'C', p: 200 }] },
    { day: '2026-09-01', items: [{ i: 'd', t: 'D', p: 50 }] },
  ]);
  assert.deepEqual([...map.keys()], ['2026-08', '2026-09']);
  assert.deepEqual(map.get('2026-08').map((x) => x.id), ['b', 'c', 'a']);
  assert.equal(monthOf('2026-08-17'), '2026-08');
});

test('buildChunk / buildManifest：条数自洽、月份从新到旧', () => {
  const aug = buildChunk('2026-08', [{ id: 'a', ts: 1, title: 't', time: '', source: '', url: '' }]);
  const sep = buildChunk('2026-09', []);
  const man = buildManifest(
    [
      { m: '2026-08', n: aug.n, bytes: 10 },
      { m: '2026-09', n: 0, bytes: 2 },
    ],
    { from: '2026-08-01', to: '2026-09-30' }
  );
  assert.equal(aug.v, HISTORY_SEARCH_VERSION);
  assert.equal(man.total, 1);
  assert.deepEqual(monthsDesc(man), ['2026-09', '2026-08']);
  assert.deepEqual(WEB.monthsDesc(man), monthsDesc(man));
  assert.equal(WEB.chunkUrl('2026-08'), 'search-history/2026-08.json');
});

test('validateChunk：拒绝重复 id / 条数不一致 / 缺字段', () => {
  const ok = { v: HISTORY_SEARCH_VERSION, m: '2026-08', n: 1, items: [{ id: 'a', ts: 1, title: 't' }] };
  assert.equal(validateChunk(ok), '');
  assert.equal(validateChunk({ ...ok, n: 2 }), 'count');
  assert.equal(validateChunk({ ...ok, m: 'x' }), 'month');
  assert.equal(validateChunk({ ...ok, items: [{ id: 'a', ts: 1 }, { id: 'a', ts: 2 }] , n: 2 }), 'field');
  const dup = { ...ok, n: 2, items: [{ id: 'a', ts: 1, title: 't' }, { id: 'a', ts: 2, title: 'u' }] };
  assert.equal(validateChunk(dup), 'duplicate');
});

test('mergeResults：近期在前、历史追加、id/url 去重（web 与 src 行为一致）', () => {
  const recent = [{ id: 'a', url: 'u1', title: 'A' }, { id: 'b', url: 'u2', title: 'B' }];
  const hist = [{ id: 'c', url: 'u3', title: 'C' }, { id: 'a', url: 'u1', title: 'A' }, { url: 'u2', id: '', title: 'B' }];
  for (const fn of [mergeResults, WEB.mergeResults]) {
    const out = fn(recent, hist);
    assert.deepEqual(out.map((x) => x.id || x.url), ['a', 'b', 'c']);
  }
  // 近期结果原样保留：数据里本来就有重复 id 时也不得在这里删（否则「历史追加」会变负数）
  const dupRecent = [{ id: 'a', url: 'u1' }, { id: 'a', url: 'u1' }];
  for (const fn of [mergeResults, WEB.mergeResults]) {
    const out = fn(dupRecent, [{ id: 'a', url: 'u1' }, { id: 'z', url: 'uz' }]);
    assert.deepEqual(out.map((x) => x.id), ['a', 'a', 'z']);
  }
});

test('window 常量不回退：仍为 62 天，且 search.json 不混入窗口外条目', () => {
  assert.equal(SEARCH_WINDOW_DAYS, 62);
  const s = readJSON('data/search.json');
  assert.equal(s.windowDays, SEARCH_WINDOW_DAYS);
  const cutoff = searchCutoff(Date.now());
  const guard = addDays(cutoff, -1);
  const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10); // 新闻日 = UTC 日期
  // 窗口前一天是已知的跨日残留（2.4.19 之前按自然日归档，未搬动），只允许边界日少量存在
  const outside = s.items.filter((x) => day(x.ts) < guard);
  assert.equal(outside.length, 0, `search.json 混入 ${outside.length} 条窗口外条目`);
  const boundary = s.items.filter((x) => day(x.ts) === guard);
  assert.ok(boundary.length < 50, `边界日跨日残留 ${boundary.length} 条，超出已知范围`);
});

test('manifest 覆盖 history 全部月份（+archive 补录），分片自洽且不含热段日期', () => {
  const man = readJSON('data/search-history/manifest.json');
  const hist = readJSON('data/history/index.json');
  const histMonths = [...new Set(hist.days.map((d) => d.d.slice(0, 7)))].sort();
  const months = man.chunks.map((c) => c.m).sort();
  for (const m of histMonths) assert.ok(months.includes(m), `manifest 缺 ${m} 月分片`);
  // 2.30.0：热段（最近 7 个新闻日）由 search.json 承担，分片从它前一天往前覆盖
  assert.equal(man.hot.days, HOT_WINDOW_DAYS);
  assert.equal(addDays(man.hot.to, -(HOT_WINDOW_DAYS - 1)), man.hot.from);
  assert.ok(man.total >= hist.total, '分片条数少于 history：archive 补录没进来');
  assert.equal(man.to, addDays(man.hot.from, -1), 'manifest.to 应为热段前一天');

  let sum = 0;
  const ids = new Set();
  let dup = 0;
  for (const c of man.chunks) {
    const doc = readJSON(`data/search-history/${c.m}.json`);
    assert.equal(validateChunk(doc), '', `${c.m} 分片校验失败`);
    assert.equal(doc.n, c.n);
    assert.equal(doc.n, doc.items.length);
    const gz = zlib.gzipSync(Buffer.from(fs.readFileSync(path.join(ROOT, `data/search-history/${c.m}.json`))), { level: 9 }).length;
    assert.ok(gz <= CHUNK_MAX_GZIP, `${c.m} gzip ${gz} 超上限`);
    for (const it of doc.items) {
      const day = new Date(it.ts * 1000).toISOString().slice(0, 10); // 新闻日 = UTC 日期
      assert.ok(day < man.hot.from, `${c.m} 混入热段日期 ${day}`);
      if (ids.has(it.id)) dup++;
      ids.add(it.id);
    }
    sum += doc.n;
  }
  assert.equal(sum, man.total);
  assert.equal(dup, 0, `分片之间存在 ${dup} 个重复 id`);
});

test('D：search.json 对「页面走 history」的日期取切片条目，且复用同一阈值', () => {
  const collect = fs.readFileSync(path.join(ROOT, 'src/collect.mjs'), 'utf8');
  assert.match(collect, /historyItemToSearch/);
  assert.match(collect, /decideDaySource\(\{ archiveCount: d\.items\.length, historyCount: h \}\)/);
  assert.match(collect, /fromHistory: searchFromHistory/);

  const s = readJSON('data/search.json');
  const idx = readJSON('data/index.json');
  const hist = readJSON('data/history/index.json');
  const archCount = new Map(idx.days.map((d) => [d.day, d.count]));
  const histCount = new Map(hist.days.map((d) => [d.d, d.n]));
  const should = [...histCount.keys()].filter((d) => d >= s.from && (histCount.get(d) > (archCount.get(d) || 0) || (archCount.get(d) || 0) < 20));
  // 至少当天窗口里的 09-15~09-18 必须按 history 取；只断言与索引声明的天数一致
  assert.equal(s.fromHistory, should.length, `fromHistory=${s.fromHistory} 期望 ${should.length}`);
});

test('前端接线：历史检索脚本已加载、版本串一致、不修改 search.json 生成范围', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /assets\/search-history\.js\?v=(\w+)/);
  const v = html.match(/assets\/search-history\.js\?v=(\w+)/)[1];
  assert.match(html, new RegExp(`assets/app\\.js\\?v=${v}`));
  const app = fs.readFileSync(path.join(ROOT, 'assets/app.js'), 'utf8');
  assert.match(app, /MacroSearchHistory/);
  assert.match(app, /runHistorySearch/);
  assert.match(app, /item-src hist/);
});

test('2.22.1 默认只扫最近 3 个月：常量、按钮接线、全部月份语义保留', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'assets/app.js'), 'utf8');
  // 默认档位常量，改动要同步改本测试（不允许悄悄改成 12 个月）
  assert.match(app, /const HIST_RECENT_N = 3;/);
  assert.match(app, /const HIST_RECENT = '__recent';/);
  // 主按钮与下拉默认走「最近 N 个月」，不是 __all
  assert.match(app, /\$\('#qHistBtn'\)\.onclick = \(\) => runHistorySearch\(\$\('#qHistMonth'\)\.value \|\| HIST_RECENT\)/);
  assert.doesNotMatch(app, /runHistorySearch\(\$\('#qHistMonth'\)\.value \|\| HIST_ALL\)/);
  // 显式选「全部月份」仍是一次扫全量（不留尾、不出「继续扫描」）
  assert.match(app, /scope === HIST_ALL \? all/);
  assert.match(app, /HIST\.more = scope === HIST_RECENT \? all\.slice\(HIST_RECENT_N\) : \[\]/);
  // 「继续扫描更早」按钮存在且接线
  assert.match(html, /id="qHistMore"/);
  assert.match(app, /'#qHistMore'\)\.onclick/);
  // 下拉仍保留「全部月份」选项
  assert.match(app, /全部月份（\$\{HIST\.manifest\.months\} 个月）/);
});
