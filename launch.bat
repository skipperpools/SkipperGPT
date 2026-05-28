@echo off
setlocal EnableExtensions
set "BACKEND=%~dp0backend"
set "PY=%BACKEND%\.venv\Scripts\python.exe"
set "START_PS1=%BACKEND%\start-backend.ps1"

if not exist "%PY%" (
  echo [launch.bat] Virtual env not found at:
  echo   %PY%
  echo.
  echo Create it from the backend folder:
  echo   cd backend
  echo   python -m venv .venv
  echo   .venv\Scripts\pip install -r requirements.txt
  pause
  exit /b 1
)

if not exist "%START_PS1%" (
  echo [launch.bat] backend startup wrapper not found:
  echo   %START_PS1%
  pause
  exit /b 1
)

REM New window: server logs stay visible; close that window to stop the app.
REM If startup fails quickly, keep the window open so the error can be read.
set "BACKEND_CMD=powershell -ExecutionPolicy Bypass -File ""%START_PS1%"" -BindHost 127.0.0.1 -Port 8001"
start "Skipper Pools Dashboard" cmd /c "%BACKEND_CMD% || (echo. & echo [launch.bat] Backend startup failed. Review the error above. & pause)"

REM Give Uvicorn a moment to bind before opening the browser
timeout /t 2 /nobreak >nul

start "" "http://127.0.0.1:8001/"

endlocal
