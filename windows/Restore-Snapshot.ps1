#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$BackupDirectory,[Parameter(Mandatory)][string]$NewDataDirectory,
      [Parameter(Mandatory)][string]$ReleaseDirectory,[Parameter(Mandatory)][string]$JavaExe,
      [switch]$ApproveIsolatedRestore)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Deployment.psm1') -Force
try {
    if(!$ApproveIsolatedRestore) { throw 'EXPLICIT_ISOLATED_RESTORE_APPROVAL_REQUIRED' }
    $target=Assert-LocalPath $NewDataDirectory
    if(Test-Path -LiteralPath $target) { throw 'RESTORE_REQUIRES_NEW_DIRECTORY' }
    $release=Assert-Release $ReleaseDirectory
    $manifest=Get-Content -LiteralPath (Join-Path $BackupDirectory 'manifest.json') -Raw | ConvertFrom-Json
    if($manifest.format -ne 1 -or $manifest.schemaSha256 -ne $release.schemaSha256) { throw 'BACKUP_RELEASE_SCHEMA_MISMATCH' }
    $snapshot=Join-Path $BackupDirectory 'database.sqlite'
    Assert-Hash $snapshot $manifest.sha256
    $null=Assert-LocalPath $JavaExe
    $pins=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'toolchain.lock.json') -Raw | ConvertFrom-Json
    Assert-Hash $JavaExe $pins.java.javaExeSha256
    $null=New-Item -ItemType Directory -Path $target
    $database=Join-Path $target 'greenflix.db'
    [IO.File]::Copy($snapshot,$database,$false)
    $flushed=[IO.File]::Open($database,'Open','ReadWrite','None')
    try { $flushed.Flush($true) } finally { $flushed.Dispose() }
    Assert-Hash $database $manifest.sha256
    & $JavaExe '--enable-native-access=ALL-UNNAMED' '-Dloader.main=com.greenflix.operations.DatabaseMaintenance' '-cp' (Join-Path $ReleaseDirectory 'greenflix.jar') 'org.springframework.boot.loader.launch.PropertiesLauncher' 'verify' $database $manifest.sha256
    if($LASTEXITCODE -ne 0) { throw 'RESTORED_SNAPSHOT_VALIDATION_FAILED' }
    Write-NewUtf8 (Join-Path $target 'RESTORE-VERIFIED.json') ($manifest | ConvertTo-Json)
    '{"Status":"PASS","Scope":"ISOLATED_RESTORE","ConfigurationSwitched":false,"RootAndManagedFileReconciliation":"REQUIRED"}'
} catch { Write-Error ('Restore refused: '+(Get-SafeFailureCategory $_)); exit 1 }
