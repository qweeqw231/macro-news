# scripts/git-sync-lib.ps1
# 2.23.0 / 2.28.1：本机同步层的共享件（由 collect-and-push.ps1 / sync-close.ps1 点源引入）。
#
# 背景（2026-11-16 事故）：origin 走 ssh://git@ssh.github.com:443（insteadOf 改写），
# 该通道会被随机 reset。推送侧早就做了 6 次重试，fetch 侧却只有一次、失败即整轮跳过；
# 更糟的是失败分支还会写 data/ 下的状态文件却不提交，让工作区永久变脏，
# 把之后所有轮次（含 sync-close 的 ff-only）一起拖死。
#
# 本文件里的函数都**只写 .local/**，绝不写 data/：
#   1) Invoke-GitFetchRetry —— fetch 重试 + 退避
#   2) Write-SyncState      —— 「本地数据是否可用」的本地哨兵
#   3) Get-CloseBasisDirtyPaths / Get-PmSnapshotState —— 2.28.1 的脏判定与新鲜度判据
# 用途：即使 fetch 再失败，消费方也能从 .local/metrics/sync-state.json 一眼看出
# 「本地不是最新」，而不是对着旧截面猜。

function Say-Lib($m) {
    if (Get-Command Say -ErrorAction SilentlyContinue) { Say $m } else { Write-Host $m }
}

# ---- 2.28.1：脏判定与新鲜度判定的作用域 ----
# 旧口径是全树 `git status` + behind==0：并行开发会话的源码/测试/工作流改动、早报线持续改写的
# data/_briefing-status.json、data/history/index.json、data/index.json 都被算脏。
# 而云端每 15 分钟会提交「采集 6 件套」（_last-run/archive/index/latest/quotes/search），
# 本地只要其中一件脏，`git merge --ff-only` 就必然失败 ⇒ 17:00 消费端每天都拿到
# 「result=skipped-dirty + localFresh=false」，可当天 pm 其实早就在本地且合规。
#
# 新口径分两层，且都只盯「收盘基准」：
#   · 让路判据（CloseBasisPaths）：只有 data/snapshots 有未提交改动才跳过——那才是快照本体；
#   · 新鲜度判据（Get-PmSnapshotState）：当天 data/snapshots/<date>_pm.json 是否存在、
#     gate 是否 ok、有没有本地未提交改动、内容是否落后于 origin/main。
#     其它文件（quotes/latest/kline/新闻索引）的脏与落后只记录，不再让下游把当天标成「本地未同步」。
#   为什么 pm 之外的落地数据不参与：pm 快照本身就是收盘数字的固化结果；只有 pm 缺失时下游才退回
#   quotes.json，而那时 pm.exists=false ⇒ localFresh 照样是 false，保护伞没被拆掉。
$script:CloseBasisPaths = @('data/snapshots')

# 全树「受版本控制的未提交改动」（未跟踪文件不计：ff 不会覆盖它们）
function Get-GitDirtyPaths {
    param([string[]]$Pathspec = @())
    $gitArgs = @('status', '--porcelain', '--untracked-files=no')
    if ($Pathspec.Count -gt 0) { $gitArgs += '--'; $gitArgs += $Pathspec }
    $out = @(& git @gitArgs 2>$null)
    return @($out | ForEach-Object {
        if ($_ -match '^..\s+(.+)$') { $matches[1].Trim().Trim('"') }
    } | Where-Object { $_ } | Sort-Object -Unique)
}

# 收盘基准目录（data/snapshots）上的未提交改动 —— 只有它非空才让路
function Get-CloseBasisDirtyPaths {
    return @(Get-GitDirtyPaths -Pathspec $script:CloseBasisPaths)
}

