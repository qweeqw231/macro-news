# scripts\register-pull-task.ps1
# 注册 / 更新 Windows 计划任务：每 N 小时把远端数据拉回本机
#
# 取代原来的 minimax「4 小时同步」任务：纯本地 git 操作，不依赖任何外部配额。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\register-pull-task.ps1            # 默认 4 小时
#   powershell -ExecutionPolicy Bypass -File scripts\register-pull-task.ps1 -Hours 2
#   powershell -ExecutionPolicy Bypass -File scripts\register-pull-task.ps1 -Unregister

param(
    [int]$Hours = 4,
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$taskName = 'MacroNews-Pull'

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "已取消计划任务：$taskName" -ForegroundColor Yellow
    exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root 'scripts\pull-remote.ps1'
$hidden = Join-Path $root 'scripts\run-hidden.vbs'

# 与采集任务同样的零窗口启动方式（wscript 是 GUI 宿主，不会先闪一下黑框）
$argLine = "//nologo `"$hidden`" `"$script`""
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $argLine -WorkingDirectory $root

# 从现在开始，每 $Hours 小时一次
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours $Hours)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$params = @{
    TaskName    = $taskName
    Action      = $action
    Trigger     = $trigger
    Settings    = $settings
    Description = "宏观资讯台：每 $Hours 小时从远端快进同步数据（只读，不覆盖工作区）"
}
Register-ScheduledTask @params | Out-Null

Write-Host ""
Write-Host "✅ 计划任务已注册：$taskName" -ForegroundColor Green
Write-Host "   频率：每 $Hours 小时"
Write-Host "   脚本：$script"
Write-Host "   日志：$root\logs\pull-*.log"
Write-Host ""
Write-Host "查看状态：Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo"
Write-Host "立即试跑：Start-ScheduledTask -TaskName $taskName"
Write-Host "取消任务：powershell -ExecutionPolicy Bypass -File scripts\register-pull-task.ps1 -Unregister"
