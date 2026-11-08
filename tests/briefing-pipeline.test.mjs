// tests/briefing-pipeline.test.mjs
// 2.3.0 三段式离线回归：输入快照复用、检查点续写、schema 拒绝、
// draft/missed 降级不冒充、AI 覆盖保护、发布原子性、索引透传。
//
// 不联网；所有写盘只发生在 os.tmpdir() 下的临时目录；仓库路径只读。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkStatusInvariants, normalizeBriefingSource } from '../scripts/briefing/core.mjs';
import {
  checkpointReport,
  patchIndexDoc,
  prepareSnapshot,
  publishRun,
  snapshotSha,
  validateFinal,
  verifyIndexBriefing,
} from '../scripts/briefing/pipeline.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-pipe-'));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

const DATE = '2026-11-02';
const T0 = Date.UTC(2026, 10, 2, 1, 0); // 北京 09:00
const T1 = Date.UTC(2026, 10, 2, 1, 35); // 北京 09:35

function fresh(label) {
  const dir = path.join(TMP, label);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    runs: path.join(dir, 'runs'),
    site: path.join(dir, 'site'),
    local: path.join(dir, 'local'),
    data: path.join(dir, 'data'),
    status: path.join(dir, 'status.json'),
    db: path.join(dir, 'news.db'),
    archive: path.join(dir, 'archive'),
  };
}

const candidate = (i) => ({
  rank: i + 1,
  date: '2026-11-02T09:00',
  source: ['中国人民银行', '美联储', '国家统计局'][i % 3],
  channel: '官方',
  title: `宏观事件 ${i}：央行政策与利率变化`,
  summary: `候选摘要 ${i}，用于早报写作。`,
  url: `https://example.com/${i}`,
  score: 20 - i,
  content_status: 'full',
  published_ts: 1793580000 + i,
});
const ITEMS = Array.from({ length: 10 }, (_, i) => candidate(i));
const WINDOW = { from: '2026-11-01', to: DATE };

function writeInput(runsDir, items = ITEMS) {
  const dir = path.join(runsDir, DATE);
  fs.mkdirSync(dir, { recursive: true });
  const inputSha = snapshotSha(DATE, WINDOW, items);
  const input = {
    v: 1,
    date: DATE,
    preparedAt: '2026-11-02T09:00:00+08:00',
    generator: 'prepare-v1',
    window: WINDOW,
    candidateCount: items.length,
    selectedCount: items.length,
    inputSha,
    items,
  };
  fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify(input, null, 2));
  return input;
}

function writeCheckpoint(runsDir, stage, input, patch = {}) {
  const dir = path.join(runsDir, DATE);
  fs.mkdirSync(dir, { recursive: true });
  const doc = {
    date: DATE,
    inputSha: input.inputSha,
    ...(stage === 'final'
      ? { generatedAt: '2026-11-02T09:20:00+08:00' }
      : { createdAt: '2026-11-02T09:10:00+08:00' }),
    ...patch,
    stage,
  };
  fs.writeFileSync(path.join(dir, `${stage}.json`), JSON.stringify(doc, null, 2));
  return doc;
}

function finalDoc(input, overrides = {}) {
  return {
    date: DATE,
    inputSha: input.inputSha,
    stage: 'final',
    generatedAt: '2026-11-02T09:20:00+08:00',
    overview: '今日主线：央行政策与海外利率同时变化，风险偏好先抑后扬。',
    items: input.items.slice(0, 5).map((it, i) => ({
      rank: i + 1,
      title: it.title,
      summary: `摘要 ${i}，基于候选事实改写，不含编造。`,
      why: '为什么重要：影响今日风险偏好。',
      source: it.source,
      publishedAt: it.date,
      url: it.url,
    })),
    watch: ['明日关注央行公开市场操作', '关注美国通胀数据'],
    ...overrides,
  };
}

