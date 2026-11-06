# scripts\collect-and-push.ps1
# 采集 → 有变化就提交并推送 → GitHub Pages 自动更新
# 由 Windows 计划任务按固定周期调用；也可手动执行。
#
# 参数：
#   -NoKline          完全跳过日/周/月 K 线（只要新闻，最快）
#   -MinuteKline      顺带刷新分钟 K（data/kline/min/）
#   -KlineStaleHours  日 K 快照超过这个小时数才补刷一次（默认 6；0 = 每轮都刷）
#   -NewsStaleMinutes 最新新闻超过这个分钟数才真正采集（默认 45；0 = 每轮都采）
#   -SyncOnly         只做同步与守卫自检，不采集（临时仓库验证用）

param(
    [switch]$NoKline,
    [switch]$MinuteKline,
    [int]$KlineStaleHours = 6,
    [int]$NewsStaleMinutes = 45,
    # 只做同步与自检，不采集（用于临时仓库验证 2.4.16 的同步逻辑）
    [switch]$SyncOnly
)

$ErrorActionPreference = 'Continue'

# ⚠ 日志乱码修复：node 输出 UTF-8，而 PowerShell 5.1 默认按控制台代码页（GBK）解码，
#   结果是「[collect] 寮€濮?」这种乱码，出问题时根本没法看日志。
#   显式把原生进程输出流按 UTF-8 解码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir ("collect-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))

function Say($m) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding UTF8
}

# 只保留最近 14 天的日志，避免无限增长
Get-ChildItem $logDir -Filter 'collect-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
    ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

Say "=== 采集开始 ==="

# ---- 运行台账（2.4.22）----
# 每轮结束（成功/跳过/失败）向 .local/metrics/collect-runs.jsonl 追加一行 JSON。
# .local/ 已 gitignore；台账只用于自有管道用量的长期趋势，不入库、不进 data/。
# 写台账失败只告警，不影响主流程与退出码。
$runStart = Get-Date
$metricsDir = Join-Path $root '.local\metrics'
$ledgerFile = Join-Path $metricsDir 'collect-runs.jsonl'
$runMode = 'collect'
if ($SyncOnly) { $runMode = 'sync-only' }
$runStats = [ordered]@{
    at = ''
    host = $env:COMPUTERNAME
    mode = $runMode
    result = 'failed'
    headBefore = ''
    headAfter = ''
    behind = $null
    ahead = $null
    filesWritten = 0
    commitCreated = $false
    skipReason = ''
    syncResult = ''
    durationMs = 0
    # 2.9.0：跳过采集 = result 仍 ok，但 collected 必须是 false，不能再混成「成功采集」
    collected = $false
    quotesGeneratedAt = ''
    pmSnapshotExists = $false
    pmCapturedAt = ''
}

function Write-RunLedger {
    $prevCode = $LASTEXITCODE
    try {
        $runStats.at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        $runStats.durationMs = [int]((Get-Date) - $runStart).TotalMilliseconds
        # 账本要能自证「本轮行情是什么时点、今天的 pm 在不在本地」
        try {
            $qPath = Join-Path $root 'data\quotes.json'
            if (Test-Path $qPath) {
                $qDoc = ConvertFrom-Json (Get-Content $qPath -Raw -Encoding UTF8)
                if ($qDoc.generatedAt) { $runStats.quotesGeneratedAt = [string]$qDoc.generatedAt }
            }
            $todayStr = Get-Date -Format 'yyyy-MM-dd'
            $pmPath = Join-Path $root ("data\snapshots\{0}_pm.json" -f $todayStr)
            if (Test-Path $pmPath) {
                $runStats.pmSnapshotExists = $true
                $pmDoc = ConvertFrom-Json (Get-Content $pmPath -Raw -Encoding UTF8)
                if ($pmDoc.capturedAt) { $runStats.pmCapturedAt = [string]$pmDoc.capturedAt }
            }
        } catch { }
        try {
            $h = [string](& git rev-parse --short HEAD 2>$null | Select-Object -First 1)
            if ($h) { $runStats.headAfter = $h }
        } catch { }
        if (-not (Test-Path $metricsDir)) {
            New-Item -ItemType Directory -Path $metricsDir -Force | Out-Null
        }
        $line = ($runStats | ConvertTo-Json -Compress)
        $enc = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::AppendAllText($ledgerFile, $line + "`n", $enc)
    } catch {
        try { Say "ledger: 写入失败（$($_.Exception.Message)）—— 不影响本轮结果" } catch { }
    } finally {
        $LASTEXITCODE = $prevCode
    }
}

