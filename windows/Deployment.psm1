#requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function Assert-LocalPath {
    param([Parameter(Mandatory)][string]$Path)
    if($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '[\x00-\x1f"%]' -or $Path -match '(^|[\\/])\.\.?([\\/]|$)') { throw 'LOCAL_ABSOLUTE_PATH_REQUIRED' }
    $full=[IO.Path]::GetFullPath($Path)
    if($full.TrimEnd('\','/').Length -lt 4) { throw 'VOLUME_ROOT_REFUSED' }
    $drive=Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='"+$full.Substring(0,2)+"'")
    if(!$drive -or $drive.DriveType -ne 3 -or $drive.FileSystem -ne 'NTFS') { throw 'LOCAL_FIXED_NTFS_REQUIRED' }
    $entry=$full
    while($entry) {
        if(Test-Path -LiteralPath $entry) {
            if(((Get-Item -LiteralPath $entry -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_PATH_REFUSED' }
        }
        $entry=Split-Path $entry -Parent
    }
    return $full.TrimEnd('\','/')
}
function Assert-ChildPath {
    param([string]$Parent,[string]$Child)
    if(!$Child.StartsWith($Parent.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'PATH_CONTAINMENT_FAILED' }
}
function Read-OperatorConfig {
    param([string]$Path)
    $null=Assert-LocalPath $Path
    $c=Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $allowed=@('InstallRoot','StateRoot','ReleaseDirectory','JavaExe','FfprobeExe','ServiceAccount','ExpectedIdentitySid','Origin','TlsMode','DatabaseFileName')
    foreach($name in $c.PSObject.Properties.Name) { if($name -notin $allowed) { throw 'UNKNOWN_OPERATOR_CONFIGURATION_FIELD' } }
    foreach($name in @('InstallRoot','StateRoot','ReleaseDirectory','JavaExe','FfprobeExe')) {
        $c.$name=Assert-LocalPath $c.$name
    }
    if($c.InstallRoot.StartsWith($c.StateRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or
       $c.StateRoot.StartsWith($c.InstallRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $c.InstallRoot -eq $c.StateRoot) { throw 'INSTALL_DATA_OVERLAP' }
    Assert-ChildPath (Join-Path $c.InstallRoot 'releases') $c.ReleaseDirectory
    if($c.ServiceAccount -notmatch '^[A-Za-z0-9_.-]+\\[A-Za-z0-9_.-]+\$$' -or $c.ExpectedIdentitySid -notmatch '^S-1-5-21-[0-9-]+$') { throw 'DEDICATED_GMSA_AND_SID_REQUIRED' }
    $sid=([Security.Principal.NTAccount]::new($c.ServiceAccount)).Translate([Security.Principal.SecurityIdentifier]).Value
    if($sid -ne $c.ExpectedIdentitySid) { throw 'ACCOUNT_SID_MISMATCH' }
    if($c.DatabaseFileName -notmatch '^[A-Za-z0-9_-]+\.db$') { throw 'INVALID_DATABASE_FILENAME' }
    $uri=[Uri]$c.Origin
    if(!$uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/' -or $c.TlsMode -notin @('Direct','Proxy')) { throw 'INTERNAL_HTTPS_ORIGIN_REQUIRED' }
    return $c
}
function Assert-Hash {
    param([string]$Path,[string]$Sha256)
    if($Sha256 -notmatch '^[0-9a-fA-F]{64}$' -or !(Test-Path -LiteralPath $Path -PathType Leaf) -or
       (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Sha256) { throw 'ARTIFACT_HASH_MISMATCH' }
}
function Assert-Release {
    param([string]$Directory)
    $base=Assert-LocalPath $Directory
    $manifest=Get-Content -LiteralPath (Join-Path $base 'release-manifest.json') -Raw | ConvertFrom-Json
    if($manifest.format -ne 1 -or $manifest.schemaVersion -ne '1' -or $manifest.files.Count -lt 5) { throw 'INVALID_RELEASE_MANIFEST' }
    foreach($file in $manifest.files) {
        if($file.path -notmatch '^[A-Za-z0-9_./-]+$' -or $file.path -match '(^|/)\.\.?(/|$)' -or $file.path.StartsWith('/')) { throw 'INVALID_RELEASE_MEMBER' }
        $member=Join-Path $base $file.path
        $null=Assert-LocalPath $member
        Assert-ChildPath $base ([IO.Path]::GetFullPath($member))
        Assert-Hash $member $file.sha256
    }
    $actual=@(Get-ChildItem -LiteralPath $base -File -Recurse | ForEach-Object { $_.FullName.Substring($base.Length+1).Replace('\','/') } | Where-Object { $_ -ne 'release-manifest.json' } | Sort-Object)
    $listed=@($manifest.files.path | Sort-Object)
    if(Compare-Object $actual $listed) { throw 'UNLISTED_RELEASE_MEMBER' }
    return $manifest
}
function Assert-Administrator {
    $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if(!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'ELEVATED_OPERATOR_REQUIRED' }
}
function Assert-ProtectedAcl {
    param([string]$Path,[string]$ServiceSid,[switch]$Writable)
    $acl=Get-Acl -LiteralPath $Path
    if(!$acl.AreAccessRulesProtected) { throw 'PROTECTED_ACL_REQUIRED' }
    $administrators=@('S-1-5-18','S-1-5-32-544')
    $write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor
           [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach($rule in $acl.Access) {
        $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -ne 0 -and $sid -notin $administrators -and !($Writable -and $sid -eq $ServiceSid)) { throw 'EXCESSIVE_WRITE_ACL' }
    }
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if($owner -notin $administrators) { throw 'ADMINISTRATIVE_OWNER_REQUIRED' }
}
function Get-GreenflixService {
    return Get-CimInstance Win32_Service -Filter "Name='Greenflix'" -ErrorAction Stop
}
function Assert-ServiceIdentity {
    param($Config,$Service)
    if(!$Service -or $Service.StartName -ne $Config.ServiceAccount) { throw 'SCM_SERVICE_IDENTITY_MISMATCH' }
    $expected='"'+(Join-Path $Config.InstallRoot 'service\Greenflix.exe')+'"'
    if($Service.PathName -ne $expected -and $Service.PathName -ne $expected.Trim('"')) { throw 'SCM_EXECUTABLE_MISMATCH' }
}
function Write-NewUtf8 {
    param([string]$Path,[string]$Text)
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Text); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Get-SafeFailureCategory {
    param($Failure)
    if($Failure.Exception.Message -cmatch '^[A-Z][A-Z0-9_]{2,100}$') { return $Failure.Exception.Message }
    return 'IO_OR_CONFIGURATION_UNAVAILABLE'
}
Export-ModuleMember -Function Assert-LocalPath,Assert-ChildPath,Read-OperatorConfig,Assert-Hash,Assert-Release,Assert-Administrator,Assert-ProtectedAcl,Get-GreenflixService,Assert-ServiceIdentity,Write-NewUtf8,Get-SafeFailureCategory
