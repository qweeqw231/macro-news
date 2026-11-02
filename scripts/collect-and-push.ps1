# scripts\collect-and-push.ps1
# 采集 → 有变化就提交并推送 → GitHub Pages 自动更新
# 由 Windows 计划任务按固定周期调用；也可手动执行。
#
# 参数：
#   -NoKline          完全跳过日/周/月 K 线（只要新闻，最快）
#   -MinuteKline      顺带刷新分钟 K（data/kline/min/）
#   -KlineStaleHours  日 K 快照超过这个小时数才补刷一次（默认 6；0 = 每轮都刷）
#   -NewsStaleMinutes 最新新闻超过这个分钟数才真正采集（默认 45；0 = 每轮都采）

param(
    [switch]$NoKline,
    [switch]$MinuteKline,
    [int]$KlineStaleHours = 6,
    [int]$NewsStaleMinutes = 45
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
#   briefings / history / snapshots / macro 不归本任务，绝不顺手提交。
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
}
foreach ($p in $fixed) {
    if (Test-Path $p) { $null = git add -- $p }
}

$staged = @(git diff --cached --name-only)
if ($staged.Count -eq 0) {
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
#   冲突只可能出在 data/（两边都改了同一份数据）⇒ -X ours 取**本地**版本：
#   本地跑的是新代码，与远端旧代码写出的同一份数据语义可能不同（口径以本地为准）。
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
$null = git commit -m "data: 宏观资讯自动采集（$stamp）"
if ($LASTEXITCODE -ne 0) { Say "提交失败，跳过推送"; exit 1 }
Say "已提交"

$null = git fetch origin main
if ($LASTEXITCODE -eq 0) {
    $behind = [int](git rev-list --count HEAD..origin/main 2>$null)
    if ($behind -gt 0) {
        Say "远端领先 $behind 个提交，合并（data/ 冲突取本地）"
        $null = git merge -X ours --no-edit origin/main
        if ($LASTEXITCODE -ne 0) {
            Say "合并失败，放弃本次推送（下次运行再试；数据已提交在本地）"
            $null = git merge --abort
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
        $null = git merge -X ours --no-edit origin/main
        if ($LASTEXITCODE -ne 0) {
            Say "合并失败，放弃重推（数据已存在本地提交里，下次运行会再推）"
            $null = git merge --abort
            break
        }
        Start-Sleep -Seconds 5
    }
}
if (-not $pushOk) {
    Say "推送未成功：数据已安全保存在本地提交里，下次运行会自动重试。"
}
