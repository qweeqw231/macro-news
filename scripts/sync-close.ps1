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

# 2.23.0：fetch 重试 + 本地对齐哨兵（只写 .local/）
. (Join-Path $PSScriptRoot 'git-sync-lib.ps1')

# 3.2.0：休眠唤醒时 Windows 会把错过的 16:18/16:33/16:48 三轮一起补跑
# （2026-11-25 实测三份日志在同一秒开始），并发 fetch 只会互相拖慢。
# 用命名互斥量保证同一时刻只有一个实例在跑，其余直接让路。
$mutex = New-Object System.Threading.Mutex($false, 'MacroNews-SyncClose')
$lockHeld = $false
try {
    $lockHeld = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    $lockHeld = $true   # 上一个实例被强杀，互斥量已归本进程
}
if (-not $lockHeld) {
    Say '另一个 sync-close 实例正在执行，本轮让路（并发 fetch 无收益）'
    exit 0
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
    # 2.23.0：pm 到底有没有生成，要看 origin/main 对象，而不是本地工作树
    pmInRemote = $false
    pmRemoteCapturedAt = ''
    pmRemoteGate = ''
    localFresh = $false
    # 2.28.1：被消费数据的脏/落后清单（localFresh 的唯一判据）
    closeBasisDirty = @()
    pmDrift = $false
    dirtyBlocking = @()
    # 3.2.0：当天收盘基准的确定性档位（五档，见 git-sync-lib.ps1 的 Resolve-CloseBasis）
    closeBasis = $null
    originMainHead = ''
    fetchAttempts = 0
    syncError = ''
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

# 3.2.0：体检 + 裁决当天收盘基准（五档），写进 $st 与日志。
#   FetchOk=false 时本地 origin/main ref 不可信，Resolve-CloseBasis 会优先走 HTTPS 反通道。
function Resolve-AndLogBasis {
    param([string]$Date, [bool]$FetchOk)
    $st.originMainHead = [string](& git rev-parse --short origin/main 2>$null | Select-Object -First 1)
    $pm = Get-PmSnapshotState -Root $root -Date $Date
    $st.pmExists = $pm.exists
    $st.pmCapturedAt = $pm.capturedAt
    $st.pmGate = $pm.gate
    $st.pmInRemote = $pm.inRemote
    $st.pmRemoteCapturedAt = $pm.remoteCapturedAt
    $st.pmRemoteGate = $pm.remoteGate
    $st.pmDrift = $pm.drift
    $st.closeBasis = Resolve-CloseBasis -Root $root -Date $Date -FetchOk $FetchOk -PmState $pm
    $st.localFresh = ($st.closeBasis.tier -eq 'local-pm')

    $pmRel = "data/snapshots/${Date}_pm.json"
    if ($pm.exists -and $pm.gate -eq 'ok') {
        Say "pm：$Date 已到本地 · capturedAt=$($pm.capturedAt) · gate=ok · localFresh=$($st.localFresh)"
        if ($pm.dirty) { Say "  localFresh=false · pm 有未提交改动：$pmRel" }
        if ($pm.drift) { Say "  localFresh=false · pm 落后 origin/main：$pmRel（origin 版 capturedAt=$($pm.remoteCapturedAt)）" }
    } elseif ($pm.exists) {
        Say "pm：文件存在但未过门禁 · capturedAt=$($pm.capturedAt) · gate=$($pm.gate)"
    } elseif ($pm.inRemote) {
        $st.pmGate = 'missing-local'
        Say "pm：$Date 在 origin/main 已存在（capturedAt=$($pm.remoteCapturedAt) · gate=$($pm.remoteGate)），本地没有"
    } else {
        $st.pmGate = 'missing'
        Say "pm：$Date 本地与 origin/main（$($st.originMainHead)）都没有（云端尚未生成或尚未提交）"
    }

    $cb = $st.closeBasis
    Say ("closeBasis: tier={0} usable={1} partial={2} stale={3} capturedAt={4}" -f `
        $cb.tier, $cb.usable, $cb.partial, $cb.stale, $cb.capturedAt)
    if ($cb.source) { Say "  basis source: $($cb.source)" }
    if ($cb.path) { Say "  basis path: $($cb.path)" }
    if ($cb.ref) { Say "  basis ref: $($cb.ref)（refAt=$($cb.refAt) refHead=$($cb.refHead)）" }
    if ($cb.fetchedAt) { Say "  basis fetchedAt: $($cb.fetchedAt)" }
    if ($cb.reason) { Say "  basis reason: $($cb.reason)" }
}

function Invoke-Sync {
    $st.headBefore = [string](& git rev-parse --short HEAD 2>$null | Select-Object -First 1)
    if (-not $st.headBefore) { $st.headBefore = 'unknown' }

    # ---- 1. fetch（2.23.0：SSH-443 会被随机 reset；2 次够用且能塞进 16:18→16:33 的档位）----
    $f = Invoke-GitFetchRetry -Max 2
    $st.fetchAttempts = $f.attempts

    if (-not $f.ok) {
        $st.result = 'fetch-failed'
        $st.syncError = $f.error
        Say "git fetch 失败（已重试 $($f.attempts) 次）：$($f.error)"
        Say "⚠ 本地工作树与本地 origin/main ref 都不是远端最新；本轮按五档降级裁决当天收盘基准"
        # 3.2.0：fetch 失败不再直接放弃——先走 HTTPS 反通道把当天 pm 取回来，
        #   取不到再标 stale / 退 quotes，让下游拿到确定的档位而不是一句「未同步」。
        Resolve-AndLogBasis -Date (Get-Date -Format 'yyyy-MM-dd') -FetchOk $false
        return 1
    }

    # ---- 2. 只比较、只快进：不 stash、不 merge commit、不做任何写操作以外的动作 ----
    $st.behind = [int](& git rev-list --count HEAD..origin/main 2>$null)
    $st.ahead = [int](& git rev-list --count origin/main..HEAD 2>$null)
    Say "head=$($st.headBefore) behind=$($st.behind) ahead=$($st.ahead)"

    # 2.28.1：让路判据只看「收盘基准本体」data/snapshots。
    #   旧口径是全树：并行会话的源码/测试/工作流改动、早报线的 data/index.json 等都会让 ff 失败，
    #   于是每天都写 skipped-dirty + localFresh=false，下游只能把当天标成「估（本地未同步）」。
    $st.closeBasisDirty = @(Get-CloseBasisDirtyPaths)
    $allDirty = @(Get-GitDirtyPaths)
    $unrelatedDirty = @($allDirty | Where-Object { $st.closeBasisDirty -notcontains $_ })
    if ($unrelatedDirty.Count -gt 0) {
        Say ("脏面：全树 {0} 个，其中 data/snapshots {1} 个；无关脏（只记录、不让路）：{2}" -f `
            $allDirty.Count, $st.closeBasisDirty.Count, (($unrelatedDirty | Select-Object -First 6) -join ', '))
    }

    if ($st.closeBasisDirty.Count -gt 0) {
        # 收盘基准目录本身有未提交改动 ⇒ 本地快照不可信，直接让路（不放宽核心保证）
        $st.result = 'skipped-dirty'
        Say ("data/snapshots 有 {0} 个未提交改动，跳过快进（不 stash、不合并）：" -f $st.closeBasisDirty.Count)
        foreach ($p in $st.closeBasisDirty) { Say "  脏(快照): $p" }
    } elseif ($st.ahead -gt 0) {
        # 本地有独有提交：ff 会失败，且任何合并都会改变历史 ⇒ 直接跳过，交给人工/采集任务
        $st.result = 'skipped-local-ahead'
        Say "本地有 $($st.ahead) 个独有提交，跳过（只读任务不做合并）"
    } elseif ($st.behind -eq 0) {
        $st.result = 'up-to-date'
        Say '本地已是最新'
    } else {
        $mergeOut = & git merge --ff-only origin/main 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            # 2.28.1：把**完整**阻断清单写进日志与台账（旧实现只留第一行，根本看不出被谁挡住）
            $mergeLines = @($mergeOut -split "`r?`n")
            $blocking = @($mergeLines | Where-Object { $_ -match '^\s+(\S.*)$' } |
                ForEach-Object { $_.Trim() } |
                Where-Object { $_ -and $_ -notmatch '^(Please|Aborting|Updating|\+|git\.exe|CategoryInfo|FullyQualifiedErrorId|所在位置)' } |
                Sort-Object -Unique)
            $st.dirtyBlocking = $blocking
            $basisBlocked = @($blocking | Where-Object {
                $p = $_
                ($script:CloseBasisPaths | Where-Object { $p -eq $_ -or $p.StartsWith($_ + '/') }).Count -gt 0
            })
            if ($basisBlocked.Count -gt 0) {
                $st.result = 'skipped-dirty'
                Say ("快进失败，阻断文件属于收盘基准目录（{0} 个）" -f $basisBlocked.Count)
            } else {
                # 阻断都来自无关路径：快照本体没被改，可用性另行由 pm 体检判定
                $st.result = 'skipped-dirty-unrelated'
                Say '快进失败，但阻断文件都不在 data/snapshots 内（无关脏），不影响本地收盘快照可用性'
            }
            if ($blocking.Count -gt 0) { foreach ($p in $blocking) { Say "  阻断: $p" } }
            else { Say ("  阻断: 无法解析 git 输出首行：{0}" -f (($mergeLines | Where-Object { $_ -match '\S' } | Select-Object -First 1))) }
        } else {
            $st.result = 'synced'
            $st.headAfter = [string](& git rev-parse --short HEAD 2>$null | Select-Object -First 1)
            Say "已快进 $($st.behind) 个提交 → $($st.headAfter)"
        }
    }

    # 2.23.1：behind/ahead 必须在同步之后再测一次。
    #   旧实现拿「同步前」的 behind 去算 localFresh：ff 成功后 HEAD 已经等于 origin/main，
    #   但 behind 仍留着 1，于是写出「result=synced + localFresh=false + behind=1」的自相矛盾
    #   （2026-11-17 消费端据此把当天数字标成「估（本地未同步）」）。
    $st.behind = [int](& git rev-list --count HEAD..origin/main 2>$null)
    $st.ahead = [int](& git rev-list --count origin/main..HEAD 2>$null)
    $st.headAfter = [string](& git rev-parse --short HEAD 2>$null | Select-Object -First 1)
    Say "同步后：head=$($st.headAfter) behind=$($st.behind) ahead=$($st.ahead)"

    # ---- 3. 只读体检 + 收盘基准裁决 ----
    #    不写工作区，只把结论写进日志、台账与 .local/metrics/sync-state.json。
    #    3.2.0：localFresh 只在 tier=local-pm 时为 true；其余档位由 closeBasis 显式给出，
    #    下游据 usable/partial/stale 判断能用到多准，而不是笼统地「未同步」。
    $today = Get-Date -Format 'yyyy-MM-dd'
    Resolve-AndLogBasis -Date $today -FetchOk $true
    return 0
}