# ---- 0. 启动自检：确认写锁/成交量守卫已接线（缺失只告警，不停摆）----
function Get-GuardStatus {
    $lock = Join-Path $root 'src\kline-lock.mjs'
    $last = Join-Path $root 'scripts\update-kline-last.mjs'
    if (-not (Test-Path $lock) -or -not (Test-Path $last)) { return 'missing' }
    try {
        $txt = Get-Content $last -Raw -Encoding UTF8
        if ($txt -match 'upsertBars') { return 'ok' }
    } catch { }
    return 'missing'
}
function Say-Guard($phase) {
    $st = Get-GuardStatus
    if ($st -eq 'ok') {
        Say "guard:ok（$phase：src/kline-lock.mjs + update-kline-last/upsertBars）"
    } else {
        Say "🛡 guard:missing（$phase：src\kline-lock.mjs 缺失或 update-kline-last 未引用 upsertBars）—— 继续采集，但本轮可能缺少写锁/成交量保护"
    }
    return $st
}
$guardBefore = Say-Guard '启动'

# 2.4.17：把本机同步结果写进 data/_last-run.json 的 localSync 子对象
function Write-LocalSync($result) {
    $cli = Join-Path $root 'scripts\local-sync-write.mjs'
    if (-not (Test-Path $cli)) {
        Say "localSync: 写盘脚本缺失（$cli）"
        return $false
    }
    $out = & node $cli --root $root --result $result 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        $first = ($out.Trim() -split "`r?`n" | Select-Object -First 1)
        Say "localSync: 写入失败（$result）：$first"
        return $false
    }
    Say "localSync: $($out.Trim())"
    return $true
}

# 跳过轮只发布状态文件：仅在 HEAD 与 origin/main 同步时提交，不 merge、不 force
function Publish-LocalSync($result) {
    if (-not (Write-LocalSync $result)) { return }

    $oldSsh = $env:GIT_SSH_COMMAND
    $env:GIT_SSH_COMMAND = 'ssh -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3'
    $fetchOut = & git fetch origin main 2>&1 | Out-String
    $fetchOk = ($LASTEXITCODE -eq 0)
    if ($null -eq $oldSsh) {
        Remove-Item Env:\GIT_SSH_COMMAND -ErrorAction SilentlyContinue
    } else {
        $env:GIT_SSH_COMMAND = $oldSsh
    }
    if (-not $fetchOk) {
        Say "localSync:publish=offline（fetch 失败，状态仅写本地）"
        return
    }

    # 只有 HEAD == origin/main 才提交状态，避免在分叉/落后时制造无法推送的本地提交
    $behind = [int](& git rev-list --count HEAD..origin/main 2>$null)
    $ahead = [int](& git rev-list --count origin/main..HEAD 2>$null)
    if ($behind -ne 0 -or $ahead -ne 0) {
        Say "localSync:publish=skipped-not-at-origin（behind=$behind ahead=$ahead；状态仅写本地）"
        return
    }

    $null = git add -- data/_last-run.json
    $commitOut = & git commit -m "data: 本机同步跳过（$result）" -- data/_last-run.json 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        $first = ($commitOut.Trim() -split "`r?`n" | Select-Object -First 1)
        Say "localSync:publish=commit-failed（$first）"
        return
    }
    $runStats.commitCreated = $true
    $runStats.filesWritten = 1
    for ($i = 1; $i -le 2; $i++) {
        $pushOut = & git push origin main 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) {
            Say "localSync:publish=ok（$result）"
            return
        }
        if ($i -lt 2) { Start-Sleep -Seconds 5 }
        else {
            $first = ($pushOut.Trim() -split "`r?`n" | Select-Object -First 1)
            Say "localSync:publish=push-failed（$first；本地提交保留，下一轮再试）"
        }
    }
}

