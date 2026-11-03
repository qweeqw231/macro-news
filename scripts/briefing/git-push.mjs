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

/**
 * @param {{root:string, date:string, exec?:Function, log?:Function}} o
 * @returns {{pushed:boolean, committed:boolean, commit?:string, error?:string}}
 */
export function commitAndPush(o) {
  const root = o.root;
  const date = o.date;
  const exec = o.exec || defaultExec;
  const log = o.log || (() => {});
  const paths = pushPathsFor(date).filter((p) => fs.existsSync(path.join(root, p)));

  if (!paths.length) return { pushed: false, committed: false, error: '没有可提交的早报文件' };

  exec('git', ['add', '--', ...paths], { cwd: root });
  const staged = outText(exec('git', ['diff', '--cached', '--name-only'], { cwd: root })).trim();
  let committed = false;
  let commit = null;
  if (staged) {
    const out = outText(
      exec('git', ['commit', '-m', `data: 早报入库 ${date}`], { cwd: root })
    ).trim();
    committed = true;
    commit = out.split('\n')[0] || null;
    log(`[briefing] 已提交 ${staged.split('\n').length} 个文件`);
  }

  try {
    exec('git', ['fetch', 'origin', 'main'], { cwd: root });
  } catch (e) {
    return { pushed: false, committed, commit, error: `fetch 失败：${errText(e)}` };
  }
  try {
    // 采集器可能同时在改 data/：autostash 避免“index contains uncommitted changes”
    exec('git', ['rebase', '--autostash', 'origin/main'], { cwd: root });
  } catch (e) {
    // 明确回到干净状态；**不 reset 已发布文件**
    try { exec('git', ['rebase', '--abort'], { cwd: root }); } catch { /* ignore */ }
    return { pushed: false, committed, commit, error: `rebase 失败：${errText(e)}` };
  }
  try {
    exec('git', ['push', 'origin', 'HEAD:main'], { cwd: root });
  } catch (e) {
    return { pushed: false, committed, commit, error: `push 失败：${errText(e)}` };
  }
  log('[briefing] 已推送到 origin/main');
  return { pushed: true, committed, commit };
}
