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
  atomicWriteJSON,
  atomicWriteText,
  beijingNow,
  buildBriefing,
  checkBriefing,
  deadlinePassed,
  generateArgs,
  planCatchup,
} from '../scripts/briefing/core.mjs';

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

test('补跑计划：升序、本地完整只发布、今天未到 09:30 不补', () => {
  const check = (d) => ({
    complete: d === '2026-11-01',
    localComplete: d === '2026-10-31',
  });
  const before = planCatchup({
    today: '2026-11-02', nowHm: '09:00', days: 3, check,
  });
  assert.deepEqual(before, [{ date: '2026-10-31', action: 'publish' }]);

  const after = planCatchup({
    today: '2026-11-02', nowHm: '09:31', days: 3, check,
  });
  assert.deepEqual(after, [
    { date: '2026-10-31', action: 'publish' },
    { date: '2026-11-02', action: 'generate' },
  ]);
});

test('宽限边界与跨日：09:29 未到、09:30 到点；UTC 17:30 是北京次日', () => {
  assert.equal(deadlinePassed('09:29', '09:00', 30), false);
  assert.equal(deadlinePassed('09:30', '09:00', 30), true);
  assert.equal(deadlinePassed('08:00', '09:00', 0), false);

  const bj = beijingNow(Date.UTC(2026, 10, 1, 17, 30));
  assert.equal(bj.date, '2026-11-02');
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
  assert.ok(b.overview.startsWith('今日主线：'));
  assert.ok(!b.overview.includes('早餐'), '概览应跳过汇总稿');
  assert.ok(b.items.every((x) => x.why && x.rank >= 1));
  assert.deepEqual(b.watch, []);
});

test('ensure 子进程参数显式携带全部路径（防止写进仓库默认目录）', () => {
  const s = generateArgs({
    date: '2026-11-02',
    out: 'C:/t/out',
    siteOut: 'C:/t/site',
    status: 'C:/t/status.json',
    lock: 'C:/t/lock',
    db: 'C:/t/news.db',
    archive: 'C:/t/archive',
    quiet: true,
  }).join(' ');
  for (const want of [
    '--date 2026-11-02', '--no-lock', '--no-import',
    '--out C:/t/out', '--site-out C:/t/site', '--status C:/t/status.json',
    '--lock C:/t/lock', '--db C:/t/news.db', '--archive C:/t/archive', '--quiet',
  ]) {
    assert.ok(s.includes(want), `缺少参数：${want}`);
  }
});
