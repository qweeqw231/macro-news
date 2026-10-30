# scripts\collect-and-push.ps1
# 采集 → 有变化就提交并推送 → GitHub Pages 自动更新
# 由 Windows 计划任务按固定周期调用；也可手动执行。

$ErrorActionPreference = 'Continue'

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

# ---- 1. 采集 ----
$nodeOut = & node src\collect.mjs 2>&1 | Out-String
$nodeOut.TrimEnd() -split "`r?`n" | ForEach-Object { Say $_ }
if ($LASTEXITCODE -ne 0) {
    Say "采集进程返回非 0（$LASTEXITCODE），仍尝试检查是否有新数据"
}

# ---- 2. 是否有变化 ----
# 注意：不要写成 `git add ... 2>&1 | Out-Null`。
# PowerShell 5.1 下把原生命令的输出管道给 Out-Null 时，该命令可能根本不执行
# （表现为 add 没生效、后续 commit 报 "no changes added to commit"）。
# `$null =` 才是既执行又丢弃输出的正确写法。
$null = git add -- data

$dirty = @(git status --porcelain -- data)
if ($dirty.Count -eq 0) {
    Say "无新数据，跳过提交与推送"
    exit 0
}

Say "检测到 $($dirty.Count) 个数据文件有变化"

# ---- 3. 提交 ----
# ⚠ 提交前必须先 fetch + merge：远端可能已经被别的链路（Actions / 另一台机器）推过提交，
#   不合并就直接 commit + push 会一直 non-fast-forward ⇒ **数据永远推不上去**。
#   冲突只可能出在 data/（两边都改了同一个数据文件）⇒ 用 -X ours 取**本地**版本：
#   本地跑的是新代码，与远端旧代码写出的同一份数据语义可能不同（口径以本地为准）。
$null = git fetch origin main
if ($LASTEXITCODE -eq 0) {
    $behind = [int](git rev-list --count HEAD..origin/main 2>$null)
    if ($behind -gt 0) {
        Say "远端领先 $behind 个提交，先合并（data/ 冲突取本地）"
        $null = git merge -X ours --no-edit origin/main
        if ($LASTEXITCODE -ne 0) {
            Say "合并失败，放弃本次提交（下次运行再试）"
            $null = git merge --abort
            exit 1
        }
    }
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
$null = git commit -m "data: 宏观资讯自动采集（$stamp）"
if ($LASTEXITCODE -ne 0) { Say "提交失败，跳过推送"; exit 1 }
Say "已提交"

# ---- 4.5 定期 gc：压缩仓库历史（长期体积的主要杠杆） ----
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

# ---- 4. 推送（带重试）----
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
