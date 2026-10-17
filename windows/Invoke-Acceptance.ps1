#requires -Version 5.1
# Password stays in memory and stdin. Config/results must be protected; no transcript.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigFile,[ValidateSet('load','smb','https')][string]$Suite='smb',
      [switch]$ApproveHeavyLoad,[switch]$ApproveSmbLoad,[switch]$ApproveFixtureCatalogChanges,[switch]$ApproveDisposableManagedWrites)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Deployment.psm1') -Force
try {
    $null=Assert-LocalPath $ConfigFile
    $config=Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
    if($Suite -eq 'load' -and (!$ApproveHeavyLoad -or ($config.storageKind -eq 'SMB' -and !$ApproveSmbLoad))) { throw 'EXPLICIT_LOAD_APPROVAL_REQUIRED' }
    if($Suite -eq 'smb' -and !$ApproveFixtureCatalogChanges) { throw 'EXPLICIT_FIXTURE_CATALOG_APPROVAL_REQUIRED' }
    if($Suite -eq 'smb' -and ($config.PSObject.Properties.Name -contains 'managedRootId') -and $config.managedRootId -and !$ApproveDisposableManagedWrites) { throw 'EXPLICIT_DISPOSABLE_WRITE_APPROVAL_REQUIRED' }
    if($Suite -eq 'smb' -and ($config.PSObject.Properties.Name -contains 'ffprobeExe') -and $config.ffprobeExe) {
        $null=Assert-LocalPath $config.ffprobeExe
        $pins=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'toolchain.lock.json') -Raw | ConvertFrom-Json
        Assert-Hash $config.ffprobeExe $pins.ffprobe.sha256
    }
    if(!$config.resultFile) { throw 'NEW_PROTECTED_RESULT_FILE_REQUIRED' }
    $null=Assert-LocalPath $config.resultFile
    if(Test-Path -LiteralPath $config.resultFile) { throw 'RESULT_FILE_ALREADY_EXISTS' }
    foreach($entry in @{allowHeavyLoad=[bool]$ApproveHeavyLoad;allowSmbLoad=[bool]$ApproveSmbLoad;approveFixtureCatalogChanges=[bool]$ApproveFixtureCatalogChanges;approveDisposableManagedWrites=[bool]$ApproveDisposableManagedWrites}.GetEnumerator()) {
        $config | Add-Member -NotePropertyName $entry.Key -NotePropertyValue $entry.Value -Force
    }
    $secure=Read-Host 'Shared administrator password (no transcript)' -AsSecureString
    $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $payload=@{config=$config;password=$password} | ConvertTo-Json -Depth 12 -Compress
    $start=[Diagnostics.ProcessStartInfo]::new(); $start.FileName=(Get-Command node.exe).Source
    $script=Join-Path (Split-Path $PSScriptRoot -Parent) ('acceptance/'+$Suite+'.mjs')
    $start.Arguments='"'+$script+'"'; $start.UseShellExecute=$false; $start.CreateNoWindow=$true; $start.RedirectStandardInput=$true
    $process=[Diagnostics.Process]::new(); $process.StartInfo=$start
    try {
        $null=$process.Start(); $process.StandardInput.Write($payload); $process.StandardInput.Close()
        $payload=$null; $password=$null; $secure.Dispose()
        $process.WaitForExit(); exit $process.ExitCode
    } finally { $process.Dispose() }
} catch { Write-Error ('Acceptance refused: '+(Get-SafeFailureCategory $_)); exit 2 }
