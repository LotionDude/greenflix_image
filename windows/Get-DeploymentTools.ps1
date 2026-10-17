#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$NewOutputDirectory,[switch]$ApproveDownloads)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Deployment.psm1') -Force
try {
    if(!$ApproveDownloads) { throw 'EXPLICIT_DOWNLOAD_APPROVAL_REQUIRED' }
    $output=Assert-LocalPath $NewOutputDirectory
    if(Test-Path -LiteralPath $output) { throw 'NEW_TOOL_DIRECTORY_REQUIRED' }
    $pins=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'toolchain.lock.json') -Raw | ConvertFrom-Json
    $null=New-Item -ItemType Directory -Path $output
    $archive=Join-Path $output 'temurin.zip'
    Invoke-WebRequest -UseBasicParsing -Uri $pins.java.url -OutFile $archive
    Assert-Hash $archive $pins.java.archiveSha256
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $output 'runtime')
    $java=Join-Path $output 'runtime\jdk-25.0.4.1+1-jre\bin\java.exe'
    Assert-Hash $java $pins.java.javaExeSha256
    $wrapper=Join-Path $output 'WinSW-x64.exe'
    Invoke-WebRequest -UseBasicParsing -Uri $pins.winsw.url -OutFile $wrapper
    Assert-Hash $wrapper $pins.winsw.sha256
    Write-NewUtf8 (Join-Path $output 'PROVISIONED.json') ($pins | ConvertTo-Json -Depth 6)
    '{"Status":"PASS","Scope":"PINNED_TOOL_STAGING_ONLY","Installed":false}'
} catch { Write-Error 'Pinned tool provisioning failed; preserve output and inspect approved sources/checksums.'; exit 1 }
