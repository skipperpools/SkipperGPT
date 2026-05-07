@echo off
setlocal EnableExtensions
cd /d "%~dp0" || exit /b 1

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-admin.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" pause
exit /b %ERR%
