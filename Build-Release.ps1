#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$NewOutputDirectory,[string]$Version='2.0.0-rc.2',
      [long]$SourceDateEpoch=1792195200,[string]$BrowserChannel='chrome')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$output=[IO.Path]::GetFullPath($NewOutputDirectory)
if(Test-Path -LiteralPath $output) { throw 'Release output must be new; existing artifacts are preserved.' }
if($Version -notmatch '^[0-9][A-Za-z0-9_.-]{0,63}$') { throw 'Invalid version.' }
$previous=$env:TEST_BROWSER_CHANNEL
$results=Join-Path $PSScriptRoot 'test-results'
$null=New-Item -ItemType Directory -Path $results -Force
$label='portable-release-'+[Guid]::NewGuid().ToString('N')
function Invoke-BuildCheck([string]$Name,[scriptblock]$Action) {
    & $Action *> (Join-Path $results ($label+'-'+$Name+'.log'))
    if($LASTEXITCODE -ne 0) { throw ($Name+' failed; inspect the protected build log.') }
    Write-Output ($Name+' PASS')
}
try {
    $pins=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows/toolchain.lock.json') -Raw | ConvertFrom-Json
    if((& node --version) -ne ('v'+$pins.build.node) -or (& npm.cmd --version) -ne $pins.build.npm) { throw 'Pinned Node/npm versions required.' }
    $env:TEST_BROWSER_CHANNEL=$BrowserChannel
    Push-Location (Join-Path $root 'frontend')
    try {
        Invoke-BuildCheck 'npm-ci' { npm.cmd ci --no-audit --no-fund }
        Invoke-BuildCheck 'frontend' { npm.cmd test }
    } finally { Pop-Location }
    Push-Location (Join-Path $root 'backend')
    try { Invoke-BuildCheck 'backend' { .\mvnw.cmd -B -q '-Dgreenflix.library.imports.write-approved-references=' "-Dproject.build.outputTimestamp=$SourceDateEpoch" clean verify } } finally { Pop-Location }
    $jar=Join-Path $root 'backend/target/greenflix-0.1.0-SNAPSHOT.jar'
    $proof=Join-Path $results ($label+'-proof.json')
    & node (Join-Path $PSScriptRoot 'build-proof.mjs') create $root $jar $proof (Join-Path $results ($label+'-frontend.log'))
    if($LASTEXITCODE -ne 0){throw 'Complete regression proof failed (including optional real FFprobe fixture).'}
    & (Join-Path $PSScriptRoot 'New-ReleaseBundle.ps1') -NewOutputDirectory $output -VerifiedJar $jar -BuildProof $proof -Version $Version -SourceDateEpoch $SourceDateEpoch
    if(!$?){throw 'Release packaging failed.'}
    Write-Output 'Release staged. Run the clean-directory acceptance tests before operator installation.'
} finally { $env:TEST_BROWSER_CHANNEL=$previous }
