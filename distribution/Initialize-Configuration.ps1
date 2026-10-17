#requires -Version 5.1
param([Parameter(Mandatory)][string]$NewConfigDirectory,[Parameter(Mandatory)][string]$DataDirectory)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $NewConfigDirectory){throw 'New configuration directory required; existing configuration is never overwritten.'}
if(![IO.Path]::IsPathRooted($DataDirectory) -or $DataDirectory.StartsWith('\\')){throw 'Absolute LOCAL data directory required.'}
$null=New-Item -ItemType Directory -Path $NewConfigDirectory
$secrets=Join-Path ([IO.Path]::GetFullPath($NewConfigDirectory)) 'secrets'
$null=New-Item -ItemType Directory -Path $secrets
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @($identity,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
Set-Acl -LiteralPath $secrets -AclObject $acl
$null=New-Item -ItemType Directory -Path $DataDirectory -Force
# Existing helper enforces 32–256 code points and prompts without CLI credentials.
$hash=& (Join-Path $PSScriptRoot 'tools/create-admin-secret.ps1')
if($hash -notmatch '^[0-9a-fA-F]{96}$'){throw 'Password helper did not return a valid PBKDF2 hash.'}
[IO.File]::WriteAllText((Join-Path $secrets 'greenflix-admin-password-hash'),$hash,[Text.UTF8Encoding]::new($false))
$text=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config/examples/application.minimal.yml') -Raw
$text=$text.Replace('${GREENFLIX_STATE_DIR}',$DataDirectory.Replace('\','/')).Replace('${GREENFLIX_SECRETS_DIR}',$secrets.Replace('\','/'))
[IO.File]::WriteAllText((Join-Path $NewConfigDirectory 'application.yml'),$text,[Text.UTF8Encoding]::new($false))
'External configuration prepared. Review data-directory ACLs before launch and use the dedicated service identity for unattended hosting.'
