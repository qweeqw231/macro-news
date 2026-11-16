# scripts/git-sync-lib.ps1
# 2.23.0：本机同步层的两个共享件（由 collect-and-push.ps1 / sync-close.ps1 点源引入）。
#
# 背景（2026-11-16 事故）：origin 走 ssh://git@ssh.github.com:443（insteadOf 改写），
# 该通道会被随机 reset。推送侧早就做了 6 次重试，fetch 侧却只有一次、失败即整轮跳过；
# 更糟的是失败分支还会写 data/ 下的状态文件却不提交，让工作区永久变脏，
# 把之后所有轮次（含 sync-close 的 ff-only）一起拖死。
#
# 本文件里的两个函数都**只写 .local/**，绝不写 data/：
#   1) Invoke-GitFetchRetry —— fetch 重试 + 退避
#   2) Write-SyncState      —— 「本地是否与远端对齐」的本地哨兵
# 用途：即使 fetch 再失败，消费方也能从 .local/metrics/sync-state.json 一眼看出
# 「本地不是最新」，而不是对着旧截面猜。

function Say-Lib($m) {
    if (Get-Command Say -ErrorAction SilentlyContinue) { Say $m } else { Write-Host $m }
}

# 单次 git 调用 + 停滞检测（不是固定总超时）。
# 为什么不用固定总超时：2026-11-16 夜间实测同一通道有两种形态 ——
#   · 限速：一次 fetch 只下 2~3 MB 就走不动，但仍在动；
#   · 真停滞：整段时间一个字节都不动。
# 固定总超时会把前者误杀。判据改为「两个信号都不再变化」才中止：
#   ① `.git/objects/pack/tmp_pack_*` 字节数（网络侧进度）
#   ② git 的 stderr 输出（--progress 的进度行，含 index-pack 的 receiving/resolving）
# 不用 CPU 时间做信号：父 git 进程会周期性醒来，几毫秒的 tick 会不断重置计时器（实测导致判据失效）。
# 另设 MaxSeconds 绝对上限。ConnectTimeout / ServerAlive* 只约束建连与会话保活，替代不了这一层。
# 返回 [ordered]@{ exitCode; out; timedOut; reason; bytes; elapsedSec }
function Invoke-GitWithTimeout {
    param(
        [Parameter(Mandatory)][string[]]$GitArgs,
        [int]$StallSeconds = 120,
        [int]$MaxSeconds = 600,
        [string]$ProgressDir = ''
    )
    $res = [ordered]@{ exitCode = 124; out = ''; timedOut = $false; reason = ''; bytes = 0; elapsedSec = 0 }
    $tmpOut = [System.IO.Path]::GetTempFileName()
    $tmpErr = [System.IO.Path]::GetTempFileName()
    $start = Get-Date
    $watching = ($ProgressDir -ne '') -and (Test-Path $ProgressDir)
    try {
        $p = Start-Process -FilePath 'git' -ArgumentList $GitArgs -NoNewWindow -PassThru `
            -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
        $lastSig = -1
        $lastChange = $start
        while (-not $p.WaitForExit(5000)) {
            $now = Get-Date
            $packBytes = 0
            if ($watching) {
                try {
                    $packBytes = [int64]((Get-ChildItem $ProgressDir -Filter 'tmp_pack_*' -ErrorAction SilentlyContinue |
                        Measure-Object Length -Sum).Sum)
                } catch { }
            }
            $res.bytes = $packBytes
            $errBytes = 0
            try { $errBytes = (New-Object System.IO.FileInfo($tmpErr)).Length } catch { }
            $sig = $packBytes + $errBytes
            if ($sig -ne $lastSig) { $lastSig = $sig; $lastChange = $now }
            $elapsed = ($now - $start).TotalSeconds
            $idle = ($now - $lastChange).TotalSeconds
            if ($watching -and $elapsed -ge $StallSeconds -and $idle -ge $StallSeconds) {
                $res.timedOut = $true
                $res.reason = "stalled：${StallSeconds}s 无任何进展（已收 $($res.bytes) 字节）"
                break
            }
            if ($elapsed -ge $MaxSeconds) {
                $res.timedOut = $true
                $res.reason = "deadline：超过 ${MaxSeconds}s 仍未完成"
                break
            }
        }
        if ($res.timedOut) {
            # 连 ssh 子进程一起杀，避免留下占着连接的孤儿进程
            try { $null = & taskkill.exe /PID $p.Id /T /F 2>&1 } catch { }
            try { $p.Kill() } catch { }
        } else {
            $res.exitCode = $p.ExitCode
        }
        $res.elapsedSec = [int](((Get-Date) - $start).TotalSeconds)
        $stdout = ''
        $stderr = ''
        try { $stdout = [System.IO.File]::ReadAllText($tmpOut) } catch { }
        try { $stderr = [System.IO.File]::ReadAllText($tmpErr) } catch { }
        $res.out = (($stdout.TrimEnd() + "`n" + $stderr.TrimEnd()).Trim())
    } finally {
        Remove-Item $tmpOut, $tmpErr -Force -ErrorAction SilentlyContinue
    }
    return $res
}