try {

# ---- 0.1 先同步再跑（2.4.16）----
# 底线：不做硬重置、不做路径级覆盖、不用 ours 合并策略、不强制推送。
# 同步失败/冲突时宁可本轮不采集，也不覆盖本地文件。
$headBefore = [string](& git rev-parse --short HEAD 2>$null | Select-Object -First 1)
if (-not $headBefore) { $headBefore = 'unknown' }
$runStats.headBefore = $headBefore

$unmerged = @(& git ls-files -u 2>$null)
if ($unmerged.Count -gt 0) {
    $runStats.result = 'skipped'
    $runStats.skipReason = 'unmerged'
    $runStats.syncResult = 'skipped:unmerged'
    Say "sync: head=$headBefore result=skipped:unmerged（存在未合并文件，先人工解决；本轮不采集）"
    if (-not $SyncOnly) { Publish-LocalSync 'skipped:unmerged' }
    exit 0
}

$dirtyPaths = @()
$dirtyPaths += @(& git diff --name-only 2>$null)
$dirtyPaths += @(& git diff --cached --name-only 2>$null)
$dirtyPaths = @($dirtyPaths | Where-Object { $_ } | Sort-Object -Unique)
$dirty = if ($dirtyPaths.Count -gt 0) { 'yes' } else { 'no' }

$oldSsh = $env:GIT_SSH_COMMAND
$env:GIT_SSH_COMMAND = 'ssh -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3'
$fetchOut = & git fetch origin main 2>&1 | Out-String
$fetchOk = ($LASTEXITCODE -eq 0)
if ($null -eq $oldSsh) {
    Remove-Item Env:\GIT_SSH_COMMAND -ErrorAction SilentlyContinue
} else {
    $env:GIT_SSH_COMMAND = $oldSsh
}

if (-not $fetchOk) {
    $first = ($fetchOut.Trim() -split "`r?`n" | Select-Object -First 1)
    $runStats.result = 'skipped'
    $runStats.skipReason = 'fetch-failed'
    $runStats.syncResult = 'skipped:fetch-failed'
    Say "sync: head=$headBefore behind=unknown ahead=unknown dirty=$dirty result=skipped:fetch-failed head_after=$headBefore stash=none（$first）"
    Say "同步失败，本轮不采集、不提交；下一轮重试。"
    if (-not $SyncOnly) {
        $null = Write-LocalSync 'skipped:fetch-failed'
        Say "localSync:publish=offline（fetch 失败，状态仅写本地）"
    }
    exit 0
}

$behind = [int](& git rev-list --count HEAD..origin/main 2>$null)
$ahead = [int](& git rev-list --count origin/main..HEAD 2>$null)
$runStats.behind = $behind
$runStats.ahead = $ahead

function Push-Stash($paths, $msg) {
    $out = & git stash push -m $msg -- $paths 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) { return $true }
    $first = ($out.Trim() -split "`r?`n" | Select-Object -First 1)
    Say "sync: stash 失败：$first"
    return $false
}
function Pop-Stash {
    $out = & git stash pop 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) { return $true }
    $first = ($out.Trim() -split "`r?`n" | Select-Object -First 1)
    Say "sync: stash pop 冲突（stash 保留，未强解）：$first"
    return $false
}

$headAfter = $headBefore
$stashState = 'none'
$syncResult = ''
$stashMsg = "macro-news sync $(Get-Date -Format 'yyyyMMdd-HHmmss')"

