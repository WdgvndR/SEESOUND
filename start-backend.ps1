# start-backend.ps1
# Activates the virtual environment and starts the FastAPI server.
# Run from the SEESOUND root directory.

# Refresh PATH so python is available in this session
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')

Write-Host "`n[SEESOUND] Starting FastAPI backend on http://localhost:8000 ...`n" -ForegroundColor Cyan
Set-Location "$PSScriptRoot\backend"
& "$PSScriptRoot\.venv\Scripts\python.exe" -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
