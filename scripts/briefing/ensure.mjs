// scripts/briefing/ensure.mjs
// 早报兜底（2.3.0）：扫最近 7 天 → 缺失当天只 prepare 输入快照，等待 LLM 写作；
// 本地已有完整 AI 产物则只发布到站点，不重新生成。历史缺口只标 missed。
//
// 设计文档：docs/superpowers/specs/2026-11-02-briefing-resilience-design.md
//            docs/superpowers/specs/2026-11-02-briefing-llm-pipeline-design.md
//
// 用法：
//   node scripts/briefing/ensure.mjs                     # 真实时间：今天过 09:30 才补今天
//   node scripts/briefing/ensure.mjs --dry-run            # 只看计划
//   node scripts/briefing/ensure.mjs --sync               # 先 pull 再补
//   node scripts/briefing/ensure.mjs --today 2026-10-30 --now-hm 09:40   # 模拟/测试
//   node scripts/briefing/ensure.mjs --backfill-from 2026-11-14 --backfill-to 2026-11-14
//        # 2.19.0 按日补写：只收已过去的日子、不早于归档起点、该日必须有新闻；
//        # 只做切片与状态，LLM 写作仍由外部 harness 完成（产物带 backfill 溯源章）
//
// 退出码：0 全部完整/已准备 / 1 有失败 / 2 锁被占用（视为「在跑」，不重复补）

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEADLINE_HM,
  GRACE_MIN,
  HARD_TIMEOUT_MS,
  STATUS_KEEP_DAYS,
  acquireLock,
  addDays,
  archiveSpan,
  atomicWriteText,
  beijingNow,
  briefEraStart,
  checkBriefing,
  checkStatusInvariants,
  guardBackfill,
  normalizeBriefingSource,
  parseBackfillRange,
  planCatchup,
  readStatus,
  scanGaps,
  scanMissed,
  updateStatus,
} from './core.mjs';
import { prepareArgs, publishRun, readJson } from './pipeline.mjs';
import { importArchive } from '../news-db/import-archive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PREPARE = path.join(ROOT, 'scripts', 'briefing', 'prepare.mjs');

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
const TODAY = arg('today', NOW.date);
const NOW_HM = arg('now-hm', NOW.hm);
const SCAN_DAYS = num('scan-days', 7);
const BACKFILL = (() => {
  try {
    return parseBackfillRange(arg('backfill-from', null), arg('backfill-to', null));
  } catch (e) {
    console.error(`[briefing] ${e.message}`);
    process.exit(1);
  }
})();
const DB = path.resolve(ROOT, arg('db', '.local/news.db'));
const ARCHIVE = path.resolve(ROOT, arg('archive', 'data/archive'));
const OUT = path.resolve(ROOT, arg('out', '.local/briefings'));
const SITE_OUT = path.resolve(ROOT, arg('site-out', 'data/briefings'));
const RUNS = path.resolve(ROOT, arg('runs', '.local/runs'));
const STATUS = path.resolve(ROOT, arg('status', 'data/_briefing-status.json'));
const DATA_DIR = path.resolve(ROOT, arg('data-dir', 'data'));
const LOCK = path.resolve(ROOT, arg('lock', '.local/briefing.lock'));
const DRY = flag('dry-run');
const SYNC = flag('sync');
const NO_IMPORT = flag('no-import');
const QUIET = flag('quiet');

const log = (...a) => { if (!QUIET) console.log(...a); };
const siteFile = (d) => path.join(SITE_OUT, `${d}.json`);
const localFile = (d) => path.join(OUT, `${d}.json`);

// 2.28.2：「这天有没有新闻」= archive 与 history 切片取大者。
// 只看 archive 会把薄归档但切片完整的日子判成 no-news，补写窗口里会被整段跳过。
const readSpan = () => archiveSpan(
  readJson(path.join(DATA_DIR, 'index.json')).value,
  readJson(path.join(DATA_DIR, 'history/index.json')).value
);

/** 对某天：站点产物是否完整、本地产物是否完整 */
function checkDay(d) {
  const site = checkBriefing(siteFile(d));
  const local = checkBriefing(localFile(d));
  return { ...site, complete: site.complete, localComplete: local.complete };
}

