@echo off
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"

powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-backend.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [start-backend.bat] Backend failed with exit code %RC%.
)
exit /b %RC%
