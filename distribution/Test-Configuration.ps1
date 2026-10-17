#requires -Version 5.1
param([Parameter(Mandatory)][string]$ConfigDirectory)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'Greenflix.exe') "--config-dir=$ConfigDirectory" --verify-config
if($LASTEXITCODE -ne 0){throw 'Configuration verification failed. No database was migrated or reset.'}
