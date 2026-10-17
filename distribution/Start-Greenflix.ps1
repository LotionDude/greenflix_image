#requires -Version 5.1
param([Parameter(Mandatory)][string]$ConfigDirectory,[switch]$OpenBrowser,[string]$Url='http://localhost:8080')
$ErrorActionPreference='Stop'
if($OpenBrowser){Start-Process $Url -WindowStyle Hidden}
& (Join-Path $PSScriptRoot 'Greenflix.exe') "--config-dir=$ConfigDirectory"
if($LASTEXITCODE -ne 0){throw 'Greenflix startup failed; inspect the console and external application.yml.'}