$code = 0
try {
    $code = Invoke-Sync
} finally {
    Write-Ledger
    # 2.23.0：把「本地是否最新 / origin-main-ref 是否陈旧」写到 .local/metrics/sync-state.json
    # 2.23.1：head 用同步后的值；behind/ahead 也是同步后重算的；pm 可用性独立成 pm.* 子对象
    $stateHead = $st.headAfter
    if (-not $stateHead) { $stateHead = $st.headBefore }
    Write-SyncState -Root $root -Source 'sync-close.ps1' -Result $st.result `
        -Error $st.syncError -FetchAttempts $st.fetchAttempts -Head $stateHead `
        -Behind $st.behind -Ahead $st.ahead -FetchOk ($st.result -ne 'fetch-failed') -LocalFresh $st.localFresh `
        -CloseBasisDirty $st.closeBasisDirty -PmDrift $st.pmDrift `
        -DirtyPaths @(Get-GitDirtyPaths) `
        -PmDate (Get-Date -Format 'yyyy-MM-dd') `
        -PmAvailable ($st.pmExists -and $st.pmGate -eq 'ok') `
        -PmCapturedAt $st.pmCapturedAt -PmGate $st.pmGate -PmInRemote $st.pmInRemote `
        -CloseBasis $st.closeBasis
    if ($lockHeld) {
        try { $mutex.ReleaseMutex() } catch { }
        try { $mutex.Dispose() } catch { }
    }
}

exit $code
