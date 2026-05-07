@echo off
setlocal EnableExtensions
set "BACKEND=%~dp0backend"
set "PY=%BACKEND%\.venv\Scripts\python.exe"

if not exist "%PY%" (
  echo [reset-db.bat] Virtual env not found at:
  echo   %PY%
  echo.
  echo Create it from the backend folder:
  echo   cd backend
  echo   python -m venv .venv
  echo   .venv\Scripts\pip install -r requirements.txt
  pause
  exit /b 1
)

echo.
echo Resetting database: clearing all jobs/tasks and re-importing seed data.
echo If Schedules.xlsx exists in the project folder, jobs load from that file.
echo Otherwise the built-in demo jobs are used.
echo.

pushd "%BACKEND%"
"%PY%" -m app.seed --reset
set "EXITCODE=%ERRORLEVEL%"
popd

if not "%EXITCODE%"=="0" (
  echo.
  echo [reset-db.bat] Seed failed with exit code %EXITCODE%.
  pause
  exit /b %EXITCODE%
)

echo.
echo Done.
pause
endlocal
