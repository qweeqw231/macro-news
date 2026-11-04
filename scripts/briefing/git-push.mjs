// scripts/briefing/git-push.mjs
// 2.4.2：publish --push 的入库步骤。
//
// 只提交早报相关的 4 个路径，绝不整目录 add：
//   data/briefings/<date>.json
//   data/index.json
//   data/history/index.json
//   data/_briefing-status.json
//
// push 前 fetch + rebase；失败**不回滚**已发布文件，由调用方把 pushed/error 写进状态。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function pushPathsFor(date) {
  return [
    `data/briefings/${date}.json`,
    'data/index.json',
    'data/history/index.json',
    'data/_briefing-status.json',
  ];
}

// ⚠ execFileSync 在 encoding 下**直接返回 stdout 字符串**（不是 {stdout}）
const defaultExec = (cmd, args, opts) =>
  execFileSync(cmd, args, { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const outText = (r) => (typeof r === 'string' ? r : String((r && r.stdout) || ''));

function errText(e) {
  const s = (e && (e.stderr || e.message)) || String(e);
  return String(s).trim().split('\n').slice(-2).join(' ');
}

// 只允许自动解决「派生索引」冲突：data/index.json、data/history/index.json。
// 这两个文件的计数/日期来自采集器，早报字段（hasBriefing/briefLine/source）来自发布器；
// rebase 时同一 JSON 块两边都改 ⇒ 冲突。合并策略：以**远端最新计数**为底，
// 覆盖上本地这一天的早报字段。其它任何文件冲突都中止，交给人工。
const DERIVED_INDEX_PATHS = new Set(['data/index.json', 'data/history/index.json']);

function resolveDerivedIndexConflict(root, date, exec, log) {
  if (!date) return false;
  const conflicted = outText(exec('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: root }))
    .trim().split('\n').map((s) => s.trim()).filter(Boolean);
  if (!conflicted.length) return false;
  if (!conflicted.every((p) => DERIVED_INDEX_PATHS.has(p))) return false;

  for (const p of conflicted) {
    let ours;
    let theirs;
    try {
      ours = JSON.parse(outText(exec('git', ['show', `:2:${p}`], { cwd: root })));
      theirs = JSON.parse(outText(exec('git', ['show', `:3:${p}`], { cwd: root })));
    } catch {
      return false;
    }
    const pick = (doc) => (doc && Array.isArray(doc.days)
      ? doc.days.find((x) => x && (x.day === date || x.d === date))
      : null);
    const o = pick(ours);
    const t = pick(theirs);
    if (!o || !t) return false;
    t.hasBriefing = o.hasBriefing;
    if (o.briefLine) t.briefLine = o.briefLine;
    else delete t.briefLine;
    if (o.source) t.source = o.source;
    fs.writeFileSync(path.join(root, p), JSON.stringify(theirs, null, 2), 'utf8');
    exec('git', ['add', '--', p], { cwd: root });
  }
  try {
    exec('git', ['rebase', '--continue'], { cwd: root, env: { ...process.env, GIT_EDITOR: 'true' } });
  } catch {
    return false;
  }
  log('[briefing] index 冲突已自动合并：远端计数 + 本地早报字段');
  return true;
}

/**
 * 通用：把给定路径提交并推到 origin/main。只 add 白名单文件，绝不整目录。
 * @param {{root:string, paths:string[], message:string, exec?:Function, log?:Function,
 *          skipWhenClean?:boolean, date?:string}} o
 * @returns {{pushed:boolean, committed:boolean, commit?:string, error?:string, kind?:string}}
 */
export function commitPathsAndPush(o) {
  const root = o.root;
  const exec = o.exec || defaultExec;
  const log = o.log || (() => {});
  const paths = (o.paths || []).filter((p) => fs.existsSync(path.join(root, p)));

  if (!paths.length) return { pushed: false, committed: false, kind: 'no-files', error: '没有可提交的早报文件' };

  exec('git', ['add', '--', ...paths], { cwd: root });
  const staged = outText(exec('git', ['diff', '--cached', '--name-only'], { cwd: root })).trim();
  if (!staged && o.skipWhenClean) return { pushed: true, committed: false, commit: null };
  let committed = false;
  let commit = null;
  if (staged) {
    const out = outText(
      exec('git', ['commit', '-m', o.message], { cwd: root })
    ).trim();
    committed = true;
    commit = out.split('\n')[0] || null;
    log(`[briefing] 已提交 ${staged.split('\n').length} 个文件`);
  }

  try {
    exec('git', ['fetch', 'origin', 'main'], { cwd: root });
  } catch (e) {
    return { pushed: false, committed, commit, kind: 'fetch', error: `fetch 失败：${errText(e)}` };
  }
  try {
    // 采集器可能同时在改 data/：autostash 避免“index contains uncommitted changes”
    exec('git', ['rebase', '--autostash', 'origin/main'], { cwd: root });
  } catch (e) {
    const err0 = errText(e);
    // 2.4.8：采集器与早报同时改 data/index.json 时会冲突。
    // 只自动解决派生索引（远端计数 + 本地早报字段），其它冲突一律中止。
    if (resolveDerivedIndexConflict(root, o.date, exec, log)) {
      // 已 rebase --continue，继续走 push
    } else {
      // 明确回到干净状态；**不 reset 已发布文件**
      try { exec('git', ['rebase', '--abort'], { cwd: root }); } catch { /* ignore */ }
      return { pushed: false, committed, commit, kind: 'conflict', error: `rebase 失败：${err0}` };
    }
  }
  try {
    exec('git', ['push', 'origin', 'HEAD:main'], { cwd: root });
  } catch (e) {
    return { pushed: false, committed, commit, kind: 'push', error: `push 失败：${errText(e)}` };
  }
  log('[briefing] 已推送到 origin/main');
  return { pushed: true, committed, commit };
}

/**
 * 2.4.4：早报文件入库成功后，再把 `data/_briefing-status.json` 的
 * `pushed:true` 二次提交上去，否则线上长期显示 `pushed: null`。
 *
 * 这次提交**只含状态文件**；即使失败也不影响已入库的早报，
 * 由调用方把 statusCommit=false 写回状态文件并在日志里留痕。
 *
 * @param {{root:string, statusPath:string, date:string, exec?:Function, log?:Function}} o
 */
export function commitStatusPush(o) {
  const rel = path.relative(o.root, o.statusPath).split(path.sep).join('/');
  return commitPathsAndPush({
    root: o.root,
    paths: [rel],
    message: `data: 记录早报入库 ${o.date}`,
    exec: o.exec,
    log: o.log,
    skipWhenClean: true,
  });
}

/**
 * @param {{root:string, date:string, exec?:Function, log?:Function}} o
 * @returns {{pushed:boolean, committed:boolean, commit?:string, error?:string}}
 */
export function commitAndPush(o) {
  return commitPathsAndPush({
    root: o.root,
    paths: pushPathsFor(o.date),
    message: `data: 早报入库 ${o.date}`,
    exec: o.exec,
    log: o.log,
    date: o.date,
  });
}
