# AI Contribution Tracker — one-line installer (Windows)
#
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/YoavLax/AI-Contribution-Tracker/refs/heads/feat/standalone-cli-distribution/install.ps1 | iex"
#
# Downloads the self-contained ai-track.exe, installs it to
# %LOCALAPPDATA%\ai-track\bin, adds it to PATH, and runs `ai-track init`.
# No Node, no npm required.

$ErrorActionPreference = 'Stop'

# Binaries are attached to the latest GitHub Release. Override for forks/testing.
$AssetBase  = if ($env:AI_TRACK_ASSET_BASE) { $env:AI_TRACK_ASSET_BASE } else { 'https://github.com/YoavLax/AI-Contribution-Tracker/releases/latest/download' }
$InstallDir = Join-Path $env:LOCALAPPDATA 'ai-track\bin'
$BinName    = 'ai-track.exe'

function Say  ($m) { Write-Host "  $([char]0x2713) $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "  $([char]0x2717) $m" -ForegroundColor Red; exit 1 }

# ─── Detect architecture ────────────────────────────────────
$arch = if ([System.Environment]::Is64BitOperatingSystem) { 'x64' } else { Die 'Only 64-bit Windows is supported' }
$asset = "ai-track-win-$arch.exe"
$url   = "$AssetBase/$asset"

Write-Host ''
Write-Host "AI Contribution Tracker — installing $asset"
Write-Host ''

# ─── Download ───────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$target = Join-Path $InstallDir $BinName
try {
    Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing
    Say "Installed binary: $target"
} catch {
    Die "Download failed: $url  ($($_.Exception.Message))"
}

# ─── Ensure it's on PATH (user scope) ───────────────────────
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User')
    $env:Path = "$env:Path;$InstallDir"
    Say "Added $InstallDir to your user PATH"
}

# ─── Try to install the VS Code companion extension (optional) ──
$codeCmd = Get-Command code -ErrorAction SilentlyContinue
if (-not $codeCmd) { $codeCmd = Get-Command code-insiders -ErrorAction SilentlyContinue }
if ($codeCmd) {
    try {
        & $codeCmd.Source --install-extension YoavLax.ai-contribution-tracker 2>$null | Out-Null
        Say 'Installed VS Code companion extension (inline-suggestion tracking)'
    } catch {
        Warn 'Could not install VS Code extension (continuing without it)'
    }
} else {
    Warn "VS Code 'code' command not found — skipping companion extension (inline tracking)."
}

# ─── Run init ───────────────────────────────────────────────
Write-Host ''
& $target init

Write-Host ''
Say "Done. Open a new terminal so 'ai-track' is on your PATH."
Write-Host ''
