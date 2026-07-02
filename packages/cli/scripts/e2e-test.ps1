$ErrorActionPreference = 'Stop'
$bin = 'c:\Users\ylax\source\repos\AI-Commit-Tracker\packages\cli\dist\ai-track-test.exe'
$repo = Join-Path $env:TEMP ('ai-track-e2e-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $repo | Out-Null
Set-Location $repo
git init -q
git config user.email 't@t.co'
git config user.name 'test'

# Local hooks dir (does NOT touch global git config)
$hooks = Join-Path $repo '.githooks'
New-Item -ItemType Directory -Force $hooks | Out-Null
git config core.hooksPath $hooks
$binPosix = $bin -replace '\\', '/'

$lines = @(
    '#!/bin/sh'
    'case "$2" in merge|squash|commit) exit 0 ;; esac'
    "AI_TRACK=`"$binPosix`""
    'IMPACT_FLAG=$(git rev-parse --git-path AI_IMPACT_PENDING)'
    'STATE_FILE=$(git rev-parse --git-path ai-tracker-state.json)'
    'if [ -f "$AI_TRACK" ]; then'
    '  GIT_ABS_DIR=$(git rev-parse --absolute-git-dir)'
    '  printf ''{"hookEventName":"CommitMsg","cwd":".","gitDir":"%s"}'' "$GIT_ABS_DIR" | "$AI_TRACK" hook >/dev/null 2>&1 || true'
    'fi'
    'if [ -f "$IMPACT_FLAG" ]; then'
    '  MARKER=$(cat "$IMPACT_FLAG")'
    '  if ! grep -qF "$MARKER" "$1"; then echo "" >> "$1"; echo "$MARKER" >> "$1"; fi'
    '  rm "$IMPACT_FLAG"'
    'fi'
    'if [ -f "$STATE_FILE" ]; then rm "$STATE_FILE"; fi'
)
$hookPath = Join-Path $hooks 'prepare-commit-msg'
[System.IO.File]::WriteAllText($hookPath, ($lines -join "`n") + "`n")

$repoPosix = $repo -replace '\\', '/'
# Simulate a Copilot agent session firing hook events.
# Write payloads as UTF-8 (no BOM) and feed via `cmd type` so stdin is clean bytes.
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Send-Event($json) {
    $f = Join-Path $env:TEMP ('evt-' + [guid]::NewGuid().ToString('N') + '.json')
    [System.IO.File]::WriteAllText($f, $json, $utf8)
    cmd /c "type `"$f`" | `"$bin`" hook" | Out-Null
    Remove-Item $f -ErrorAction SilentlyContinue
}
Send-Event "{""hookEventName"":""SessionStart"",""source"":""new"",""session_id"":""e2e-1"",""cwd"":""$repoPosix""}"
Send-Event "{""hookEventName"":""UserPromptSubmit"",""session_id"":""e2e-1"",""prompt"":""add a feature"",""cwd"":""$repoPosix""}"
Send-Event "{""hookEventName"":""Stop"",""session_id"":""e2e-1"",""cwd"":""$repoPosix""}"

$statePath = Join-Path $repo '.git\ai-tracker-state.json'
$flagPath = Join-Path $repo '.git\AI_IMPACT_PENDING'
Write-Host "state exists: $(Test-Path $statePath)"
Write-Host "flag  exists: $(Test-Path $flagPath)"
if (Test-Path $flagPath) { Write-Host "flag contents: $(Get-Content $flagPath -Raw)" }

Set-Content -Path (Join-Path $repo 'file.txt') -Value 'hello'
git add -A
git commit -q -m 'feat: add feature'
Write-Host "`n=== COMMIT MESSAGE ==="
git log -1 --format='%B'
Write-Host "=== END ==="
Set-Location $env:TEMP
Remove-Item -Recurse -Force $repo -ErrorAction SilentlyContinue