# 当天收盘基准 data/snapshots/<date>_pm.json 的可用性（本地文件 + origin/main 对象 + 本地改动/落后）
# gate 口径与下游一致：date 匹配、isTradingDay、capturedAt >= 16:10
function Get-PmSnapshotState {
    param([string]$Root, [string]$Date)
    $rel = "data/snapshots/${Date}_pm.json"
    $res = [ordered]@{
        date = $Date; path = $rel
        exists = $false; capturedAt = ''; gate = ''
        inRemote = $false; remoteCapturedAt = ''; remoteGate = ''
        dirty = $false; drift = $false
    }
    $full = Join-Path $Root ($rel -replace '/', '\')
    if (Test-Path $full) {
        try {
            $doc = ConvertFrom-Json (Get-Content $full -Raw -Encoding UTF8)
            $res.exists = $true
            $res.capturedAt = [string]$doc.capturedAt
            $cap = [datetimeoffset]::Parse([string]$doc.capturedAt)
            $capMin = $cap.Hour * 60 + $cap.Minute
            $ok = ($doc.date -eq $Date) -and ($doc.isTradingDay -eq $true) -and ($capMin -ge (16 * 60 + 10))
            $res.gate = if ($ok) { 'ok' } else { 'pending' }
        } catch {
            $res.gate = 'unreadable'
        }
    }
    # 远端有没有：看 origin/main 对象，而不是本地工作树（本地落后时也要能分辨「没生成」和「没同步」）
    $null = & git cat-file -e ("origin/main:" + $rel) 2>$null
    if ($LASTEXITCODE -eq 0) {
        $res.inRemote = $true
        try {
            $raw = & git --no-pager cat-file blob ("origin/main:" + $rel) 2>$null | Out-String
            if (-not $raw.Trim()) { throw 'pm blob 为空（可能被分页器/管道吞掉）' }
            $rdoc = ConvertFrom-Json $raw
            $res.remoteCapturedAt = [string]$rdoc.capturedAt
            $rcap = [datetimeoffset]::Parse([string]$rdoc.capturedAt)
            $rcapMin = $rcap.Hour * 60 + $rcap.Minute
            $rok = ($rdoc.date -eq $Date) -and ($rdoc.isTradingDay -eq $true) -and ($rcapMin -ge (16 * 60 + 10))
            $res.remoteGate = if ($rok) { 'ok' } else { 'pending' }
        } catch {
            $res.remoteGate = 'unreadable'
        }
    }
    $res.dirty = (@(Get-GitDirtyPaths -Pathspec @($rel)).Count -gt 0)
    if ($res.exists -and $res.inRemote) {
        $out = @(& git diff --name-only HEAD origin/main -- $rel 2>$null)
        $res.drift = (@($out | Where-Object { $_ -match '\S' }).Count -gt 0)
    }
    return $res
}

# 单次 git 调用 + 停滞检测（不是固定总超时）。
# 为什么不用固定总超时：2026-11-16 夜间实测同一通道有两种形态 ——
#   · 限速：一次 fetch 只下 2~3 MB 就走不动，但仍在动（一次 17 MB 要 6 分钟）；
#   · 真停滞：整段时间一个字节都不动。
# 固定总超时会把前者误杀。判据改为「pack 字节数持续 StallSeconds 秒不变」才中止，另设 MaxSeconds 绝对上限。
# ConnectTimeout / ServerAlive* 只约束建连与会话保活，替代不了这一层。
# 注意：这里刻意用 .NET Process 而不是 Start-Process —— 后者在 PS 5.1 下
#   `$p.ExitCode` 恒为空（实测），会把「fetch 成功」误判成失败，导致整轮白让路。
# 返回 [ordered]@{ exitCode; out; timedOut; reason; bytes; elapsedSec }
function Invoke-GitWithTimeout {
    param(
        [Parameter(Mandatory)][string[]]$GitArgs,
        [int]$StallSeconds = 180,
        [int]$MaxSeconds = 600,
        [string]$ProgressDir = ''
    )
    $res = [ordered]@{ exitCode = 124; out = ''; timedOut = $false; reason = ''; bytes = 0; elapsedSec = 0 }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'git'
    $psi.Arguments = ($GitArgs -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.WorkingDirectory = (Get-Location).Path
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $start = Get-Date
    $watching = ($ProgressDir -ne '') -and (Test-Path $ProgressDir)
    try {
        $null = $proc.Start()
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        $lastSize = -1
        $lastChange = $start
        while (-not $proc.WaitForExit(5000)) {
            $now = Get-Date
            $packBytes = 0
            if ($watching) {
                try {
                    $packBytes = [int64]((Get-ChildItem $ProgressDir -Filter 'tmp_pack_*' -ErrorAction SilentlyContinue |
                        Measure-Object Length -Sum).Sum)
                } catch { }
            }
            $res.bytes = $packBytes
            if ($packBytes -gt $lastSize) { $lastSize = $packBytes; $lastChange = $now }
            $elapsed = ($now - $start).TotalSeconds
            $idle = ($now - $lastChange).TotalSeconds
            if ($watching -and $elapsed -ge $StallSeconds -and $idle -ge $StallSeconds) {
                $res.timedOut = $true
                $res.reason = "stalled：${StallSeconds}s 无数据增长（已收 $($res.bytes) 字节）"
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
            try { $null = & taskkill.exe /PID $proc.Id /T /F 2>&1 } catch { }
            try { $proc.Kill() } catch { }
            $null = $proc.WaitForExit(3000)
        } else {
            $res.exitCode = $proc.ExitCode
        }
        $res.elapsedSec = [int](((Get-Date) - $start).TotalSeconds)
        $stdout = ''
        $stderr = ''
        try { if ($outTask.Wait(3000)) { $stdout = [string]$outTask.Result } } catch { }
        try { if ($errTask.Wait(3000)) { $stderr = [string]$errTask.Result } } catch { }
        $res.out = (($stdout.TrimEnd() + "`n" + $stderr.TrimEnd()).Trim())
    } finally {
        try { $proc.Dispose() } catch { }
    }
    return $res
}

# fetch 重试：默认 3 次（间隔 5s / 15s）；单次用停滞检测（180s 无数据增长即中止，绝对上限 10 分钟）。
# 返回 [ordered]@{ ok; attempts; error; bytes; elapsedSec }
function Invoke-GitFetchRetry {
    param(
        [int]$Max = 3,
        [int[]]$BackoffSeconds = @(0, 5, 15),
        [int]$StallSeconds = 180,
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

# ---- 3.2.0：收盘基准的确定性降级阶梯 ----
# 2026-11-25 事故：本机休眠错过 16:18/16:33/16:48 三轮同步，唤醒补跑时 SSH-443 连接阶段被掐断，
# 而云端 16:14 早就生成并提交了当天 pm。结果 17:00 消费端只看到 localFresh=false，退回 15:08 的
# quotes（港股 16:00、上海金 15:30 两腿是盘中值）。之后验证 raw.githubusercontent.com 1.2s 就能取到
# 同一份 pm（28 KB），说明「拿不到 git」不等于「拿不到当天收盘」。
#
# 因此把降级顺序固定成五档，由 Resolve-CloseBasis 统一裁决，写进 sync-state 的 closeBasis：
#   local-pm          本地工作树里的当天 pm（门禁通过 + 无未提交改动 + 不落后 origin/main）  最可信
#   origin-main       fetch 成功，本地缺 pm（例如快照目录脏挡住 ff），读 origin/main 的 blob
#   http-raw          fetch 失败，改用 raw.githubusercontent.com 取当天 pm 并缓存到 .local/cache
#   origin-main-stale fetch 与反通道都失败，只能用本地 ref 的 blob；标 stale + refAt，让下游自行打折
#   quotes            当天 pm 完全拿不到，退回 data/quotes.json；标 partial（港股/黄金腿可能未收盘）
# 判据不放宽：pm 缺失、日期不符、capturedAt < 16:10、快照有未提交改动，都不会返回 local-pm。
$script:RemoteRepoSlug = 'qweeqw231/macro-news'
$script:RawSnapshotBase = 'https://raw.githubusercontent.com/' + $script:RemoteRepoSlug + '/main'

# 文件级反通道：直接 HTTP GET 当天 pm（不经过 git/SSH），成功后缓存到 .local/cache/snapshots/
# 返回 [ordered]@{ ok; url; fetchedAt; capturedAt; gate; path; sha256; bytes; error }
function Get-RemotePmViaHttp {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Date,
        [int]$TimeoutSec = 20
    )
    $rel = "data/snapshots/${Date}_pm.json"
    $url = "$script:RawSnapshotBase/$rel"
    $res = [ordered]@{ ok = $false; url = $url; fetchedAt = ''; capturedAt = ''; gate = ''; path = ''; sha256 = ''; bytes = 0; error = '' }
    try {
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $TimeoutSec
        if ($r.StatusCode -ne 200) { throw "HTTP $($r.StatusCode)" }
        $doc = ConvertFrom-Json $r.Content
        if ([string]$doc.date -ne $Date) { throw "date 不匹配：$($doc.date)" }
        $cap = [datetimeoffset]::Parse([string]$doc.capturedAt)
        $capMin = $cap.Hour * 60 + $cap.Minute
        $gate = 'pending'
        if (($doc.isTradingDay -eq $true) -and ($capMin -ge (16 * 60 + 10))) { $gate = 'ok' }

        $cacheDir = Join-Path $Root '.local\cache\snapshots'
        if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
        $cacheFile = Join-Path $cacheDir "${Date}_pm.json"
        $metaFile = Join-Path $cacheDir "${Date}_pm.meta.json"
        $enc = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($cacheFile, $r.Content, $enc)
        $meta = [ordered]@{
            date = $Date
            url = $url
            fetchedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            capturedAt = [string]$doc.capturedAt
            gate = $gate
            bytes = [int]$r.RawContentLength
            sha256 = (Get-FileHash $cacheFile -Algorithm SHA256).Hash.ToLower()
        }
        [System.IO.File]::WriteAllText($metaFile, (($meta | ConvertTo-Json -Compress) + "`n"), $enc)

        $res.fetchedAt = [string]$meta.fetchedAt
        $res.capturedAt = [string]$doc.capturedAt
        $res.gate = $gate
        $res.sha256 = [string]$meta.sha256
        $res.bytes = [int]$meta.bytes
        if ($gate -eq 'ok') {
            $res.ok = $true
            $res.path = $cacheFile
        } else {
            $res.error = "取到了当天 pm 但门禁未过（gate=$gate）"
        }
    } catch {
        $res.error = $_.Exception.Message
    }
    return $res
}

# 把 pm 内容落到 .local/cache/snapshots/ 下，供下游按统一 path 读取（不写 data/）
function Save-PmTextToCache {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Date,
        [Parameter(Mandatory)][string]$Text,
        [string]$Source = '',
        [string]$RefHead = '',
        [string]$RefAt = ''
    )
    $dir = Join-Path $Root '.local\cache\snapshots'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $file = Join-Path $dir "${Date}_pm.json"
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($file, $Text, $enc)
    $meta = [ordered]@{
        date = $Date
        source = $Source
        refHead = $RefHead
        refAt = $RefAt
        cachedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        sha256 = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    }
    [System.IO.File]::WriteAllText((Join-Path $dir "${Date}_pm.meta.json"), (($meta | ConvertTo-Json -Compress) + "`n"), $enc)
    return $file
}

# 统一的收盘基准裁决（五档）。PmState 可传入以避免重复 git 调用。
# 返回 [ordered]@{ date; tier; usable; partial; stale; source; path; ref; capturedAt; gate; fetchedAt; refAt; refHead; quotesGeneratedAt; reason }
function Resolve-CloseBasis {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Date,
        [bool]$FetchOk = $true,
        [object]$PmState = $null
    )
    $pm = $PmState
    if ($null -eq $pm) { $pm = Get-PmSnapshotState -Root $Root -Date $Date }

    $res = [ordered]@{
        date = $Date
        tier = 'unavailable'
        usable = $false
        partial = $false
        stale = $false
        source = ''
        path = ''
        ref = ''
        capturedAt = ''
        gate = ''
        fetchedAt = ''
        refAt = ''
        refHead = ''
        quotesGeneratedAt = ''
        reason = ''
    }
    if ($pm.inRemote) {
        $res.refHead = [string](& git rev-parse --short origin/main 2>$null | Select-Object -First 1)
        $res.refAt = [string](& git log -1 --format=%cI origin/main 2>$null | Select-Object -First 1)
    }

    # 1) 本地工作树：最可信
    if ($pm.exists -and $pm.gate -eq 'ok' -and (-not $pm.dirty) -and (-not $pm.drift)) {
        $res.tier = 'local-pm'; $res.usable = $true; $res.source = 'worktree'
        $res.path = (Join-Path $Root ($pm.path -replace '/', '\'))
        $res.capturedAt = $pm.capturedAt; $res.gate = $pm.gate
        $res.reason = '本地 pm 存在、门禁通过、无未提交改动、不落后 origin/main'
        return $res
    }

    # 2) 本轮 fetch 成功：origin/main 可信，本地缺 pm 时读 ref 里的 blob
    if ($FetchOk -and $pm.inRemote -and $pm.remoteGate -eq 'ok') {
        $res.tier = 'origin-main'; $res.usable = $true; $res.source = 'ref:origin/main'
        $res.ref = 'origin/main:' + $pm.path
        $res.capturedAt = $pm.remoteCapturedAt; $res.gate = $pm.remoteGate
        # 把 blob 落到 .local/cache，下游统一按 path 读，不必自己 git show
        try {
            $raw = & git --no-pager cat-file blob $res.ref 2>$null | Out-String
            if ($raw.Trim()) {
                $res.path = Save-PmTextToCache -Root $Root -Date $Date -Text $raw `
                    -Source 'ref:origin/main' -RefHead $res.refHead -RefAt $res.refAt
            }
        } catch { }
        $res.reason = 'fetch 成功但本地没有可用 pm；改用 origin/main 的 blob'
        return $res
    }

    # 3) fetch 失败：本地 ref 可能旧，先走文件级 HTTPS 反通道
    $http = Get-RemotePmViaHttp -Root $Root -Date $Date
    if ($http.ok) {
        $res.tier = 'http-raw'; $res.usable = $true; $res.source = 'https:raw.githubusercontent.com'
        $res.path = $http.path; $res.capturedAt = $http.capturedAt; $res.gate = $http.gate
        $res.fetchedAt = $http.fetchedAt
        $res.reason = 'git fetch 失败；用 raw.githubusercontent.com 直接取当天 pm（已缓存到 .local/cache）'
        return $res
    }

    # 4) 反通道也不通：只能退回本地 ref 的 blob，明确标 stale
    if ($pm.inRemote -and $pm.remoteGate -eq 'ok') {
        $res.tier = 'origin-main-stale'; $res.usable = $true; $res.stale = $true
        $res.source = 'ref:origin/main'
        $res.ref = 'origin/main:' + $pm.path
        $res.capturedAt = $pm.remoteCapturedAt; $res.gate = $pm.remoteGate
        try {
            $raw = & git --no-pager cat-file blob $res.ref 2>$null | Out-String
            if ($raw.Trim()) {
                $res.path = Save-PmTextToCache -Root $Root -Date $Date -Text $raw `
                    -Source 'ref:origin/main(stale)' -RefHead $res.refHead -RefAt $res.refAt
            }
        } catch { }
        $res.reason = "git fetch 与 HTTPS 反通道都失败；退回本地 ref 的 pm blob（ref 可能滞后，见 refAt；反通道错误：$($http.error)）"
        return $res
    }

    # 5) 当天 pm 完全拿不到：退回 quotes，并标明可能含盘中腿
    $quotesFull = Join-Path $Root 'data\quotes.json'
    if (Test-Path $quotesFull) {
        try {
            $q = ConvertFrom-Json (Get-Content $quotesFull -Raw -Encoding UTF8)
            $res.quotesGeneratedAt = [string]$q.generatedAt
            $res.source = 'worktree:data/quotes.json'
            $res.path = $quotesFull
        } catch { }
        $res.tier = 'quotes'; $res.partial = $true
        $res.reason = "当天 pm 本地/ref/反通道都不可用（反通道错误：$($http.error)）；退回 quotes，港股与上海金腿可能是盘中值"
    } else {
        $res.reason = "当天 pm 与 data/quotes.json 都不可用（反通道错误：$($http.error)）"
    }
    return $res
}

# 本地对齐状态哨兵（.local/metrics/sync-state.json，已 gitignore，不入库）
#   localFresh     = 2.28.1 起 =「当天收盘基准 data/snapshots/<date>_pm.json 是否可用」
#                    （存在 + gate ok + 本地无未提交改动 + 不落后 origin/main；
#                      旧口径依次是「整树 behind==0」「被消费路径干净」，都被无关脏/无关提交打成过 false）
#   remoteRefStale = 本轮 fetch 是否失败（true ⇒ 本地 origin/main ref 本身也是旧的）
#   remoteRefAt    = origin/main 这个 ref 最后一次被刷新成功的时刻（保留上一轮值）
#   consumedDirty  = 被消费路径上的未提交改动（本地改了没提交）
#   consumedDrift  = 被消费路径上 HEAD 与 origin/main 的差异（本地落后远端）
#   pm.*           = 当天 pm 快照的可用性，与 localFresh 解耦：
#                    消费端要判「今天能不能用 pm 收盘价」看 pm.available/ok，
#                    要判「本地被消费数据是否可信」看 localFresh —— 两件事不要互相替代。
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
        [bool]$LocalFresh = $false,
        [string[]]$CloseBasisDirty = @(),
        [bool]$PmDrift = $false,
        [string[]]$DirtyPaths = @(),
        [string]$PmDate = '',
        [bool]$PmAvailable = $false,
        [string]$PmCapturedAt = '',
        [string]$PmGate = '',
        [bool]$PmInRemote = $false,
        [object]$CloseBasis = $null
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
        # fetch 失败时远端不可知：pm 相关字段沿用上一轮，不拿「空值」冒充「云端没有」
        if (-not $FetchOk -and -not $PmDate -and $prev -and $prev.pm) {
            $PmDate = [string]$prev.pm.date
            $PmAvailable = [bool]$prev.pm.available
            $PmCapturedAt = [string]$prev.pm.capturedAt
            $PmGate = [string]$prev.pm.gate
            $PmInRemote = [bool]$prev.pm.inRemote
            $PmDrift = [bool]$prev.pm.drift
        }
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
            consumedDirty = @($CloseBasisDirty)
            # 全树脏清单只做诊断（最多 20 条），不参与 localFresh 判定
            dirtyPaths = @($DirtyPaths | Select-Object -First 20)
            pm = [ordered]@{
                date = $PmDate
                available = [bool]$PmAvailable
                capturedAt = $PmCapturedAt
                gate = $PmGate
                inRemote = [bool]$PmInRemote
                drift = [bool]$PmDrift
            }
            # 3.2.0：把「今天到底该用哪一档收盘基准」显式写出来，下游不必自己推断
            #   tier/usable/partial/stale/source/path/ref/capturedAt/fetchedAt/refAt/reason
            closeBasis = $CloseBasis
            note = '3.2.0 起 closeBasis 给出收盘基准的确定性档位（local-pm > origin-main > http-raw > origin-main-stale > quotes）；localFresh 仅在 local-pm 时为 true。'
        }
        $enc = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($file, (($doc | ConvertTo-Json -Compress) + "`n"), $enc)
    } catch {
        Say-Lib "sync-state: 写入失败（$($_.Exception.Message)）—— 不影响本轮结果"
    }
}
