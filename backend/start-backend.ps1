Param(
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 8000,
    [switch]$NoReload,
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$backendRoot = $PSScriptRoot
$venvPython = Join-Path $backendRoot ".venv\Scripts\python.exe"
$requirements = Join-Path $backendRoot "requirements.txt"

if (-not (Test-Path $venvPython)) {
    Write-Host "[start-backend] Virtual env not found: $venvPython" -ForegroundColor Red
    Write-Host "[start-backend] Create it first:"
    Write-Host "  cd backend"
    Write-Host "  python -m venv .venv"
    Write-Host "  .venv\Scripts\pip install -r requirements.txt"
    exit 1
}

if (-not (Test-Path $requirements)) {
    Write-Host "[start-backend] requirements.txt not found: $requirements" -ForegroundColor Red
    exit 1
}

if (-not $SkipInstall) {
    Write-Host "[start-backend] Syncing dependencies from requirements.txt ..."
    & $venvPython -m pip install -r $requirements
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[start-backend] pip install failed." -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Set-Location $backendRoot

$uvicornArgs = @("-m", "uvicorn", "app.main:app", "--host", $BindHost, "--port", "$Port")
if (-not $NoReload) {
    $uvicornArgs += "--reload"
}

Write-Host "[start-backend] Starting API on http://$BindHost`:$Port ..."
& $venvPython @uvicornArgs
exit $LASTEXITCODE
