# scripts\briefing\run-ensure.ps1
# 早报兜底入口（供 Windows 计划任务 / mcode 调度调用）：
#   node scripts\briefing\ensure.mjs → 缺失当天只 prepare 输入快照（今天过 09:30 才补），
#   等待 LLM 写作；不再自动生成规则版。历史缺口只标 missed。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\briefing\run-ensure.ps1
#   powershell ... -File scripts\briefing\run-ensure.ps1 -Sync      # 先 pull 再补
#   powershell ... -File scripts\briefing\run-ensure.ps1 -DryRun    # 只看计划
#
# 日志：logs/briefing-YYYYMMDD.log（保留 14 天）
# 退出码原样透传：0 完整 / 1 有失败 / 2 已有进程在跑 / 124 超时

param(
    [switch]$Sync,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

# node 输出是 UTF-8，PowerShell 5.1 默认按 GBK 解码会乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir ("briefing-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))

Get-ChildItem $logDir -Filter 'briefing-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
    ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

function Say($m) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding UTF8
}

$argv = @()
if ($Sync) { $argv += '--sync' }
if ($DryRun) { $argv += '--dry-run' }

Say ("=== 早报兜底开始（{0}）===" -f ($argv -join ' '))
$out = & node scripts\briefing\ensure.mjs @argv 2>&1 | Out-String
$code = $LASTEXITCODE
$out.TrimEnd() -split "`r?`n" | ForEach-Object { Say $_ }
Say ("=== 结束，退出码 {0} ===" -f $code)
exit $code
