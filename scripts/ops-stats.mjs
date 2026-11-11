#!/usr/bin/env node
// scripts/ops-stats.mjs
// 2.4.22：管道操作底账（只读）。
//
// 数据源：
//   1) GitHub REST 匿名 actions/runs（按 created 分日、按 workflow 计数）；
//   2) 本机 .local/metrics/collect-runs.jsonl（collect-and-push.ps1 每轮追加）。
//
// 只读：不写仓库、不提交、不写 data/；快照写到 .local/metrics/ops-stats-<date>.json。
// 用途：长期趋势与自证用量，不用于指认外部 clone 来源。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LEDGER = path.join(ROOT, '.local', 'metrics', 'collect-runs.jsonl');
const OUT_DIR = path.join(ROOT, '.local', 'metrics');
const DEFAULT_REPO = 'qweeqw231/macro-news';
const TZ = 'Asia/Shanghai';
const PER_PAGE = 100;
const MAX_PAGES_PER_DAY = 10; // 匿名分页上限 1,000 条/日
const API = 'https://api.github.com';
const PAGES_WORKFLOW = 'pages build and deployment';

/** 把一个 UTC ISO 时刻转成指定时区的 YYYY-MM-DD */
export function dayKey(iso, tz = TZ) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 按日 + 按 workflow 聚合 GitHub runs；push 用 head_sha 去重 */
export function aggregateRuns(runs, { tz = TZ } = {}) {
  const days = {};
  for (const r of runs || []) {
    const day = dayKey(r.created_at, tz);
    if (!day) continue;
    const d = days[day] || (days[day] = {
      day, workflowRuns: 0, pagesBuilds: 0, byWorkflow: {}, pushShas: [],
    });
    const name = r.name || r.path || '(unknown)';
    if (name === PAGES_WORKFLOW) {
      d.pagesBuilds++;
    } else {
      d.workflowRuns++;
      d.byWorkflow[name] = (d.byWorkflow[name] || 0) + 1;
    }
    if (r.event === 'push' && r.head_sha && !d.pushShas.includes(r.head_sha)) {
      d.pushShas.push(r.head_sha);
    }
  }
  return days;
}

/** 连续 dirty-worktree 让路的告警阈值（2 小时一轮 ⇒ 3 轮 ≈ 6 小时） */
export const DIRTY_ALERT_STREAK = 3;

/** 台账尾部「连续 dirty-worktree 让路」的轮数。
 *  只数真正的 dirty-worktree 跳过——news-fresh 等正常跳过会中断计数（视为兜底在工作）。
 *  sync-only 是人工验证轮，不计入兜底轮次。 */
export function dirtyWorktreeStreak(entries) {
  let n = 0;
  for (let i = (entries || []).length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || typeof e !== 'object') continue;
    if (e.mode === 'sync-only') continue;
    if (e.skipReason === 'dirty-worktree') n++;
    else break;
  }
  return n;
}

/** 本机台账行的日键：优先用写入侧显式记录的北京日 `day`；
 *  旧行（< 2.13.5）没有 `day`，按 `at`（UTC）换算成北京日回退——历史行不回填。 */
export function ledgerDay(e, tz = TZ) {
  if (e && typeof e.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.day)) return e.day;
  return dayKey(e && e.at, tz);
}

