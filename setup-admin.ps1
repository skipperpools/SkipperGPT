# Skipper Pools: prompt for admin username/password and run app.create_admin
# Run from setup-admin.bat (double-click) or: powershell -File setup-admin.ps1

function Read-FileSafe([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) {
        return ""
    }
    try {
        return [System.IO.File]::ReadAllText($path)
    }
    catch {
        return ""
    }
}

# Avoid treating Python stderr (e.g. passlib/bcrypt notices) as a terminating error.
$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
$backend = Join-Path $root "backend"
if (-not (Test-Path -LiteralPath $backend)) {
    [System.Windows.Forms.MessageBox]::Show(
        "Could not find the backend folder:`n$backend",
        "Skipper Pools",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}

Set-Location -LiteralPath $backend

$venvPy = Join-Path $backend ".venv\Scripts\python.exe"
$py = if (Test-Path -LiteralPath $venvPy) { $venvPy } else { "python" }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "Skipper Pools - Create first admin"
$form.Size = New-Object System.Drawing.Size(420, 220)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false

$lblU = New-Object System.Windows.Forms.Label
$lblU.Text = "Username:"
$lblU.Location = New-Object System.Drawing.Point(12, 18)
$lblU.AutoSize = $true

$tbU = New-Object System.Windows.Forms.TextBox
$tbU.Location = New-Object System.Drawing.Point(120, 15)
$tbU.Width = 260

$lblP = New-Object System.Windows.Forms.Label
$lblP.Text = "Password:"
$lblP.Location = New-Object System.Drawing.Point(12, 58)
$lblP.AutoSize = $true

$tbP = New-Object System.Windows.Forms.TextBox
$tbP.Location = New-Object System.Drawing.Point(120, 55)
$tbP.Width = 260
$tbP.PasswordChar = "*"

$btnOk = New-Object System.Windows.Forms.Button
$btnOk.Text = "Create admin"
$btnOk.DialogResult = [System.Windows.Forms.DialogResult]::OK
$btnOk.Location = New-Object System.Drawing.Point(160, 115)

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = "Cancel"
$btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$btnCancel.Location = New-Object System.Drawing.Point(265, 115)

$form.Controls.AddRange(@($lblU, $tbU, $lblP, $tbP, $btnOk, $btnCancel))
$form.AcceptButton = $btnOk
$form.CancelButton = $btnCancel

$result = $form.ShowDialog()
if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    exit 1
}

$user = $tbU.Text.Trim()
$pass = $tbP.Text
if (-not $user) {
    [System.Windows.Forms.MessageBox]::Show(
        "Please enter a username.",
        "Skipper Pools",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
    exit 1
}
if (-not $pass) {
    [System.Windows.Forms.MessageBox]::Show(
        "Please enter a password.",
        "Skipper Pools",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
    exit 1
}

# Use Start-Process + file redirects so ExitCode is correct (not $LASTEXITCODE, often wrong in PS 5.1).
$id = [Guid]::NewGuid().ToString("N")
$outFile = Join-Path $env:TEMP "skipper-setup-$id-stdout.txt"
$errFile = Join-Path $env:TEMP "skipper-setup-$id-stderr.txt"
Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue

$exitCode = 1
$captureErr = $null

try {
    $procParams = @{
        FilePath               = $py
        ArgumentList           = @("-m", "app.create_admin", $user, $pass)
        WorkingDirectory       = $backend
        Wait                   = $true
        PassThru               = $true
        NoNewWindow            = $true
        RedirectStandardOutput = $outFile
        RedirectStandardError  = $errFile
    }
    $proc = Start-Process @procParams
    if ($proc -ne $null) {
        $exitCode = [int]$proc.ExitCode
    }
}
catch {
    $captureErr = $_.Exception.Message
}

$stdout = Read-FileSafe $outFile
$stderr = Read-FileSafe $errFile
Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue

$nl = [Environment]::NewLine
$parts = @()
if (-not [string]::IsNullOrWhiteSpace($captureErr)) {
    $parts += "Unable to launch Python:"
    $parts += $captureErr
}
if (-not [string]::IsNullOrWhiteSpace($stdout.Trim())) {
    $parts += $stdout.TrimEnd()
}
if (-not [string]::IsNullOrWhiteSpace($stderr.Trim())) {
    $parts += $stderr.TrimEnd()
}
if ($parts.Length -eq 0) {
    $parts += "(no captured output)"
    $parts += "Python: $py"
    $parts += ("Working directory: {0}" -f $backend)
}

$text = ($parts | Where-Object { $_ -ne $null -and -not [string]::IsNullOrWhiteSpace($_) }) -join $nl
if ([string]::IsNullOrWhiteSpace($text.Trim())) {
    $text = "(no output)"
}

if ($exitCode -eq 0) {
    $msgFinished = -join @("Finished.", [Environment]::NewLine, [Environment]::NewLine, $text)
    [System.Windows.Forms.MessageBox]::Show(
        $msgFinished,
        "Skipper Pools",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
}
else {
    $msgFail = -join @("Command exited with code ", $exitCode, ".", [Environment]::NewLine, [Environment]::NewLine, $text)
    [System.Windows.Forms.MessageBox]::Show(
        $msgFail,
        "Skipper Pools",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
}

exit $exitCode
