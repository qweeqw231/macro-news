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

// ---------- rebase 冲突的语义合并 ----------
//
// ⚠️ **rebase 冲突时 git 的 stage 语义与直觉相反**（2026-11-05 实测确认）：
//     `:2:` = **上游**（origin/main，采集器写的新鲜计数）
//     `:3:` = **正在重放的本地提交**（含当天早报字段，但计数是旧的）
//   merge 时才是「ours=当前 HEAD、theirs=被合入方」；rebase 里 ours 指的其实是**上游**。
//   ⇒ 千万别把 :2: 当成「我们的版本」，否则合并结果会变成
//     「旧计数 + 当天早报标记被远端值抹掉」，站点索引当天不显示早报。
//
// 合并基准：**以 :2:（上游）为底**（generatedAt/total/各日 count 更新鲜），
// **叠加 :3:（本地）那一天的早报字段**（hasBriefing/briefLine/source）。
// 状态文件同理由「远端为底 + 本地当天的发布状态」。
// 任何非白名单文件的冲突一律中止，交给人工。
const AUTO_MERGE_INDEX_PATHS = new Set(['data/index.json', 'data/history/index.json']);
const AUTO_MERGE_STATUS_PATH = 'data/_briefing-status.json';
const AUTO_MERGE_PATHS = new Set([...AUTO_MERGE_INDEX_PATHS, AUTO_MERGE_STATUS_PATH]);

/** 找某一天在索引里的条目（data/index.json 用 day，data/history/index.json 用 d） */
function findDayEntry(doc, date) {
  if (!doc || !Array.isArray(doc.days)) return null;
  return doc.days.find((x) => x && (x.day === date || x.d === date)) || null;
}

/**
 * 合并派生索引：**upstream(:2:) 为底 + local(:3:) 的当天早报字段**。
 * - 计数/total/generatedAt 一律取上游（更新鲜）；
 * - hasBriefing/briefLine/source 取本地（只有发布器写得出来）；
 * - 上游还没有当天条目时，把本地条目整体补进去（计数只能取本地这一份）。
 */
export function mergeIndexDoc(upstream, local, date) {
  if (!upstream || typeof upstream !== 'object') return upstream;
  const u = findDayEntry(upstream, date);
  const l = findDayEntry(local, date);
  if (!l) return upstream;
  if (!u) {
    const days = Array.isArray(upstream.days) ? upstream.days.slice() : [];
    days.push(l);
    days.sort((a, b) => String(b.day || b.d || '').localeCompare(String(a.day || a.d || '')));
    upstream.days = days;
    upstream.total = (Number(upstream.total) || 0) + (Number(l.count ?? l.n) || 0);
    return upstream;
  }
  if (l.hasBriefing) {
    u.hasBriefing = true;
    if (l.briefLine) u.briefLine = l.briefLine;
    else delete u.briefLine;
    if (l.source) u.source = l.source;
  }
  return upstream;
}

/**
 * 合并状态文件：**upstream(:2:) 为底 + local(:3:) 当天的发布状态**。
 * 其余天的记录保留上游的（状态文件由发布器独家写，但采集器会 `git add -u` 把它一起提交）。
 */
export function mergeStatusDoc(upstream, local, date) {
  if (!upstream || typeof upstream !== 'object') return upstream;
  const days = (upstream.days && typeof upstream.days === 'object') ? upstream.days : {};
  const l = (local && local.days && local.days[date]) || null;
  if (l) days[date] = { ...(days[date] || {}), ...l };
  const ordered = {};
  Object.keys(days).sort().forEach((k) => { ordered[k] = days[k]; });
  upstream.days = ordered;
  // updatedAt 两边谁更新说不准 ⇒ 取较晚者
  const a = Date.parse(upstream.updatedAt || '');
  const b = Date.parse((local && local.updatedAt) || '');
  if (Number.isFinite(b) && (!Number.isFinite(a) || b > a)) upstream.updatedAt = local.updatedAt;
  return upstream;
}

function listConflicted(exec, root) {
  return outText(exec('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: root }))
    .trim().split('\n').map((s) => s.trim()).filter(Boolean);
}

/** rebase 是否还在进行中（.git/rebase-merge 或 .git/rebase-apply 存在） */
function rebaseInProgress(exec, root) {
  try {
    const gd = outText(exec('git', ['rev-parse', '--git-dir'], { cwd: root })).trim();
    const abs = gd ? (path.isAbsolute(gd) ? gd : path.join(root, gd)) : path.join(root, '.git');
    return fs.existsSync(path.join(abs, 'rebase-merge')) || fs.existsSync(path.join(abs, 'rebase-apply'));
  } catch {
    return false;
  }
}

/** 把一个冲突文件按语义合并后 stage 上去 */
function applyMergeFor(root, rel, date, exec) {
  let upstream;
  let local;
  try {
    upstream = JSON.parse(outText(exec('git', ['show', `:2:${rel}`], { cwd: root })));
    local = JSON.parse(outText(exec('git', ['show', `:3:${rel}`], { cwd: root })));
  } catch {
    return false;
  }
  const merged = rel === AUTO_MERGE_STATUS_PATH
    ? mergeStatusDoc(upstream, local, date)
    : mergeIndexDoc(upstream, local, date);
  fs.writeFileSync(path.join(root, rel), JSON.stringify(merged, null, 2), 'utf8');
  exec('git', ['add', '--', rel], { cwd: root });
  return true;
}

/**
 * rebase 失败后的自动解冲突：语义合并 → continue → 继续走 push。
 * 冲突文件必须全在白名单内，否则返回 false（由调用方 abort）。
 */
function resolveAutoMergeConflict(root, date, exec, log) {
  if (!date) return false;
  let mergedAny = false;
  for (let round = 0; round < 8; round++) {
    const conflicted = listConflicted(exec, root);
    if (conflicted.length) {
      if (!conflicted.every((p) => AUTO_MERGE_PATHS.has(p))) return false;
      for (const p of conflicted) {
        if (!applyMergeFor(root, p, date, exec)) return false;
      }
      mergedAny = true;
    } else if (round === 0) {
      return false; // 没有冲突 ⇒ rebase 失败另有原因，不在这里兜
    }
    try {
      exec('git', ['rebase', '--continue'], { cwd: root, env: { ...process.env, GIT_EDITOR: 'true' } });
    } catch {
      if (!rebaseInProgress(exec, root)) {
        if (!mergedAny) return false;
        log('[briefing] 冲突已自动合并：远端计数 + 本地早报字段');
        return true;
      }
      if (!listConflicted(exec, root).length) return false; // 未知错误，交给人工
      continue;
    }
    if (!rebaseInProgress(exec, root)) {
      if (!mergedAny) return false;
      log('[briefing] 冲突已自动合并：远端计数 + 本地早报字段');
      return true;
    }
    // 仍在 rebase 中（可能还有后续提交要重放）⇒ 下一轮
  }
  return false;
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
    // 只自动解决「派生索引 + 状态文件」（远端计数 + 本地早报字段），其它冲突一律中止。
    if (resolveAutoMergeConflict(root, o.date, exec, log)) {
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
    date: o.date,
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
