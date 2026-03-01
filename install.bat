@echo off
echo ===================================================
echo     SEESOUND - First Time Installation Script
echo ===================================================
echo.

echo [1/3] Checking for prerequisite tools...
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed or not in PATH! Please install Python 3.10+.
    pause
    exit /b
)
where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] pnpm is not installed! 
    echo Please install Node.js then run: npm install -g pnpm
    pause
    exit /b
)
echo OK! Python and pnpm found.
echo.

echo [2/3] Setting up Python Backend Environment...
if not exist ".venv\" (
    echo Creating virtual environment...
    python -m venv .venv
)
echo Installing python requirements...
call .venv\Scripts\activate.bat
pip install -r backend\requirements.txt
call deactivate
echo OK! Backend ready.
echo.

echo [3/3] Setting up Node Frontend Environment...
cd frontend
call pnpm install
cd ..
echo OK! Frontend ready.
echo.

echo ===================================================
echo  Installation Complete! 
echo  You can now double-click 'start.bat' to run SEESOUND.
echo ===================================================
pause