function briefFile(source, items = 3) {
  const list = Array.from({ length: items }, (_, i) => ({
    rank: i + 1,
    title: `已有产物 ${i}`,
    summary: '已有正文',
    why: '已有判断',
    source: '中国人民银行',
    publishedAt: '2026-11-02T09:00',
    url: `https://example.com/existing-${i}`,
  }));
  return {
    date: DATE,
    generatedAt: '2026-11-02T09:00:00+08:00',
    endedAt: '2026-11-02T09:02:00+08:00',
    source,
    generator: source === 'rule' ? 'rule-v1' : 'existing',
    window: WINDOW,
    overview: '已有产物概览',
    items: list,
    watch: [],
  };
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ---------------------------------------------------------------------------

test('输入快照复用：重跑不读 archive / 不碰 DB，文件字节不变', () => {
  const d = fresh('prepare');
  fs.mkdirSync(d.archive, { recursive: true });
  const ts = Math.floor(Date.parse('2026-11-02T09:00:00+08:00') / 1000);
  fs.writeFileSync(path.join(d.archive, '2026-11-02.json'), JSON.stringify({
    date: DATE,
    items: ITEMS.map((it, i) => ({
      id: `a${i}`,
      source: it.source,
      channel: it.channel,
      title: it.title,
      summary: it.summary,
      url: it.url,
      time: it.date,
      ts: ts + i,
      kind: 'news',
    })),
  }, null, 2));

  const first = prepareSnapshot({
    date: DATE, runsDir: d.runs, dbFile: d.db, archiveDir: d.archive, limit: 10, now: T0,
  });
  assert.equal(first.reused, false);
  assert.ok(first.input.items.length >= 3);
  const bytes = fs.readFileSync(first.inputPath, 'utf8');

  // 移走 archive 和 DB：如果 prepare 重新取数，会直接失败
  fs.rmSync(d.archive, { recursive: true, force: true });
  fs.rmSync(d.db, { force: true });
  const second = prepareSnapshot({
    date: DATE, runsDir: d.runs, dbFile: d.db, archiveDir: d.archive, limit: 10, now: T0 + 1000,
  });
  assert.equal(second.reused, true);
  assert.equal(second.inputSha, first.inputSha);
  assert.equal(fs.readFileSync(second.inputPath, 'utf8'), bytes);
});

test('检查点续写：prepare → outline → draft → final → publish；旧指纹回退到 outline', () => {
  const d = fresh('checkpoints');
  assert.equal(checkpointReport({ date: DATE, runsDir: d.runs }).next, 'prepare');

  const input = writeInput(d.runs);
  assert.equal(checkpointReport({ date: DATE, runsDir: d.runs }).next, 'outline');

  writeCheckpoint(d.runs, 'outline', input, { thesis: '主线', picks: [], watch: [] });
  assert.equal(checkpointReport({ date: DATE, runsDir: d.runs }).next, 'draft');

  writeCheckpoint(d.runs, 'draft', input, finalDoc(input));
  assert.equal(checkpointReport({ date: DATE, runsDir: d.runs }).next, 'final');

  writeCheckpoint(d.runs, 'final', input, finalDoc(input));
  const done = checkpointReport({ date: DATE, runsDir: d.runs });
  assert.equal(done.next, 'publish');
  assert.equal(done.latest, 'final');

  // 快照被 --force 重建：所有旧检查点都带旧 inputSha，必须从 outline 重写
  const changed = { ...input, inputSha: 'ffffffffffffffff' };
  fs.writeFileSync(
    path.join(d.runs, DATE, 'input.json'),
    JSON.stringify(changed, null, 2)
  );
  const stale = checkpointReport({ date: DATE, runsDir: d.runs });
  assert.equal(stale.next, 'outline');
  assert.equal(stale.latest, null);
  assert.equal(stale.checkpoints.final.stale, true);
});

test('schema：空 overview / 条数不足 / 不可追溯 / 来源不一致 / draft 伪装 / 超 10 条全部拒绝', () => {
  const d = fresh('schema');
  const input = writeInput(d.runs);
  const ok = finalDoc(input);
  assert.deepEqual(validateFinal({ doc: ok, input, date: DATE }), { ok: true, errors: [] });

  const bad = [
    finalDoc(input, { overview: '  ' }),
    finalDoc(input, { items: ok.items.slice(0, 2) }),
    finalDoc(input, {
      items: ok.items.map((x, i) => (i === 0 ? { ...x, url: 'https://not-in-input/1' } : x)),
    }),
    finalDoc(input, {
      items: ok.items.map((x, i) => (i === 0 ? { ...x, source: '错误来源' } : x)),
    }),
    { ...ok, stage: 'draft' },
    finalDoc(input, {
      items: Array.from({ length: 11 }, (_, i) => ({ ...ok.items[0], url: `https://example.com/${i}` })),
    }),
  ];
  for (const doc of bad) {
    const r = validateFinal({ doc, input, date: DATE });
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(doc).slice(0, 80)}`);
    assert.ok(r.errors.length > 0);
  }
});

test('无 final → missed 且不写站点文件；状态 missed 与文件互斥', () => {
  const d = fresh('no-final');
  const input = writeInput(d.runs);
  writeCheckpoint(d.runs, 'outline', input, { thesis: '主线', picks: [], watch: [] });

  const r = publishRun({
    date: DATE, runsDir: d.runs, siteOut: d.site, localOut: d.local,
    status: d.status, dataDir: d.data, noLock: true, now: T1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-final');
  assert.equal(fs.existsSync(path.join(d.site, `${DATE}.json`)), false);

  const st = JSON.parse(fs.readFileSync(d.status, 'utf8'));
  assert.equal(st.days[DATE].status, 'missed');
  const bad = checkStatusInvariants(st.days, new Map());
  assert.deepEqual(bad, []);
});

test('校验失败 + draft-on-fail：只出 source=draft 事实清单，绝不出现 rule', () => {
  const d = fresh('draft');
  const input = writeInput(d.runs);
  const bad = finalDoc(input, {
    items: finalDoc(input).items.map((x, i) => (i === 0 ? { ...x, url: 'https://evil/1' } : x)),
  });
  writeCheckpoint(d.runs, 'final', input, bad);

  const r = publishRun({
    date: DATE, runsDir: d.runs, siteOut: d.site, localOut: d.local,
    status: d.status, dataDir: d.data, draftOnFail: true, noLock: true, now: T1,
  });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  assert.equal(r.source, 'draft');

  const doc = JSON.parse(fs.readFileSync(path.join(d.site, `${DATE}.json`), 'utf8'));
  assert.equal(doc.source, 'draft');
  assert.equal(doc.generator, 'draft-v1');
  assert.equal(doc.source === 'rule', false);
  assert.ok(doc.overview.includes('事实清单'));
  assert.ok(doc.items.every((x) => x.summary === ''), '事实清单不能带 AI 摘要');
  assert.ok(doc.items.length <= 10);

  const st = JSON.parse(fs.readFileSync(d.status, 'utf8'));
  assert.equal(st.days[DATE].status, 'done');
  assert.equal(st.days[DATE].source, 'draft');
  const files = new Map([[DATE, { source: 'draft' }]]);
  assert.deepEqual(checkStatusInvariants(st.days, files), []);
});

test('校验失败且未降级：missed，不写文件，不产生规则版', () => {
  const d = fresh('invalid');
  const input = writeInput(d.runs);
  const bad = finalDoc(input, { overview: '' });
  writeCheckpoint(d.runs, 'final', input, bad);

  const r = publishRun({
    date: DATE, runsDir: d.runs, siteOut: d.site, localOut: d.local,
    status: d.status, dataDir: d.data, noLock: true, now: T1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid');
  assert.equal(fs.existsSync(path.join(d.site, `${DATE}.json`)), false);
  const st = JSON.parse(fs.readFileSync(d.status, 'utf8'));
  assert.equal(st.days[DATE].status, 'missed');
  assert.equal(st.days[DATE].source, '');
});

test('有效定稿：原子写站点 + 本地副本 + 状态 done/ai + 索引透传', () => {
  const d = fresh('publish');
  const input = writeInput(d.runs);
  writeCheckpoint(d.runs, 'final', input, finalDoc(input));
  fs.mkdirSync(d.data, { recursive: true });
  fs.writeFileSync(path.join(d.data, 'index.json'), JSON.stringify({
    generatedAt: '', total: 10, days: [{ day: DATE, count: 10, hasBriefing: false }],
  }, null, 2));
  fs.mkdirSync(path.join(d.data, 'history'), { recursive: true });
  fs.writeFileSync(path.join(d.data, 'history', 'index.json'), JSON.stringify({
    v: 2, days: [{ d: DATE, n: 10, b: 1, hasBriefing: false }],
  }, null, 2));

  const r = publishRun({
    date: DATE, runsDir: d.runs, siteOut: d.site, localOut: d.local,
    status: d.status, dataDir: d.data, noLock: true, now: T1,
  });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'published');
  assert.equal(r.source, 'ai');

  const site = path.join(d.site, `${DATE}.json`);
  const doc = JSON.parse(fs.readFileSync(site, 'utf8'));
  assert.equal(doc.source, 'ai');
  assert.equal(doc.generator, 'llm-v1');
  assert.equal(doc.endedAt, '2026-11-02T09:35:00+08:00');
  assert.equal(doc.items.length, 5);
  assert.ok(fs.existsSync(path.join(d.local, `${DATE}.json`)));
  assert.ok(fs.existsSync(path.join(d.local, `${DATE}.md`)));

  const st = JSON.parse(fs.readFileSync(d.status, 'utf8'));
  assert.equal(st.days[DATE].status, 'done');
  assert.equal(st.days[DATE].source, 'ai');
  assert.deepEqual(checkStatusInvariants(st.days, new Map([[DATE, { source: 'ai' }]])), []);

  assert.equal(JSON.parse(fs.readFileSync(path.join(d.data, 'index.json'), 'utf8')).days[0].source, 'ai');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d.data, 'history', 'index.json'), 'utf8')).days[0].source, 'ai');

  const leftovers = [
    ...fs.readdirSync(d.site), ...fs.readdirSync(d.local),
  ].filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('AI 覆盖保护：站点已有 AI 早报时，即使 final 有效也不覆盖', () => {
  const d = fresh('protect');
  fs.mkdirSync(d.site, { recursive: true });
  const site = path.join(d.site, `${DATE}.json`);
  fs.writeFileSync(site, JSON.stringify(briefFile('ai'), null, 2));
  const before = sha(site);

  const input = writeInput(d.runs);
  writeCheckpoint(d.runs, 'final', input, finalDoc(input));
  const r = publishRun({
    date: DATE, runsDir: d.runs, siteOut: d.site, localOut: d.local,
    status: d.status, dataDir: d.data, draftOnFail: true, noLock: true, now: T1,
  });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'existing-ai');
  assert.equal(r.skipped, true);
  assert.equal(sha(site), before, 'AI 文件不得被覆盖');

  const st = JSON.parse(fs.readFileSync(d.status, 'utf8'));
  assert.equal(st.days[DATE].status, 'done');
  assert.equal(st.days[DATE].source, 'ai');
});

test('已有 rule 且新定稿不合格：保留 rule 并记 done/rule，不得标 missed', () => {
  const d = fresh('keep-rule');
  fs.mkdirSync(d.site, { recursive: true });
  const site = path.join(d.site, `${DATE}.json`);
  fs.writeFileSync(site, JSON.stringify(briefFile('rule'), null, 2));
  const before = sha(site);

  const input = writeInput(d.runs);
  writeCheckpoint(d.runs, 'final', input, finalDoc(input, { overview: '' }));
  const r = publishRun({
    date: DATE, runsDir: d.runs, siteOut: d.site, localOut: d.local,
    status: d.status, dataDir: d.data, noLock: true, now: T1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid');
  assert.equal(r.preserved, true);
  assert.equal(sha(site), before);
  const st = JSON.parse(fs.readFileSync(d.status, 'utf8'));
  assert.equal(st.days[DATE].status, 'done');
  assert.equal(st.days[DATE].source, 'rule');
  assert.deepEqual(checkStatusInvariants(st.days, new Map([[DATE, { source: 'rule' }]])), []);
});

test('索引只改已存在的日期；没有归档条目不新增', () => {
  const doc = { days: [{ day: '2026-11-01', count: 3, hasBriefing: false }] };
  assert.equal(patchIndexDoc(doc, { date: DATE, briefLine: '主线', source: 'draft' }), false);
  assert.equal(patchIndexDoc(doc, { date: '2026-11-01', briefLine: '主线', source: 'draft' }), true);
  assert.equal(doc.days[0].hasBriefing, true);
  assert.equal(doc.days[0].source, 'draft');
});

test('draft 来源不被读取端误判成 ai', () => {
  assert.equal(normalizeBriefingSource({ source: 'draft' }), 'draft');
  assert.equal(normalizeBriefingSource({ source: 'rule' }), 'rule');
  assert.equal(normalizeBriefingSource({ source: 'ai' }), 'ai');
  assert.equal(normalizeBriefingSource({}), 'ai');
});

// ---------------------------------------------------------------------------
// 2.4.19：发布自检 —— 索引没打上标记就不算发布成功（2026-11-06 事故的回归）
// ---------------------------------------------------------------------------

test('verifyIndexBriefing：缺天/未标记/缺 briefLine/缺 source 全部不通过；索引不存在则放行', () => {
  const d = fresh('verify-index');
  fs.mkdirSync(d.data, { recursive: true });
  const write = (doc) =>
    fs.writeFileSync(path.join(d.data, 'index.json'), JSON.stringify(doc, null, 2));

  write({ days: [{ day: '2026-11-01', count: 3, hasBriefing: false }] });
  let r = verifyIndexBriefing({ dataDir: d.data, date: DATE });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'day-missing');
  assert.match(r.reason, /git fetch origin main/);

  write({ days: [{ day: DATE, count: 3, hasBriefing: false }] });
  r = verifyIndexBriefing({ dataDir: d.data, date: DATE });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-marked');

  write({ days: [{ day: DATE, count: 3, hasBriefing: true }] });
  r = verifyIndexBriefing({ dataDir: d.data, date: DATE });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-line');

  write({ days: [{ day: DATE, count: 3, hasBriefing: true, briefLine: '主线' }] });
  r = verifyIndexBriefing({ dataDir: d.data, date: DATE });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-source');

  write({ days: [{ day: DATE, count: 3, hasBriefing: true, briefLine: '主线', source: 'ai' }] });
  r = verifyIndexBriefing({ dataDir: d.data, date: DATE, expectLine: '主线' });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'index-ok');

  r = verifyIndexBriefing({ dataDir: d.data, date: DATE, expectLine: '别的' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'line-mismatch');

  fs.rmSync(path.join(d.data, 'index.json'));
  r = verifyIndexBriefing({ dataDir: d.data, date: DATE });
  assert.equal(r.ok, true, '索引不存在 ⇒ 无从核对，不拦发布');
  assert.equal(r.code, 'no-index');

  r = verifyIndexBriefing({ dataDir: null, date: DATE });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'skipped');
});

test('发布自检：本地 checkout 落后、索引里没有当天 ⇒ 判失败而不是静默成功', () => {
  const d = fresh('index-self-check');
  const input = writeInput(d.runs);
  writeCheckpoint(d.runs, 'final', input, finalDoc(input));
  fs.mkdirSync(d.data, { recursive: true });
  // 复现 2026-11-06：本地 data/index.json 还是昨天的版本，没有当天这一行
  fs.writeFileSync(path.join(d.data, 'index.json'), JSON.stringify({
    generatedAt: '', total: 3, days: [{ day: '2026-11-01', count: 3, hasBriefing: false }],
  }, null, 2));

  const r = publishRun({
    date: DATE, runsDir: d.runs, siteOut: d.site, localOut: d.local,
    status: d.status, dataDir: d.data, noLock: true, now: T1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'index-not-patched');
  assert.equal(r.indexCheck, 'day-missing');
  assert.match(r.reason, /索引自检未通过/);
  assert.match(r.reason, /git fetch origin main/);

  const st = JSON.parse(fs.readFileSync(d.status, 'utf8'));
  assert.equal(st.days[DATE].status, 'failed');
  assert.equal(st.days[DATE].source, '');

  // 不能靠 publish 偷偷给不存在的天补一行：索引里仍然没有当天
  const ix = JSON.parse(fs.readFileSync(path.join(d.data, 'index.json'), 'utf8'));
  assert.equal(ix.days.find((x) => x.day === DATE), undefined);
});

test('发布自检：索引同步后重跑 ⇒ 标记补上、判成功', () => {
  const d = fresh('index-self-check-retry');
  const input = writeInput(d.runs);
  writeCheckpoint(d.runs, 'final', input, finalDoc(input));
  fs.mkdirSync(d.data, { recursive: true });
  fs.writeFileSync(path.join(d.data, 'index.json'), JSON.stringify({
    generatedAt: '', total: 3, days: [{ day: '2026-11-01', count: 3, hasBriefing: false }],
  }, null, 2));

  const first = publishRun({
    date: DATE, runsDir: d.runs, siteOut: d.site, localOut: d.local,
    status: d.status, dataDir: d.data, noLock: true, now: T1,
  });
  assert.equal(first.ok, false);

  // 模拟「先同步本地」：索引里出现了当天这一行
  fs.writeFileSync(path.join(d.data, 'index.json'), JSON.stringify({
    generatedAt: '', total: 10, days: [{ day: DATE, count: 10, hasBriefing: false }],
  }, null, 2));

  const second = publishRun({
    date: DATE, runsDir: d.runs, siteOut: d.site, localOut: d.local,
    status: d.status, dataDir: d.data, noLock: true, now: T1 + 1000,
  });
  assert.equal(second.ok, true);
  const ix = JSON.parse(fs.readFileSync(path.join(d.data, 'index.json'), 'utf8'));
  assert.equal(ix.days[0].hasBriefing, true);
  assert.equal(ix.days[0].source, 'ai');
  assert.ok(ix.days[0].briefLine.length > 0);
  const st = JSON.parse(fs.readFileSync(d.status, 'utf8'));
  assert.equal(st.days[DATE].status, 'done');
  assert.equal(st.days[DATE].source, 'ai');
});