/** 扫描站点目录里所有完整早报（day → {source, items}） */
function listSiteBriefings() {
  const map = new Map();
  try {
    for (const f of fs.readdirSync(SITE_OUT)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (!m) continue;
      const d = m[1];
      const chk = checkBriefing(path.join(SITE_OUT, f));
      if (!chk.complete) continue;
      let source = 'ai';
      try {
        source = normalizeBriefingSource(JSON.parse(fs.readFileSync(path.join(SITE_OUT, f), 'utf8')));
      } catch { /* ignore */ }
      map.set(d, { source, items: chk.items });
    }
  } catch { /* 目录不存在 */ }
  return map;
}

/**
 * 状态不变式校正（2.2.3）：
 *   · 有文件 → 必须是 done，source 取实际文件；
 *   · done 但文件不存在 → 纠正为 missed；
 *   · 最后跑一遍 checkStatusInvariants，仍有违规就返回（调用方退出码 1）。
 */
function reconcileStatus() {
  const files = listSiteBriefings();
  const cutoff = addDays(TODAY, -(STATUS_KEEP_DAYS - 1));
  for (const [d, meta] of files) {
    if (d < cutoff) continue;
    const rec = readStatus(STATUS).days[d] || {};
    if (rec.status === 'done' && rec.source === meta.source && rec.endedAt && Number(rec.items) === meta.items) {
      continue;
    }
    let endedAt = rec.endedAt;
    if (!endedAt) {
      try { endedAt = beijingNow(fs.statSync(path.join(SITE_OUT, `${d}.json`)).mtimeMs).iso; } catch { endedAt = NOW.iso; }
    }
    updateStatus(STATUS, d, {
      status: 'done',
      stage: 'done',
      endedAt,
      exitCode: 0,
      items: meta.items,
      reason: rec.status && rec.status !== 'done' ? '' : (rec.reason || ''),
      source: meta.source,
      generator: rec.generator || 'existing',
      startedAt: rec.startedAt || endedAt,
      attempt: rec.attempt || 0,
    });
  }
  // done 但产物不存在 → missed（不变式另一方向）
  for (const [d, rec] of Object.entries(readStatus(STATUS).days)) {
    if (d < cutoff) continue;
    if (rec.status === 'done' && !files.has(d)) {
      updateStatus(STATUS, d, {
        status: 'missed',
        stage: 'missed',
        source: '',
        items: 0,
        reason: '状态为 done 但产物不存在（已自动纠正）',
        generator: 'missed',
      });
    }
  }
  const bad = checkStatusInvariants(readStatus(STATUS).days, files);
  if (bad.length) {
    log(`[briefing] 状态不变式违规：${bad.map((x) => `${x.day}:${x.kind}`).join('、')}`);
  }
  return bad;
}

function syncArchives() {
  const script = path.join(ROOT, 'scripts', 'pull-remote.ps1');
  if (!fs.existsSync(script)) return 'pull-remote.ps1 不存在';
  const ps = process.platform === 'win32' ? 'powershell' : 'pwsh';
  const r = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    cwd: ROOT, encoding: 'utf8', timeout: 5 * 60 * 1000,
  });
  if (r.error) return `同步出错：${r.error.message}`;
  if (r.status !== 0) return `同步退出码 ${r.status}：${(r.stdout || r.stderr || '').slice(-200)}`;
  return '';
}

function publish(d) {
  const chk = checkBriefing(localFile(d));
  if (!chk.complete) throw new Error(`${d} 本地早报不完整，无法发布`);
  const text = fs.readFileSync(localFile(d), 'utf8');
  let source = 'ai';
  try { source = normalizeBriefingSource(JSON.parse(text)); } catch { /* ignore */ }
  atomicWriteText(siteFile(d), text);
  const t = beijingNow();
  updateStatus(STATUS, d, {
    status: 'done',
    stage: 'publish',
    startedAt: t.iso,
    endedAt: t.iso,
    exitCode: 0,
    candidates: 0,
    items: chk.items,
    reason: '本地已有完整早报，仅发布到站点',
    durationMs: 0,
    generator: 'publish',
    source,
  });
}

