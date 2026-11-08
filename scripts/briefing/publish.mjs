// scripts/briefing/publish.mjs
// 2.3.0 第三段：校验 LLM 定稿 → 原子发布 → 索引 → 状态。
//
// 设计文档：docs/superpowers/specs/2026-11-02-briefing-llm-pipeline-design.md
//
// 用法：
//   node scripts/briefing/publish.mjs --date 2026-11-02
//   node scripts/briefing/publish.mjs --date 2026-11-02 --draft-on-fail  # 降级事实清单
//
// 退出码：0 成功（含已有 AI 早报跳过）/ 1 未发布或降级 / 2 锁被占用

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beijingNow, updateStatus } from './core.mjs';
import { publishRun } from './pipeline.mjs';
import { commitAndPush, commitStatusPush } from './git-push.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : dflt;
};
const flag = (name) => process.argv.includes('--' + name);

const DATE = arg('date', beijingNow().date);
const RUNS = path.resolve(ROOT, arg('runs', '.local/runs'));
const SITE_OUT = path.resolve(ROOT, arg('site-out', 'data/briefings'));
const LOCAL_OUT = path.resolve(ROOT, arg('local-out', '.local/briefings'));
const STATUS = path.resolve(ROOT, arg('status', 'data/_briefing-status.json'));
const DATA_DIR = path.resolve(ROOT, arg('data-dir', 'data'));
const DRAFT_ON_FAIL = flag('draft-on-fail');
const NO_LOCK = flag('no-lock');
const QUIET = flag('quiet');
// 2.4.2：发布即入库（只提交早报相关 4 个路径；失败不回滚已发布文件）
const PUSH = flag('push');

function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
    console.error(`[briefing] 日期格式不对：${DATE}`);
    return 1;
  }
  try {
    const r = publishRun({
      date: DATE,
      runsDir: RUNS,
      siteOut: SITE_OUT,
      localOut: LOCAL_OUT,
      status: STATUS,
      dataDir: DATA_DIR,
      draftOnFail: DRAFT_ON_FAIL,
      noLock: NO_LOCK,
    });
    if (!QUIET) {
      // 2.4.19：失败要直说「失败」，不能因为 r.reason 有值就打成「完成」
      const tag = !r.ok ? '失败'
        : r.degraded ? '降级事实清单'
        : r.skipped ? '跳过（已有 AI 早报）'
        : '完成';
      console.error(`[briefing] publish ${DATE}：${tag} · ${r.reason || r.code}`);
    }

    // 发布成功后入库；失败只记录，不撤稿、不重写已发布文件
    let push = null;
    if (PUSH && r.ok) {
      // 先清掉上一轮的失败痕迹，避免把 pushed:false 提交进仓库
      try {
        updateStatus(STATUS, DATE, { pushed: null, pushError: '', pushAt: '' });
      } catch { /* ignore */ }
      push = commitAndPush({ root: ROOT, date: DATE, log: QUIET ? undefined : (m) => console.error(m) });
      try {
        updateStatus(STATUS, DATE, {
          pushed: !!push.pushed,
          pushError: push.error || '',
          pushErrorKind: push.kind || '',
          pushAt: push.pushed ? beijingNow().iso : '',
          statusCommit: null,
          statusError: '',
        });
      } catch { /* 状态写失败不影响已发布文件 */ }
      // 2.4.4：早报文件已入库后，再把 pushed:true 的状态文件单独提交一次，
      // 否则线上 _briefing-status.json 长期显示 pushed:null（读者无法判断是否入库）。
      if (push.pushed) {
        const sp = commitStatusPush({
          root: ROOT,
          statusPath: STATUS,
          date: DATE,
          log: QUIET ? undefined : (m) => console.error(m),
        });
        push.statusCommit = !!sp.pushed;
        if (!sp.pushed) {
          try {
            updateStatus(STATUS, DATE, { statusCommit: false, statusError: sp.error || '' });
          } catch { /* ignore */ }
          if (!QUIET) console.error(`[briefing] 状态二次提交失败：${sp.error}`);
        }
      }
      if (!push.pushed && !QUIET) {
        console.error(`[briefing] 已发布但未入库：${push.error}`);
      }
    }
    console.log(JSON.stringify({ ...r, push }, null, 2));
    if (r.code === 'locked') return 2;
    if (!r.ok || r.degraded) return 1;
    return 0;
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    try {
      updateStatus(STATUS, DATE, {
        status: 'failed',
        stage: 'publish',
        startedAt: beijingNow().iso,
        endedAt: beijingNow().iso,
        exitCode: 1,
        items: 0,
        source: '',
        reason,
        durationMs: 0,
        generator: 'publish',
      });
    } catch { /* ignore */ }
    console.error(`[briefing] publish 异常：${reason}`);
    return 1;
  }
}

process.exitCode = main();
