#!/usr/bin/env node
// scripts/capacity.mjs
// 容量周报（只读）：把「快撞线」变成可观测的数字。
//
// 为什么需要它（2026-11-15 容量分析结论）：
//   · 仓库体积增速 ≈ 站点内容增速 × 1.7（search.json / 当日归档每天被重写上百次）；
//   · Pages 构建曾打到 10 次/小时软上限，而运行次数统计里完全看不出体积；
//   · 现有 ops-stats.mjs 只数运行次数与 dirty 轮数，**不看任何体积指标**
//     ⇒ 仓库从 97 MiB 涨到 700 MiB 的全过程不会有任何告警。
//
// 输出：
//   1) 终端一张表；
//   2) .local/metrics/capacity-<YYYY-Www>.json（本机台账，gitignore，不提交）；
//   3) 任一指标到达红档时写 .local/metrics/capacity-alert.json（与 alert.json 同目录同风格）。
//
// 用法：
//   node scripts/capacity.mjs                 # 立刻跑一次（写本周快照并打印趋势）
//   node scripts/capacity.mjs --force         # 同上，忽略「本周已跑过」的节流
//   node scripts/capacity.mjs --weekly        # 周节流：只在周一 09:00 之后、且本周还没跑过时才执行
//                                             #   其它时间立刻退出（约 0.1s，不联网、不写盘）
//   node scripts/capacity.mjs --fast          # 跳过 clone 包实测（省约 40 秒，用 size-pack 近似）
//   node scripts/capacity.mjs --no-net        # 完全离线：不调 GitHub API / Cloudflare API
//
// 验证周节流（伪造"现在"）：
//   $env:CAPACITY_FAKE_NOW='2026-11-18T10:00:00+08:00'; node scripts/capacity.mjs --weekly   # 周三 → 跳过
//   $env:CAPACITY_FAKE_NOW='2026-11-16T08:10:00+08:00'; node scripts/capacity.mjs --weekly   # 周一 08:10 → 跳过
//   $env:CAPACITY_FAKE_NOW='2026-11-16T09:10:00+08:00'; node scripts/capacity.mjs --weekly   # 周一 09:10 → 执行
//
// 触发方式（二选一）：
//   A. 手动：上面的命令；
//   B. 挂到既有本机定时任务：在 MacroNews-Collect 的每轮命令后追加
//        node scripts/capacity.mjs --weekly
//      它平时立即退出（不产生网络与磁盘写），只在周一 09:00 后第一次调用时真正执行。
//
// 只读保证：不写 data/、不写仓库、不提交；所有产物都在 .local/metrics/。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '.local', 'metrics');
const ALERT_FILE = path.join(OUT_DIR, 'capacity-alert.json');
const REPO = process.env.CAPACITY_REPO || 'qweeqw231/macro-news';
const API = 'https://api.github.com';
const TZ = 'Asia/Shanghai';

const argv = new Set(process.argv.slice(2));
const FORCE = argv.has('--force');
const WEEKLY = argv.has('--weekly');
const FAST = argv.has('--fast');
const NO_NET = argv.has('--no-net');

// 便于验证周节流（伪造"现在"）：
//   CAPACITY_FAKE_NOW=2026-11-16T09:10:00+08:00 node scripts/capacity.mjs --weekly
const FAKE_NOW = process.env.CAPACITY_FAKE_NOW ? new Date(process.env.CAPACITY_FAKE_NOW) : null;
const NOW = () => (FAKE_NOW && !Number.isNaN(FAKE_NOW.getTime()) ? FAKE_NOW : new Date());

const MIB = 1048576;

