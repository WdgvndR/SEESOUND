@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-backend.ps1"
pause
