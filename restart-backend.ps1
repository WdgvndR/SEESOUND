# SEESOUND — Restart Backend
# Kills any process on port 8000, then starts uvicorn fresh.

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path

# Kill whatever is on port 8000
$raw = netstat -ano | Select-String ":8000\s.*LISTEN"
if ($raw) {
    $pid8k = ($raw -split "\s+")[-1]
    if ($pid8k -match "^\d+$") {
        Stop-Process -Id ([int]$pid8k) -Force -ErrorAction SilentlyContinue
        Write-Host "Killed old process (PID $pid8k) on port 8000."
        Start-Sleep -Seconds 1
    }
}
else {
    Write-Host "Port 8000 is free."
}

# Start uvicorn
$python = Join-Path $ROOT ".venv\Scripts\python.exe"
$backend = Join-Path $ROOT "backend"

Write-Host "Starting SEESOUND backend..."
Set-Location $backend
& $python -m uvicorn main:app --host 0.0.0.0 --port 8000