// ── 阈值（来源：2026-11-15 容量预案 §5.1）────────────────────────────────
// amber = 开始准备（写方案、跑对照，不动线上）；red = 开始执行（有窗口期）
const LIMITS = {
  repo_mib: { amber: 500, red: 700, hard: 1024, label: '仓库体积(API)' },
  site_mb: { amber: 500, red: 700, hard: 1024, label: '站点发布体积' },
  pack_mib: { amber: 150, red: 250, hard: null, label: 'clone 包' },
  // 2026-11-22：站点已改用自定义 Actions 部署（build_type: workflow），GitHub Pages
  // 「分支构建 10 次/小时」的软上限不再适用（官方：custom workflow 不受该限制）。
  // 这里的阈值改为「重复部署/触发风暴」监测：15 分钟定时节奏 = 4 次/h，
  // 黄 24（6×）、红 36（9×）只用于发现异常重复，不再代表配额。
  builds_per_hour_6h: { amber: 24, red: 36, hard: null, label: '构建次数/小时(近6h峰值)' },
  worker_req_day: { amber: 50000, red: 80000, hard: 100000, label: 'Worker 请求/天' },
  search_gz_mib: { amber: 4.5, red: 6, hard: null, label: 'search.json(gzip)' },
};

// ── 小工具 ────────────────────────────────────────────────────────────────
function git(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * MIB, ...opts,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

function gitBuf(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, maxBuffer: 64 * MIB, ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败`);
  return r.stdout;
}

/** HEAD 里某个路径的 blob 字节（不受工作区抖动影响） */
function blobSize(relPath) {
  const out = spawnSync('git', ['cat-file', '-s', `HEAD:${relPath}`], { cwd: ROOT, encoding: 'utf8' });
  if (out.status !== 0) return null;
  const n = Number(out.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

function blobBuffer(relPath) {
  const out = spawnSync('git', ['cat-file', 'blob', `HEAD:${relPath}`], { cwd: ROOT, maxBuffer: 64 * MIB });
  return out.status === 0 ? out.stdout : null;
}

/**
 * 部署期生成、不在 HEAD 的检索索引（2.33.1 起 search.json / search-history 不进 git）。
 * 这些文件由 scripts/build-search.mjs 在 Pages 部署时现算并打进 artifact，
 * 所以「站点发布体积」必须把它们算进去，否则会低估约 55 MiB。
 */
function generatedIndexFiles() {
  const hotPath = path.join(ROOT, 'data', 'search.json');
  let hot = null;
  try {
    const st = fs.statSync(hotPath);
    if (st.isFile()) hot = { path: 'data/search.json', size: st.size };
  } catch { /* 还没生成 */ }

  const shardDir = path.join(ROOT, 'data', 'search-history');
  let shards = [];
  try {
    shards = fs.readdirSync(shardDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ path: `data/search-history/${f}`, size: fs.statSync(path.join(shardDir, f)).size }));
  } catch { /* 还没生成 */ }

  const files = [...(hot ? [hot] : []), ...shards];
  return { hot, shards, files, bytes: files.reduce((a, r) => a + r.size, 0) };
}

/** HEAD 全量文件清单：[{ path, size }] */
function treeFiles() {
  const out = git(['ls-tree', '-r', '-l', 'HEAD']);
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [meta, p] = line.split('\t');
    if (!meta || !p) continue;
    const parts = meta.split(/\s+/);
    const size = Number(parts[3]);
    if (!Number.isFinite(size)) continue;
    rows.push({ path: p, size });
  }
  return rows;
}

const sumWhere = (rows, pred) => rows.filter(pred).reduce((a, r) => a + r.size, 0);

/** 等价「一次 clone 要下多少字节」：rev-list | pack-objects（与主报告同口径） */
function clonePackBytes(rev = 'HEAD') {
  return new Promise((resolve, reject) => {
    const p1 = spawn('git', ['rev-list', '--objects', rev], { cwd: ROOT });
    const p2 = spawn('git', ['pack-objects', '--stdout', '--quiet', '--delta-base-offset'], { cwd: ROOT });
    let n = 0;
    p1.stdout.pipe(p2.stdin);
    p2.stdout.on('data', (d) => { n += d.length; });
    p2.on('error', reject);
    p1.on('error', reject);
    p2.on('close', (code) => (code === 0 ? resolve(n) : reject(new Error(`pack-objects exit ${code}`))));
  });
}

/** git 本机对象库的 size-pack（--fast 时的近似值） */
function sizePackBytes() {
  const out = git(['count-objects', '-v']);
  const m = out.match(/size-pack:\s*(\d+)/);
  return m ? Number(m[1]) * 1024 : 0;
}

function tzDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t)?.value || '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

function isoWeek(d = NOW()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(week).padStart(2, '0')}`;
}

async function gh(pathname) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'macro-news-capacity' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  // 周报是低频任务，偶发 fetch terminated 不该让整份报告缺一半指标 ⇒ 重试一次
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(`${API}${pathname}`, { headers });
      if (!res.ok) throw new Error(`GitHub ${pathname} → ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

// ── 采集各项指标 ──────────────────────────────────────────────────────────
async function collect() {
  const m = { at: NOW().toISOString(), week: isoWeek(), notes: [] };

  // 1) 站点发布体积 = HEAD 里的发布文件 + 部署期生成的检索索引（不进 git）
  //    2.33.1 起 search.json / search-history 只在 Pages 部署时现算并打进 artifact，
  //    只数 HEAD 会低估约 55 MiB。这里按「artifact 展开后」的真实体积统计。
  const files = treeFiles();
  const trackedBytes = files.reduce((a, r) => a + r.size, 0);
  const trackedDataBytes = sumWhere(files, (r) => r.path.startsWith('data/'));
  const gen = generatedIndexFiles();

  m.site_tracked_mib = round(trackedBytes / MIB);
  m.site_generated_mib = gen.files.length ? round(gen.bytes / MIB) : null;
  m.site_mb = round((trackedBytes + gen.bytes) / MIB);
  m.data_tracked_mb = round(trackedDataBytes / MIB);
  m.data_mb = round((trackedDataBytes + gen.bytes) / MIB);
  m.kline_mb = round(sumWhere(files, (r) => r.path.startsWith('data/kline/')) / MIB);
  m.kline_min_mb = round(sumWhere(files, (r) => r.path.startsWith('data/kline/min/')) / MIB);
  m.history_mb = round(sumWhere(files, (r) => r.path.startsWith('data/history/')) / MIB);
  m.archive_mb = round(sumWhere(files, (r) => r.path.startsWith('data/archive/')) / MIB);
  m.snapshots_mb = round(sumWhere(files, (r) => r.path.startsWith('data/snapshots/')) / MIB);
  m.files_tracked = files.length;
  m.files_generated = gen.files.length;
  m.files = files.length + gen.files.length;
  if (!gen.files.length) {
    m.notes.push('检索索引未生成：site_mb 只含 git 树，低估约 55 MiB；先跑 node scripts/build-search.mjs');
  }

  // 2) search.json：原始 + gzip（体积代价在 gzip，前端拿到的就是它）
  //    优先读工作区里的生成产物（部署时打进去的那份），没有再回落到 HEAD。
  let sj = gen.hot ? fs.readFileSync(path.join(ROOT, 'data', 'search.json')) : null;
  let sjSource = gen.hot ? 'generated' : null;
  if (!sj) {
    sj = blobBuffer('data/search.json');
    if (sj) sjSource = 'git';
  }
  if (sj) {
    m.search_source = sjSource;
    m.search_mib = round(sj.length / MIB);
    m.search_gz_mib = round(zlib.gzipSync(sj, { level: 6 }).length / MIB);
    try { m.search_entries = JSON.parse(sj.toString('utf8')).items?.length ?? null; } catch { m.search_entries = null; }
  } else {
    m.notes.push('data/search.json 既不在工作区也不在 git（检索索引未生成）');
  }

  // 3) 历史检索分片（2.22.0，2.33.1 起部署期生成）：同样优先工作区产物
  const shardRows = gen.shards.length
    ? gen.shards
    : files.filter((r) => r.path.startsWith('data/search-history/') && r.path.endsWith('.json'));
  if (shardRows.length) {
    m.shards = shardRows.length;
    m.shards_source = gen.shards.length ? 'generated' : 'git';
    m.shards_mb = round(shardRows.reduce((a, r) => a + r.size, 0) / MIB);
    m.shard_max_mb = round(Math.max(...shardRows.map((r) => r.size)) / MIB);
  }

  // 各项数字的口径，随快照一起落盘，避免下一个人再把 site_mb 当成「git 树体积」
  m.definitions = {
    site_mb: 'HEAD 发布文件 + 部署期生成的检索索引（artifact 展开体积，MiB）',
    site_tracked_mib: 'HEAD 树里的发布文件（git 跟踪部分）',
    site_generated_mib: 'data/search.json + data/search-history/*，部署时生成、不进 git',
    data_mb: 'data/ 发布体积（HEAD 中的 data + 生成的检索索引）',
    data_tracked_mb: 'HEAD 中 data/ 的体积（不含生成索引）',
    repo_mib: 'GitHub API 仓库 size（含全部历史）',
    pack_mib: 'clone 包（rev-list --objects | pack-objects，与主报告同口径）',
    search_mib: 'search.json 原始体积（优先工作区生成产物）',
    search_gz_mib: 'search.json gzip 体积（前端实际传输）',
    builds_per_hour_6h: '自定义 Actions 部署不受 Pages 分支构建 10 次/h 软限制；黄 24 / 红 36 次/h 仅用于发现重复部署/触发风暴（15 分钟定时节奏为 4 次/h）',
    deploy_dupe_24h: '近 24h 同一 head_sha 被部署多次的统计；extra_runs 为可省的重复构建',
  };

  // 4) clone 包
  if (FAST) {
    m.pack_mib = round(sizePackBytes() / MIB);
    m.pack_note = 'size-pack 近似（--fast；含不可达对象，实测偏高约 30%）';
  } else {
    try {
      m.pack_mib = round((await clonePackBytes('HEAD')) / MIB);
      m.pack_note = 'pack-objects 实测';
    } catch (e) {
      m.pack_mib = round(sizePackBytes() / MIB);
      m.pack_note = `降级为 size-pack：${e.message}`;
    }
  }

  // 5) GitHub：仓库登记体积 + 构建频率 + 部署健康
  if (!NO_NET) {
    try {
      const info = await gh(`/repos/${REPO}`);
      m.repo_mib = round((info.size || 0) / 1024);
      m.pushed_at = info.pushed_at || '';
    } catch (e) {
      m.notes.push(`仓库体积获取失败：${e.message}`);
    }
    try {
      const runs = [];
      for (let p = 1; p <= 4; p++) {
        const page = await gh(`/repos/${REPO}/actions/runs?per_page=100&page=${p}`);
        runs.push(...(page.workflow_runs || []));
        if ((page.workflow_runs || []).length < 100) break;
      }
      // 分支构建叫「pages build and deployment」，Actions 部署后是本仓库的 pages.yml
      const isPages = (r) => r.name === 'pages build and deployment' || /pages\.ya?ml$/i.test(r.path || '');
      const pagesRuns = runs.filter(isPages);
      const byHour = new Map();
      const byDay = new Map();
      for (const r of pagesRuns) {
        const h = (r.created_at || '').slice(0, 13);
        const d = tzDay(r.created_at);
        if (h) byHour.set(h, (byHour.get(h) || 0) + 1);
        if (d) byDay.set(d, (byDay.get(d) || 0) + 1);
      }
      m.builds_per_hour = byHour.size ? Math.max(...byHour.values()) : null;
      // 判级用「近 6 小时峰值」：切换部署方式的那个小时会同时出现旧分支构建与新部署，
      // 24h 峰值会被这类一次性重叠抬高（实测 16 次/h），不代表当前状态。
      const cut6 = NOW().getTime() - 6 * 3600 * 1000;
      const recentBuckets = [...byHour.entries()]
        .filter(([h]) => new Date(`${h}:00:00Z`).getTime() >= cut6)
        .map(([, c]) => c);
      m.builds_per_hour_6h = recentBuckets.length ? Math.max(...recentBuckets) : null;
      if (m.builds_per_hour_6h == null) {
        // 近 6 小时没有构建记录（空闲期，或用 CAPACITY_FAKE_NOW 伪造时间做验证）时，
        // 回落到 24h 峰值，避免指标整行缺失看不出状态
        m.builds_per_hour_6h = m.builds_per_hour;
        m.notes.push('近 6h 无构建记录，构建峰值回落为 24h 峰值');
      }
      m.builds_per_hour_mean = byHour.size ? round(pagesRuns.length / byHour.size) : null;
      m.builds_per_day = byDay.size ? round(pagesRuns.length / byDay.size) : null;
      m.builds_sampled_hours = byHour.size;

      // 重复部署：同一 head_sha 在近 24h 被跑多次。guard 只比对「最近一次已完成的部署」，
      // push 与 schedule / workflow_dispatch 在几分钟内抢同一 SHA 时会双双放行（实测 3 组）。
      // 这些是可直接省掉的构建，单独计数，供判断构建量是否真的偏高。
      const sinceDup = NOW().getTime() - 24 * 3600 * 1000;
      const recent24 = pagesRuns.filter((r) => new Date(r.created_at).getTime() >= sinceDup);
      const bySha = new Map();
      for (const r of recent24) bySha.set(r.head_sha, (bySha.get(r.head_sha) || 0) + 1);
      const ev24 = {};
      for (const r of recent24) ev24[r.event || 'unknown'] = (ev24[r.event || 'unknown'] || 0) + 1;
      m.deploy_dupe_24h = {
        runs: recent24.length,
        distinct_commits: bySha.size,
        dup_commits: [...bySha.values()].filter((n) => n > 1).length,
        extra_runs: recent24.length - bySha.size,
        ratio: recent24.length ? round((recent24.length - bySha.size) / recent24.length) : null,
        by_event: ev24,
      };
      if (m.deploy_dupe_24h.extra_runs > 0) {
        m.notes.push(
          `近24h 同提交重复部署 ${m.deploy_dupe_24h.extra_runs} 次`
            + `（${(m.deploy_dupe_24h.ratio * 100).toFixed(1)}%），多为 push 与 schedule/dispatch 抢同一 SHA；`
            + `触发构成 ${Object.entries(ev24).map(([k, v]) => `${k} ${v}`).join(' / ')}`
        );
      }

      // 部署健康：最近一次 pages 运行的结论与耗时
      const last = pagesRuns.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];
      if (last) {
        const sec = (new Date(last.updated_at) - new Date(last.run_started_at)) / 1000;
        m.last_deploy = {
          name: last.name, conclusion: last.conclusion, event: last.event,
          at: last.created_at, duration_s: Number.isFinite(sec) ? Math.round(sec) : null,
          run_url: last.html_url,
        };
        const recent = pagesRuns.slice(0, 10);
        m.deploy_fail_in_10 = recent.filter((r) => r.conclusion && r.conclusion !== 'success').length;
        // 近 24h 构建失败数（cancelled 也算：10 次/小时超限时的表现就是被取消）
        const since = NOW().getTime() - 24 * 3600 * 1000;
        m.builds_fail_24h = pagesRuns.filter((r) => r.conclusion && r.conclusion !== 'success'
          && new Date(r.created_at).getTime() >= since).length;
      }
    } catch (e) {
      m.notes.push(`Actions 运行获取失败：${e.message}`);
    }
  }

  // 6) Cloudflare Worker 调用量（可选：需要 CF_API_TOKEN + CF_ACCOUNT_ID）
  if (!NO_NET && process.env.CF_API_TOKEN && process.env.CF_ACCOUNT_ID) {
    try {
      const q = `query { viewer { accounts(filter:{accountTag:"${process.env.CF_ACCOUNT_ID}"}) { workersInvocationsAdaptive(limit:7, filter:{datetime_geq:"${new Date(Date.now() - 7 * 864e5).toISOString()}"}) { sum { requests } dimensions { datetime } } } } }`;
      const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      const j = await res.json();
      const rows = j?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
      const total = rows.reduce((a, r) => a + (r.sum?.requests || 0), 0);
      m.worker_req_day = rows.length ? round(total / rows.length) : null;
    } catch (e) {
      m.notes.push(`Worker 调用量获取失败：${e.message}`);
    }
  } else if (!NO_NET) {
    m.worker_req_day = null;
    m.notes.push('Worker 调用量未采集（未设置 CF_API_TOKEN / CF_ACCOUNT_ID）');
  }

  return m;
}

// ── 趋势与判级 ────────────────────────────────────────────────────────────
const round = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

// 周节流状态：记录「本周是否已经真正跑过」。用状态文件而不是「快照文件是否存在」，
// 因为手动 --force 也会产出快照，两者语义不同。
const STATE_FILE = path.join(OUT_DIR, 'capacity-state.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function writeState(week, at) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify({ lastRunWeek: week, lastRunAt: at })}\n`, 'utf8');
}

