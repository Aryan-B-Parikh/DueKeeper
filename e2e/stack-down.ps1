$repo = Split-Path $PSScriptRoot -Parent

function Get-ListenerPid([int]$port) {
  $line = netstat -ano | Select-String "[:]$port\s+.*LISTENING" | Select-Object -First 1
  if ($line) { return ($line.Line.Trim() -split '\s+')[-1] }
  return $null
}

foreach ($port in @(8081, 3001)) {
  $pidToKill = Get-ListenerPid $port
  if ($pidToKill) {
    Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped $port (pid $pidToKill)"
  }
}
