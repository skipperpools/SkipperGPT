@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "PY=%BACKEND%\.venv\Scripts\python.exe"

if not exist "%PY%" (
  echo [backup-data.bat] Python virtual env not found:
  echo   %PY%
  echo.
  echo Setup backend first:
  echo   cd backend
  echo   python -m venv .venv
  echo   .venv\Scripts\pip install -r requirements.txt
  pause
  exit /b 1
)

if "%~1"=="" (
  echo Backup utility
  echo   [1] Export backup zip
  echo   [2] Import backup zip
  echo   [Q] Quit
  echo.
  choice /c 12Q /n /m "Choose an option (1/2/Q): "
  if errorlevel 3 (
    echo Cancelled.
    pause
    exit /b 1
  )
  if errorlevel 2 (
    echo.
    set /p "ARCHIVE=Enter full path to backup zip: "
    if "%ARCHIVE%"=="" (
      echo No archive path provided.
      pause
      exit /b 1
    )
    set "PYTHONPATH=%BACKEND%"
    "%PY%" -m app.backup_bundle import "%ARCHIVE%"
    set "EXIT_CODE=%ERRORLEVEL%"
    if not "%EXIT_CODE%"=="0" pause
    if "%EXIT_CODE%"=="0" echo Done.
    if "%EXIT_CODE%"=="0" pause
    exit /b %EXIT_CODE%
  )
  if errorlevel 1 (
    set "PYTHONPATH=%BACKEND%"
    "%PY%" -m app.backup_bundle export
    set "EXIT_CODE=%ERRORLEVEL%"
    if not "%EXIT_CODE%"=="0" pause
    if "%EXIT_CODE%"=="0" echo Done.
    if "%EXIT_CODE%"=="0" pause
    exit /b %EXIT_CODE%
  )
)

set "PYTHONPATH=%BACKEND%"
"%PY%" -m app.backup_bundle %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause

exit /b %EXIT_CODE%
