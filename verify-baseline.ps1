#requires -Version 5.1
[CmdletBinding()]
param([string]$BrowserChannel = 'chrome', [switch]$SkipInstall, [switch]$IncludeLive)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$previousChannel = $env:TEST_BROWSER_CHANNEL
$results = Join-Path $PSScriptRoot 'test-results'
$null = New-Item -ItemType Directory -Path $results -Force
function Invoke-Check {
    param([string]$Name,[scriptblock]$Action)
    $log = Join-Path $results ($Name + '.log')
    & $Action *> $log
    if ($LASTEXITCODE -ne 0) { throw "$Name failed; inspect its protected local log." }
    Write-Output "$Name PASS"
}
try {
    $env:TEST_BROWSER_CHANNEL = $BrowserChannel
    Push-Location (Join-Path $root 'frontend')
    try {
        if (!$SkipInstall) { Invoke-Check 'baseline-install' { npm.cmd ci --no-audit --no-fund } }
        Invoke-Check 'baseline-frontend' { npm.cmd test }
    } finally { Pop-Location }
    Push-Location (Join-Path $root 'backend')
    try { Invoke-Check 'baseline-backend' { .\mvnw.cmd -B -q clean verify } } finally { Pop-Location }
    if ($IncludeLive) {
        Push-Location (Join-Path $root 'frontend')
        try {
            Invoke-Check 'baseline-live' { npm.cmd run test:live }
            Invoke-Check 'baseline-release' { npm.cmd run test:release }
        } finally { Pop-Location }
    }
} finally { $env:TEST_BROWSER_CHANNEL = $previousChannel }
