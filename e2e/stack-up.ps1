param(
  [int]$ApiPort = 8081,
  [int]$WebPort = 3001,
  [switch]$FreshDb
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent

function Get-ListenerPid([int]$port) {
  $line = netstat -ano | Select-String "[:]$port\s+.*LISTENING" | Select-Object -First 1
  if ($line) { return ($line.Line.Trim() -split '\s+')[-1] }
  return $null
}

foreach ($port in @($ApiPort, $WebPort)) {
  $pidToKill = Get-ListenerPid $port
  if ($pidToKill) {
    Write-Host "Stopping existing listener on $port (pid $pidToKill)"
    Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Seconds 2

if ($FreshDb -and (Test-Path "$repo/server/.e2e")) {
  Remove-Item "$repo/server/.e2e" -Recurse -Force -ErrorAction SilentlyContinue
}

$jwt = node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
$enc = node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

$apiCmd = "set NODE_ENV=production&& set PORT=$ApiPort&& set DB_PATH=./.e2e/e2e.db&& set JWT_SECRET=$jwt&& set ENCRYPTION_KEY=$enc&& set APP_BASE_URL=https://e2e.local&& set WEB_APP_URL=http://localhost:$WebPort&& set CORS_ALLOWED_ORIGINS=http://localhost:$WebPort&& set ALLOW_LOCALHOST_E2E=1&& node dist/index.js > .e2e-server.log 2>&1"
Start-Process -FilePath cmd -ArgumentList "/c", $apiCmd -WorkingDirectory "$repo/server" -WindowStyle Hidden

$webCmd = "set PORT=$WebPort&& npm run start > .e2e-web.log 2>&1"
Start-Process -FilePath cmd -ArgumentList "/c", $webCmd -WorkingDirectory "$repo/web" -WindowStyle Hidden

function Wait-Ready([string]$url, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    try {
      $res = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 3
      if ($res.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 1
  }
  return $false
}

if (-not (Wait-Ready "http://localhost:$ApiPort/api/health" 30)) {
  Write-Host "API failed to start:"; Get-Content "$repo/server/.e2e-server.log" -Tail 10; exit 1
}
Write-Host "API ready on $ApiPort"

if (-not (Wait-Ready "http://localhost:$WebPort/login" 40)) {
  Write-Host "Web failed to start:"; Get-Content "$repo/web/.e2e-web.log" -Tail 10; exit 1
}
Write-Host "Web ready on $WebPort"
