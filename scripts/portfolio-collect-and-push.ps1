# scripts\portfolio-collect-and-push.ps1
# 组合行情 + 宏观指标采集 → 提交数据 → 推送到 GitHub
#
# 由 minimax 定时任务在每个交易日 16:30（Asia/Shanghai）调用。
# 设计要点：
#   1. 采集本身是确定性脚本（src\portfolio-collect.mjs），不占用 AI 对话上下文；
#      本脚本只负责「跑采集 → 有变化就提交 → 推送」，全程无 AI 参与。
#   2. 推送失败不致命：数据已提交在本地，下次运行会自动重试。
#      （GitHub 的 HTTPS 通道在本机被重置，走 SSH-443，靠仓库级
#        url.insteadOf 配置自动切换，不需要在这里改 remote URL。）
#   3. 与远端同步放在采集之前：远端每 5 分钟有 Actions 自动提交，
#      先同步再采集，本地提交就直接落在远端最新提交之上，推送时不必 rebase。
#
# 退出码：0 = 成功（或无变化）；1 = 采集失败（由 16:35 的重试任务接手）

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir ("portfolio-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))

function Say($m) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding UTF8
}

# 只保留最近 14 天的日志
Get-ChildItem $logDir -Filter 'portfolio-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
    ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------------------
# 与远端同步。冲突时 data/ 一律取远端版本（远端更新、本地只有 5 分钟内的差距），
# 本地尚未提交的改动保留在工作区，不会被丢弃。
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
    # 有冲突：data/ 取远端版本
    Say '合并冲突：data/ 取远端版本'
    $null = git checkout --theirs -- data
    $null = git add -- data
    $env:GIT_EDITOR = 'true'
    $null = git commit --no-edit
    if ($LASTEXITCODE -eq 0) {
        Say '已用远端版本解决 data/ 冲突并完成合并'
        return $true
    }
    Say '冲突未能解决，放弃本次合并（本地改动保留在工作区）'
    $null = git merge --abort
    return $false
}

Say '=== 组合采集开始 ==='

$startedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
$statusFile = Join-Path $logDir 'last-portfolio-status.json'

# 写状态文件（不提交，避免给 git 增加无意义变更）。
# 16:35 的重试任务靠它判断「16:30 那轮到底成功没有」。
function Write-Status($collectExit, $pushed, $pushError) {
    # 采集明细从 data\_last-run.json 取（那是采集脚本写的运行日志）
    $detail = [ordered]@{ quoteOk = @(); macroOk = @(); fail = @{} }
    $runFile = Join-Path $root 'data\_last-run.json'
    if (Test-Path $runFile) {
        try {
            $run = Get-Content $runFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($run.ok)       { $detail.quoteOk = @($run.ok) }
            if ($run.macroOk)  { $detail.macroOk = @($run.macroOk) }
            if ($run.fail)     { $detail.fail = $run.fail }
        } catch { }
    }
    $obj = [ordered]@{
        startedAt   = $startedAt
        finishedAt  = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
        collectExit = $collectExit
        collectOk   = ($collectExit -eq 0)
        quoteOk     = $detail.quoteOk
        macroOk     = $detail.macroOk
        fail        = $detail.fail
        pushed      = [bool]$pushed
        pushError   = $pushError
    }
    $json = $obj | ConvertTo-Json -Depth 5
    # 不用 Set-Content -Encoding UTF8：PowerShell 5.1 会写 BOM，
    # 而 Node 的 JSON.parse 遇到 BOM 会直接报错。
    [System.IO.File]::WriteAllText(
        $statusFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# ---- 0. 先同步远端 ----
$null = Sync-Remote

# ---- 1. 采集 ----
$nodeOut = & node src\portfolio-collect.mjs 2>&1 | Out-String
$nodeExit = $LASTEXITCODE
$nodeOut.TrimEnd() -split "`r?`n" | ForEach-Object { Say $_ }
if ($nodeExit -ne 0) {
    Say "采集失败（退出码 $nodeExit），交由 16:35 的重试任务接手"
    Write-Status $nodeExit $false '采集失败，未进入推送阶段'
    exit 1
}

# ---- 2. 有变化才提交 ----
# 注意：不要写成 `git add ... 2>&1 | Out-Null`。
# PowerShell 5.1 下把原生命令的输出管道给 Out-Null 时该命令可能根本不执行，
# `$null =` 才是既执行又丢弃输出的正确写法。
$null = git add -- data
$dirty = @(git status --porcelain -- data)
if ($dirty.Count -eq 0) {
    Say '数据无变化，跳过提交与推送'
    Write-Status 0 $true ''
    exit 0
}
Say "检测到 $($dirty.Count) 个数据文件有变化"

# ---- 3. 提交 ----
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
$null = git commit -m "data: 组合行情+宏观采集（$stamp）"
if ($LASTEXITCODE -ne 0) { Say '提交失败'; Write-Status 0 $false 'git commit 失败'; exit 1 }
Say '已提交'

# ---- 4. 推送（最多两轮：被远端抢先就重新同步后再试） ----
for ($i = 1; $i -le 2; $i++) {
    $pushOut = & git push origin main 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
        Say "推送成功（第 $i 轮），GitHub Pages 将在 1-2 分钟内更新"
        Write-Status 0 $true ''
        exit 0
    }
    Say "推送未成功（第 $i 轮）：$(($pushOut.Trim() -split "`r?`n" | Select-Object -First 1))"
    if ($i -lt 2) {
        Say '重新同步远端后再试一次'
        $null = Sync-Remote
    }
}

Say '推送失败（网络问题），数据已提交在本地，下次运行会自动重试'
Write-Status 0 $false 'git push 失败（数据已提交在本地，下次运行自动重试）'
exit 0
