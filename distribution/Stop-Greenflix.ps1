#requires -Version 5.1
param([Parameter(Mandatory)][string]$ConfigDirectory)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'Greenflix.exe') "--config-dir=$ConfigDirectory" --stop
if($LASTEXITCODE -ne 0){throw 'Graceful stop request failed. No process was terminated.'}
