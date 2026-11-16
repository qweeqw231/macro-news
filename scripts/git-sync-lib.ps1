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

# fetch 重试：默认 3 次（间隔 5s / 15s）。
# 返回 [ordered]@{ ok; attempts; error }
# 单次 git 调用 + 硬超时。
# 为什么必须硬超时：GIT_SSH_COMMAND 的 ConnectTimeout 只约束 TCP 连接，
# ServerAlive* 只在会话建立后生效；实测 2026-11-16 15:54 那一轮 fetch 卡了 178 秒才被 peer reset，
# 21:24 复测又卡了 2 分钟以上 —— 没有整体 deadline 时一次 fetch 可以把整轮/整档任务拖死。
# 返回 [ordered]@{ exitCode; out; timedOut }
function Invoke-GitWithTimeout {
    param(
        [Parameter(Mandatory)][string[]]$GitArgs,
        [int]$TimeoutSeconds = 90
    )
    $res = [ordered]@{ exitCode = 124; out = ''; timedOut = $false }
    $tmpOut = [System.IO.Path]::GetTempFileName()
    $tmpErr = [System.IO.Path]::GetTempFileName()
    try {
        $p = Start-Process -FilePath 'git' -ArgumentList $GitArgs -NoNewWindow -PassThru `
            -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
        if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
            $res.timedOut = $true
            # 连 ssh 子进程一起杀，避免留下占着连接的孤儿进程
            try { $null = & taskkill.exe /PID $p.Id /T /F 2>&1 } catch { }
            try { $p.Kill() } catch { }
        } else {
            $res.exitCode = $p.ExitCode
        }
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

# fetch 重试：默认 3 次（间隔 5s / 15s），每次硬超时 90s。
# 返回 [ordered]@{ ok; attempts; error }
function Invoke-GitFetchRetry {
    param(
        [int]$Max = 3,
        [int[]]$BackoffSeconds = @(0, 5, 15),
        [int]$TimeoutSeconds = 90
    )
    $res = [ordered]@{ ok = $false; attempts = 0; error = '' }
    for ($i = 1; $i -le $Max; $i++) {
        $wait = if ($BackoffSeconds.Count -ge $i) { [int]$BackoffSeconds[$i - 1] } else { 15 }
        if ($i -gt 1 -and $wait -gt 0) {
            Say-Lib ("sync: fetch 第 {0}/{1} 次重试（等待 {2}s）" -f $i, $Max, $wait)
            Start-Sleep -Seconds $wait
        }
        $oldSsh = $env:GIT_SSH_COMMAND
        $env:GIT_SSH_COMMAND = 'ssh -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3'
        $run = Invoke-GitWithTimeout -GitArgs @('fetch', 'origin', 'main') -TimeoutSeconds $TimeoutSeconds
        if ($null -eq $oldSsh) {
            Remove-Item Env:\GIT_SSH_COMMAND -ErrorAction SilentlyContinue
        } else {
            $env:GIT_SSH_COMMAND = $oldSsh
        }
        $res.attempts = $i
        if (-not $run.timedOut -and $run.exitCode -eq 0) {
            $res.ok = $true
            $res.error = ''
            return $res
        }
        if ($run.timedOut) {
            $res.error = "fetch 超过 ${TimeoutSeconds}s 未完成，已中止（硬超时）"
        } else {
            $lines = @($run.out -split "`r?`n" | Where-Object { $_ -match '\S' -and $_ -notmatch '^(所在位置|\s*\+|CategoryInfo|FullyQualifiedErrorId)' })
            $res.error = (($lines | Select-Object -First 2) -join ' | ')
        }
        Say-Lib ("sync: fetch 第 {0}/{1} 次失败：{2}" -f $i, $Max, $res.error)
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
