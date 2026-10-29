# scripts\pull-remote.ps1
# 从 GitHub 远端拉取最新的新闻（含标题与正文）与行情到本地工作区
#
# 由 minimax 定时任务定期调用（默认每 4 小时）。
#
# 设计要点：
#   1. 用 `git fetch` + `git merge --ff-only` 整体快进，而不是
#      `git restore --source=origin/main --worktree -- data`：
#      后者实测会留下「脏工作区 + untracked 文件」，反而阻塞下一次快进。
#   2. 快进失败（本地有未提交改动 / 有本地独有提交）→ **跳过并报告，绝不覆盖用户的工作区**。
#      拉取任务只做「只读同步」，任何破坏性操作一律不做。
#   3. 拉取方向是「远端 → 本地」，与 16:30 采集任务的「本地 → 远端」方向相反，互不覆盖。
#
# 退出码：0 = 同步完成或已最新（或安全跳过）；1 = fetch 失败（网络问题）

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir ("pull-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))

function Say($m) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding UTF8
}

$statusFile = Join-Path $logDir 'last-pull-status.json'
function Write-Status($state, $detail) {
    $obj = [ordered]@{
        at          = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
        state       = $state
        detail      = $detail
        quoteKeys   = 0
        archiveDays = 0
        latestItems = 0
        newCommits  = 0
    }
    try {
        $q = Get-Content (Join-Path $root 'data\quotes.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $obj.quoteKeys = @($q.quotes).Count
        $obj.archiveDays = @(Get-ChildItem (Join-Path $root 'data\archive') -Filter '*.json' -File).Count
        $l = Get-Content (Join-Path $root 'data\latest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $obj.latestItems = [int]$l.total
    } catch { }
    $json = $obj | ConvertTo-Json -Depth 4
    # 不用 Set-Content -Encoding UTF8：PowerShell 5.1 会写 BOM，Node 的 JSON.parse 遇到 BOM 会报错
    [System.IO.File]::WriteAllText($statusFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

Say '=== 拉取远端数据（新闻 + 行情）==='

# ---- 1. fetch ----
$fetchOut = & git fetch origin main 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Say "git fetch 失败（网络问题）：$(($fetchOut.Trim() -split "`r?`n" | Select-Object -First 1))"
    Write-Status 'fetch-failed' 'git fetch 失败'
    exit 1
}

# ---- 2. 比较本地与远端 ----
$behind = 0; $ahead = 0
try { $behind = [int](git rev-list --count HEAD..origin/main 2>$null) } catch { }
try { $ahead = [int](git rev-list --count origin/main..HEAD 2>$null) } catch { }

if ($ahead -gt 0) {
    Say "本地有 $ahead 个远端没有的提交，为避免历史分叉，本次不同步"
    Write-Status 'skipped' "本地有 $ahead 个独有提交"
    exit 0
}
if ($behind -eq 0) {
    Say '本地已是最新，无需同步'
    Write-Status 'up-to-date' ''
    exit 0
}

# ---- 3. 快进（ff-only：只前进，不产生合并提交，不覆盖未提交改动）----
$mergeOut = & git merge --ff-only origin/main 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Say "快进失败（本地工作区有未提交改动），已安全跳过，未改动任何文件"
    Write-Status 'skipped' '本地有未提交改动，未快进'
    exit 0
}

Say "已同步 $behind 个提交：$(($mergeOut.Trim() -split "`r?`n" | Where-Object { $_ -match 'Fast-forward|files? changed' } | Select-Object -First 1))"

# ---- 4. 报告本地现在有什么 ----
$q = Get-Content (Join-Path $root 'data\quotes.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$l = Get-Content (Join-Path $root 'data\latest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$days = @(Get-ChildItem (Join-Path $root 'data\archive') -Filter '*.json' -File).Count
Say "本地现状：行情 $($q.quotes.Count) 个 key · 新闻 $($l.total) 条 · 归档 $days 天"
Say "行情快照时间：$($q.generatedAt)"

Write-Status 'synced' "同步了 $behind 个提交"
exit 0
