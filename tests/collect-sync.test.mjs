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
const CLOSE = read('scripts/sync-close.ps1');
const LIB = read('scripts/git-sync-lib.ps1');

test('同步在陈旧度判定 / 采集之前', () => {
  const fetchAt = SCRIPT.indexOf('Invoke-GitFetchRetry');
  const staleAt = SCRIPT.indexOf('$latestFile');
  assert.ok(fetchAt >= 0, '缺少 Invoke-GitFetchRetry（fetch 重试入口）');
  assert.match(LIB, /'fetch', '--progress', 'origin', 'main'/);
  assert.ok(staleAt > fetchAt, '同步必须在 $latestFile 陈旧度判定之前');
  assert.ok(SCRIPT.indexOf('src\\collect.mjs --no-kline') > fetchAt, '同步必须在采集之前');
});

test('落后时只做 ff-only；脏工作区整轮跳过，不 stash / 不 pop', () => {
  assert.match(SCRIPT, /git merge --ff-only origin\/main/);
  // 2.13.4：脏检测只看受版本控制的文件
  assert.match(SCRIPT, /git status --porcelain --untracked-files=no/);
  assert.match(SCRIPT, /skipReason = 'dirty-worktree'/);
  assert.match(SCRIPT, /skipped:dirty-worktree/);
  // 2.13.4：脏工作区上绝不再 stash/pop（2026-11-11 19:54 事故根因）
  assert.doesNotMatch(SCRIPT, /git stash push/);
  assert.doesNotMatch(SCRIPT, /git stash pop/);
  assert.doesNotMatch(SCRIPT, /skipped:stash-pop-conflict/);
  assert.doesNotMatch(SCRIPT, /\$stashState/);
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
  assert.match(SCRIPT, /sync: head=\{0\} behind=\{1\} ahead=\{2\} dirty=\{3\} result=\{4\} head_after=\{5\} stash=none/);
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

test('fetch 有 SSH 超时，且带重试/退避/停滞检测（SSH-443 会被随机 reset）', () => {
  assert.match(LIB, /GIT_SSH_COMMAND/);
  assert.match(LIB, /ConnectTimeout=15/);
  assert.match(LIB, /ServerAliveInterval=15/);
  assert.match(LIB, /function Invoke-GitFetchRetry/);
  assert.match(LIB, /Start-Sleep/);
  assert.match(LIB, /BackoffSeconds/);
  // 判据必须是「停滞」而不是固定总超时：慢速大包（2~3 MB/90s）不能被误杀
  assert.match(LIB, /function Invoke-GitWithTimeout/);
  assert.match(LIB, /StallSeconds/);
  assert.match(LIB, /tmp_pack_/);
  assert.match(SCRIPT, /Invoke-GitFetchRetry/);
  assert.match(CLOSE, /Invoke-GitFetchRetry/);
});

test('fetch 失败不写 data/：只落 .local 哨兵，避免工作区自锁', () => {
  const start = SCRIPT.indexOf("skipReason = 'fetch-failed'");
  assert.ok(start > 0, '缺少 fetch-failed 分支');
  const end = SCRIPT.indexOf('exit 0', start);
  const block = SCRIPT.slice(start, end);
  assert.doesNotMatch(block, /Write-LocalSync/, 'fetch 失败分支不得写 data/_last-run.json');
  assert.doesNotMatch(block, /_last-run\.json/, 'fetch 失败分支不得碰 data/_last-run.json');
  assert.match(block, /Write-SyncState/);
  assert.match(block, /-FetchOk \$false/);
});

test('跳过轮写盘必须排在 fetch 与 at-origin 判定之后', () => {
  const start = SCRIPT.indexOf('function Publish-LocalSync');
  assert.ok(start > 0);
  const end = SCRIPT.indexOf('\ntry {', start);
  const body = SCRIPT.slice(start, end);
  const fetchAt = body.indexOf('Invoke-GitFetchRetry');
  const behindAt = body.indexOf('rev-list --count HEAD..origin/main');
  const writeAt = body.indexOf('Write-LocalSync $result');
  assert.ok(fetchAt >= 0, 'Publish-LocalSync 必须先 fetch');
  assert.ok(behindAt > fetchAt, '必须先判 at-origin');
  assert.ok(writeAt > behindAt, '写 data/_last-run.json 必须排在 fetch / at-origin 判定之后');
});

test('本地对齐哨兵：两脚本都点源 git-sync-lib，且只写 .local', () => {
  assert.match(SCRIPT, /git-sync-lib\.ps1/);
  assert.match(CLOSE, /git-sync-lib\.ps1/);
  assert.match(LIB, /\.local\\metrics/);
  assert.match(LIB, /sync-state\.json/);
  assert.match(LIB, /localFresh/);
  assert.match(LIB, /remoteRefStale/);
  assert.doesNotMatch(LIB, /_last-run\.json/, '哨兵不得写 data/_last-run.json');
});

test('收盘同步：pm 缺失时看 origin/main，不得断言「云端可能尚未生成」', () => {
  assert.match(CLOSE, /git cat-file -e/);
  assert.match(CLOSE, /"origin\/main:" \+ \$pmRel/);
  assert.match(CLOSE, /pmInRemote/);
  assert.match(CLOSE, /本地不是最新/);
  assert.doesNotMatch(CLOSE, /云端可能尚未生成/);
});
