#!/usr/bin/env node
// scripts/news-volume-stats.mjs
// 2.11.0：当日新闻「真实体量」统计（只读，不写 data/、不提交）。
//
// 为什么需要它：满载（历史上是 800）之后 selectDayItems 会按时间倒序把最早的条目挤掉，
// 日志里只有 +N，看不出删了多少。于是「一天到底需要多少条」在满载后就不可见了。
// 本脚本从 git 历史里把每天的归档版本全部读一遍，回答四个问题：
//
//   trueTotal   该日文件在「git 历史所有版本」里的 id 并集（≈ 当天真实出现过的条目数）
//   current     当前文件条数
//   peak        历史上出现过的最大条数（用来判断有没有触顶）
//   maxCand     单轮最大候选量（优先取 _last-run.json 的 news.candidates，2.11.0 起才有；
//               没有时用「相邻两版 id 并集」近似）
//   触顶         peak >= 当时的 cap 就说明这天被截断过
//
// 用法：
//   node scripts/news-volume-stats.mjs            # 最近 7 个归档日
//   node scripts/news-volume-stats.mjs --days 30
//   node scripts/news-volume-stats.mjs --all
//   node scripts/news-volume-stats.mjs --json     # 只输出 JSON
//
// 只读：写 `.local/metrics/news-volume-<date>.json`，不进版本库。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DAY_TOTAL } from '../src/quota.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = path.join(ROOT, 'data/archive');
const OUT_DIR = path.join(ROOT, '.local/metrics');
const CAP_HISTORY = 800; // 2.4.21 ~ 2.10.x 的当日上限；2.11.0 起为 DAY_TOTAL

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const ALL = process.argv.includes('--all');
const JSON_ONLY = process.argv.includes('--json');
const DAYS = ALL ? Infinity : Number(arg('days', 7)) || 7;

const git = (args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });

/** 解析 `git cat-file --batch` 的流式输出：header 行 + size 字节正文 */
function parseBatch(buf) {
  const out = [];
  let p = 0;
  while (p < buf.length) {
    const nl = buf.indexOf(10, p);
    if (nl < 0) break;
    const header = buf.subarray(p, nl).toString('utf8');
    p = nl + 1;
    if (/ missing$| ambiguous$/.test(header)) continue;
    const size = Number(header.split(' ')[2]);
    out.push(buf.subarray(p, p + size).toString('utf8'));
    p += size + 1;
  }
  return out;
}

/** 读某天所有历史版本（旧 → 新） */
function readVersions(day) {
  const rel = `data/archive/${day}.json`;
  const shas = git(['log', '--format=%H', '--', rel]).trim().split('\n').filter(Boolean).reverse();
  if (!shas.length) return { shas: [], docs: [] };
  const res = spawnSync('git', ['-C', ROOT, 'cat-file', '--batch'], {
    input: shas.map((s) => `${s}:${rel}`).join('\n') + '\n',
    maxBuffer: 1 << 30,
  });
  if (res.status !== 0) return { shas, docs: [] };
  return { shas, docs: parseBatch(res.stdout) };
}

/** 从 _last-run.json 历史里取每个新闻日的最大候选量（2.11.0 起才有 news 字段） */
function maxCandidatesFromRuns() {
  const map = new Map(); // day -> { candidates, evicted, cap, at }
  let shas = [];
  try {
    shas = git(['log', '--format=%H', '--', 'data/_last-run.json']).trim().split('\n').filter(Boolean);
  } catch { return map; }
  if (!shas.length) return map;
  const res = spawnSync('git', ['-C', ROOT, 'cat-file', '--batch'], {
    input: shas.map((s) => `${s}:data/_last-run.json`).join('\n') + '\n',
    maxBuffer: 1 << 28,
  });
  if (res.status !== 0) return map;
  for (const text of parseBatch(res.stdout)) {
    let doc;
    try { doc = JSON.parse(text); } catch { continue; }
    for (const d of doc.news?.days || []) {
      const cur = map.get(d.day) || { candidates: 0, evicted: 0, cap: doc.news.cap, at: doc.startedAt };
      if (d.candidates > cur.candidates) {
        cur.candidates = d.candidates;
        cur.evicted = d.evicted;
        cur.cap = doc.news.cap || cur.cap;
        cur.at = doc.startedAt;
      }
      map.set(d.day, cur);
    }
  }
  return map;
}

const files = fs.readdirSync(ARCHIVE)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort()
  .slice(-DAYS);

const runStats = maxCandidatesFromRuns();
const rows = [];

for (const f of files) {
  const day = f.replace('.json', '');
  const { docs } = readVersions(day);
  if (!docs.length) continue;
  const lastSeen = new Map();
  let peak = 0;
  let prev = null;
  let maxCandArch = 0;
  for (const text of docs) {
    let doc;
    try { doc = JSON.parse(text); } catch { continue; }
    const items = doc.items || [];
    peak = Math.max(peak, items.length);
    if (prev) {
      // 相邻两版：候选 ≈ |上一版 ∪ 本版|（被淘汰的 id 在上一版里，新增的在本版里）
      const ids = new Set(items.map((x) => x.id));
      let union = items.length;
      for (const it of prev) if (!ids.has(it.id)) union++;
      maxCandArch = Math.max(maxCandArch, union);
    }
    for (const it of items) lastSeen.set(it.id, it);
    prev = items;
  }
  const cur = JSON.parse(fs.readFileSync(path.join(ARCHIVE, f), 'utf8')).items || [];
  const run = runStats.get(day);
  // 上限取「当天实际生效的值」：_last-run.json 的 news.cap（2.11.0 起才有），
  // 更早的日子一律按 800 判——那时常量就是 800。
  const cap = run?.cap || CAP_HISTORY;
  rows.push({
    day,
    trueTotal: lastSeen.size,
    current: cur.length,
    lost: Math.max(0, lastSeen.size - cur.length),
    peak,
    maxCandidates: run ? Math.max(run.candidates, maxCandArch) : maxCandArch,
    candidateSource: run ? 'run' : 'arch',
    maxEvicted: run?.evicted ?? undefined,
    cap,
    hitCap: peak >= cap,
    versions: docs.length,
  });
}

const snap = {
  generatedAt: new Date().toISOString(),
  cap: DAY_TOTAL,
  days: rows,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(OUT_DIR, `news-volume-${stamp}.json`), JSON.stringify(snap, null, 2), 'utf8');

if (JSON_ONLY) {
  process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
} else {
  const pad = (v, n) => String(v).padStart(n);
  console.log('日期        唯一  当前  丢失  峰值  单轮最大候选(来源)   上限  触顶  版本');
  for (const r of rows) {
    console.log(
      `${r.day} ${pad(r.trueTotal, 5)} ${pad(r.current, 5)} ${pad(r.lost, 5)} ${pad(r.peak, 5)}   `
      + `${pad(r.maxCandidates, 5)}(${r.candidateSource})`.padEnd(20)
      + ` ${pad(r.cap, 5)}  ${r.hitCap ? '是' : '否'}  ${pad(r.versions, 4)}`
    );
  }
  const lost = rows.reduce((n, r) => n + r.lost, 0);
  const hit = rows.filter((r) => r.hitCap).length;
  console.log(`\n合计：${rows.length} 天，唯一条目 ${rows.reduce((n, r) => n + r.trueTotal, 0)}，丢失 ${lost}，触顶 ${hit} 天（当前上限 ${DAY_TOTAL}）`);
  console.log(`快照：.local/metrics/news-volume-${stamp}.json`);
}
