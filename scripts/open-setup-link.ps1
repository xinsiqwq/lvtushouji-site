param(
  [string]$Origin = 'https://lvtushouji.xyz'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$credentialPath = Join-Path $projectRoot '.local-console/cloudflare-secrets.xml'

if (-not (Test-Path -LiteralPath $credentialPath)) {
  throw 'Encrypted secret backup .local-console/cloudflare-secrets.xml not found. Run scripts/provision-cloudflare-secrets.ps1 first.'
}

$protectedValues = Import-Clixml -LiteralPath $credentialPath
$plaintextJson = ([System.Net.NetworkCredential]::new('', $protectedValues)).Password
$parsed = $plaintextJson | ConvertFrom-Json
$plaintextJson = $null

$token = $parsed.SETUP_TOKEN
if (-not $token -or $token.Length -lt 32) {
  throw 'SETUP_TOKEN is missing or invalid in .local-console/cloudflare-secrets.xml.'
}

$setupUrl = "$($Origin.TrimEnd('/'))/__setup?token=$token"
$token = $null
Start-Process -FilePath $setupUrl | Out-Null
$setupUrl = $null

Write-Output 'Opened one-time setup page in your default browser. After setting the admin password, run: npx wrangler secret delete SETUP_TOKEN -c wrangler.production.jsonc'
