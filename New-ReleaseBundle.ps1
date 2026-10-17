#requires -Version 5.1
# Package an already verified unchanged JAR. Never builds, installs or overwrites an existing bundle.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$NewOutputDirectory,[Parameter(Mandatory)][string]$VerifiedJar,
      [Parameter(Mandatory)][string]$BuildProof,[string]$Version='2.0.0-rc.1',[long]$SourceDateEpoch=1792108800)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent;$output=[IO.Path]::GetFullPath($NewOutputDirectory)
if(Test-Path -LiteralPath $output){throw 'New release output required.'}
& node (Join-Path $PSScriptRoot 'build-proof.mjs') verify $root $VerifiedJar $BuildProof
if($LASTEXITCODE -ne 0){throw 'Application build proof is stale or invalid.'}
$null=New-Item -ItemType Directory -Path $output
Copy-Item -LiteralPath $VerifiedJar -Destination (Join-Path $output 'greenflix.jar')
Copy-Item -LiteralPath $BuildProof -Destination (Join-Path $output 'build-verification.json')
$null=New-Item -ItemType Directory -Path (Join-Path $output 'deploy')
foreach($name in @('windows','acceptance')) {
    $target=Join-Path $output ('deploy/'+$name);$null=New-Item -ItemType Directory -Path $target
    Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot $name) -File | Where-Object { $_.Extension -in '.ps1','.psm1','.cs','.md','.mjs','.json','.template' -and $_.Name -notlike '*.test.mjs' } |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target $_.Name) }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Get-Ffprobe.ps1') -Destination (Join-Path $output 'deploy/Get-Ffprobe.ps1')
$null=New-Item -ItemType Directory -Path (Join-Path $output 'docs')
Get-ChildItem -LiteralPath (Join-Path $root 'docs') -File | Where-Object { $_.Extension -in '.md','.json' } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $output ('docs/'+$_.Name)) }
& node (Join-Path $PSScriptRoot 'release-manifest.mjs') $output $root $Version $SourceDateEpoch
if($LASTEXITCODE -ne 0){throw 'Release manifest failed.'}
