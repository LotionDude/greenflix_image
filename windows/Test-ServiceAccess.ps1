#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigFile,[switch]$RequireServiceSession)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Validation.psm1') -Force
try {
    if($ConfigFile.StartsWith('\\') -or ![IO.Path]::IsPathRooted($ConfigFile)) { throw 'LOCAL_CONFIG_REQUIRED' }
    $config=Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if($identity.User.Value -ne $config.ExpectedIdentitySid) { throw 'IDENTITY_MISMATCH' }
    if(([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'RESTRICTED_SERVICE_TOKEN_REQUIRED' }
    $serviceSession=(Get-Process -Id $PID).SessionId -eq 0
    if($RequireServiceSession -and !$serviceSession) { throw 'NONINTERACTIVE_SERVICE_SESSION_REQUIRED' }
    if(!('Greenflix.Operations.EffectiveAccess' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'EffectiveAccess.cs') }
    $report=@(); $failed=$false
    foreach($root in $config.Roots) {
        if($root.Classification -notin @('LEGACY','MANAGED') -or $root.Reference -notmatch '^[A-Za-z0-9_-]{1,80}$') { throw 'INVALID_ROOT' }
        if($root.Path.StartsWith('\\')) { Assert-ApprovedInput $root.Path $root.RepresentativeMp4 }
        elseif(!$root.Path.StartsWith([IO.Path]::GetPathRoot($root.Path)) -or !$root.RepresentativeMp4.StartsWith($root.Path.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'INVALID_ROOT' }
        $access=@{}
        foreach($entry in @{ReadAndEnumerate=1;AddFile=2;AddDirectory=4;DeleteChild=64;Delete=65536;ChangeAcl=262144;TakeOwnership=524288}.GetEnumerator()) {
            $access[$entry.Key]=[Greenflix.Operations.EffectiveAccess]::Check($root.Path,[uint32]$entry.Value)
        }
        $sampleWrite=[Greenflix.Operations.EffectiveAccess]::Check($root.RepresentativeMp4,0x40000000)
        $sampleDelete=[Greenflix.Operations.EffectiveAccess]::Check($root.RepresentativeMp4,0x10000)
        $ok=$access.ReadAndEnumerate -eq 'ALLOWED'
        if($root.Classification -eq 'LEGACY') {
            foreach($name in @('AddFile','AddDirectory','DeleteChild','Delete','ChangeAcl','TakeOwnership')) { $ok=$ok -and $access[$name] -eq 'DENIED' }
            $ok=$ok -and $sampleWrite -eq 'DENIED' -and $sampleDelete -eq 'DENIED'
        } else { $ok=$ok -and $access.AddFile -eq 'ALLOWED' -and $access.AddDirectory -eq 'ALLOWED' -and $access.ChangeAcl -eq 'DENIED' -and $access.TakeOwnership -eq 'DENIED' }
        $read=if($root.Path.StartsWith('\\')) { Invoke-SmbProbe $root.Path $root.RepresentativeMp4 2 1 4096 } else { $null }
        if($read -and $read.Status -ne 'PASS') { $ok=$false }
        $failed=$failed -or !$ok
        $report+=[pscustomobject]@{Reference=$root.Reference;Status=$(if($ok){'PASS'}else{'FAIL'});Access=$access;SampleWriteAccess=$sampleWrite;SampleDeleteAccess=$sampleDelete;Reads=$read;Layer='EFFECTIVE_NTFS_AND_SMB_WHEN_UNC';ShareAclReview='PENDING_SERVER_ADMIN_EXPORT'}
    }
    $local=@()
    if($config.PSObject.Properties.Name -contains 'LocalDirectories') { foreach($entry in $config.LocalDirectories) {
        if($entry.Reference -notmatch '^[A-Za-z0-9_-]{1,80}$' -or $entry.Path -notmatch '^[A-Za-z]:\\') { throw 'INVALID_LOCAL_DIRECTORY' }
        $read=[Greenflix.Operations.EffectiveAccess]::Check($entry.Path,1)
        $write=[Greenflix.Operations.EffectiveAccess]::Check($entry.Path,2)
        $acl=[Greenflix.Operations.EffectiveAccess]::Check($entry.Path,262144)
        $ok=$read -eq 'ALLOWED' -and $acl -eq 'DENIED' -and $write -eq $(if($entry.Writable){'ALLOWED'}else{'DENIED'})
        $failed=$failed -or !$ok
        $local+=@{Reference=$entry.Reference;Read=$read;AddFile=$write;ChangeAcl=$acl;Status=$(if($ok){'PASS'}else{'FAIL'})}
    } }
    [pscustomobject]@{Status=$(if($failed){'FAIL'}else{'PASS'});IdentityValidated=$true;ServiceSession=$serviceSession;ServiceTokenAcceptance=$(if($serviceSession){'CHECK_SCM_PROVENANCE'}else{'PENDING'});Roots=$report;LocalDirectories=$local;FilesystemModified=$false} | ConvertTo-Json -Depth 8
    if($failed) { exit 1 }
} catch { '{"Status":"FAIL","Category":"SERVICE_ACCESS_PROBE_REFUSED_OR_UNAVAILABLE"}'; exit 2 }
