#requires -Version 5.1
<#
.SYNOPSIS
Bounded, read-only verification of one explicitly approved UNC root and MP4.
.DESCRIPTION
No credentials, drive mappings, recursive scanning, or share writes. Emits redacted
JSON. Exit 0=passed reads, 1=failed, 2=invalid input, 3=timeout. LargeOffsets may
remain NOT_TESTED_FILE_TOO_SMALL even with exit 0. A timeout is inconclusive.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ApprovedUncRoot,
    [Parameter(Mandatory)][string]$RepresentativeMp4,
    [ValidateRange(1,20)][int]$ParallelReads = 2,
    [ValidateRange(1,100)][int]$Iterations = 1,
    [ValidateRange(1,1048576)][int]$BytesPerRead = 4096,
    [ValidateRange(5,300)][int]$TimeoutSeconds = 30,
    [switch]$AllowHeavyLoad,
    [string]$ExpectedIdentitySid
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Validation.psm1') -Force
try {
    Assert-ApprovedInput $ApprovedUncRoot $RepresentativeMp4
    if (!$AllowHeavyLoad -and ($ParallelReads -gt 4 -or $Iterations -gt 4 -or $BytesPerRead -gt 65536)) { throw 'INVALID_INPUT' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($ExpectedIdentitySid -and $ExpectedIdentitySid -ne $sid) {
        '{"Status":"FAIL","Category":"IDENTITY_MISMATCH"}'
        exit 2
    }
    $payload = @{ Root=$ApprovedUncRoot; File=$RepresentativeMp4; ParallelReads=$ParallelReads; Iterations=$Iterations; BytesPerRead=$BytesPerRead } | ConvertTo-Json -Compress
    $modulePath = (Join-Path $PSScriptRoot 'Validation.psm1').Replace("'", "''")
    $code = @"
`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new(`$false)
try {
    Import-Module '$modulePath' -Force
    `$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    Invoke-SmbProbe -Root `$p.Root -File `$p.File -ParallelReads `$p.ParallelReads -Iterations `$p.Iterations -BytesPerRead `$p.BytesPerRead | ConvertTo-Json -Depth 5 -Compress
} catch { '{"Status":"FAIL","Category":"PROBE_ERROR"}' }
"@
    $child = Invoke-BoundedPowerShell -Code $code -InputJson $payload -TimeoutSeconds $TimeoutSeconds
    if ($child.TimedOut) { '{"Status":"INCONCLUSIVE","Category":"TIMEOUT"}'; exit 3 }
    if ($child.ExitCode -ne 0) { throw 'PROBE_ERROR' }
    $result = $child.Output | ConvertFrom-Json
    $result | Add-Member NoteProperty IdentitySid $sid
    $result | Add-Member NoteProperty IdentityValidated ([bool]$ExpectedIdentitySid)
    $result | ConvertTo-Json -Depth 5
    if ($result.Status -eq 'PASS') { exit 0 } else { exit 1 }
} catch {
    $category = if ($_.Exception.Message -eq 'INVALID_INPUT') { 'INVALID_INPUT' } else { 'PROBE_ERROR' }
    @{ Status='FAIL'; Category=$category } | ConvertTo-Json -Compress
    exit 2
}