/** 本机台账聚合：按北京日（GH 三列也按北京日，两列才逐日对齐）；sync-only 不计入采集轮次 */
export function aggregateLedger(entries, { tz = TZ } = {}) {
  const days = {};
  const totals = { runs: 0, ok: 0, skipped: 0, failed: 0, syncOnly: 0, skipReasons: {} };
  for (const e of entries || []) {
    if (!e || typeof e !== 'object') continue;
    const day = ledgerDay(e, tz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const d = days[day] || (days[day] = {
      day, runs: 0, ok: 0, skipped: 0, failed: 0, syncOnly: 0, skipReasons: {},
    });
    if (e.mode === 'sync-only') {
      d.syncOnly++;
      totals.syncOnly++;
      continue;
    }
    const result = e.result === 'ok' ? 'ok' : e.result === 'skipped' ? 'skipped' : 'failed';
    d.runs++;
    d[result]++;
    totals.runs++;
    totals[result]++;
    if (result !== 'ok' && e.skipReason) {
      d.skipReasons[e.skipReason] = (d.skipReasons[e.skipReason] || 0) + 1;
      totals.skipReasons[e.skipReason] = (totals.skipReasons[e.skipReason] || 0) + 1;
    }
  }
  return { days, totals };
}

/**
 * 合并成每日操作次数表。
 * @param {object[]} runs GitHub workflow_runs
 * @param {object[]} ledgerEntries 本机台账行
 * @param {{days?:number, now?:number, tz?:string}} opts
 */
export function buildTable(runs, ledgerEntries, { days = 14, now = Date.now(), tz = TZ } = {}) {
  const from = now - days * 86400000;
  const gh = aggregateRuns((runs || []).filter((r) => {
    const t = new Date(r.created_at).getTime();
    return Number.isFinite(t) && t >= from;
  }), { tz });
  const local = aggregateLedger((ledgerEntries || []).filter((e) => {
    const t = new Date(e.at).getTime();
    return Number.isFinite(t) && t >= from;
  }), { tz });

  const daySet = new Set([...Object.keys(gh), ...Object.keys(local.days)]);
  // 补齐窗口内的空白天，便于看趋势（最多 days 天）
  for (let i = 0; i < days; i++) {
    const d = dayKey(new Date(now - i * 86400000).toISOString(), tz);
    if (d) daySet.add(d);
  }

  const pagesSeen = Object.values(gh).some((g) => g.pagesBuilds > 0);
  const rows = [...daySet].sort().reverse().map((day) => {
    const g = gh[day] || { workflowRuns: 0, pagesBuilds: 0, byWorkflow: {}, pushShas: [] };
    const l = local.days[day] || { runs: 0, ok: 0, skipped: 0, failed: 0, syncOnly: 0, skipReasons: {} };
    const pushCount = g.pushShas.length;
    // Pages 构建优先直接计数（同一份 runs 里的 pages workflow）；
    // 若整窗都没有 pages 运行（API 缺失/仓库未启用），回退到「一次 push 一次构建」的推断。
    const pagesBuilds = pagesSeen ? g.pagesBuilds : pushCount;
    const total = g.workflowRuns + pagesBuilds + l.runs;
    return {
      day,
      workflowRuns: g.workflowRuns,
      byWorkflow: g.byWorkflow,
      pushCount,
      pagesBuilds,
      localRuns: l.runs,
      localOk: l.ok,
      localSkipped: l.skipped,
      localFailed: l.failed,
      localSyncOnly: l.syncOnly,
      localSkipReasons: l.skipReasons,
      total,
      // 1 次 GH 运行 ≈ 1 次 clone；本机是 fetch，不计入
      cloneEquivalent: g.workflowRuns + pagesBuilds,
    };
  });

  const workflowTotals = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.byWorkflow)) {
      workflowTotals[k] = (workflowTotals[k] || 0) + v;
    }
  }
  const sums = {
    workflowRuns: rows.reduce((s, r) => s + r.workflowRuns, 0),
    pagesBuilds: rows.reduce((s, r) => s + r.pagesBuilds, 0),
    localRuns: rows.reduce((s, r) => s + r.localRuns, 0),
    localSyncOnly: rows.reduce((s, r) => s + r.localSyncOnly, 0),
    total: rows.reduce((s, r) => s + r.total, 0),
    cloneEquivalent: rows.reduce((s, r) => s + r.cloneEquivalent, 0),
  };
  return { rows, workflowTotals, sums, localTotals: local.totals };
}

/** 终端表格（等宽用空格补齐；中文字符宽度不精确，但列不会串行） */
export function formatTable(table) {
  const head = ['日期', 'GH运行', 'Pages', '本机采集', '合计', 'clone当量'];
  const body = table.rows.map((r) => [
    r.day, r.workflowRuns, r.pagesBuilds, r.localRuns, r.total, r.cloneEquivalent,
  ].map(String));
  const widths = head.map((h, i) => Math.max(displayWidth(h), ...body.map((row) => displayWidth(row[i]))));
  const line = (cells) => cells.map((c, i) => padRight(c, widths[i])).join('  ');
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}

function displayWidth(s) {
  return String(s).replace(/[^\x00-\xff]/g, 'xx').length;
}
function padRight(s, w) {
  const gap = w - displayWidth(s);
  return String(s) + ' '.repeat(Math.max(0, gap));
}

/** 拉取单日 runs（按 UTC 日期过滤；匿名分页上限 1,000） */
export async function fetchDayRuns(day, { repo = DEFAULT_REPO, maxPages = MAX_PAGES_PER_DAY } = {}) {
  const runs = [];
  let totalCount = 0;
  let truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const url = `${API}/repos/${repo}/actions/runs`
      + `?per_page=${PER_PAGE}&page=${page}&created=${day}..${day}`;
    const res = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'macro-news-ops-stats' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg += ` ${(await res.json()).message || ''}`.trim(); } catch { /* ignore */ }
      if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        msg += `（匿名配额耗尽，约 ${Math.max(0, Math.round((reset - Date.now()) / 60000))} 分钟后重置）`;
      }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    totalCount = Number(json.total_count) || totalCount;
    const list = json.workflow_runs || [];
    runs.push(...list);
    if (list.length < PER_PAGE) break;
    if (page === maxPages) truncated = true;
  }
  return { runs, totalCount, truncated, missing: Math.max(0, totalCount - runs.length) };
}

