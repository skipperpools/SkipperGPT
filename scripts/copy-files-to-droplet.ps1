# Copy Docs, Photos, and Sketches to the droplet volume.
# Usage: .\scripts\copy-files-to-droplet.ps1 -DropletHost skipper@YOUR_DROPLET_IP

param(
    [Parameter(Mandatory = $true)]
    [string]$DropletHost
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path $PSScriptRoot -Parent

foreach ($dir in @("Docs", "Photos", "Sketches")) {
    $local = Join-Path $projectRoot $dir
    if (-not (Test-Path $local)) {
        Write-Warning "Skipping missing folder: $local"
        continue
    }
    Write-Host "Uploading $dir ..."
    scp -r $local "${DropletHost}:/var/skipper/"
}

Write-Host "Done. On the droplet run: sudo chown -R skipper:skipper /var/skipper"
