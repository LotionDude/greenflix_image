#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigFile)
$ErrorActionPreference = 'Stop'
try {
    if ($ConfigFile.StartsWith('\\') -or ![IO.Path]::IsPathRooted($ConfigFile)) { throw 'Invalid config' }
    $config = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
    if (!$config.ExpectedIdentitySid) { throw 'Expected SID required' }
    if($config.PSObject.Properties.Name -contains 'Roots') {
        & (Join-Path $PSScriptRoot 'Test-ServiceAccess.ps1') -ConfigFile $ConfigFile -RequireServiceSession
        exit $LASTEXITCODE
    }
    & (Join-Path $PSScriptRoot 'Test-SmbRead.ps1') -ApprovedUncRoot $config.ApprovedUncRoot `
        -RepresentativeMp4 $config.RepresentativeMp4 -ExpectedIdentitySid $config.ExpectedIdentitySid
    exit $LASTEXITCODE
} catch { '{"Status":"FAIL","Category":"SERVICE_PROBE_CONFIG_ERROR"}'; exit 2 }
