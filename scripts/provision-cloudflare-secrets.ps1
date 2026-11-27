$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot 'wrangler.production.jsonc'
$credentialPath = Join-Path $projectRoot '.local-console/cloudflare-secrets.xml'
$wranglerPath = Join-Path $projectRoot 'node_modules/wrangler/bin/wrangler.js'

if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Missing production config: $configPath"
}
if (-not (Test-Path -LiteralPath $wranglerPath)) {
  throw "Missing wrangler CLI at: $wranglerPath"
}

function New-RandomHex32 {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function ConvertFrom-DpapiSecureString {
  param([Parameter(Mandatory = $true)][System.Security.SecureString]$SecureValue)
  return ([System.Net.NetworkCredential]::new('', $SecureValue)).Password
}

Push-Location $projectRoot
try {
  if (-not (Test-Path -LiteralPath $credentialPath)) {
    $existingOutput = & node $wranglerPath secret list -c $configPath --format json
    if ($LASTEXITCODE -ne 0) {
      throw 'Unable to inspect existing Cloudflare secrets for lvtushouji-site.'
    }
    $existingText = ($existingOutput -join "`n").Trim()
    $existingSecrets = if ($existingText) { $existingText | ConvertFrom-Json } else { @() }
    if ($existingSecrets.name -contains 'SESSION_SECRET') {
      throw 'Cloudflare already has SESSION_SECRET. Refusing to replace it without .local-console/cloudflare-secrets.xml.'
    }

    $secretObj = [ordered]@{
      SESSION_SECRET = New-RandomHex32
      SETUP_TOKEN    = New-RandomHex32
    }
    $secretJson = $secretObj | ConvertTo-Json -Compress
    $secretObj.Clear()

    New-Item -ItemType Directory -Path (Split-Path -Parent $credentialPath) -Force | Out-Null
    # SecureString uses this Windows user's DPAPI key; no plaintext secrets are written persistently.
    $secureJson = ConvertTo-SecureString -String $secretJson -AsPlainText -Force
    Export-Clixml -LiteralPath $credentialPath -InputObject $secureJson
    $secretJson = $null
  }

  $protectedValues = Import-Clixml -LiteralPath $credentialPath
  $plaintextJson = ConvertFrom-DpapiSecureString -SecureValue $protectedValues

  $tmpDir = Split-Path -Parent $credentialPath
  New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
  $tmpPath = Join-Path $projectRoot '.local-console\.tmp-secrets-upload.json'
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  $bytes = $utf8NoBom.GetBytes($plaintextJson)
  $plaintextJson = $null

  try {
    [System.IO.File]::WriteAllBytes($tmpPath, $bytes)
    [Array]::Clear($bytes, 0, $bytes.Length)

    & node $wranglerPath secret bulk $tmpPath -c $configPath
    $bulkExit = $LASTEXITCODE
    if ($bulkExit -ne 0) {
      throw "Cloudflare secret bulk failed with exit code $bulkExit."
    }
  } finally {
    $plaintextJson = $null
    if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if (Test-Path -LiteralPath $tmpPath) {
      try {
        [System.IO.File]::WriteAllBytes($tmpPath, (New-Object byte[] 256))
      } catch {
        # ignore overwrite failure before delete
      }
      Remove-Item -LiteralPath $tmpPath -Force
    }
    if (Test-Path -LiteralPath $tmpPath) {
      throw "Failed to delete temporary secrets file: $tmpPath"
    }
  }

  $verifyOutput = & node $wranglerPath secret list -c $configPath --format json
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to verify uploaded Cloudflare secrets.'
  }
  $verifyText = ($verifyOutput -join "`n").Trim()
  $verifiedSecrets = if ($verifyText) { $verifyText | ConvertFrom-Json } else { @() }
  if (-not ($verifiedSecrets.name -contains 'SESSION_SECRET') -or -not ($verifiedSecrets.name -contains 'SETUP_TOKEN')) {
    throw 'Cloudflare secret verification failed: expected SESSION_SECRET and SETUP_TOKEN to be present remotely.'
  }

  Write-Output 'Cloudflare production secrets provisioned and verified for lvtushouji-site (DPAPI recovery stored in .local-console/cloudflare-secrets.xml).'
} finally {
  Pop-Location
}
