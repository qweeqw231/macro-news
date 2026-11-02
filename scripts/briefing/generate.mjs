// scripts/briefing/generate.mjs
// 确定性早报入口：取数 → 候选 → 规则组装 → 原子落盘（本地 + 站点副本）→ 状态。
//
// 设计文档：docs/superpowers/specs/2026-11-02-briefing-resilience-design.md
//
// 用法：
//   node scripts/briefing/generate.mjs --date 2026-11-02
//   node scripts/briefing/generate.mjs --date 2026-11-02 --no-import
//   node scripts/briefing/generate.mjs --date 2026-11-02 --sync      # 先 pull 再生成
//   node scripts/briefing/generate.mjs --date 2026-11-02 --no-site   # 只写本地
//
// 退出码：0 成功 / 1 失败 / 2 锁被占用 / 124 硬超时

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  HARD_TIMEOUT_MS,
  acquireLock,
  addDays,
  atomicWriteText,
  beijingNow,
  buildBriefing,
  briefingMarkdown,
  checkBriefing,
  normalizeBriefingSource,
  readStatus,
  updateStatus,
} from './core.mjs';
import { buildCandidates } from '../news-db/brief-candidates.mjs';
import { importArchive } from '../news-db/import-archive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : dflt;
};
const flag = (name) => process.argv.includes('--' + name);
const num = (name, dflt) => {
  const v = Number(arg(name, dflt));
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const NOW = beijingNow();
const DATE = arg('date', NOW.date);
const DB = path.resolve(ROOT, arg('db', '.local/news.db'));
const ARCHIVE = path.resolve(ROOT, arg('archive', 'data/archive'));
const OUT = path.resolve(ROOT, arg('out', '.local/briefings'));
const SITE_OUT = path.resolve(ROOT, arg('site-out', 'data/briefings'));
const STATUS = path.resolve(ROOT, arg('status', 'data/_briefing-status.json'));
const LOCK = path.resolve(ROOT, arg('lock', '.local/briefing.lock'));
const CANDIDATES = num('candidates', 120);
const LIMIT = num('limit', 10);
const SYNC = flag('sync');
const NO_IMPORT = flag('no-import');
const NO_SITE = flag('no-site');
const NO_LOCK = flag('no-lock');
const FORCE = flag('force');
const QUIET = flag('quiet');

const log = (...a) => { if (!QUIET) console.log(...a); };
const started = Date.now();
const STARTED_ISO = beijingNow(started).iso;
let stage = 'start';
let exitCode = 0;
let candidates = 0;

function mark(patch) {
  return updateStatus(STATUS, DATE, { startedAt: STARTED_ISO, ...patch }, { now: Date.now() });
}

function fail(reason, code = 1) {
  exitCode = code;
  mark({
    status: code === 124 ? 'timeout' : 'failed',
    stage,
    endedAt: beijingNow().iso,
    exitCode: code,
    candidates,
    items: 0,
    reason,
    durationMs: Date.now() - started,
    generator: 'deterministic',
  });
  console.error(`[briefing] 失败（${stage}）：${reason}`);
  return code;
}

function syncArchives() {
  const script = path.join(ROOT, 'scripts', 'pull-remote.ps1');
  if (!fs.existsSync(script)) return 'pull-remote.ps1 不存在';
  const ps = process.platform === 'win32' ? 'powershell' : 'pwsh';
  const r = spawnSync(
    ps,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { cwd: ROOT, encoding: 'utf8', timeout: 5 * 60 * 1000 }
  );
  if (r.error) return `同步出错：${r.error.message}`;
  if (r.status !== 0) return `同步退出码 ${r.status}：${(r.stdout || r.stderr || '').slice(-200)}`;
  return '';
}

function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) return fail(`日期格式不对：${DATE}`);
  fs.mkdirSync(OUT, { recursive: true });
  if (!NO_SITE) fs.mkdirSync(SITE_OUT, { recursive: true });
  fs.mkdirSync(path.dirname(STATUS), { recursive: true });

  let lock = null;
  if (!NO_LOCK) {
    lock = acquireLock(LOCK);
    if (!lock.ok) {
      console.error(
        `[briefing] 另一个进程正在生成（pid ${lock.holder && lock.holder.pid}，` +
          `开始于 ${lock.holder && lock.holder.startedAt}），本次跳过`
      );
      return 2;
    }
  }

  // 进程内硬超时：到点直接写状态并退出（真正的兜底由 ensure 的 spawnSync timeout 负责）
  const watchdog = setTimeout(() => {
    try {
      mark({
        status: 'timeout',
        stage,
        endedAt: beijingNow().iso,
        exitCode: 124,
        candidates,
        items: 0,
        reason: '超过 15 分钟硬超时',
        durationMs: Date.now() - started,
        generator: 'deterministic',
      });
    } catch { /* ignore */ }
    process.exit(124);
  }, HARD_TIMEOUT_MS);

  try {
    const prev = readStatus(STATUS).days[DATE] || {};
    mark({
      status: 'running',
      stage: 'start',
      endedAt: '',
      exitCode: 0,
      candidates: 0,
      items: 0,
      reason: '',
      generator: 'deterministic',
      attempt: (Number(prev.attempt) || 0) + 1,
    });
    log(`[briefing] ${DATE} 开始（pid ${process.pid}）`);

    if (SYNC) {
      stage = 'sync';
      mark({ status: 'running', stage, attempt: (Number(prev.attempt) || 0) + 1 });
      const err = syncArchives();
      if (err) {
        log(`[briefing] 同步未成功，继续用本地数据：${err}`);
        mark({ status: 'running', stage, syncError: err });
      }
    }

    stage = 'import';
    mark({ status: 'running', stage, attempt: (Number(prev.attempt) || 0) + 1 });
    if (!NO_IMPORT) {
      const imp = importArchive({ dbFile: DB, archiveDir: ARCHIVE, quiet: true });
      log(`[briefing] 导入 archive：${imp.files} 天 / ${imp.total} 条（新增 ${imp.inserted}）`);
    }

    stage = 'select';
    mark({ status: 'running', stage, attempt: (Number(prev.attempt) || 0) + 1 });
    const cand = buildCandidates({
      dbFile: DB,
      from: addDays(DATE, -1),
      to: DATE,
      limit: CANDIDATES,
    });
    candidates = cand.candidates;
    if (!cand.items.length) {
      return fail('候选为空：新闻库可能没同步（先检查 MacroNews-Pull / import-archive）');
    }
    log(`[briefing] 候选 ${cand.candidates} 条 → 选中 ${cand.items.length} 条`);
    mark({ status: 'running', stage, candidates, attempt: (Number(prev.attempt) || 0) + 1 });

    stage = 'write';
    mark({ status: 'running', stage, candidates, attempt: (Number(prev.attempt) || 0) + 1 });
    const outFile = path.join(OUT, `${DATE}.json`);
    const siteFile = path.join(SITE_OUT, `${DATE}.json`);
    // 2.2.2：绝不覆盖已有的 AI 早报（规则版只用于“当天缺失”的兜底）
    const prevLocal = checkBriefing(outFile);
    if (!FORCE && prevLocal.complete) {
      let prevDoc = null;
      try { prevDoc = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* ignore */ }
      if (normalizeBriefingSource(prevDoc) === 'ai') {
        if (!NO_SITE && !checkBriefing(siteFile).complete) {
          atomicWriteText(siteFile, fs.readFileSync(outFile, 'utf8'));
        }
        mark({
          status: 'done', stage: 'done', endedAt: beijingNow().iso, exitCode: 0,
          candidates, items: prevLocal.items, reason: '已存在 AI 早报，未覆盖',
          durationMs: Date.now() - started, generator: 'existing', source: 'ai',
          attempt: (Number(prev.attempt) || 0) + 1,
        });
        log('[briefing] 已存在 AI 早报，跳过生成');
        return 0;
      }
    }
    const doc = buildBriefing({ date: DATE, candidates: cand.items, limit: LIMIT });
    const jsonText = JSON.stringify(doc, null, 2);
    const jsonFile = path.join(OUT, `${DATE}.json`);
    const mdFile = path.join(OUT, `${DATE}.md`);
    atomicWriteText(jsonFile, jsonText);
    atomicWriteText(mdFile, briefingMarkdown(doc));
    if (!NO_SITE) {
      atomicWriteText(path.join(SITE_OUT, `${DATE}.json`), jsonText);
    }

    stage = 'done';
    mark({
      status: 'done',
      stage,
      endedAt: beijingNow().iso,
      exitCode: 0,
      candidates,
      items: doc.items.length,
      reason: '',
      durationMs: Date.now() - started,
      generator: 'rule-v1',
      source: 'rule',
      attempt: (Number(prev.attempt) || 0) + 1,
    });
    log(
      `[briefing] 完成：${doc.items.length} 条 · ${((Date.now() - started) / 1000).toFixed(1)}s · ` +
        `${path.relative(ROOT, jsonFile)}${NO_SITE ? '' : ' + 站点副本'}`
    );
    return 0;
  } catch (e) {
    return fail(e && e.message ? e.message : String(e));
  } finally {
    clearTimeout(watchdog);
    if (lock && lock.ok) lock.release();
  }
}

process.exitCode = main();