if ($behind -eq 0) {
    $syncResult = 'up-to-date'
} elseif ($ahead -eq 0) {
    $ok = $true
    if ($dirty -eq 'yes') {
        $ok = Push-Stash $dirtyPaths $stashMsg
        if ($ok) { $stashState = 'pending' }
    }
    if (-not $ok) {
        $syncResult = 'skipped:stash-failed'
    } else {
        $mergeOut = & git merge --ff-only origin/main 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            $first = ($mergeOut.Trim() -split "`r?`n" | Select-Object -First 1)
            Say "sync: ff-only 失败：$first"
            if ($stashState -eq 'pending') {
                if (Pop-Stash) { $stashState = 'restored' } else { $stashState = 'kept' }
            }
            if ($stashState -eq 'kept') { $syncResult = 'skipped:stash-pop-conflict' }
            else { $syncResult = 'skipped:ff-only-failed' }
        } else {
            $headAfter = [string](& git rev-parse --short HEAD 2>$null | Select-Object -First 1)
            if ($stashState -eq 'pending') {
                if (Pop-Stash) { $stashState = 'restored' } else { $stashState = 'kept' }
            }
            if ($stashState -eq 'kept') { $syncResult = 'skipped:stash-pop-conflict' }
            else { $syncResult = 'ff-only' }
        }
    }
} else {
    # 本地有未推提交且远端也前进：普通 merge，冲突则 abort，不覆盖任何本地提交
    $ok = $true
    if ($dirty -eq 'yes') {
        $ok = Push-Stash $dirtyPaths $stashMsg
        if ($ok) { $stashState = 'pending' }
    }
    if (-not $ok) {
        $syncResult = 'skipped:stash-failed'
    } else {
        $mergeOut = & git merge --no-edit origin/main 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            $first = ($mergeOut.Trim() -split "`r?`n" | Select-Object -First 1)
            Say "sync: merge 冲突，abort（本地提交保留，未 reset）：$first"
            $null = & git merge --abort 2>&1
            if ($stashState -eq 'pending') {
                if (Pop-Stash) { $stashState = 'restored' } else { $stashState = 'kept' }
            }
            if ($stashState -eq 'kept') { $syncResult = 'skipped:stash-pop-conflict' }
            else { $syncResult = 'skipped:merge-conflict' }
        } else {
            $headAfter = [string](& git rev-parse --short HEAD 2>$null | Select-Object -First 1)
            if ($stashState -eq 'pending') {
                if (Pop-Stash) { $stashState = 'restored' } else { $stashState = 'kept' }
            }
            if ($stashState -eq 'kept') { $syncResult = 'skipped:stash-pop-conflict' }
            else { $syncResult = 'merge' }
        }
    }
}