function fmtWeekday(d) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, weekday: 'long' }).format(d);
}

function prevSnapshot() {
  if (!fs.existsSync(OUT_DIR)) return null;
  const files = fs.readdirSync(OUT_DIR)
    .filter((f) => /^capacity-\d{4}-W\d{2}\.json$/.test(f))
    .sort();
  const cur = `capacity-${isoWeek()}.json`;
  const older = files.filter((f) => f !== cur);
  if (!older.length) return null;
  try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, older[older.length - 1]), 'utf8')); } catch { return null; }
}

function withTrend(cur, prev) {
  if (!prev) return cur;
  const days = Math.max(0.5, (new Date(cur.at) - new Date(prev.at)) / 864e5);
  const perMonth = (k) => (Number.isFinite(cur[k]) && Number.isFinite(prev[k])
    ? round(((cur[k] - prev[k]) / days) * 30) : null);
  // 间隔不足 7 天时不给「月化」：一次性回补（新增标的、历史补齐）会让单日增量
  // 被放大成荒谬的月速率（实测把一次性 73 MB 回补算成 +2485/月）。
  const trustworthy = days >= 7;
  // 一周内站点体积跳增 >50% 基本只可能是一次性台阶（历史回补、分片重建、新增数据目录），
  // 直接年化会把 7 天窗口放大成荒谬的月速（2026-11-22 实测：+84 MiB/7.1 天 → 353/月，
  // 再算出「距 1 GB 只剩 2.2 个月」，与实际稳态 33 MiB/月 矛盾）。这种情况不出月化与 ETA。
  const siteJump = prev.site_mb > 0 ? (cur.site_mb - prev.site_mb) / prev.site_mb : 0;
  const stepSuspected = Number.isFinite(siteJump) && siteJump > 0.5;
  cur.trend = {
    since: prev.at, days: round(days), trustworthy,
    repo_mib_per_month: trustworthy && !stepSuspected ? perMonth('repo_mib') : null,
    site_mb_per_month: trustworthy && !stepSuspected ? perMonth('site_mb') : null,
    // clone 包只在与上次同为「pack-objects 实测」时才比较，避免 --fast 的 size-pack 混入
    pack_mib_per_month: trustworthy && prev.pack_note === cur.pack_note ? perMonth('pack_mib') : null,
    data_mb_per_month: trustworthy && !stepSuspected ? perMonth('data_mb') : null,
    one_time_suspected: stepSuspected || undefined,
  };
  if (stepSuspected) {
    cur.notes.push(`站点体积较上次跳增 ${(siteJump * 100).toFixed(0)}%，判为一次性台阶；本期不出月化与 ETA`);
  }
  if (!trustworthy) {
    cur.notes.push(`上次快照仅 ${cur.trend.days} 天前，间隔不足 7 天，本期不出月化速率`);
  }
  return cur;
}

