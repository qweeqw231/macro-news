// tests/ops-stats.test.mjs
// 2.4.22：管道操作底账的纯函数、抓取解析与静态接线。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dayKey, aggregateRuns, aggregateLedger, buildTable, fetchDayRuns, fetchWindow,
} from '../scripts/ops-stats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const run = (created, name, { event = 'schedule', sha = 'abc' } = {}) => ({
  created_at: created, name, event, head_sha: sha,
});
const ledger = (at, result, { mode = 'collect', skipReason = '' } = {}) =>
  ({ at, mode, result, skipReason, host: 'pc', headBefore: 'a', headAfter: 'b' });

test('dayKey：上海时区分日，UTC 16:00 跨日', () => {
  assert.equal(dayKey('2026-11-04T15:59:59Z'), '2026-11-04');
  assert.equal(dayKey('2026-11-04T16:00:00Z'), '2026-11-05');
  assert.equal(dayKey('bad'), '');
});

test('aggregateRuns：按日 + 按 workflow；Pages 单列；同一 push 的多个运行只算一次', () => {
  const days = aggregateRuns([
    run('2026-11-04T02:00:00Z', 'collect', { event: 'push', sha: 's1' }),
    run('2026-11-04T02:00:01Z', 'snapshot', { event: 'push', sha: 's1' }),
    run('2026-11-04T02:00:02Z', 'pages build and deployment', { event: 'push', sha: 's1' }),
    run('2026-11-04T03:00:00Z', 'collect'),
    run('2026-11-05T01:00:00Z', 'collect'),
  ]);
  assert.equal(days['2026-11-04'].workflowRuns, 3);
  assert.equal(days['2026-11-04'].pagesBuilds, 1);
  assert.deepEqual(days['2026-11-04'].byWorkflow, { collect: 2, snapshot: 1 });
  assert.deepEqual(days['2026-11-04'].pushShas, ['s1']);
  assert.equal(days['2026-11-05'].workflowRuns, 1);
});

test('aggregateLedger：成功/跳过/失败、原因分布、sync-only 单列', () => {
  const agg = aggregateLedger([
    ledger('2026-11-04T01:00:00Z', 'ok'),
    ledger('2026-11-04T03:00:00Z', 'skipped', { skipReason: 'news-fresh' }),
    ledger('2026-11-04T05:00:00Z', 'failed', { skipReason: 'push-failed' }),
    ledger('2026-11-04T07:00:00Z', 'ok', { mode: 'sync-only' }),
    ledger('bad', 'ok'),
  ]);
  const d = agg.days['2026-11-04'];
  assert.equal(d.runs, 3);
  assert.deepEqual(
    { ok: d.ok, skipped: d.skipped, failed: d.failed, syncOnly: d.syncOnly },
    { ok: 1, skipped: 1, failed: 1, syncOnly: 1 },
  );
  assert.deepEqual(d.skipReasons, { 'news-fresh': 1, 'push-failed': 1 });
  assert.equal(agg.totals.syncOnly, 1);
});

test('buildTable：Pages 由 push 派生，合计含本机，clone 当量不含本机', () => {
  const now = Date.parse('2026-11-06T00:00:00Z');
  const table = buildTable([
    run('2026-11-04T02:00:00Z', 'collect', { event: 'push', sha: 'p1' }),
    run('2026-11-04T02:00:01Z', 'snapshot', { event: 'push', sha: 'p1' }),
    run('2026-11-04T03:00:00Z', 'collect'),
  ], [
    ledger('2026-11-04T02:10:00Z', 'ok'),
    ledger('2026-11-04T04:10:00Z', 'skipped', { skipReason: 'news-fresh' }),
  ], { days: 3, now });
  const row = table.rows.find((r) => r.day === '2026-11-04');
  assert.equal(row.workflowRuns, 3);
  assert.equal(row.pushCount, 1);
  assert.equal(row.pagesBuilds, 1);
  assert.equal(row.localRuns, 2);
  assert.equal(row.total, 6);
  assert.equal(row.cloneEquivalent, 4);
  assert.equal(table.sums.localRuns, 2);
});

