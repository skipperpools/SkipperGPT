# Standard backend bootstrap for SkipperGPT on Windows.
# Uses Python 3.12 explicitly so optional HEIC support is available.

$ErrorActionPreference = "Stop"

Write-Host "Setting up backend virtual environment with Python 3.12..."

Set-Location -Path $PSScriptRoot

$py312 = Get-Command py -ErrorAction SilentlyContinue
if (-not $py312) {
  throw "Python launcher (py) was not found. Install Python 3.12 and try again."
}

py -3.12 -m venv .venv
if ($LASTEXITCODE -ne 0) {
  throw "Python 3.12 is not installed. Install it first (py install 3.12), then rerun this script."
}

$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
  throw "Failed to create .venv with Python 3.12."
}

Write-Host "Installing base backend dependencies..."
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r requirements.txt

Write-Host "Installing optional HEIC dependencies..."
& $venvPython -m pip install -r requirements-heic.txt
if ($LASTEXITCODE -eq 0) {
  Write-Host "HEIC support installed."
} else {
  Write-Warning "Optional HEIC dependency install failed."
  Write-Warning "You can still run the app; HEIC uploads will be rejected until pillow-heif is available."
}

Write-Host ""
Write-Host "Backend setup complete."
Write-Host "Activate venv with: .venv\Scripts\activate"
Write-Host "Run server with:    uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"
