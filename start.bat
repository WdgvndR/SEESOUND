@echo off
echo ===================================================
echo     Starting SEESOUND...
echo ===================================================

:: Check if .venv exists
if not exist ".venv\" (
    echo [ERROR] Virtual environment not found. Please run 'install.bat' first!
    pause
    exit /b
)

:: Check if frontend node_modules exist
if not exist "frontend\node_modules\" (
    echo [ERROR] Frontend dependencies not found. Please run 'install.bat' first!
    pause
    exit /b
)

:: Start Backend in a new window
echo Starting Backend (FastAPI)...
start "SEESOUND Backend" cmd /k "call .venv\Scripts\activate.bat && cd backend && uvicorn server:app --reload --host 0.0.0.0"

:: Start Frontend in a new window (it will open the browser automatically)
echo Starting Frontend (Vite)...
start "SEESOUND Frontend" cmd /k "cd frontend && pnpm run dev --open"

echo.
echo Both servers are starting up. 
echo A browser window will open shortly at http://localhost:5173
echo.
echo Leave the two console windows open while using SEESOUND.
echo Keep this window open if you want to read these instructions, or close it.
pause