#requires -Version 5.1
# Local synthetic tests only. No UNC contact or service registration.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Validation.psm1') -Force
Initialize-ReadProbe
$script:checks = 0
function Assert-True { param([bool]$Value,[string]$Message); if (!$Value) { throw $Message }; $script:checks++ }
function Assert-Rejected {
    param([scriptblock]$Action)
    $rejected=$false
    try { & $Action } catch { $rejected=$true }
    Assert-True $rejected 'Invalid path was accepted'
}
Assert-ApprovedInput '\\fixture\share\approved' '\\fixture\share\approved\Movie.mp4'
$script:checks++
Assert-Rejected { Assert-ApprovedInput '\\fixture\share\approved' '\\fixture\share\approved-other\Movie.mp4' }
Assert-Rejected { Assert-ApprovedInput '\\fixture\share\approved' '\\fixture\share\approved\..\Movie.mp4' }
Assert-Rejected { Assert-ApprovedInput '\\fixture\share' 'C:\Movie.mp4' }
Assert-Rejected { Assert-ApprovedInput '\\?\UNC\fixture\share' '\\?\UNC\fixture\share\Movie.mp4' }
Assert-Rejected { Assert-ApprovedInput '\\fixture\share' '\\fixture\share\Movie.mkv' }
Assert-Rejected { Assert-ApprovedInput '\\fixture\share' '\\fixture\share\Movie.mp4:stream' }
Assert-Rejected { Assert-ApprovedInput '\\fixture\share' '\\fixture\share\folder.\Movie.mp4' }
foreach ($testCase in @(@(5,'PERMISSION_DENIED'),@(1326,'PERMISSION_DENIED'),@(53,'SHARE_UNAVAILABLE'),@(67,'SHARE_UNAVAILABLE'),@(2,'NOT_FOUND'),@(32,'FILE_BUSY'))) {
    $errorObject = [IO.IOException]::new('SENSITIVE_PATH_MUST_NOT_APPEAR', (-2147024896 -bor [int]$testCase[0]))
    Assert-True ([Greenflix.Validation.ReadProbe]::Failure($errorObject) -eq $testCase[1]) 'Error classification failed'
}
$results = Join-Path $PSScriptRoot 'results'
$null = New-Item -ItemType Directory -Path $results -Force
$directory = Join-Path $results ('selftest-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $directory
try {
    $file = Join-Path $directory 'synthetic.mp4'
    [IO.File]::WriteAllBytes($file, [byte[]](0..255))
    $r = [Greenflix.Validation.ReadProbe]::Run($file,2,2,64)
    Assert-True ($r.Length -eq 256 -and $r.HandlesDisposed -and !$r.LargeOffsetsTested -and $r.BytesRead -gt 0) 'Small-file read failed'
    $exclusive = [IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $exclusive.Dispose()
    $script:checks++
    $empty = Join-Path $directory 'empty.mp4'
    [IO.File]::WriteAllBytes($empty,[byte[]]@())
    $failed=$false
    try { $null = [Greenflix.Validation.ReadProbe]::Run($empty,2,1,64) } catch { $failed=$true }
    Assert-True $failed 'Empty file accepted'
    $exclusive = [IO.File]::Open($empty,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $exclusive.Dispose()
    $script:checks++
    # Mark sparse BEFORE setting length: no multi-GiB ordinary allocation.
    if (-not ('Greenflix.Validation.SparseFile' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace Greenflix.Validation {
  public static class SparseFile {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool DeviceIoControl(SafeFileHandle h, uint code, IntPtr input, uint inputSize, IntPtr output, uint outputSize, out uint returned, IntPtr overlapped);
  }
}
'@
    }
    $large = Join-Path $directory 'sparse.mp4'
    $stream = [IO.File]::Open($large,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        [uint32]$returned=0
        if (![Greenflix.Validation.SparseFile]::DeviceIoControl($stream.SafeFileHandle,0x900c4,[IntPtr]::Zero,0,[IntPtr]::Zero,0,[ref]$returned,[IntPtr]::Zero)) { throw 'Sparse-file support required for local large-offset test' }
        $stream.SetLength(4294983680L)
        foreach ($offset in @(0L,2147483648L,4294967296L)) {
            $null=$stream.Seek($offset,[IO.SeekOrigin]::Begin)
            $stream.WriteByte([byte](1 + $offset/2147483648L))
        }
    } finally { $stream.Dispose() }
    $r = [Greenflix.Validation.ReadProbe]::Run($large,4,2,4096)
    Assert-True ($r.Length -eq 4294983680L -and $r.Offsets -contains 2147483648L -and $r.Offsets -contains 4294967296L -and $r.LargeOffsetsTested) '64-bit offsets failed'
    $readAt = [Greenflix.Validation.ReadProbe].GetMethod('ReadAt',[Reflection.BindingFlags]'NonPublic,Static')
    $stream = [IO.File]::OpenRead($large)
    try {
        foreach ($offset in @(0L,2147483648L,4294967296L)) {
            $bytes = $readAt.Invoke($null, [object[]]@($stream,[long]$offset,[int]1))
            Assert-True ($bytes[0] -eq [byte](1 + $offset/2147483648L)) 'High-offset byte mismatch'
        }
    } finally { $stream.Dispose() }
    $exclusive = [IO.File]::Open($large,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $exclusive.Dispose()
    $script:checks++
    $r = Invoke-BoundedPowerShell -Code '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::In.ReadToEnd()' -InputJson 'stdin-roundtrip' -TimeoutSeconds 5
    Assert-True (!$r.TimedOut -and $r.ExitCode -eq 0 -and $r.Output.Trim() -eq 'stdin-roundtrip') 'Bounded child failed'
    $r = Invoke-BoundedPowerShell -Code 'Start-Sleep -Seconds 10' -TimeoutSeconds 1
    Assert-True ($r.TimedOut -and $r.ExitCode -eq 124) 'Timeout was not enforced'
    $probeScript = (Join-Path $PSScriptRoot 'Test-SmbRead.ps1').Replace("'","''")
    $r = Invoke-BoundedPowerShell -Code "& '$probeScript' -ApprovedUncRoot '\\fixture\share' -RepresentativeMp4 '\\fixture\share\Movie.mp4' -ParallelReads 20; exit `$LASTEXITCODE" -TimeoutSeconds 10
    Assert-True ($r.ExitCode -eq 2 -and $r.Output -match 'INVALID_INPUT' -and $r.Output -notmatch 'fixture') 'Heavy-load guard/redaction failed'
    $r = Invoke-BoundedPowerShell -Code "& '$probeScript' -ApprovedUncRoot '\\fixture\share' -RepresentativeMp4 '\\fixture\share\Movie.mp4' -ExpectedIdentitySid 'S-1-0-0'; exit `$LASTEXITCODE" -TimeoutSeconds 10
    Assert-True ($r.ExitCode -eq 2 -and $r.Output -match 'IDENTITY_MISMATCH') 'Identity guard failed'
    foreach ($template in @('Greenflix.xml.template','GreenflixProbe.xml.template')) {
        [xml]$xml = Get-Content -LiteralPath (Join-Path $PSScriptRoot $template) -Raw
        Assert-True ($null -ne $xml.service.serviceaccount -and !$xml.SelectSingleNode('//password') -and !$xml.SelectSingleNode('//map')) 'Unsafe WinSW template'
    }
    $parseErrors = @()
    foreach ($source in (Get-ChildItem $PSScriptRoot -File | Where-Object { $_.Extension -in '.ps1','.psm1' })) {
        $tokens=$null; $errors=$null
        $null=[Management.Automation.Language.Parser]::ParseFile($source.FullName,[ref]$tokens,[ref]$errors)
        $parseErrors += @($errors)
    }
    Assert-True ($parseErrors.Count -eq 0) 'PowerShell parse failure'
    @{ Status='PASS'; Checks=$script:checks; Scope='LOCAL_SYNTHETIC_ONLY'; Smb='NOT_TESTED'; Service='NOT_INSTALLED' } | ConvertTo-Json
} finally {
    $resolved = [IO.Path]::GetFullPath($directory)
    $expected = [IO.Path]::GetFullPath($results) + [IO.Path]::DirectorySeparatorChar
    if (!$resolved.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cleanup target' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