# fetch 重试：默认 3 次（间隔 5s / 15s）；单次用停滞检测（120s 无字节/进度变化即中止，绝对上限 10 分钟）。
# 返回 [ordered]@{ ok; attempts; error; bytes; elapsedSec }
function Invoke-GitFetchRetry {
    param(
        [int]$Max = 3,
        [int[]]$BackoffSeconds = @(0, 5, 15),
        [int]$StallSeconds = 120,
        [int]$MaxSeconds = 600
    )
    $res = [ordered]@{ ok = $false; attempts = 0; error = ''; bytes = 0; elapsedSec = 0 }
    # 断点续传式残余：上次被中止的 tmp_pack_* 不会被 git 自动清理，这里顺手清掉（只在本仓库 .git 内）
    $packDir = Join-Path (Get-Location) '.git\objects\pack'
    if (Test-Path $packDir) {
        Get-ChildItem $packDir -Filter 'tmp_pack_*' -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }
    for ($i = 1; $i -le $Max; $i++) {
        $wait = if ($BackoffSeconds.Count -ge $i) { [int]$BackoffSeconds[$i - 1] } else { 15 }
        if ($i -gt 1 -and $wait -gt 0) {
            Say-Lib ("sync: fetch 第 {0}/{1} 次重试（等待 {2}s）" -f $i, $Max, $wait)
            Start-Sleep -Seconds $wait
        }
        $oldSsh = $env:GIT_SSH_COMMAND
        $env:GIT_SSH_COMMAND = 'ssh -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3'
        $run = Invoke-GitWithTimeout -GitArgs @('fetch', '--progress', 'origin', 'main') `
            -StallSeconds $StallSeconds -MaxSeconds $MaxSeconds -ProgressDir $packDir
        if ($null -eq $oldSsh) {
            Remove-Item Env:\GIT_SSH_COMMAND -ErrorAction SilentlyContinue
        } else {
            $env:GIT_SSH_COMMAND = $oldSsh
        }
        $res.attempts = $i
        $res.bytes = $run.bytes
        $res.elapsedSec = $run.elapsedSec
        if (-not $run.timedOut -and $run.exitCode -eq 0) {
            $res.ok = $true
            $res.error = ''
            return $res
        }
        if ($run.timedOut) {
            $res.error = "fetch 被中止（$($run.reason)）"
        } else {
            $lines = @($run.out -split "`r?`n" | Where-Object { $_ -match '\S' -and $_ -notmatch '^(所在位置|\s*\+|CategoryInfo|FullyQualifiedErrorId)' })
            $res.error = (($lines | Select-Object -First 2) -join ' | ')
        }
        Say-Lib ("sync: fetch 第 {0}/{1} 次失败（{2}s）：{3}" -f $i, $Max, $run.elapsedSec, $res.error)
    }
    return $res
}

# 本地对齐状态哨兵（.local/metrics/sync-state.json，已 gitignore，不入库）
#   localFresh     = 本地工作树是否已包含最近一次成功 fetch 的 origin/main
#   remoteRefStale = 本轮 fetch 是否失败（true ⇒ 本地 origin/main ref 本身也是旧的）
#   remoteRefAt    = origin/main 这个 ref 最后一次被刷新成功的时刻（保留上一轮值）
function Write-SyncState {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Result,
        [string]$Error = '',
        [int]$FetchAttempts = 0,
        [string]$Head = '',
        $Behind = $null,
        $Ahead = $null,
        [bool]$FetchOk = $true,
        [bool]$LocalFresh = $false
    )
    try {
        $dir = Join-Path $Root '.local\metrics'
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $file = Join-Path $dir 'sync-state.json'
        $prev = $null
        try { $prev = ConvertFrom-Json (Get-Content $file -Raw -Encoding UTF8 -ErrorAction Stop) } catch { }
        $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        $prevRefAt = ''
        if ($prev -and $prev.remoteRefAt) { $prevRefAt = [string]$prev.remoteRefAt }
        $refAt = $prevRefAt
        if ($FetchOk) { $refAt = $now }
        $doc = [ordered]@{
            updatedAt = $now
            source = $Source
            result = $Result
            localFresh = [bool]$LocalFresh
            remoteRefStale = (-not $FetchOk)
            remoteRefAt = $refAt
            head = $Head
            behind = $Behind
            ahead = $Ahead
            fetchAttempts = $FetchAttempts
            error = $Error
            note = '本地是否最新以本文件为准；origin/main 是本地 ref，fetch 失败时它本身就是旧的'
        }
        $enc = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($file, (($doc | ConvertTo-Json -Compress) + "`n"), $enc)
    } catch {
        Say-Lib "sync-state: 写入失败（$($_.Exception.Message)）—— 不影响本轮结果"
    }
}