test('buildTable：窗口内的空白天也出现在表里', () => {
  const now = Date.parse('2026-11-06T00:00:00Z');
  const table = buildTable([], [], { days: 3, now });
  assert.equal(table.rows.length, 3);
  assert.ok(table.rows.every((r) => r.total === 0));
});

test('fetchDayRuns：分页取完即停，total_count 与缺失量正确', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const list = calls === 1
      ? Array.from({ length: 100 }, (_, i) => run('2026-11-04T01:00:00Z', 'collect', { sha: `s${i}` }))
      : Array.from({ length: 20 }, (_, i) => run('2026-11-04T01:00:00Z', 'collect', { sha: `t${i}` }));
    return new Response(JSON.stringify({ total_count: 120, workflow_runs: list }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const r = await fetchDayRuns('2026-11-04');
    assert.equal(r.runs.length, 120);
    assert.equal(r.totalCount, 120);
    assert.equal(r.missing, 0);
    assert.equal(r.truncated, false);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchDayRuns：403 给出可读原因', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ message: 'API rate limit exceeded' }),
    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60) } },
  );
  try {
    await assert.rejects(() => fetchDayRuns('2026-11-04'), /HTTP 403.*匿名配额耗尽/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchWindow：覆盖 days+2 个 UTC 日', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
  };
  try {
    const r = await fetchWindow({ days: 3, now: Date.parse('2026-11-06T00:00:00Z') });
    assert.equal(calls, 5);
    assert.equal(r.runs.length, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test('静态：ops-stats 只读、匿名、capped、不写 data/', () => {
  const src = read('scripts/ops-stats.mjs');
  assert.match(src, /\.local['"],\s*'metrics'/);
  assert.match(src, /MAX_PAGES_PER_DAY\s*=\s*10/);
  assert.match(src, /per_page=\$\{PER_PAGE\}/);
  assert.match(src, /created=\$\{day\}\.\.\$\{day\}/);
  assert.doesNotMatch(src, /Authorization/);
  assert.doesNotMatch(src, /path\.join\(ROOT,\s*'data'/);
  assert.match(src, /fs\.writeFileSync\(outFile/);
});

test('静态：collect-and-push 台账字段、try/finally、失败不改退出码', () => {
  const src = read('scripts/collect-and-push.ps1');
  const start = src.indexOf('$runStats = [ordered]@{');
  const end = src.indexOf('# ---- 0. 启动自检');
  const block = src.slice(start, end);
  assert.ok(start > -1 && end > start, 'Write-RunLedger 必须在启动自检之前');
  for (const f of ['at', 'host', 'mode', 'result', 'headBefore', 'headAfter',
    'behind', 'ahead', 'filesWritten', 'commitCreated', 'skipReason', 'syncResult', 'durationMs']) {
    assert.match(block, new RegExp(`\\b${f}\\b`), `缺字段 ${f}`);
  }
  assert.match(src, /\.local\\metrics/);
  assert.match(src, /collect-runs\.jsonl/);
  assert.match(src, /mode = \$runMode/);
  assert.match(src, /if \(\$SyncOnly\) \{ \$runMode = 'sync-only' \}/);
  assert.match(block, /catch \{/);
  assert.doesNotMatch(block, /\bexit\b/, '写台账失败不得 exit');
  assert.match(block, /\$LASTEXITCODE = \$prevCode/);
  // try 必须在同步之前；finally 在文件末尾
  assert.ok(src.indexOf('try {') < src.indexOf('# ---- 0.1 先同步再跑'));
  assert.match(src, /\} finally \{\s*Write-RunLedger\s*\}/);
  for (const r of ['skipped', 'failed', 'ok']) {
    assert.match(src, new RegExp(`result = '${r}'`), `缺 result=${r}`);
  }
});
