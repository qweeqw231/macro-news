// tests/collect-sync.test.mjs
// 2.4.16：本机采集任务「先同步再跑」的静态守卫（不依赖真实仓库/网络）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPT = read('scripts/collect-and-push.ps1');
const REGISTER = read('scripts/register-task.ps1');

test('同步在陈旧度判定 / 采集之前', () => {
  const fetchAt = SCRIPT.indexOf('git fetch origin main');
  const staleAt = SCRIPT.indexOf('$latestFile');
  assert.ok(fetchAt >= 0, '缺少 git fetch origin main');
  assert.ok(staleAt > fetchAt, '同步必须在 $latestFile 陈旧度判定之前');
  assert.ok(SCRIPT.indexOf('src\\collect.mjs --no-kline') > fetchAt, '同步必须在采集之前');
});

test('落后时只做 ff-only，脏工作区先 stash 再 pop', () => {
  assert.match(SCRIPT, /git merge --ff-only origin\/main/);
  assert.match(SCRIPT, /git stash push -m \$msg -- \$paths/);
  assert.match(SCRIPT, /git stash pop/);
  assert.match(SCRIPT, /skipped:stash-pop-conflict/);
  assert.match(SCRIPT, /\$stashState = 'kept'/);
  assert.match(SCRIPT, /skipped:unmerged/);
});

test('分叉与提交后合并使用普通 merge，冲突 abort', () => {
  assert.match(SCRIPT, /git merge --no-edit origin\/main/);
  assert.match(SCRIPT, /git merge --abort/);
  assert.match(SCRIPT, /skipped:merge-conflict/);
});

test('禁止破坏性/强制操作', () => {
  for (const bad of [
    /-X\s+ours/i,
    /reset\s+--hard/i,
    /checkout\s+--/i,
    /push\s+--force/i,
    /push\s+-f\b/i,
  ]) {
    assert.doesNotMatch(SCRIPT, bad, `脚本不得包含 ${bad}`);
  }
});

test('每轮记录 HEAD / behind / ahead / 同步结果', () => {
  assert.match(SCRIPT, /git rev-parse --short HEAD/);
  assert.match(SCRIPT, /git rev-list --count HEAD\.\.origin\/main/);
  assert.match(SCRIPT, /git rev-list --count origin\/main\.\.HEAD/);
  assert.match(SCRIPT, /sync: head=\{0\} behind=\{1\} ahead=\{2\} dirty=\{3\} result=\{4\} head_after=\{5\} stash=\{6\}/);
  assert.match(SCRIPT, /dirty=\$dirty/);
});

test('守卫自检：缺失只告警，继续采集', () => {
  assert.match(SCRIPT, /src\\kline-lock\.mjs/);
  assert.match(SCRIPT, /upsertBars/);
  assert.match(SCRIPT, /guard:missing/);
  assert.match(SCRIPT, /继续采集/);
  assert.doesNotMatch(SCRIPT, /guard:missing[\s\S]{0,80}?exit 1/, 'guard:missing 不得以失败退出');
});

test('保留 wscript + run-hidden.vbs 静默宿主', () => {
  assert.match(REGISTER, /New-ScheduledTaskAction -Execute 'wscript\.exe'/);
  assert.match(REGISTER, /run-hidden\.vbs/);
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'run-hidden.vbs')), 'run-hidden.vbs 必须存在');
  // 计划任务实际动作已备份；脚本本身不得改成 powershell.exe 直接启动
  assert.doesNotMatch(SCRIPT, /-WindowStyle Hidden/);
});

test('同步-only 测试开关存在，但生产任务默认不传', () => {
  assert.match(SCRIPT, /\[switch\]\$SyncOnly/);
  assert.match(SCRIPT, /sync-only：结束（不采集）/);
  assert.doesNotMatch(REGISTER, /-SyncOnly/, '注册任务不应传测试开关');
});

test('fetch 有 SSH 超时，避免落后很多时长时间卡住', () => {
  assert.match(SCRIPT, /GIT_SSH_COMMAND/);
  assert.match(SCRIPT, /ConnectTimeout=15/);
  assert.match(SCRIPT, /ServerAliveInterval=15/);
});
