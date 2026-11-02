// scripts/briefing/prepare.mjs
// 2.3.0 第一段：确定性取数 → 候选 → 输入快照。**不生成摘要正文，不发布站点文件。**
//
// 设计文档：docs/superpowers/specs/2026-11-02-briefing-llm-pipeline-design.md
//
// 用法：
//   node scripts/briefing/prepare.mjs --date 2026-11-02
//   node scripts/briefing/prepare.mjs --date 2026-11-02 --force   # 重建快照（旧检查点作废）
//
// 产物：.local/runs/<date>/input.json + prompt.md（不进 git）
// 退出码：0 成功 / 1 失败 / 2 锁被占用

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireLock,
  atomicWriteText,
  beijingNow,
  readStatus,
  updateStatus,
} from './core.mjs';
import {
  prepareSnapshot,
  renderPrompt,
  runDirOf,
} from './pipeline.mjs';

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
const RUNS = path.resolve(ROOT, arg('runs', '.local/runs'));
const STATUS = path.resolve(ROOT, arg('status', 'data/_briefing-status.json'));
const DB = path.resolve(ROOT, arg('db', '.local/news.db'));
const ARCHIVE = path.resolve(ROOT, arg('archive', 'data/archive'));
const LIMIT = num('candidates', 120);
const FORCE = flag('force');
const NO_IMPORT = flag('no-import');
const NO_PROMPT = flag('no-prompt');
const NO_LOCK = flag('no-lock');
const QUIET = flag('quiet');

const log = (...a) => { if (!QUIET) console.error(...a); };

function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
    console.error(`[briefing] 日期格式不对：${DATE}`);
    return 1;
  }
  const runDir = runDirOf(RUNS, DATE);
  fs.mkdirSync(runDir, { recursive: true });
  let lock = null;
  if (!NO_LOCK) {
    lock = acquireLock(path.join(runDir, 'run.lock'));
    if (!lock.ok) {
      console.error(
        `[briefing] 另一个进程正在跑（pid ${lock.holder && lock.holder.pid}），本次跳过`
      );
      return 2;
    }
  }

  try {
    const r = prepareSnapshot({
      date: DATE,
      runsDir: RUNS,
      dbFile: DB,
      archiveDir: ARCHIVE,
      limit: LIMIT,
      noImport: NO_IMPORT,
      force: FORCE,
    });
    const promptPath = path.join(runDir, 'prompt.md');
    if (!NO_PROMPT) {
      atomicWriteText(promptPath, renderPrompt({
        date: DATE,
        inputPath: r.inputPath,
        inputSha: r.inputSha,
        runDir,
        next: r.report.next,
      }));
    }

    const rec = readStatus(STATUS).days[DATE] || {};
    let status = 'awaiting';
    const stage = r.report.next === 'publish' ? 'awaiting-publish' : 'awaiting-llm';
    if (rec.status === 'done') {
      // 已有产物（ai/rule/draft）时不能把状态改成 awaiting：done ⇔ 有文件
      status = 'done';
    } else {
      const reason = r.reused
        ? `输入快照已复用；当前检查点 ${r.report.latest || 'input'}，下一段 ${r.report.next}`
        : '输入快照已生成，等待 LLM 写作';
      updateStatus(STATUS, DATE, {
        status,
        stage,
        startedAt: NOW.iso,
        endedAt: '',
        exitCode: 0,
        candidates: Number(r.input.selectedCount) || 0,
        items: 0,
        source: '',
        reason,
        durationMs: 0,
        generator: 'prepare-v1',
        attempt: (Number(rec.attempt) || 0) + 1,
      });
    }

    const out = {
      ok: true,
      date: DATE,
      runDir,
      inputPath: r.inputPath,
      inputSha: r.inputSha,
      reused: r.reused,
      candidateCount: Number(r.input.candidateCount) || 0,
      selectedCount: Number(r.input.selectedCount) || 0,
      next: r.report.next,
      latest: r.report.latest,
      checkpoints: r.report.checkpoints,
      promptPath: NO_PROMPT ? '' : promptPath,
      status,
    };
    console.log(JSON.stringify(out, null, 2));
    log(`[briefing] prepare 完成：${DATE} · ${out.selectedCount} 条候选 · ` +
      `${r.reused ? '复用快照' : '新快照'} · 下一段 ${out.next}`);
    return 0;
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    const rec = readStatus(STATUS).days[DATE] || {};
    if (rec.status === 'done') {
      updateStatus(STATUS, DATE, { reason: `prepare 失败，保留已有产物：${reason}` });
    } else {
      updateStatus(STATUS, DATE, {
        status: 'missed',
        stage: 'prepare',
        startedAt: NOW.iso,
        endedAt: beijingNow().iso,
        exitCode: 1,
        candidates: 0,
        items: 0,
        source: '',
        reason,
        durationMs: 0,
        generator: 'prepare-v1',
      });
    }
    console.error(`[briefing] prepare 失败：${reason}`);
    return 1;
  } finally {
    if (lock && lock.ok) lock.release();
  }
}

process.exitCode = main();
