# scripts\snapshot-collect-and-push.ps1
# 时点快照采集 → 提交 → 推送到 GitHub
#
# 由 minimax 定时任务调用（默认每天 12:05，取上午盘收盘价）。
# 也可手工补拉：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\snapshot-collect-and-push.ps1 -Session pm
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\snapshot-collect-and-push.ps1 -Backfill 5
#
# 设计要点：
#   1. 采集本身是确定性脚本（src\snapshot.mjs），不占用 AI 对话上下文。
#      时点价一律取自 K 线（5 分钟 K / 日 K），所以**事后任意时刻都能补拉**：
#      设备断网几天后再跑一次，仍能还原那天的上午收盘价与收盘价。
#   2. 只提交 data\snapshots\ 目录，不碰其它数据文件（避免和别的链路互相覆盖）。
#   3. 推送失败不致命：数据已提交在本地，下次运行会自动重试。
#
# 退出码：0 = 成功（或无变化）；1 = 采集失败

param(
    [ValidateSet('am', 'pm', 'auto')]
    [string]$Session = 'auto',
    [int]$Backfill = 0,
    [string]$Date = ''
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir ("snapshot-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))

function Say($m) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding UTF8
}

# 只保留最近 14 天的日志
Get-ChildItem $logDir -Filter 'snapshot-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
    ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------------------
# 与远端同步。冲突时只处理 data/snapshots\，本地其它改动保留在工作区。
# ---------------------------------------------------------------------------
function Sync-Remote {
    $fetchOut = & git fetch origin main 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        Say "git fetch 失败（不影响采集，继续）：$(($fetchOut.Trim() -split "`r?`n" | Select-Object -First 1))"
        return $false
    }
    $behind = 0
    try { $behind = [int](git rev-list --count HEAD..origin/main 2>$null) } catch { $behind = 0 }
    if ($behind -le 0) { return $true }

    Say "本地落后远端 $behind 个提交，合并中"
    $mergeOut = & git merge --no-edit origin/main 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
        Say '合并完成（无冲突）'
        return $true
    }
    # 有冲突：快照目录取远端版本（远端更新的那份优先），本地改动保留在工作区
    Say '合并冲突：data/snapshots 取远端版本'
    $null = git checkout --theirs -- data/snapshots
    $null = git add -- data/snapshots
    $env:GIT_EDITOR = 'true'
    $null = git commit --no-edit
    if ($LASTEXITCODE -eq 0) {
        Say '已用远端版本解决 data/snapshots 冲突并完成合并'
        return $true
    }
    Say '冲突未能解决，放弃本次合并（本地改动保留在工作区）'
    $null = git merge --abort
    return $false
}

Say "=== 快照采集开始（session=$Session backfill=$Backfill date=$Date）==="

# ---- 0. 先同步远端 ----
$null = Sync-Remote

# ---- 1. 采集 ----
$argsList = @('src\snapshot.mjs')
if ($Backfill -gt 0) { $argsList += @('--backfill', "$Backfill") }
elseif ($Session -ne 'auto') {
    $argsList += @('--session', $Session)
    if ($Date) { $argsList += @('--date', $Date) }
}
# Session=auto 时不传参：脚本按当前北京时间判断该补哪些档（am 已到 11:35 / pm 已到 15:10），
# 缺哪档补哪档；已有的快照不会重写。
$nodeOut = & node @argsList 2>&1 | Out-String
$nodeExit = $LASTEXITCODE
$nodeOut.TrimEnd() -split "`r?`n" | ForEach-Object { Say $_ }
if ($nodeExit -ne 0) {
    Say "采集失败（退出码 $nodeExit）"
    exit 1
}

# ---- 2. 有变化才提交（只提交快照目录）----
$null = git add -- data/snapshots
$dirty = @(git status --porcelain -- data/snapshots)
if ($dirty.Count -eq 0) {
    Say '快照无变化，跳过提交与推送'
    exit 0
}
Say "检测到 $($dirty.Count) 个快照文件有变化"

# ---- 3. 提交 ----
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
$null = git commit -m "data: 时点快照 $Session（$stamp）"
if ($LASTEXITCODE -ne 0) { Say '提交失败'; exit 1 }
Say '已提交'

# ---- 4. 推送（最多两轮：被远端抢先就重新同步后再试） ----
for ($i = 1; $i -le 2; $i++) {
    $pushOut = & git push origin main 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
        Say "推送成功（第 $i 轮）"
        exit 0
    }
    Say "推送未成功（第 $i 轮）：$(($pushOut.Trim() -split "`r?`n" | Select-Object -First 1))"
    if ($i -lt 2) {
        Say '重新同步远端后再试一次'
        $null = Sync-Remote
    }
}

Say '推送失败（网络问题），快照已提交在本地，下次运行会自动重试'
exit 0
