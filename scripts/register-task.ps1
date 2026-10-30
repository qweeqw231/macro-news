# scripts\register-task.ps1
# 注册 / 更新 Windows 计划任务：定时采集并推送
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1              # 默认 30 分钟
#   powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Minutes 15  # 自定义
#   powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Full       # 每轮都刷日/周/月K
#   powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -MinuteKline # 顺带刷分钟K
#   powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Unregister  # 取消

param(
    [int]$Minutes = 30,
    [switch]$Full,
    [switch]$MinuteKline,
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$taskName = 'MacroNews-Collect'

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "已取消计划任务：$taskName" -ForegroundColor Yellow
    exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root 'scripts\collect-and-push.ps1'
$hidden = Join-Path $root 'scripts\run-hidden.vbs'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: 未找到 node，请先安装 Node.js" -ForegroundColor Red
    exit 1
}

# 先清掉旧的，避免重复注册
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# ⚠ 这两行把 -Full / -MinuteKline 真正传到 collect-and-push.ps1。
#   之前只在 param 里声明、却没拼进 Argument —— 开关是死的：
#   计划任务永远按默认「日K 陈旧度 6 小时」跑，分钟K 一次都不会刷。
$extra = @()
if ($Full) { $extra += '-KlineStaleHours' ; $extra += '0' }   # 0 = 每轮都刷日/周/月K
if ($MinuteKline) { $extra += '-MinuteKline' }

# ⚠ 用 wscript + run-hidden.vbs 启动，而不是直接 powershell.exe -WindowStyle Hidden：
#   后者仍会**先弹一下黑框**再隐藏（每 30 分钟闪一次）。
#   wscript.exe 是 GUI 子系统宿主，本身没有控制台；WshShell.Run 用 style 0
#   启动子进程 ⇒ 全程零窗口。
$argLine = "//nologo `"$hidden`" `"$script`""
if ($extra.Count -gt 0) { $argLine += ' ' + ($extra -join ' ') }

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $argLine -WorkingDirectory $root

# 每 $Minutes 分钟一次，从现在开始
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $Minutes)

# 允许错过的任务补跑、允许手动运行、不限制运行时长
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "宏观资讯台：定时采集 + 有变化则提交推送（每 $Minutes 分钟）" | Out-Null

Write-Host ""
Write-Host "✅ 计划任务已注册：$taskName" -ForegroundColor Green
Write-Host "   频率：每 $Minutes 分钟"
Write-Host "   脚本：$script"
Write-Host "   日志：$root\logs\"
Write-Host ""
Write-Host "查看状态：Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo"
Write-Host "立即试跑：Start-ScheduledTask -TaskName $taskName"
Write-Host "取消任务：powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Unregister"
