// scripts/briefing/ensure.mjs
// 早报兜底：扫最近 7 天 → 缺失/不完整就补（本地有完整产物则只发布，不再生成）。
//
// 设计文档：docs/superpowers/specs/2026-11-02-briefing-resilience-design.md
//
// 用法：
//   node scripts/briefing/ensure.mjs                     # 真实时间：今天过 09:30 才补今天
//   node scripts/briefing/ensure.mjs --dry-run            # 只看计划
//   node scripts/briefing/ensure.mjs --sync               # 先 pull 再补
//   node scripts/briefing/ensure.mjs --today 2026-10-30 --now-hm 09:40   # 模拟/测试
//
// 退出码：0 全部完整 / 1 有失败 / 2 锁被占用（视为「在跑」，不重复补）

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
  atomicWriteText,
  beijingNow,
  checkBriefing,
  checkStatusInvariants,
  generateArgs,
  normalizeBriefingSource,
  parseBackfillRange,
  planCatchup,
  readStatus,
  scanMissed,
  updateStatus,
} from './core.mjs';
import { importArchive } from '../news-db/import-archive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATE = path.join(ROOT, 'scripts', 'briefing', 'generate.mjs');

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
const STATUS = path.resolve(ROOT, arg('status', 'data/_briefing-status.json'));
const LOCK = path.resolve(ROOT, arg('lock', '.local/briefing.lock'));
const DRY = flag('dry-run');
const SYNC = flag('sync');
const NO_IMPORT = flag('no-import');
const QUIET = flag('quiet');

const log = (...a) => { if (!QUIET) console.log(...a); };
const siteFile = (d) => path.join(SITE_OUT, `${d}.json`);
const localFile = (d) => path.join(OUT, `${d}.json`);

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
      // 手动补齐：只有显式给出窗口才会跑，不参与自动调度
      for (let d = BACKFILL.from; d <= BACKFILL.to; d = addDays(d, 1)) {
        const c = checkDay(d);
        if (c.complete) continue;
        plan.push({ date: d, action: c.localComplete ? 'publish' : 'generate' });
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
      missed = scanMissed({ today: TODAY, days: SCAN_DAYS, check: checkDay });
      if (!DRY) {
        for (const d of missed) {
          const rec = readStatus(STATUS).days[d] || {};
          if (rec.status === 'done' || rec.status === 'missed') continue;
          updateStatus(STATUS, d, {
            status: 'missed',
            stage: 'missed',
            endedAt: beijingNow().iso,
            exitCode: 0,
            candidates: 0,
            items: 0,
            source: '',
            reason: '历史日期不自动生成（早报是 AI 判断性内容，宁缺不假）',
            durationMs: 0,
            generator: 'missed',
          });
        }
      }
      if (missed.length) log(`[briefing] 历史缺口只标记、不补：${missed.join('、')}`);
    }

    if (!plan.length) {
      log(BACKFILL ? '[briefing] 补齐窗口内无需补跑' : '[briefing] 今天无需补跑（完整或在宽限内）');
      if (!DRY && !BACKFILL) {
        const bad = reconcileStatus();
        if (bad.length) return 1;
      }
      return 0;
    }
    log(`[briefing] 补跑计划：${plan.map((x) => `${x.date}(${x.action})`).join(' → ')}`);
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
          publish(job.date);
          okCount++;
          log(`[briefing] ${job.date} 发布完成（本地已有产物）`);
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

      // 生成：ensure 已持锁，子进程用 --no-lock；父进程用 spawnSync 的 timeout 做真兜底
      // ⚠ 所有路径都必须显式传给子进程，否则临时目录的模拟会写进仓库默认目录
      const childArgs = generateArgs({
        date: job.date,
        out: OUT,
        siteOut: SITE_OUT,
        status: STATUS,
        lock: LOCK,
        db: DB,
        archive: ARCHIVE,
        quiet: QUIET,
      });
      const r = spawnSync(
        process.execPath,
        [GENERATE, ...childArgs],
        { cwd: ROOT, encoding: 'utf8', timeout: HARD_TIMEOUT_MS, stdio: QUIET ? 'pipe' : 'inherit' }
      );
      const timedOut = r.error && r.error.code === 'ETIMEDOUT';
      if (timedOut) {
        failCount++;
        updateStatus(STATUS, job.date, {
          status: 'timeout', stage: 'generate', endedAt: beijingNow().iso,
          exitCode: 124, items: 0, reason: '超过 15 分钟硬超时（父进程终止）',
          durationMs: Date.now() - one0,
        });
        log(`[briefing] ${job.date} 超时（15 分钟）`);
      } else if (r.status !== 0) {
        failCount++;
        log(`[briefing] ${job.date} 生成失败（退出码 ${r.status}），见状态文件`);
      } else {
        okCount++;
        const rec = readStatus(STATUS).days[job.date] || {};
        log(
          `[briefing] ${job.date} 补跑完成：${rec.items || 0} 条 · ` +
            `${((Date.now() - one0) / 1000).toFixed(1)}s`
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