function grade(m) {
  const out = [];
  for (const [key, lim] of Object.entries(LIMITS)) {
    const v = m[key];
    if (!Number.isFinite(v)) continue;
    const level = v >= lim.red ? 'red' : v >= lim.amber ? 'amber' : 'ok';
    let eta = null;
    const rateKey = { repo_mib: 'repo_mib_per_month', site_mb: 'site_mb_per_month', pack_mib: 'pack_mib_per_month' }[key];
    const rate = rateKey ? m.trend?.[rateKey] : null;
    if (lim.hard && Number.isFinite(rate) && rate > 0) {
      eta = round(Math.max(0, (lim.hard - v) / rate));
    }
    out.push({ key, label: lim.label, value: v, amber: lim.amber, red: lim.red, hard: lim.hard, level, months_to_hard: eta });
  }
  return out;
}

// ── 输出 ──────────────────────────────────────────────────────────────────
function printTable(m, rows) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n容量周报 ${m.week}  ${m.at}`);
  console.log('-'.repeat(92));
  console.log(`${pad('指标', 22)}${pad('当前', 12)}${pad('阈值 黄/红', 14)}${pad('月化', 10)}状态`);
  console.log('-'.repeat(92));
  const g = Object.fromEntries(rows.map((r) => [r.key, r]));
  const line = (key, value, unit, extra = '') => {
    const r = g[key];
    const th = r ? (r.hard ? `${r.amber}/${r.red}/${r.hard}` : `${r.amber}/${r.red}`) : '-';
    const mark = r ? { ok: 'OK', amber: '黄·准备', red: '红·执行' }[r.level] : '';
    console.log(`${pad(r?.label || LIMITS[key]?.label || key, 22)}${pad(`${value ?? '-'} ${unit}`, 12)}${pad(th, 14)}${pad(extra, 10)}${mark}`);
  };
  line('repo_mib', m.repo_mib, 'MiB', m.trend?.repo_mib_per_month != null ? `+${m.trend.repo_mib_per_month}/月` : '');
  line('site_mb', m.site_mb, 'MiB', m.trend?.site_mb_per_month != null ? `+${m.trend.site_mb_per_month}/月` : '');
  line('pack_mib', m.pack_mib, 'MiB', m.trend?.pack_mib_per_month != null ? `+${m.trend.pack_mib_per_month}/月` : '');
  line('builds_per_hour_6h', m.builds_per_hour_6h, '次/h', `24h峰 ${m.builds_per_hour ?? '-'}`);
  if (m.deploy_dupe_24h) {
    const d = m.deploy_dupe_24h;
    console.log(`${pad('重复部署(24h)', 22)}${pad(`${d.extra_runs} 次`, 12)}${pad('-', 14)}`
      + `${pad(`${d.runs} 跑 / ${d.distinct_commits} 提交`, 10)}${d.extra_runs > 0 ? '可省' : 'OK'}`);
  }
  console.log(`${pad('构建失败(24h)', 22)}${pad(`${m.builds_fail_24h ?? '-'} 次`, 12)}${pad('-', 14)}${pad('', 10)}${(m.builds_fail_24h || 0) > 0 ? '需关注' : 'OK'}`);
  line('worker_req_day', m.worker_req_day, '次/天', '');
  line('search_gz_mib', m.search_gz_mib, 'MiB', `${m.search_entries ?? '-'} 条`);
  console.log('-'.repeat(92));
  console.log(`分项  data ${m.data_mb} MiB（kline ${m.kline_mb}，其中分钟线 ${m.kline_min_mb}；`
    + `history ${m.history_mb}；archive ${m.archive_mb}；snapshots ${m.snapshots_mb}）`);
  console.log('口径  构建次数：自定义 Actions 部署不受 10 次/h 软限制；'
    + '黄 24 / 红 36 次/h 仅用于发现重复部署/触发风暴（定时节奏 4 次/h）');
  if (m.site_generated_mib != null) {
    console.log(`口径  site_mb = HEAD ${m.site_tracked_mib} + 生成索引 ${m.site_generated_mib} MiB`
      + `（artifact 展开；data = ${m.data_tracked_mb} + ${m.site_generated_mib}；`
      + `search 来源 ${m.search_source || '-'}，分片来源 ${m.shards_source || '-'}）`);
  } else {
    console.log('口径  site_mb 仅含 HEAD：检索索引未生成，低估约 55 MiB');
  }
  if (m.shards) console.log(`分片  search-history ${m.shards} 片 / ${m.shards_mb} MB，最大单片 ${m.shard_max_mb} MB`);
  if (m.last_deploy) {
    console.log(`部署  最近一次「${m.last_deploy.name}」${m.last_deploy.conclusion}，`
      + `${m.last_deploy.duration_s}s，${m.last_deploy.at}（近 10 次失败 ${m.deploy_fail_in_10}）`);
  }
  for (const r of rows.filter((x) => x.months_to_hard != null)) {
    console.log(`预计   ${r.label} 距硬上限还有约 ${r.months_to_hard} 个月`);
  }
  for (const n of m.notes) console.log(`备注   ${n}`);
  console.log('');
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const now = NOW();
  const week = isoWeek(now);
  const outFile = path.join(OUT_DIR, `capacity-${week}.json`);

  if (WEEKLY && !FORCE) {
    const state = readState();
    const isMonday = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, weekday: 'short' }).format(now) === 'Mon';
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now));
    if (state.lastRunWeek === week) {
      console.log(`容量周报：${week} 本周已跑过（${state.lastRunAt}），跳过。`);
      return;
    }
    if (!isMonday) {
      console.log(`容量周报：今天是${fmtWeekday(now)}（${week}），非周一，跳过。`);
      return;
    }
    if (hour < 9) {
      console.log(`容量周报：今天周一 ${String(hour).padStart(2, '0')} 点，未到 09:00，跳过。`);
      return;
    }
  }

  const cur = await collect();
  const prev = prevSnapshot();
  withTrend(cur, prev);
  const rows = grade(cur);
  cur.grades = rows;

  // 只保留最近 12 周的快照，避免 .local 无限增长
  const all = fs.readdirSync(OUT_DIR).filter((f) => /^capacity-\d{4}-W\d{2}\.json$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 12))) {
    if (f !== path.basename(outFile)) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  fs.writeFileSync(outFile, JSON.stringify(cur, null, 1) + '\n', 'utf8');
  writeState(cur.week, cur.at);

  const red = rows.filter((r) => r.level === 'red');
  const amber = rows.filter((r) => r.level === 'amber');
  const alert = {
    updatedAt: cur.at,
    kind: 'capacity',
    active: red.length > 0,
    red: red.map((r) => `${r.label}=${r.value}`),
    amber: amber.map((r) => `${r.label}=${r.value}`),
    note: red.length
      ? '容量已达红档：按预案开始执行迁移（见 outputs/capacity-limit-runbook.md）'
      : amber.length ? '容量进入黄档：开始准备，勿动线上' : '容量正常',
  };
  fs.writeFileSync(ALERT_FILE, JSON.stringify(alert) + '\n', 'utf8');

  printTable(cur, rows);
  console.log(`快照 → ${path.relative(ROOT, outFile)}`);
  if (red.length) console.log(`⚠ 红档：${red.map((r) => r.label).join('、')}`);
  else if (amber.length) console.log(`⚠ 黄档：${amber.map((r) => r.label).join('、')}`);
}

main().catch((e) => {
  console.error('capacity.mjs 失败：', e.message);
  process.exitCode = 1;
});
