// tests/briefing-core.test.mjs
// 离线回归：早报容错链路（判据 / 补跑计划 / 原子写 / 锁 / 组装）。
// 不联网；写盘只发生在 os.tmpdir() 下的临时目录。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireLock,
  archiveSpan,
  atomicWriteJSON,
  atomicWriteText,
  beijingNow,
  briefEraStart,
  buildBriefing,
  checkBriefing,
  checkStatusInvariants,
  deadlinePassed,
  guardBackfill,
  normalizeBriefingSource,
  parseBackfillRange,
  planCatchup,
  scanGaps,
  scanMissed,
  shouldSkipExisting,
  updateStatus,
} from '../scripts/briefing/core.mjs';
import { prepareArgs } from '../scripts/briefing/pipeline.mjs';
import { buildIndex } from '../scripts/news-db/history-slice.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-core-'));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

const file = (name) => path.join(TMP, name);
const row = (o) => ({
  title: '央行开展逆回购操作',
  summary: '公开市场操作利率维持不变，流动性合理充裕。',
  source: '中国人民银行',
  url: 'https://example.com/a',
  published_ts: 1793580000,
  date: '2026-11-02T09:00',
  content_status: 'full',
  ...o,
});

test('原子写：覆盖旧内容后完整，且不遗留 .tmp', () => {
  const f = file('slice.json');
  atomicWriteText(f, '{"old":true}');
  atomicWriteJSON(f, { items: [1], overview: '新内容' });
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(doc.overview, '新内容');
  assert.deepEqual(doc.items, [1]);
  const leftovers = fs.readdirSync(TMP).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('组装幂等：同一输入 + 固定时刻，两次结果完全一致', () => {
  const now = Date.UTC(2026, 10, 2, 1, 0); // 北京 09:00
  const args = {
    date: '2026-11-02',
    now,
    candidates: Array.from({ length: 12 }, (_, i) => row({ title: `条目 ${i}`, published_ts: 1793580000 + i })),
  };
  assert.equal(JSON.stringify(buildBriefing(args)), JSON.stringify(buildBriefing(args)));
});

test('完成判据：缺失 / 截断 / items=0 / 完整（新）/ 完整（旧）', () => {
  assert.equal(checkBriefing(file('nope.json')).state, 'missing');

  const bad = file('bad.json');
  fs.writeFileSync(bad, '{"items":[', 'utf8');
  assert.equal(checkBriefing(bad).state, 'invalid');

  const empty = file('empty.json');
  atomicWriteJSON(empty, { overview: '有概览', items: [], endedAt: '2026-11-02T09:02:00+08:00' });
  assert.equal(checkBriefing(empty).state, 'incomplete');

  const noOverview = file('no-overview.json');
  atomicWriteJSON(noOverview, { overview: '  ', items: [{}], endedAt: '2026-11-02T09:02:00+08:00' });
  assert.equal(checkBriefing(noOverview).state, 'incomplete');

  const newOne = file('new.json');
  atomicWriteJSON(newOne, {
    overview: '主线', items: [{}, {}], endedAt: '2026-11-02T09:02:00+08:00',
    generatedAt: '2026-11-02T09:00:00+08:00',
  });
  assert.equal(checkBriefing(newOne).state, 'complete');
  assert.equal(checkBriefing(newOne).items, 2);

  const legacy = file('legacy.json');
  atomicWriteJSON(legacy, { overview: '主线', items: [{}], generatedAt: '2026-11-02T09:00:00+08:00' });
  assert.equal(checkBriefing(legacy).state, 'complete');
  assert.equal(checkBriefing(legacy).legacy, true);
});

test('锁：首次成功、二次拒绝、超时接管、释放后可重入', () => {
  const lockFile = file('brief.lock');
  const t0 = Date.UTC(2026, 10, 2, 1, 0);
  const a = acquireLock(lockFile, { now: t0, pid: 111 });
  assert.equal(a.ok, true);

  const b = acquireLock(lockFile, { now: t0 + 60 * 1000, pid: 222 });
  assert.equal(b.ok, false);
  assert.equal(Number(b.holder.pid), 111);

  const c = acquireLock(lockFile, { now: t0 + 21 * 60 * 1000, pid: 333 });
  assert.equal(c.ok, true, '20 分钟以上的旧锁应被接管');

  a.release(); // pid 不匹配，不应删掉 c 的锁
  assert.equal(fs.existsSync(lockFile), true);
  c.release();
  assert.equal(fs.existsSync(lockFile), false);

  const d = acquireLock(lockFile, { now: t0, pid: 444 });
  assert.equal(d.ok, true);
  d.release();
});

test('补跑计划：只补今天、09:30 边界、绝不含历史日', () => {
  const check = (d) => ({
    complete: false,
    localComplete: d === '2026-11-02',
  });
  const before = planCatchup({
    today: '2026-11-02', nowHm: '09:29', days: 1, check,
  });
  assert.deepEqual(before, []);

  const after = planCatchup({
    today: '2026-11-02', nowHm: '09:30', days: 1, check,
  });
  assert.deepEqual(after, [{ date: '2026-11-02', action: 'publish' }]);

  // 即使调用方给了 7 天，历史日也不会进入自动补跑
  const wide = planCatchup({
    today: '2026-11-02', nowHm: '09:30', days: 7, check,
  });
  assert.deepEqual(wide, [{ date: '2026-11-02', action: 'publish' }]);
});

test('历史缺口只标 missed：不含今天、不产出条目', () => {
  const check = (d) => ({ complete: d === '2026-11-01', localComplete: false });
  const missed = scanMissed({ today: '2026-11-02', days: 4, check });
  assert.deepEqual(missed, ['2026-10-30', '2026-10-31']);

  const st = file('status-missed.json');
  updateStatus(st, '2026-10-30', { status: 'missed', reason: '历史日期不自动生成' });
  const idx = buildIndex([{ d: '2026-11-02', n: 1, b: 1, hasBriefing: true, source: 'ai' }], {});
  assert.ok(!idx.days.some((x) => x.d === '2026-10-30'), 'missed 不进索引');
});

test('source：旧文件缺字段按 ai；rule/draft 原样保留并透传到索引', () => {
  assert.equal(normalizeBriefingSource({}), 'ai');
  assert.equal(normalizeBriefingSource({ source: 'ai' }), 'ai');
  assert.equal(normalizeBriefingSource({ source: 'rule' }), 'rule');
  assert.equal(normalizeBriefingSource({ source: 'draft' }), 'draft');

  const idx = buildIndex([
    { d: '2026-11-02', n: 1, b: 1, hasBriefing: true, source: 'ai' },
    { d: '2026-11-01', n: 1, b: 1, hasBriefing: true, source: 'rule' },
    { d: '2026-10-31', n: 1, b: 1, hasBriefing: true, source: 'draft' },
  ], {});
  assert.equal(idx.days[0].source, 'ai');
  assert.equal(idx.days[1].source, 'rule');
  assert.equal(idx.days[2].source, 'draft');
});

test('AI 产物不被覆盖：shouldSkipExisting 只在 ai 且未 force 时为真', () => {
  assert.equal(shouldSkipExisting({ complete: true, source: 'ai' }), true);
  assert.equal(shouldSkipExisting({ complete: true, source: undefined }), true);
  assert.equal(shouldSkipExisting({ complete: true, source: 'rule' }), false);
  assert.equal(shouldSkipExisting({ complete: true, source: 'draft' }), false);
  assert.equal(shouldSkipExisting({ complete: false, source: 'ai' }), false);
  assert.equal(shouldSkipExisting({ complete: true, source: 'ai', force: true }), false);
});

test('手动补齐窗口必须显式传 from/to', () => {
  assert.equal(parseBackfillRange(null, null), null);
  assert.throws(() => parseBackfillRange('2026-10-30', null), /同时指定/);
  assert.throws(() => parseBackfillRange(null, '2026-10-30'), /同时指定/);
  const r = parseBackfillRange('2026-10-30', '2026-11-01');
  assert.equal(r.days, 3);
  assert.throws(() => parseBackfillRange('2026-11-02', '2026-10-30'), /非法/);
});

test('状态不变式：done ⇔ 有文件、missed ⇔ 无文件、source 一致', () => {
  const files = new Map([
    ['2026-11-01', { source: 'ai' }],
    ['2026-11-02', { source: 'ai' }],
  ]);
  const bad = checkStatusInvariants({
    '2026-11-01': { status: 'done', source: 'ai' },
    '2026-11-02': { status: 'missed', source: '' },
    '2026-11-03': { status: 'done', source: 'ai' },
  }, files);
  assert.deepEqual(
    bad.map((x) => `${x.day}:${x.kind}`).sort(),
    ['2026-11-02:missed_with_file', '2026-11-03:done_without_file']
  );

  assert.deepEqual(
    checkStatusInvariants({
      '2026-11-01': { status: 'done', source: 'ai' },
      '2026-11-03': { status: 'missed', source: '' },
    }, files),
    []
  );

  const mix = checkStatusInvariants({ '2026-11-01': { status: 'done', source: 'rule' } }, files);
  assert.equal(mix[0].kind, 'source_mismatch');
});

test('宽限边界与跨日：09:29 未到、09:30 到点；UTC 17:30 仍属前一新闻日', () => {
  assert.equal(deadlinePassed('09:29', '09:00', 30), false);
  assert.equal(deadlinePassed('09:30', '09:00', 30), true);
  assert.equal(deadlinePassed('08:00', '09:00', 0), false);

  const bj = beijingNow(Date.UTC(2026, 10, 1, 17, 30));
  // 北京 11-02 01:30 未到 08:00 ⇒ 新闻日仍是 11-01
  assert.equal(bj.date, '2026-11-01');
  assert.equal(bj.hm, '01:30');
});

test('规则版早报：≤10 条、override 概览不选汇总稿、why / endedAt 非空', () => {
  const rows = [
    row({ title: '华尔街见闻早餐 | 10月30日' }),
    row({ title: '央行宣布降息 25 个基点', source: '美联储' }),
    row({ title: '财政部提前下达 2027 年新增债限额' }),
    ...Array.from({ length: 12 }, (_, i) => row({ title: `补充条目 ${i}` })),
  ];
  const b = buildBriefing({ date: '2026-11-02', candidates: rows, now: Date.UTC(2026, 10, 2, 1, 0) });
  assert.equal(b.items.length, 10);
  assert.ok(b.endedAt);
  assert.equal(b.source, 'rule');
  assert.equal(b.generator, 'rule-v1');
  assert.ok(b.overview.startsWith('今日主线：'));
  assert.ok(!b.overview.includes('早餐'), '概览应跳过汇总稿');
  assert.ok(b.items.every((x) => x.why && x.rank >= 1));
  assert.deepEqual(b.watch, []);
});

test('状态 trim：刚写入的老日子必须保留（历史补写不被自己删掉）', () => {
  const f = file('status-trim.json');
  for (let i = 1; i <= 14; i++) {
    updateStatus(f, `2026-11-${String(i).padStart(2, '0')}`, { status: 'done' });
  }
  // 写一个远早于窗口的日子（补写 09-20）
  updateStatus(f, '2026-09-20', { status: 'done', backfill: true });
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(doc.days['2026-09-20'], '刚写入的补写日被 trim 掉了');
  assert.equal(doc.days['2026-09-20'].backfill, true);
  assert.equal(Object.keys(doc.days).length, 14, '总量仍受 keepDays 约束');
  assert.equal(doc.days['2026-11-01'], undefined, '应淘汰最老的普通日');
});

test('缺口判据：制度起点之后、今天之前、有新闻、无早报，四者缺一不可', () => {
  const check = (d) => ({ complete: d === '2026-11-13' });
  const counts = new Map([
    ['2026-11-10', 5],
    ['2026-11-12', 0],       // 有行但 0 条新闻 → 不立缺口
    ['2026-11-13', 900],     // 已有早报
    ['2026-11-14', 361],     // 真缺口
    ['2026-10-30', 681],     // 制度起点之前 → 不算缺口
  ]);
  const gaps = scanGaps({ today: '2026-11-15', eraStart: '2026-11-01', counts, check, days: 14 });
  assert.deepEqual(gaps.map((g) => g.day), ['2026-11-14', '2026-11-10']);
  assert.equal(gaps[0].news, 361);
  // 今天永远不进缺口
  assert.ok(!gaps.some((g) => g.day === '2026-11-15'));
  // 没有制度起点（先无产物）→ 不臆造缺口
  assert.deepEqual(scanGaps({ today: '2026-11-15', eraStart: '', counts, check }), []);
});

test('制度起点与归档跨度：都从真实产物/索引推导，不硬编码', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'era-'));
  assert.equal(briefEraStart(dir), '', '空目录不应给起点');
  for (const [d, src] of [['2026-11-03', 'ai'], ['2026-11-01', 'ai']]) {
    atomicWriteJSON(path.join(dir, `${d}.json`), {
      date: d, source: src, overview: '概览', endedAt: '2026-11-01T09:02:00+08:00',
      items: [{ title: 't' }],
    });
  }
  // 半成品不算（items 为空）
  atomicWriteJSON(path.join(dir, '2026-10-20.json'), { date: '2026-10-20', overview: 'x', items: [] });
  assert.equal(briefEraStart(dir), '2026-11-01');

  // 2.20.0：补写产物不能把制度起点往前推。
  //   起因：10-30 补写后起点落到 10-30，10-31 被误判成「制度后缺失」，页脚出现假告警。
  atomicWriteJSON(path.join(dir, '2026-10-30.json'), {
    date: '2026-10-30', source: 'ai', overview: '补写', endedAt: '2026-11-15T00:51:59+08:00',
    items: [{ title: 't' }],
    backfill: { kind: 'pre-era', at: '2026-11-15T00:51:59+08:00', note: 'x' },
  });
  assert.equal(briefEraStart(dir), '2026-11-01', '补写产物不得成为制度起点');
  // 若目录里只有补写产物，则没有起点（不凭空立规）
  const onlyBf = path.join(TMP, 'only-backfill');
  atomicWriteJSON(path.join(onlyBf, '2026-10-30.json'), {
    date: '2026-10-30', source: 'ai', overview: '补写', items: [{ title: 't' }],
    backfill: { kind: 'pre-era', at: '2026-11-15T00:51:59+08:00', note: 'x' },
  });
  assert.equal(briefEraStart(onlyBf), '', '只有补写产物时起点为空');

  const span = archiveSpan({
    days: [
      { day: '2026-10-01', count: 0 },
      { day: '2026-08-17', count: 6 },
      { day: '2026-11-14', count: 361 },
    ],
  });
  assert.equal(span.first, '2026-08-17');
  assert.equal(span.last, '2026-11-14');
  assert.equal(span.counts.has('2026-10-01'), false, '0 条不算有新闻');

  // 2.28.2：薄归档日由 history 切片兜底；两边取大者，不能把切片条数覆盖成归档的 3 条
  const span2 = archiveSpan(
    { days: [{ day: '2026-08-17', count: 6 }, { day: '2026-11-14', count: 361 }] },
    { days: [{ d: '2026-08-17', n: 233 }, { d: '2026-09-19', n: 188 }] }
  );
  assert.equal(span2.counts.get('2026-08-17'), 233, '取 archive / history 的较大值');
  assert.equal(span2.counts.get('2026-09-19'), 188, '只有切片没有归档的日子也算有新闻');
  assert.equal(span2.counts.get('2026-11-14'), 361);
});

