# start-frontend.ps1
# Starts the Vite dev server for the SEESOUND frontend.
# Node.js must be installed: https://nodejs.org

# Refresh PATH so Node.js is available in this session
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')

Write-Host ""
Write-Host "[SEESOUND] Starting Vite frontend on http://localhost:5173 ..." -ForegroundColor Magenta
Write-Host ""

Set-Location "$PSScriptRoot\frontend"

# Install dependencies if node_modules is missing
if (-Not (Test-Path 'node_modules')) {
    Write-Host "[SEESOUND] node_modules not found - installing dependencies ..." -ForegroundColor Yellow
    $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($pnpmCmd) {
        & pnpm install
    }
    else {
        Write-Host "[SEESOUND] pnpm not found - falling back to npm install ..." -ForegroundColor Yellow
        & npm install
    }
}

# Launch Vite directly via node (avoids pnpm/corepack PATH issues)
& node ".\node_modules\vite\bin\vite.js"
