# scripts\sync-close.ps1
# 收盘前的「只读同步保障」——只做 fetch + merge --ff-only，不采集、不提交、不生成数据。
#
# 为什么需要它（2026-11-06 事故）：
#   dsh 的「交易日收盘复盘」在 17:00 只读本地文件，以 data/snapshots/<date>_pm.json
#   为当日收盘基准。云端 16:14 就生成了 pm，但本机 MacroNews-Pull 每 4 小时才同步一次
#   （落在 :11），17:00 时工作区还停在 15:54 ⇒ pm 文件不存在 ⇒ 下游退回 15:52 的
#   quotes.json，港股拿到 15:53 竞价前价、黄金拿到 15:23。
#
# 本脚本在 16:18 / 16:33 / 16:48 各跑一次（Windows 计划任务 MacroNews-Sync-*），
# 把远端已经提交的 pm 提前落到本地。它是只读的：失败就跳过，绝不覆盖工作区、不产生提交。
#
# 退出码：0 = 同步完成 / 已最新 / 安全跳过；1 = fetch 失败（网络）

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$logDir = Join-Path $root '.local\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir ("sync-close-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))

function Say($m) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding UTF8
}

$runStart = Get-Date
$ledgerDir = Join-Path $root '.local\metrics'
$ledgerFile = Join-Path $ledgerDir 'close-sync.jsonl'
$st = [ordered]@{
    at = ''
    host = $env:COMPUTERNAME
    result = 'failed'
    behind = $null
    ahead = $null
    headBefore = ''
    headAfter = ''
    pmExists = $false
    pmCapturedAt = ''
    pmGate = ''
    durationMs = 0
}

function Write-Ledger {
    try {
        $st.at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        $st.durationMs = [int]((Get-Date) - $runStart).TotalMilliseconds
        try {
            $h = [string](& git rev-parse --short HEAD 2>$null | Select-Object -First 1)
            if ($h) { $st.headAfter = $h }
        } catch { }
        if (-not (Test-Path $ledgerDir)) { New-Item -ItemType Directory -Path $ledgerDir -Force | Out-Null }
        $line = ($st | ConvertTo-Json -Compress)
        $enc = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::AppendAllText($ledgerFile, $line + "`n", $enc)
    } catch {
        try { Say "ledger: 写入失败（$($_.Exception.Message)）—— 不影响本轮结果" } catch { }
    }
}

Say '=== 收盘前同步（只读：fetch + ff-only）==='

function Invoke-Sync {
    $st.headBefore = [string](& git rev-parse --short HEAD 2>$null | Select-Object -First 1)
    if (-not $st.headBefore) { $st.headBefore = 'unknown' }

    # ---- 1. fetch ----
    $oldSsh = $env:GIT_SSH_COMMAND
    $env:GIT_SSH_COMMAND = 'ssh -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3'
    $fetchOut = & git fetch origin main 2>&1 | Out-String
    $fetchOk = ($LASTEXITCODE -eq 0)
    if ($null -eq $oldSsh) { Remove-Item Env:\GIT_SSH_COMMAND -ErrorAction SilentlyContinue }
    else { $env:GIT_SSH_COMMAND = $oldSsh }

    if (-not $fetchOk) {
        $first = ($fetchOut.Trim() -split "`r?`n" | Select-Object -First 1)
        $st.result = 'fetch-failed'
        Say "git fetch 失败（网络问题）：$first"
        return 1
    }

    # ---- 2. 只比较、只快进：不 stash、不 merge commit、不做任何写操作以外的动作 ----
    $st.behind = [int](& git rev-list --count HEAD..origin/main 2>$null)
    $st.ahead = [int](& git rev-list --count origin/main..HEAD 2>$null)
    Say "head=$($st.headBefore) behind=$($st.behind) ahead=$($st.ahead)"

    if ($st.ahead -gt 0) {
        # 本地有独有提交：ff 会失败，且任何合并都会改变历史 ⇒ 直接跳过，交给人工/采集任务
        $st.result = 'skipped-local-ahead'
        Say "本地有 $($st.ahead) 个独有提交，跳过（只读任务不做合并）"
    } elseif ($st.behind -eq 0) {
        $st.result = 'up-to-date'
        Say '本地已是最新'
    } else {
        $mergeOut = & git merge --ff-only origin/main 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            $first = ($mergeOut.Trim() -split "`r?`n" | Select-Object -First 1)
            $st.result = 'skipped-dirty'
            Say "快进失败（工作区有未提交改动），已安全跳过：$first"
        } else {
            $st.result = 'synced'
            $st.headAfter = [string](& git rev-parse --short HEAD 2>$null | Select-Object -First 1)
            Say "已快进 $($st.behind) 个提交 → $($st.headAfter)"
        }
    }

    # ---- 3. 只读体检：今天的 pm 到没到、能不能过消费方门禁 ----
    #    不写任何文件，只把结论写进日志与台账。
    $today = Get-Date -Format 'yyyy-MM-dd'
    $pmPath = Join-Path $root ("data\snapshots\{0}_pm.json" -f $today)
    if (Test-Path $pmPath) {
        try {
            $doc = ConvertFrom-Json (Get-Content $pmPath -Raw -Encoding UTF8)
            $st.pmExists = $true
            $st.pmCapturedAt = [string]$doc.capturedAt
            $cap = [datetimeoffset]::Parse([string]$doc.capturedAt)
            $capMin = $cap.Hour * 60 + $cap.Minute
            $gateOk = ($doc.date -eq $today) -and ($doc.isTradingDay -eq $true) -and ($capMin -ge (16 * 60 + 10))
            $st.pmGate = if ($gateOk) { 'ok' } else { 'pending' }
            Say "pm：$today 已到本地 · capturedAt=$($st.pmCapturedAt) · gate=$($st.pmGate)"
        } catch {
            $st.pmGate = 'unreadable'
            Say "pm：文件存在但解析失败（$($_.Exception.Message)）"
        }
    } else {
        $st.pmGate = 'missing'
        Say "pm：$today 还没有落到本地（云端可能尚未生成，等下一次 16:33 / 16:48）"
    }
    return 0
}

$code = 0
try {
    $code = Invoke-Sync
} finally {
    Write-Ledger
}

exit $code
