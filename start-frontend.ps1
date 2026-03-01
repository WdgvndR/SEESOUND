# start-frontend.ps1
# Starts the Vite dev server for the SEESOUND frontend.
# Node.js must be installed: https://nodejs.org
# Dependencies must be installed first — see README or run install-frontend.ps1

# Refresh PATH so Node.js is available in this session
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')

Write-Host "`n[SEESOUND] Starting Vite frontend on http://localhost:5173 ...`n" -ForegroundColor Magenta
Set-Location "$PSScriptRoot\frontend"

# Install dependencies if node_modules is missing
if (-Not (Test-Path 'node_modules')) {
    Write-Host '[SEESOUND] node_modules not found — installing dependencies ...`n' -ForegroundColor Yellow
    # Use corepack pnpm (bundled with Node v24+)
    corepack pnpm install
}

# Launch Vite directly via node to avoid npm wrapper issues
node ".\node_modules\vite\bin\vite.js"
