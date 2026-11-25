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
  // 2.13.4：脏检测只看受版本控制的文件（2.23.0：实现移进 git-sync-lib.ps1）
  assert.match(LIB, /'status', '--porcelain', '--untracked-files=no'/);
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
  // 2.28.1：pm 探测抽到 lib 的 Get-PmSnapshotState，两个脚本共用
  assert.match(LIB, /git cat-file -e/);
  assert.match(LIB, /cat-file blob/);
  assert.doesNotMatch(LIB, /git show \("origin\/main:"/, 'git show 可能走分页器导致空输出');
  assert.match(CLOSE, /pmInRemote/);
  assert.match(CLOSE, /都不是远端最新/);
  assert.doesNotMatch(CLOSE, /云端可能尚未生成/);
});

test('2.23.1：behind/ahead 必须在同步之后重算，localFresh 不得用同步前的旧值', () => {
  // 收盘同步：ff 之后重新计数，且 localFresh 的赋值排在重算之后
  const mergeAt = CLOSE.indexOf('git merge --ff-only');
  const recalcAt = CLOSE.indexOf('同步后：head=');
  const freshAt = CLOSE.indexOf('$st.localFresh = ($st.closeBasis.tier');
  const basisCallAt = CLOSE.indexOf('Resolve-AndLogBasis -Date $today -FetchOk $true');
  assert.ok(mergeAt > 0 && recalcAt > mergeAt, 'ff 之后必须重算 behind/ahead');
  assert.ok(freshAt > 0, 'localFresh 必须来自 closeBasis 裁决');
  assert.ok(basisCallAt > recalcAt, '收盘基准必须在同步后按当时的真实状态裁决');
  // 写入的 head 必须是同步后的值
  assert.match(CLOSE, /\$stateHead = \$st\.headAfter/);

  // 采集侧：同样在同步后重算，并把重算值传给哨兵
  const cRecalc = SCRIPT.indexOf('$behindAfter = ');
  assert.ok(cRecalc > 0, 'collect 也必须在同步后重算 behind');
  assert.match(SCRIPT, /-Behind \$behindAfter/);
  assert.doesNotMatch(SCRIPT, /-LocalFresh \$true/, 'localFresh 不得硬编码为 true');
});

test('2.23.1：当天 pm 的可用性独立成 pm 子对象，与 localFresh 解耦', () => {
  assert.match(LIB, /pm = \[ordered\]@\{/);
  assert.match(LIB, /available = \[bool\]\$PmAvailable/);
  assert.match(LIB, /capturedAt = \$PmCapturedAt/);
  assert.match(LIB, /inRemote = \[bool\]\$PmInRemote/);
  assert.match(CLOSE, /-PmAvailable \(\$st\.pmExists -and \$st\.pmGate -eq 'ok'\)/);
});

test('2.28.1：脏判定收敛到 data/snapshots，无关脏不再让路', () => {
  // 让路判据只看收盘基准目录
  assert.match(LIB, /\$script:CloseBasisPaths = @\('data\/snapshots'\)/);
  assert.match(LIB, /function Get-CloseBasisDirtyPaths/);
  // 两个脚本都必须按该作用域判脏，而不是全树
  assert.match(SCRIPT, /Get-CloseBasisDirtyPaths/);
  assert.match(CLOSE, /Get-CloseBasisDirtyPaths/);
  assert.doesNotMatch(SCRIPT, /^.*git status --porcelain --untracked-files=no/m, '全树状态查询必须走 lib');
  // 收盘基准目录脏仍然整轮跳过
  assert.match(CLOSE, /if \(\$st\.closeBasisDirty\.Count -gt 0\) \{/);
  assert.match(CLOSE, /skipped-dirty-unrelated/);
  // 新鲜度只看当天 pm：存在 + gate ok + 无本地改动 + 不落后
  assert.match(LIB, /function Get-PmSnapshotState/);
  // 3.2.0：localFresh 收敛为「裁决结果是否为 local-pm」
  assert.match(LIB, /function Resolve-CloseBasis/);
  assert.match(CLOSE, /\$st\.localFresh = \(\$st\.closeBasis\.tier -eq 'local-pm'\)/);
  assert.match(SCRIPT, /\$localFreshAfter = \(\$basisAfter\.tier -eq 'local-pm'\)/);
  // 哨兵要把判据一起写出去，便于下游区分「无关脏」与「快照脏」
  assert.match(LIB, /consumedDirty = @\(\$CloseBasisDirty\)/);
  assert.match(LIB, /drift = \[bool\]\$PmDrift/);
});

test('3.2.0：收盘基准五档降级 + 文件级反通道（fetch 失败不再直接放弃）', () => {
  assert.match(LIB, /function Resolve-CloseBasis/);
  for (const tier of ['local-pm', 'origin-main', 'http-raw', 'origin-main-stale', 'quotes']) {
    assert.match(LIB, new RegExp(`'${tier}'`), `缺少档位 ${tier}`);
  }
  // 反通道：raw.githubusercontent + 缓存到 .local（绝不写 data/）
  assert.match(LIB, /function Get-RemotePmViaHttp/);
  assert.match(LIB, /raw\.githubusercontent\.com/);
  assert.match(LIB, /\.local\\cache\\snapshots/);
  assert.doesNotMatch(LIB, /WriteAllText[^\n]*data[\\/]snapshots/, 'pm 缓存不得写进 data/');
  // 哨兵必须把档位写出去
  assert.match(LIB, /closeBasis = \$CloseBasis/);
  assert.match(CLOSE, /-CloseBasis \$st\.closeBasis/);
  assert.match(SCRIPT, /-CloseBasis \$basisFail/);
  assert.match(SCRIPT, /-CloseBasis \$basisAfter/);
  // fetch 失败分支：先裁决档位，再返回
  const failAt = CLOSE.indexOf("result = 'fetch-failed'");
  const basisAt = CLOSE.indexOf('Resolve-AndLogBasis -Date (Get-Date -Format', failAt);
  assert.ok(failAt > 0 && basisAt > failAt, 'fetch 失败时也必须先裁决 closeBasis');
  const scriptFailAt = SCRIPT.indexOf("skipReason = 'fetch-failed'");
  const scriptBasisAt = SCRIPT.indexOf('Resolve-CloseBasis -Root $root', scriptFailAt);
  assert.ok(scriptBasisAt > scriptFailAt, '采集侧 fetch 失败时也必须裁决 closeBasis');
});

test('3.2.0：sync-close 单实例锁，休眠补跑不并发 fetch', () => {
  assert.match(CLOSE, /System\.Threading\.Mutex/);
  assert.match(CLOSE, /MacroNews-SyncClose/);
  assert.match(CLOSE, /另一个 sync-close 实例正在执行/);
  assert.match(CLOSE, /ReleaseMutex/);
});
