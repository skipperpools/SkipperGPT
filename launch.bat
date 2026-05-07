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

set "USE_NGROK=N"
set /p "USE_NGROK=Launch with ngrok (skipper.ngrok.app)? [y/N]: "
if "%USE_NGROK%"=="" set "USE_NGROK=N"

REM New window: server logs stay visible; close that window to stop the app
start "Skipper Pools Dashboard" powershell -ExecutionPolicy Bypass -File "%START_PS1%" -BindHost 127.0.0.1 -Port 8000

REM Give Uvicorn a moment to bind before opening the browser / starting ngrok
timeout /t 2 /nobreak >nul

if /i "%USE_NGROK%"=="Y" (
  where ngrok >nul 2>nul
  if errorlevel 1 (
    echo [launch.bat] ngrok not found on PATH. Falling back to local URL.
    start "" "http://127.0.0.1:8000/"
  ) else (
    REM Port must follow ngrok http; --url needs full https URL (see ngrok docs).
    REM cmd /k keeps this window open if ngrok exits (errors are visible instead of a flash).
    start "Skipper Pools ngrok" cmd /k ngrok http 8000 --url=https://skipper.ngrok.app
    REM Tunnel registration can take a few seconds before the public URL responds
    timeout /t 5 /nobreak >nul
    start "" "https://skipper.ngrok.app/"
  )
) else (
  start "" "http://127.0.0.1:8000/"
)

endlocal
