# scripts\portfolio-collect-and-push.ps1
# 收盘快照 + 组合行情 + 宏观指标 → 提交数据 → 推送到 GitHub
#
# 由 minimax 定时任务在每个交易日 16:30（Asia/Shanghai）调用。
# 一轮里做两件事（两者的源互不重叠，一起失败才会是网络问题）：
#   1. 收盘快照：当天 A股 15:00 / 港股 16:00 的**官方收盘价**（data\snapshots\）
#      —— 不可覆盖的时点记录，事后可回溯补拉；
#   2. 组合行情（5 个新增 key）+ 宏观指标（5 项）→ quotes.json / macro\daily.json
#      —— 「最新价 + 日频」，会被下一次采集更新。
# 设计要点：
#   1. 采集本身是确定性脚本（src\snapshot.mjs / src\portfolio-collect.mjs），
#      不占用 AI 对话上下文；本脚本只负责「跑采集 → 有变化就提交 → 推送」。
#   2. 推送失败不致命：数据已提交在本地，下次运行会自动重试。
#      （GitHub 的 HTTPS 通道在本机被重置，走 SSH-443，靠仓库级
#        url.insteadOf 配置自动切换，不需要在这里改 remote URL。）
#   3. 与远端同步放在采集之前：远端有 Actions 自动提交，
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
        snapshotOk  = [bool]$snapOk
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

# ---- 1. 收盘快照（当天 15:00 A股 / 16:00 港股 的官方收盘价）----
# 用 --auto 而不是 --session pm：auto 会「缺哪档补哪档」，
# 所以 16:30 这一轮顺带把当天缺失的**上午盘快照**也补上（12:05 那轮没跑成时自愈）。
# 与组合行情放在同一个 16:30 任务里，是因为它们回答的是同一个问题：
# 「今天收盘时市场是什么价」。快照是**不可覆盖的时点记录**，
# 组合行情是「最新价 + 日频宏观」，两者互补但归档方式不同。
# 快照失败不阻断组合采集（两者的源不同，一个挂了另一个还能出数）。
$snapOut = & node src\snapshot.mjs --auto 2>&1 | Out-String
$snapExit = $LASTEXITCODE
$snapOut.TrimEnd() -split "`r?`n" | ForEach-Object { Say $_ }
$snapOk = ($snapExit -eq 0)
if (-not $snapOk) { Say "收盘快照采集失败（退出码 $snapExit），继续采集组合行情" }

# ---- 2. 采集组合行情 + 宏观 ----
$nodeOut = & node src\portfolio-collect.mjs 2>&1 | Out-String
$nodeExit = $LASTEXITCODE
$nodeOut.TrimEnd() -split "`r?`n" | ForEach-Object { Say $_ }
if ($nodeExit -ne 0) {
    Say "采集失败（退出码 $nodeExit），交由 16:35 的重试任务接手"
    Write-Status $nodeExit $false '采集失败，未进入推送阶段'
    exit 1
}

# ---- 3. 刷新服务端预生成的全量日K（data\kline\<key>_full.json）----
# 这是「直连源全部不可用时」的兜底：前端拿不到新浪/东财/腾讯时，
# 还能从 Pages 上读到全量日K（紧凑数组行），而不是只有 1000 根的近 4 年快照。
# 每天最多更新一次（脚本按 generatedAt 判断），所以这一步平时几乎不产生请求。
# 失败不阻断：它只是兜底，缺了只是少一条退路。
$fullOut = & node scripts\update-kline-full.mjs 2>&1 | Out-String
$fullExit = $LASTEXITCODE
$fullOut.TrimEnd() -split "`r?`n" | ForEach-Object { Say $_ }
if ($fullExit -ne 0) { Say "全量日K刷新失败（退出码 $fullExit），不影响本轮采集与推送" }

# ---- 4. 有变化才提交 ----
# 注意：不要写成 `git add ... 2>&1 | Out-Null`。
# PowerShell 5.1 下把原生命令的输出管道给 Out-Null 时该命令可能根本不执行，
# `$null =` 才是既执行又丢弃输出的正确写法。
# 这里 add 的是整个 data\：收盘快照（data\snapshots\）与组合行情（quotes.json /
# macro\daily.json）一起提交，避免两次提交互相踩。
$null = git add -- data
$dirty = @(git status --porcelain -- data)
if ($dirty.Count -eq 0) {
    Say '数据无变化，跳过提交与推送'
    Write-Status 0 $true ''
    exit 0
}
Say "检测到 $($dirty.Count) 个数据文件有变化"

# ---- 4. 提交 ----
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
$null = git commit -m "data: 收盘快照+组合行情+宏观采集（$stamp）"
if ($LASTEXITCODE -ne 0) { Say '提交失败'; Write-Status 0 $false 'git commit 失败'; exit 1 }
Say '已提交'

# ---- 5. 推送（最多两轮：被远端抢先就重新同步后再试） ----
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
