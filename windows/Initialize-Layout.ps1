#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OperatorConfig,[switch]$ApproveDirectoryAclChanges)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Deployment.psm1') -Force
try {
    if(!$ApproveDirectoryAclChanges) { throw 'EXPLICIT_DIRECTORY_AND_ACL_APPROVAL_REQUIRED' }
    Assert-Administrator
    $c=Read-OperatorConfig $OperatorConfig
    $directories=@($c.InstallRoot,(Join-Path $c.InstallRoot 'service'),(Join-Path $c.InstallRoot 'releases'),
        (Join-Path $c.InstallRoot 'runtime'),(Join-Path $c.InstallRoot 'tools'),$c.ReleaseDirectory,$c.StateRoot)
    foreach($name in @('config','data','logs','temp','backups')) { $directories+=Join-Path $c.StateRoot $name }
    $directories+=Join-Path $c.StateRoot 'config\secrets'
    $writable=@('data','logs','temp','backups') | ForEach-Object { Join-Path $c.StateRoot $_ }
    foreach($path in $directories) {
        $null=New-Item -ItemType Directory -Path $path -Force
        $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false)
        $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
        foreach($sid in @('S-1-5-18','S-1-5-32-544')) {
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
        }
        $rights=if($path -in $writable){'Modify'}else{'ReadAndExecute'}
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($c.ExpectedIdentitySid),$rights,'ContainerInherit,ObjectInherit','None','Allow'))
        Set-Acl -LiteralPath $path -AclObject $acl
    }
    # No recursive ACL reset; inspect inherited/explicit child ACLs separately before starting.
    '{"Status":"PASS","Scope":"DIRECTORIES_AND_ACLS_ONLY","ServiceInstalled":false}'
} catch { Write-Error ('Layout refused: '+(Get-SafeFailureCategory $_)); exit 1 }