/** 按 UTC 日期逐日拉取（窗口两端各多取一天，保证上海时区分组完整） */
export async function fetchWindow({ repo = DEFAULT_REPO, days = 14, now = Date.now() } = {}) {
  const start = new Date(now - (days + 1) * 86400000);
  const allRuns = [];
  let totalCount = 0;
  let missing = 0;
  let truncated = false;
  const dayCount = days + 2;
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    const r = await fetchDayRuns(d, { repo });
    allRuns.push(...r.runs);
    totalCount += r.totalCount;
    missing += r.missing;
    truncated = truncated || r.truncated;
  }
  return { runs: allRuns, totalCount, missing, truncated };
}

function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过，不阻塞统计 */ }
  }
  return out;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}

async function main() {
  const days = Math.max(1, Number(arg('days', 14)) || 14);
  const repo = arg('repo', DEFAULT_REPO);
  const ledgerFile = arg('ledger', DEFAULT_LEDGER);
  const noNetwork = process.argv.includes('--no-network');
  const now = Date.now();

  const ledgerEntries = readLedger(ledgerFile);
  const dirtyStreak = dirtyWorktreeStreak(ledgerEntries);
  let fetched = { runs: [], totalCount: 0, missing: 0, truncated: false, error: '' };
  if (noNetwork) {
    fetched.error = '--no-network';
  } else {
    try {
      fetched = await fetchWindow({ repo, days, now });
    } catch (err) {
      fetched.error = err.message || String(err);
    }
  }

  const table = buildTable(fetched.runs, ledgerEntries, { days, now });
  const generatedAt = new Date(now).toISOString();
  const snapshot = {
    generatedAt,
    repo,
    window: { days, from: new Date(now - days * 86400000).toISOString(), to: generatedAt, tz: TZ },
    github: {
      available: !fetched.error,
      error: fetched.error,
      runsFetched: fetched.runs.length,
      totalCount: fetched.totalCount,
      missing: fetched.missing,
      truncated: fetched.truncated,
      note: '匿名 actions/runs 单日分页上限 1,000；超出部分只能计为缺失',
    },
    local: {
      ledger: path.relative(ROOT, ledgerFile).replace(/\\/g, '/'),
      entries: ledgerEntries.length,
      dirtyStreak,
      dirtyAlertThreshold: DIRTY_ALERT_STREAK,
      totals: table.localTotals,
    },
    rows: table.rows,
    workflowTotals: table.workflowTotals,
    sums: table.sums,
  };

  console.log(`管道操作底账 · ${repo} · 最近 ${days} 天（按 ${TZ} 分日）`);
  console.log(formatTable(table));
  console.log('');
  console.log(`合计：GH 运行 ${table.sums.workflowRuns} · Pages 构建 ${table.sums.pagesBuilds}`
    + ` · 本机采集 ${table.sums.localRuns}（另有 sync-only ${table.sums.localSyncOnly}）`
    + ` · 合计 ${table.sums.total} · clone 当量 ${table.sums.cloneEquivalent}`);
  if (Object.keys(table.workflowTotals).length) {
    console.log('按 workflow：' + Object.entries(table.workflowTotals)
      .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('，'));
  }
  if (Object.keys(table.localTotals.skipReasons).length) {
    console.log('本机跳过原因：' + Object.entries(table.localTotals.skipReasons)
      .map(([k, v]) => `${k}=${v}`).join('，'));
  }
  if (dirtyStreak >= DIRTY_ALERT_STREAK) {
    console.log(`⚠ 本机兜底已连续让路 ${dirtyStreak} 轮（因脏工作区，约 ${dirtyStreak * 2} 小时）`
      + '：站点更新不受影响（云端 Worker 每 15 分钟采集），但本机兜底目前是失效的，'
      + '需人工处理工作区未提交改动。');
  }
  if (fetched.error) {
    console.log(`⚠ GitHub 数据不可用：${fetched.error}（本机台账仍已统计）`);
  } else if (fetched.missing > 0) {
    console.log(`⚠ GH 缺失：total=${fetched.totalCount}，已取=${fetched.runs.length}，缺 ${fetched.missing}`
      + (fetched.truncated ? '（触发匿名 1,000 条上限）' : ''));
  }
  console.log('说明：clone 当量 = GH 运行 + Pages 构建（1 运行 ≈ 1 clone）；本机 fetch 不计；'
    + 'Traffic 需 token，脚本不拉。');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `ops-stats-${dayKey(generatedAt)}.json`);
  fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`快照：${path.relative(ROOT, outFile).replace(/\\/g, '/')}`);
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((err) => {
    console.error('ops-stats 失败：', err.message || err);
    process.exitCode = 1;
  });
}
