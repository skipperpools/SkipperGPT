# Copy SQLite data to Supabase Postgres. Requires DATABASE_URL in environment or .env.
# Usage (from project root):
#   $env:DATABASE_URL = "postgresql+psycopg://..."
#   .\scripts\migrate-to-supabase.ps1
# Optional: -Force to truncate a non-empty target DB.

param(
    [string]$Source = "",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path $PSScriptRoot -Parent
$backendRoot = Join-Path $projectRoot "backend"
$defaultSource = Join-Path $projectRoot "data\skipper.db"

if (-not $Source) { $Source = $defaultSource }
if (-not (Test-Path $Source)) {
    Write-Error "SQLite source not found: $Source"
}

$envFile = Join-Path $projectRoot ".env"
if (-not $env:DATABASE_URL -and (Test-Path $envFile)) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*DATABASE_URL\s*=\s*(.+)\s*$') {
            $env:DATABASE_URL = $matches[1].Trim().Trim('"').Trim("'")
        }
    }
}

if (-not $env:DATABASE_URL) {
    Write-Error "DATABASE_URL is not set. Point it at your Supabase session pooler URL."
}
if ($env:DATABASE_URL -notmatch 'postgres') {
    Write-Error "DATABASE_URL must be a Postgres URL (got non-Postgres value)."
}

$venvPython = Join-Path $backendRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Error "Backend venv not found. Run setup-backend.ps1 first."
}

$args = @("-m", "app.migrate_sqlite_to_postgres", "--source", $Source)
if ($Force) { $args += "--force" }

Push-Location $backendRoot
try {
    & $venvPython @args
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host "Migration finished. Verify row counts in the Supabase Table Editor (13 tables)."
} finally {
    Pop-Location
}