function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(TODAY)) {
    console.error(`[briefing] today 格式不对：${TODAY}`);
    return 1;
  }
  if (BACKFILL) {
    log(`[briefing] ensure 手动补齐 ${BACKFILL.from}..${BACKFILL.to}（${BACKFILL.days} 天）`);
  } else {
    log(`[briefing] ensure 启动：今天 ${TODAY}，当前 ${NOW_HM}；自动补跑只处理今天，历史缺口只标 missed`);
  }

  let lock = null;
  if (!DRY) {
    lock = acquireLock(LOCK);
    if (!lock.ok) {
      console.error(
        `[briefing] 另一个进程正在跑（pid ${lock.holder && lock.holder.pid}），本次跳过`
      );
      return 2;
    }
  }

  try {
    let plan = [];
    let missed = [];
    if (BACKFILL) {
      // 手动补齐（2.19.0）：只有显式给出窗口才会跑，不参与自动调度。
      // 边界三条（见 core.guardBackfill / scanGaps）：不碰今天、不碰归档起点之前、
      // 该日必须有新闻；无新闻的日子只记 no-news，绝不生成任何产物。
      const span = readSpan();
      const eraStart = briefEraStart(SITE_OUT);
      const g = guardBackfill({
        from: BACKFILL.from, to: BACKFILL.to, today: TODAY, archiveFirst: span.first,
      });
      if (!g.ok) {
        console.error(`[briefing] 拒绝补写（${g.code}）：${g.reason}`);
        return 1;
      }
      log(`[briefing] 补写边界：制度起点 ${eraStart || '（无）'}、归档起点 ${span.first || '（无）'}`);
      for (let d = BACKFILL.from; d <= BACKFILL.to; d = addDays(d, 1)) {
        const c = checkDay(d);
        if (c.complete) continue;
        const news = Number(span.counts.get(d)) || 0;
        const kind = eraStart && d >= eraStart ? 'gap' : 'pre-era';
        if (!news) {
          // 没有新闻 = 没有可切片的内容。写规则版/draft 都等于编造，只能记一笔"合理空缺"。
          if (!DRY) {
            updateStatus(STATUS, d, {
              status: 'missed', stage: 'backfill', gap: 'no-news',
              backfill: true, backfillKind: kind,
              endedAt: NOW.iso, exitCode: 0, candidates: 0, items: 0, source: '',
              reason: '该日没有新闻条目，无从切片，未补写（不算缺失）',
              durationMs: 0, generator: 'backfill',
            });
          }
          log(`[briefing] ${d} 无新闻，跳过（记 no-news，不生成）`);
          continue;
        }
        plan.push({ date: d, action: c.localComplete ? 'publish' : 'prepare', backfill: kind, news });
      }
    } else {
      plan = planCatchup({
        today: TODAY,
        nowHm: NOW_HM,
        days: 1,           // 2.2.2：只补今天
        deadline: DEADLINE_HM,
        graceMin: GRACE_MIN,
        check: checkDay,
      });
      // 2.19.0：缺口只认「制度起点之后 + 有新闻 + 没写」的日子（见 core.scanGaps）。
      // 旧实现把无新闻的日子、制度前的日子也标 missed，首页会冒出一堆并不存在的"缺失"。
      const span = readSpan();
      const eraStart = briefEraStart(SITE_OUT);
      missed = scanGaps({
        today: TODAY, eraStart, counts: span.counts, check: checkDay, days: SCAN_DAYS,
      }).map((x) => x.day);
      if (!DRY) {
        for (const d of missed) {
          const rec = readStatus(STATUS).days[d] || {};
          if (rec.status === 'done' || rec.status === 'missed') continue;
          updateStatus(STATUS, d, {
            status: 'missed',
            stage: 'missed',
            gap: 'not-written',
            endedAt: beijingNow().iso,
            exitCode: 0,
            candidates: 0,
            items: 0,
            source: '',
            reason: '历史日期不自动生成（早报是 AI 判断性内容，宁缺不假）；可在页脚按日补写',
            durationMs: 0,
            generator: 'missed',
          });
        }
      }
      if (missed.length) log(`[briefing] 历史缺口只标记、不自动补：${missed.join('、')}`);
    }

    if (!plan.length) {
      log(BACKFILL ? '[briefing] 补齐窗口内无需补跑' : '[briefing] 今天无需补跑（完整或在宽限内）');
      if (!DRY && !BACKFILL) {
        const bad = reconcileStatus();
        if (bad.length) return 1;
      }
      return 0;
    }
    log(`[briefing] 补跑计划：${plan.map((x) => `${x.date}(${x.action}${x.backfill ? '/' + x.backfill : ''})`).join(' → ')}`);
    if (DRY) return 0;

    if (SYNC) {
      const err = syncArchives();
      if (err) log(`[briefing] 同步未成功，继续用本地数据：${err}`);
    }

    if (!NO_IMPORT) {
      const imp = importArchive({ dbFile: DB, archiveDir: ARCHIVE, quiet: true });
      log(`[briefing] 导入 archive：${imp.files} 天 / ${imp.total} 条（新增 ${imp.inserted}）`);
    }

    const t0 = Date.now();
    let okCount = 0;
    let failCount = 0;
    for (const job of plan) {
      const one0 = Date.now();
      if (job.action === 'publish') {
        try {
          if (job.backfill) {
            // 补写走 publishRun：同样的校验/原子写，另外补索引并核对（ensure 的旧 publish
            // 只写站点文件、不碰索引，补写历史日会出现「有产物但索引没标记」）
            const r = publishRun({
              date: job.date,
              runsDir: RUNS,
              siteOut: SITE_OUT,
              localOut: OUT,
              status: STATUS,
              dataDir: DATA_DIR,
              noLock: true,
              backfill: job.backfill,
            });
            if (!r.ok) throw new Error(r.reason || r.code);
          } else {
            publish(job.date);
          }
          okCount++;
          log(`[briefing] ${job.date} 发布完成（本地已有产物${job.backfill ? ' · ' + job.backfill : ''}）`);
        } catch (e) {
          failCount++;
          updateStatus(STATUS, job.date, {
            status: 'failed', stage: 'publish', endedAt: beijingNow().iso,
            exitCode: 1, items: 0, reason: e.message, durationMs: Date.now() - one0,
          });
          log(`[briefing] ${job.date} 发布失败：${e.message}`);
        }
        continue;
      }

      // 2.3.0：缺失当天只 prepare 输入快照，等待 LLM 写作；绝不生成规则版早报
      // ensure 已持锁，prepare 用 --no-lock；所有路径显式传，防止临时目录模拟写进仓库
      const childArgs = prepareArgs({
        date: job.date,
        runs: RUNS,
        status: STATUS,
        db: DB,
        archive: ARCHIVE,
        noImport: true,
        quiet: QUIET,
        backfill: job.backfill || '',
      });
      childArgs.push('--no-lock');
      const r = spawnSync(
        process.execPath,
        [PREPARE, ...childArgs],
        { cwd: ROOT, encoding: 'utf8', timeout: HARD_TIMEOUT_MS, stdio: QUIET ? 'pipe' : 'inherit' }
      );
      const timedOut = r.error && r.error.code === 'ETIMEDOUT';
      if (timedOut) {
        failCount++;
        updateStatus(STATUS, job.date, {
          status: 'timeout', stage: 'prepare', endedAt: beijingNow().iso,
          exitCode: 124, items: 0, reason: '超过 15 分钟硬超时（父进程终止）',
          durationMs: Date.now() - one0,
        });
        log(`[briefing] ${job.date} prepare 超时（15 分钟）`);
      } else if (r.status !== 0) {
        failCount++;
        log(`[briefing] ${job.date} prepare 失败（退出码 ${r.status}），见状态文件`);
      } else {
        okCount++;
        const rec = readStatus(STATUS).days[job.date] || {};
        log(
          `[briefing] ${job.date} 输入快照已准备：${rec.candidates || 0} 条候选 · ` +
            `等待 LLM 写作 · ${((Date.now() - one0) / 1000).toFixed(1)}s`
        );
      }
    }

    if (!BACKFILL) {
      const bad = reconcileStatus();
      if (bad.length) return 1;
    }
    log(
      `[briefing] 完成：成功 ${okCount} / 失败 ${failCount} · ` +
        `总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
    return failCount ? 1 : 0;
  } finally {
    if (lock && lock.ok) lock.release();
  }
}

process.exitCode = main();
