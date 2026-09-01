# Creates Desktop and Start Menu shortcuts for School Tracker.
# Run once via: npm run setup

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $electron)) {
    Write-Error "Electron not found at $electron. Run 'npm install' first."
}

# Windows shortcuts want a .ico; wrap the PNG in an ICO container
# (Vista+ supports PNG-compressed icons).
$png = Join-Path $root 'assets\icon.png'
$ico = Join-Path $root 'assets\icon.ico'

if ((Test-Path $png) -and (-not (Test-Path $ico))) {
    $bytes = [System.IO.File]::ReadAllBytes($png)
    $stream = [System.IO.File]::Create($ico)
    $writer = New-Object System.IO.BinaryWriter($stream)
    $writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]1)   # ICONDIR
    $writer.Write([Byte]0); $writer.Write([Byte]0)                                 # 256x256
    $writer.Write([Byte]0); $writer.Write([Byte]0)
    $writer.Write([UInt16]1); $writer.Write([UInt16]32)
    $writer.Write([UInt32]$bytes.Length)
    $writer.Write([UInt32]22)
    $writer.Write($bytes)
    $writer.Close(); $stream.Close()
}

$shell = New-Object -ComObject WScript.Shell

function New-TrackerShortcut([string]$linkPath) {
    $sc = $shell.CreateShortcut($linkPath)
    $sc.TargetPath       = $electron
    $sc.Arguments        = "`"$root`""
    $sc.WorkingDirectory = $root
    $sc.Description      = 'School assignment tracker'
    if (Test-Path $ico) { $sc.IconLocation = $ico }
    $sc.Save()
    Write-Host "  created $linkPath"
}

Write-Host 'Creating shortcuts...'
New-TrackerShortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'School Tracker.lnk')

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
New-TrackerShortcut (Join-Path $startMenu 'School Tracker.lnk')

Write-Host ''
Write-Host 'Done. Launch it from your Desktop or Start Menu.'
Write-Host 'It registers itself to start with Windows on first run (toggle in the tray menu).'
