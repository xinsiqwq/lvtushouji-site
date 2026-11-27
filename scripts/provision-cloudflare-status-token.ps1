param(
  [ValidateSet('production', 'local')]
  [string]$Target = 'production',
  [string]$AccountId = '',
  [string]$ZoneId = '',
  [string]$WorkerName = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot 'wrangler.production.jsonc'
$wranglerPath = Join-Path $projectRoot 'node_modules/wrangler/bin/wrangler.js'
$devVarsPath = Join-Path $projectRoot '.dev.vars'

function ConvertFrom-SecureInput {
  param([Parameter(Mandatory = $true)][System.Security.SecureString]$SecureValue)
  return ([System.Net.NetworkCredential]::new('', $SecureValue)).Password
}

Write-Host ''
Write-Host '=== Cloudflare 状态面板 Token 安全配置工具 ===' -ForegroundColor Cyan
Write-Host '所需最小 API Token 权限清单：'
Write-Host '  - Account / Account Analytics : Read'
Write-Host '  - Account / Workers Scripts   : Read'
Write-Host '  - Account / Account Settings  : Read (自动识别 Account ID)'
Write-Host '  - Zone    / Zone              : Read'
Write-Host '  - Zone    / Analytics         : Read'
Write-Host '  - Zone    / Zone Settings     : Edit (Under Attack & 开发模式开关)'
Write-Host '  - Zone    / Cache Purge       : Purge (一键清理整站缓存)'
Write-Host ''

$secureToken = Read-Host '请粘贴 Cloudflare API Token（输入时自动隐藏）' -AsSecureString
$plainToken = (ConvertFrom-SecureInput -SecureValue $secureToken).Trim()
if ($plainToken.Length -lt 20) {
  throw 'CF_API_TOKEN 长度无效，请检查后重试。'
}

Push-Location $projectRoot
try {
  if ($Target -eq 'local') {
    $lines = if (Test-Path -LiteralPath $devVarsPath) {
      Get-Content -LiteralPath $devVarsPath
    } elseif (Test-Path -LiteralPath (Join-Path $projectRoot '.dev.vars.example')) {
      Get-Content -LiteralPath (Join-Path $projectRoot '.dev.vars.example')
    } else {
      @()
    }

    $updates = [ordered]@{ CF_API_TOKEN = $plainToken }
    if ($AccountId) { $updates['CF_ACCOUNT_ID'] = $AccountId.Trim() }
    if ($ZoneId) { $updates['CF_ZONE_ID'] = $ZoneId.Trim() }
    if ($WorkerName) { $updates['CF_WORKER_NAME'] = $WorkerName.Trim() }

    $outLines = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new()

    foreach ($line in $lines) {
      $matchedKey = $null
      foreach ($key in $updates.Keys) {
        if ($line -match "^$([regex]::Escape($key))=") {
          $matchedKey = $key
          break
        }
      }
      if ($matchedKey) {
        $outLines.Add("$matchedKey=$($updates[$matchedKey])")
        [void]$seen.Add($matchedKey)
      } else {
        $outLines.Add($line)
      }
    }

    foreach ($key in $updates.Keys) {
      if (-not $seen.Contains($key)) {
        $outLines.Add("$key=$($updates[$key])")
      }
    }

    Set-Content -LiteralPath $devVarsPath -Value $outLines -Encoding utf8NoBOM
    Write-Host "已写入本地 .dev.vars（已加入 .gitignore，不会提交到仓库）。重启 npm run dev 即可生效。" -ForegroundColor Green
    return
  }

  if (-not (Test-Path -LiteralPath $configPath)) {
    throw "未找到生产配置文件：$configPath"
  }
  if (-not (Test-Path -LiteralPath $wranglerPath)) {
    throw "未找到 Wrangler CLI：$wranglerPath（请先运行 npm ci）"
  }

  $plainToken | & node $wranglerPath secret put CF_API_TOKEN -c $configPath
  if ($LASTEXITCODE -ne 0) {
    throw "上传 CF_API_TOKEN 失败（exit code $LASTEXITCODE）。"
  }

  if ($AccountId) {
    $AccountId.Trim() | & node $wranglerPath secret put CF_ACCOUNT_ID -c $configPath
    if ($LASTEXITCODE -ne 0) { throw '上传 CF_ACCOUNT_ID 失败。' }
  }
  if ($ZoneId) {
    $ZoneId.Trim() | & node $wranglerPath secret put CF_ZONE_ID -c $configPath
    if ($LASTEXITCODE -ne 0) { throw '上传 CF_ZONE_ID 失败。' }
  }
  if ($WorkerName) {
    $WorkerName.Trim() | & node $wranglerPath secret put CF_WORKER_NAME -c $configPath
    if ($LASTEXITCODE -ne 0) { throw '上传 CF_WORKER_NAME 失败。' }
  }

  $verifyOutput = & node $wranglerPath secret list -c $configPath --format json
  if ($LASTEXITCODE -ne 0) {
    throw '无法核验已上传的生产密钥列表。'
  }
  $verifyText = ($verifyOutput -join "`n").Trim()
  $verifiedSecrets = if ($verifyText) { $verifyText | ConvertFrom-Json } else { @() }
  if (-not ($verifiedSecrets.name -contains 'CF_API_TOKEN')) {
    throw '核验失败：云端密钥列表未发现 CF_API_TOKEN。'
  }

  Write-Host 'CF_API_TOKEN 已安全注入 Cloudflare Workers 生产环境并完成核验。' -ForegroundColor Green
} finally {
  $plainToken = $null
  Pop-Location
}
