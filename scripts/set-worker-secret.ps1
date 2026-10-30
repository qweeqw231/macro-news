# scripts\set-worker-secret.ps1
# 给 Cloudflare Worker 写 secret —— 不需要打开 dash.cloudflare.com
#
# 为什么需要它：
#   本机实测 dash.cloudflare.com 直接返回 403（即使挂代理），而 api.cloudflare.com 正常。
#   部署本身走的就是 API，所以写 secret 也直接走 API 即可。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\set-worker-secret.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\set-worker-secret.ps1 -Worker macro-news-cron -SecretName GITHUB_TOKEN
#
# 前提：本机已经用 `wrangler login` 授权过（凭据在 %TEMP%\xdg-config 或 ~/.wrangler）。
# 输入的值用 SecureString 读取，不回显、不写日志、不落盘。

param(
    [string]$Worker = 'macro-news-cron',
    [string]$SecretName = 'GITHUB_TOKEN'
)

$ErrorActionPreference = 'Stop'

# ---- 1. 找 wrangler 的 OAuth token ----
$candidates = @()
if ($env:XDG_CONFIG_HOME) { $candidates += Join-Path $env:XDG_CONFIG_HOME '.wrangler\config\default.toml' }
$candidates += Join-Path $env:TEMP 'xdg-config\.wrangler\config\default.toml'
$candidates += Join-Path $HOME '.wrangler\config\default.toml'
$cfg = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $cfg) {
    Write-Host "找不到 wrangler 凭据，请先执行：wrangler login" -ForegroundColor Red
    exit 1
}
$m = [regex]::Match((Get-Content $cfg -Raw), 'oauth_token\s*=\s*"([^"]+)"')
if (-not $m.Success) {
    Write-Host "凭据文件里没有 oauth_token：$cfg" -ForegroundColor Red
    exit 1
}
$cfToken = $m.Groups[1].Value
$headers = @{ Authorization = "Bearer $cfToken" }

# ---- 2. 账号 ----
$accounts = (Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/accounts' -Headers $headers).result
if (-not $accounts -or $accounts.Count -eq 0) {
    Write-Host "未取到 Cloudflare 账号" -ForegroundColor Red
    exit 1
}
$acc = $accounts[0].id

# ---- 3. 读取 secret 值（不回显）----
$secure = Read-Host "粘贴 $SecretName 的值后回车" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if ([string]::IsNullOrWhiteSpace($plain)) {
    Write-Host "值为空，已取消" -ForegroundColor Yellow
    exit 1
}

# ---- 3.5 先在 GitHub 侧验证：能不能真的触发 workflow ----
# 这一步会真实触发一次 collect 运行（也就顺便验证了端到端链路）。
# 验证失败就不往 Cloudflare 写，避免又出现「secret 存了但一直 401/403」的盲区。
$repoForTest = 'qweeqw231/macro-news'
$testUri = "https://api.github.com/repos/$repoForTest/actions/workflows/collect.yml/dispatches"
$ghHeaders = @{
    Authorization          = "Bearer $plain"
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'macro-news-secret-verify'
}
Write-Host "验证 token 能否触发 workflow_dispatch ..."
try {
    $resp = Invoke-WebRequest -Uri $testUri -Method Post -Headers $ghHeaders `
        -ContentType 'application/json' -Body '{"ref":"main"}' -UseBasicParsing -ErrorAction Stop
    if ($resp.StatusCode -ne 204) {
        Write-Host "token 验证失败：HTTP $($resp.StatusCode)" -ForegroundColor Red
        exit 1
    }
    Write-Host "OK token 有效（已触发一次 collect 运行）" -ForegroundColor Green
} catch {
    $code = 0
    $msg = $_.Exception.Message
    if ($_.Exception.Response) {
        $code = [int]$_.Exception.Response.StatusCode
        try {
            $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
            $msg = $reader.ReadToEnd()
        } catch { }
    }
    Write-Host "token 验证失败：HTTP $code" -ForegroundColor Red
    Write-Host "  $msg" -ForegroundColor Red
    Write-Host ""
    Write-Host "请检查 fine-grained token：Repository access 是否包含 $repoForTest；Permissions → Actions 是否为 Read and write。" -ForegroundColor Yellow
    exit 1
}

# ---- 4. 写入 ----
$uri = "https://api.cloudflare.com/client/v4/accounts/$acc/workers/scripts/$Worker/secrets"
$body = @{ name = $SecretName; text = $plain; type = 'secret_text' } | ConvertTo-Json
try {
    $res = Invoke-RestMethod -Uri $uri -Method Put -Headers $headers -ContentType 'application/json' -Body $body
} catch {
    Write-Host "写入失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    $plain = $null
}

# ---- 5. 回读验证（只列名字，不含值）----
$list = (Invoke-RestMethod -Uri $uri -Headers $headers).result
$names = ($list | ForEach-Object { $_.name }) -join ', '
Write-Host ""
Write-Host "OK 已写入 Worker=$Worker 的 secret" -ForegroundColor Green
Write-Host "   当前 secret 列表：$names"
Write-Host ""
Write-Host "下一步：等下一次 cron（每 15 分钟的第 07/22/37/52 分）去 GitHub Actions 页看 workflow_dispatch 运行。"