Say ("sync: head={0} behind={1} ahead={2} dirty={3} result={4} head_after={5} stash={6}" -f `
    $headBefore, $behind, $ahead, $dirty, $syncResult, $headAfter, $stashState)
$runStats.syncResult = $syncResult

if ($syncResult -like 'skipped:*') {
    $runStats.result = 'skipped'
    $runStats.skipReason = ($syncResult -replace '^skipped:', '')
    if (-not $SyncOnly) { Publish-LocalSync $syncResult }
    Say "同步未完成（$syncResult），本轮不采集、不提交；下一轮重试。"
    exit 0
}

# 同步成功：把结果写进 localSync（成功轮重置 consecutiveSkips）
if (-not $SyncOnly) {
    $lsResult = $syncResult
    if ($syncResult -eq 'ff-only' -and $stashState -eq 'restored') { $lsResult = 'stash-restored' }
    if ($syncResult -eq 'merge' -and $stashState -eq 'restored') { $lsResult = 'stash-restored' }
    $null = Write-LocalSync $lsResult
}

# 同步更新了代码/HEAD 时再复核一次守卫（旧代码检查已在启动时做过）
if ($headAfter -ne $headBefore -or $guardBefore -eq 'missing') {
    $null = Say-Guard '同步后'
}

if ($SyncOnly) {
    $runStats.result = 'ok'
    $runStats.skipReason = 'sync-only'
    Say "sync-only：结束（不采集）"
    exit 0
}

# ---- 1. 陈旧度判定：云端还活着就不重复采 ----
# 云端 collect.yml 每 15 分钟一轮（另有 30 分钟备份 cron）。本机每 120 分钟一轮，
# 默认只在「新闻已经超过 45 分钟没更新」时才真正采集：
#   · 云端正常 → 本机跳过，省掉 8 个源 + 行情的请求，也不产生空提交；
#   · 云端停摆（2026-10-30 实测排程器丢掉 3.75 小时的 schedule 事件）→ 45 分钟后本机接管。
# 判据看 latest.json 的**最新条目时间**，而不是 _last-run.json 的 startedAt：
# 采集器内容没变时不重写文件（省 git），startedAt 在安静时段会显得很旧。
$latestFile = Join-Path $root 'data\latest.json'
$newsAgeMin = $null
if (Test-Path $latestFile) {
    try {
        $latest = ConvertFrom-Json (Get-Content $latestFile -Raw -Encoding UTF8)
        $newest = $latest.items | Sort-Object { [double]$_.ts } -Descending | Select-Object -First 1
        if ($newest) {
            if ($newest.ts) {
                $t = ([datetime]'1970-01-01T00:00:00Z').AddSeconds([int64]$newest.ts).ToLocalTime()
            } else {
                $t = [datetime]$newest.time
            }
            $newsAgeMin = [math]::Round(((Get-Date) - $t).TotalMinutes, 0)
        }
    } catch {
        Say "latest.json 解析失败：$($_.Exception.Message)"
    }
}

$needCollect = $true
if ($null -ne $newsAgeMin -and $newsAgeMin -lt 0) {
    # 最新条目「在未来」= 本机或远端的时钟不同步。若照常按「新鲜」跳过，本机兜底会永远不跑。
    Say "最新条目时间在未来（$newsAgeMin 分钟），时钟可能不同步 —— 按陈旧处理，本机接管采集"
} elseif ($null -ne $newsAgeMin -and $NewsStaleMinutes -gt 0 -and $newsAgeMin -lt $NewsStaleMinutes) {
    $needCollect = $false
    Say "最新条目 $newsAgeMin 分钟前（阈值 $NewsStaleMinutes），云端链路在线，跳过新闻/行情采集"
} elseif ($null -eq $newsAgeMin) {
    Say "读不到最新条目时间，本机直接采集"
} else {
    Say "最新条目 $newsAgeMin 分钟前（阈值 $NewsStaleMinutes），本机接管采集"
}

# 2.9.0：把「是否真的采集」写进账本。以前跳过采集时，只要 _last-run.json 有变化
# 就会记成 result=ok + filesWritten=1 + skipReason=""，事后完全看不出没采。
$runStats.collected = $needCollect
if (-not $needCollect) { $runStats.skipReason = 'news-fresh' }

if ($needCollect) {
    # ⚠ 一律带 --no-kline：日/周/月 K 由第 2 步按「陈旧度」单独刷。
    #   每轮都刷 K 线的话，每轮要打 21×3=63 个请求，本机 IP 会被东财打到熔断，
    #   而且慢 8 倍（602 秒 vs 1~2 分钟）—— 定时任务的性价比全毁在这里。
    $nodeOut = & node src\collect.mjs --no-kline 2>&1 | Out-String
    $nodeOut.TrimEnd() -split "`r?`n" | ForEach-Object { Say $_ }
    if ($LASTEXITCODE -ne 0) {
        Say "采集进程返回非 0（$LASTEXITCODE），仍尝试检查是否有新数据"
    }
}

# ---- 2. 日/周/月 K（按陈旧度刷，不是每轮都刷）----
# ⚠ GitHub 的 kline-full.yml 每天刷一次；本机这一份是**兜底**：
#   万一 Actions 的排程器再抽风（2026-10-30 曾连续 3.75 小时不产生任何 schedule 事件），
#   本机任务至少能把日 K 顶到「几天内」的新鲜度。
if (-not $NoKline) {
    $klineDir = Join-Path $root 'data\kline'
    $newest = Get-ChildItem $klineDir -Filter '*.json' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    $ageHours = if ($newest) { [math]::Round(((Get-Date) - $newest.LastWriteTime).TotalHours, 1) } else { 999 }
    if ($KlineStaleHours -gt 0 -and $ageHours -lt $KlineStaleHours) {
        Say "日/周/月K 快照还新鲜（$ageHours 小时前刷过，阈值 $KlineStaleHours 小时），跳过"
    } else {
        Say "刷新日/周/月K（21 标的 × 3 周期；本机可能被东财限流，失败则保留旧快照）……"
        $kOut = & node src\collect.mjs --kline-only 2>&1 | Out-String
        $kOut.TrimEnd() -split "`r?`n" | ForEach-Object { Say $_ }
        if ($LASTEXITCODE -ne 0) { Say "K线刷新返回非 0（$LASTEXITCODE），旧快照保留" }
    }
}

# ---- 3. 分钟 K（可选）----
#   欧日韩指数 / 上海金 / 伦敦银的分钟K **只有东财一个源**，
#   客户端直连失败时只能靠这份服务端预生成快照 ⇒ 本机这条是「客户端直连不通」时的救命稻草。
if ($MinuteKline) {
    Say "刷新分钟K（data/kline/min/）……"
    $mOut = & node scripts\update-kline-minute.mjs 2>&1 | Out-String
    $mOut.TrimEnd() -split "`r?`n" | ForEach-Object { Say $_ }
    if ($LASTEXITCODE -ne 0) { Say "分钟K刷新返回非 0（$LASTEXITCODE），旧快照保留" }
}

# ---- 4. 只暂存采集链路自己生成的文件（白名单）----
# 注意：不要写成 `git add ... 2>&1 | Out-Null`。
# PowerShell 5.1 下把原生命令的输出管道给 Out-Null 时，该命令可能根本不执行
# （表现为 add 没生效、后续 commit 报 "no changes added to commit"）。
# `$null =` 才是既执行又丢弃输出的正确写法。
#
# ⚠ 以前是 `git add -- data`（整个目录）：任何落在 data/ 下的意外产物都会被打包推送。
#   2026-11-02 实测：2.2.1 模拟误写的规则版早报与 _briefing-status.json 就是这样上的远端。
#   现在只提交本任务真正会写的文件：
#     · data/archive/<今天|昨天>.json（按需新建；其余日期由云端采集提交）
#     · data/kline/**（已跟踪文件的更新；新标的文件由云端 kline-full.yml 提交）
#     · latest / index / search / quotes / _last-run
#     · _briefing-status.json（早报兜底状态，单文件、低频；页脚要读它才看得见）
#   briefings 只放行「今天/昨天」的单个已存在文件（2.4.2：publish 漏推时兜底）；
#   **绝不整目录 add data/briefings**；history / snapshots / macro 不归本任务。
$today = Get-Date -Format 'yyyy-MM-dd'
$yesterday = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd')
$fixed = @(
    'data/latest.json', 'data/index.json', 'data/search.json',
    'data/quotes.json', 'data/_last-run.json', 'data/_briefing-status.json'
)
# -u 只暂存「已跟踪文件」的修改，不会把未跟踪的意外新增文件扫进来
$null = git add -u -- data/archive data/kline
foreach ($d in @($today, $yesterday)) {
    $p = "data/archive/$d.json"
    if (Test-Path $p) { $null = git add -- $p }
    # 2.4.2 兜底：只提交当天/昨天已存在的早报文件（不整目录 add）
    $bp = "data/briefings/$d.json"
    if (Test-Path $bp) { $null = git add -- $bp }
}
foreach ($p in $fixed) {
    if (Test-Path $p) { $null = git add -- $p }
}

$staged = @(git diff --cached --name-only)
$runStats.filesWritten = $staged.Count
if ($staged.Count -eq 0) {
    $runStats.result = 'skipped'
    $runStats.skipReason = if ($needCollect) { 'no-data-changes' } else { 'news-fresh' }
    Say "无新数据，跳过提交与推送"
    exit 0
}

Say "检测到 $($staged.Count) 个数据文件有变化"

# ---- 5. 先提交，再合并（顺序不能反）----
# ⚠ 2026-10-30 实测：原顺序是「先 fetch+merge，后 commit」，但脚本在合并前已经
#   `git add -- data`，索引里带着未提交的改动，而远端也在改同一批 data 文件 ⇒
#   git merge 直接拒绝：
#     error: Your local changes to the following files would be overwritten by merge
#     Please commit your changes or stash them before you merge.
#   合并失败 → 脚本「放弃本次提交」→ 本机备份一条都推不上去。
#   正确顺序：**先 commit（工作区变干净），再 fetch+merge**。
#   2.4.16：去掉 ours 合并策略。普通 merge；冲突就 abort + 记日志 + 放弃本轮推送，
#   本地提交保留，下一轮重试（必要时人工处理）。绝不强制推送或重置覆盖。
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
$null = git commit -m "data: 宏观资讯自动采集（$stamp）"
if ($LASTEXITCODE -ne 0) {
    $runStats.result = 'failed'
    $runStats.skipReason = 'commit-failed'
    Say "提交失败，跳过推送"
    exit 1
}
$runStats.commitCreated = $true
Say "已提交"

$null = git fetch origin main
if ($LASTEXITCODE -eq 0) {
    $behind = [int](git rev-list --count HEAD..origin/main 2>$null)
    if ($behind -gt 0) {
        Say "远端领先 $behind 个提交，普通合并（冲突则 abort，保留本地提交）"
        $mergeOut = & git merge --no-edit origin/main 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            $first = ($mergeOut.Trim() -split "`r?`n" | Select-Object -First 1)
            $runStats.result = 'failed'
            $runStats.skipReason = 'merge-conflict'
            Say "合并冲突，abort：$first（本地提交保留；下一轮重试，必要时人工处理）"
            $null = & git merge --abort 2>&1
            exit 1
        }
    }
}

# ---- 6. 定期 gc：压缩仓库历史（长期体积的主要杠杆） ----
# 每 200 次提交做一次。git 对相似 JSON 的 delta 压缩率约 80%，
# 不 gc 的话松散对象会无限累积。
$commitCount = [int](git rev-list --count HEAD 2>$null)
if ($commitCount -gt 0 -and ($commitCount % 200) -eq 0) {
    Say "达到 $commitCount 次提交，执行 git gc 压缩仓库"
    $null = git gc --quiet --auto
    $gitMB = [math]::Round(((Get-ChildItem (Join-Path $root '.git') -Recurse -File -Force |
        Measure-Object Length -Sum).Sum / 1MB), 2)
    Say "gc 完成，.git 当前 ${gitMB} MB"
}

# ---- 7. 推送（带重试）----
# ⚠ SSH-443 会被随机 reset（实测：连续 4 次失败、第 5 次成功是常态）⇒ 必须重试。
#   重试前再 fetch + merge 一次：失败的这段时间里远端可能又前进了
#   （Actions 的其它链路也在推），不合并就是 non-fast-forward，推一百次也推不上去。
# 注意：PowerShell 会把 git 的 stderr 包装成错误文本，
# 必须以 $LASTEXITCODE 判断成败，不能看有没有红色输出。
$pushOk = $false
for ($i = 1; $i -le 6; $i++) {
    $pushOut = & git push origin main 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
        Say "推送成功（第 $i 次），GitHub Pages 将在 1-2 分钟内更新"
        $pushOk = $true
        break
    }
    $firstLine = ($pushOut.TrimEnd() -split "`r?`n" | Select-Object -First 1)
    Say "推送失败（第 $i 次）：$firstLine"
    if ($i -lt 6) {
        $null = git fetch origin main
        $mergeOut = & git merge --no-edit origin/main 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            $first = ($mergeOut.Trim() -split "`r?`n" | Select-Object -First 1)
            $runStats.result = 'failed'
            $runStats.skipReason = 'merge-conflict'
            Say "合并冲突，abort，放弃重推（本地提交保留）：$first"
            $null = & git merge --abort 2>&1
            break
        }
        Start-Sleep -Seconds 5
    }
}
if (-not $pushOk) {
    $runStats.result = 'failed'
    if (-not $runStats.skipReason) { $runStats.skipReason = 'push-failed' }
    Say "推送未成功：数据已安全保存在本地提交里，下次运行会自动重试。"
} else {
    $runStats.result = 'ok'
}

} finally {
    Write-RunLedger
}