test('补写守卫：不碰今天/未来、不早于归档起点、窗口方向正确', () => {
  const base = { today: '2026-11-15', archiveFirst: '2026-08-17' };
  assert.equal(guardBackfill({ ...base, from: '2026-11-14', to: '2026-11-14' }).ok, true);
  assert.equal(guardBackfill({ ...base, from: '2026-11-10', to: '2026-11-14' }).ok, true);

  const today = guardBackfill({ ...base, from: '2026-11-15', to: '2026-11-15' });
  assert.equal(today.ok, false);
  assert.equal(today.code, 'includes-today');
  assert.equal(guardBackfill({ ...base, from: '2026-11-14', to: '2026-11-16' }).code, 'includes-today');

  const early = guardBackfill({ ...base, from: '2026-08-16', to: '2026-08-20' });
  assert.equal(early.ok, false);
  assert.equal(early.code, 'before-archive');
  assert.match(early.reason, /没有任何新闻可切片/);

  assert.equal(guardBackfill({ ...base, from: '2026-11-14', to: '2026-11-10' }).code, 'bad-range');
  assert.equal(guardBackfill({ ...base, from: 'nov', to: '2026-11-10' }).code, 'bad-date');
});

test('ensure 子进程参数显式携带全部路径（防止写进仓库默认目录）', () => {
  const s = prepareArgs({
    date: '2026-11-02',
    runs: 'C:/t/runs',
    status: 'C:/t/status.json',
    db: 'C:/t/news.db',
    archive: 'C:/t/archive',
    noImport: true,
    quiet: true,
  }).join(' ');
  for (const want of [
    '--date 2026-11-02', '--no-import',
    '--runs C:/t/runs', '--status C:/t/status.json',
    '--db C:/t/news.db', '--archive C:/t/archive', '--quiet',
  ]) {
    assert.ok(s.includes(want), `缺少参数：${want}`);
  }
  // 2.19.0：补写标记只接受受控值，且必须一路传到 prepare 子进程
  const bf = prepareArgs({
    date: '2026-11-14', runs: 'C:/t/runs', status: 'C:/t/s.json', db: 'C:/t/n.db', archive: 'C:/t/a',
    backfill: 'gap',
  }).join(' ');
  assert.ok(bf.includes('--backfill-kind gap'));
  assert.ok(bf.includes('--no-import'));
  const bad = prepareArgs({
    date: '2026-11-14', runs: 'C:/t/runs', status: 'C:/t/s.json', db: 'C:/t/n.db', archive: 'C:/t/a',
    backfill: 'whatever',
  }).join(' ');
  assert.ok(!bad.includes('--backfill-kind'), '非法 kind 不应传给子进程');
});
