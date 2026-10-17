#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('Install','Start','Stop','Upgrade','Rollback','Uninstall','Status')][string]$Action,
      [Parameter(Mandatory)][string]$OperatorConfig,[switch]$ApproveServiceChange,
      [string]$VerifiedBackupDirectory,[switch]$ApproveInterruption,[ValidateRange(5,200)][int]$OperatorLogKeep=20)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Deployment.psm1') -Force
function Invoke-Wrapper([string]$Verb) {
    & $script:wrapper $Verb *> $script:diagnostics
    if($LASTEXITCODE -ne 0) { throw 'WINSW_COMMAND_FAILED_INSPECT_PROTECTED_LOG' }
}
function Wait-Stopped {
    $timer=[Diagnostics.Stopwatch]::StartNew()
    do {
        $service=Get-GreenflixService
        if(!$service -or $service.State -eq 'Stopped') { break }
        if($timer.Elapsed.TotalSeconds -gt 75) { throw 'SERVICE_STOP_TIMEOUT_NO_FURTHER_ACTION' }
        Start-Sleep -Milliseconds 500
    } while($true)
    # SCM Stopped alone is insufficient: verify the application's OS lock is no longer held.
    $owner=Join-Path $script:c.StateRoot ('data\'+$script:c.DatabaseFileName+'.owner.lock')
    if(Test-Path -LiteralPath $owner) {
        $stream=[IO.File]::Open($owner,'Open','ReadWrite','ReadWrite')
        try { $stream.Lock(0,1); $stream.Unlock(0,1) } finally { $stream.Dispose() }
    }
}
try {
    if($Action -ne 'Status' -and !$ApproveServiceChange) { throw 'EXPLICIT_SERVICE_CHANGE_APPROVAL_REQUIRED' }
    $script:c=Read-OperatorConfig $OperatorConfig
    $script:wrapper=Join-Path $c.InstallRoot 'service\Greenflix.exe'
    $script:diagnostics=Join-Path $c.StateRoot ('logs\operator-'+[Guid]::NewGuid().ToString('N')+'.log')
    $pins=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'toolchain.lock.json') -Raw | ConvertFrom-Json
    Assert-Hash $wrapper $pins.winsw.sha256
    $service=Get-GreenflixService
    if($Action -eq 'Status') {
        if($service) { Assert-ServiceIdentity $c $service }
        [pscustomobject]@{Status=$(if($service){$service.State}else{'NOT_INSTALLED'});ApplicationReadiness='CHECK_HTTPS_ENDPOINT'} | ConvertTo-Json
        exit 0
    }
    if(!$ApproveServiceChange) { throw 'EXPLICIT_SERVICE_CHANGE_APPROVAL_REQUIRED' }
    Assert-Administrator
    if($Action -eq 'Install') {
        if($service) { throw 'SERVICE_ALREADY_EXISTS' }
        & (Join-Path $PSScriptRoot 'Test-Preflight.ps1') -OperatorConfig $OperatorConfig
        if(!$?) { throw 'PREFLIGHT_FAILED' }
        Invoke-Wrapper 'install'; $service=Get-GreenflixService; Assert-ServiceIdentity $c $service
        if($service.State -ne 'Stopped') { throw 'INSTALL_MUST_REMAIN_STOPPED' }
    } else {
        Assert-ServiceIdentity $c $service
        switch($Action) {
            'Start' {
                & (Join-Path $PSScriptRoot 'Test-Preflight.ps1') -OperatorConfig $OperatorConfig
                if(!$?) { throw 'PREFLIGHT_FAILED' }
                Invoke-Wrapper 'start'
                # Report SCM only: HTTPS readiness is explicitly checked after startup.
            }
            'Stop' { Invoke-Wrapper 'stop'; Wait-Stopped }
            'Uninstall' {
                if($service.State -ne 'Stopped') { throw 'STOP_SERVICE_BEFORE_UNINSTALL' }
                Wait-Stopped; Invoke-Wrapper 'uninstall'
            }
            { $_ -in 'Upgrade','Rollback' } {
                if(!$ApproveInterruption -or !$VerifiedBackupDirectory) { throw 'INTERRUPTION_AND_VERIFIED_BACKUP_REQUIRED' }
                $release=Assert-Release $c.ReleaseDirectory
                $backup=Get-Content -LiteralPath (Join-Path $VerifiedBackupDirectory 'manifest.json') -Raw | ConvertFrom-Json
                Assert-Hash (Join-Path $VerifiedBackupDirectory 'database.sqlite') $backup.sha256
                if($backup.schemaSha256 -ne $release.schemaSha256) { throw 'SCHEMA_MISMATCH_USE_ISOLATED_RESTORE_PROCEDURE' }
                $currentXml=Join-Path $c.InstallRoot 'service\Greenflix.xml'
                [xml]$current=Get-Content -LiteralPath $currentXml -Raw
                $match=[regex]::Match($current.service.arguments,'-jar "([^"]+)"')
                if(!$match.Success) { throw 'CURRENT_RELEASE_POINTER_INVALID' }
                $previous=Assert-Release (Split-Path $match.Groups[1].Value -Parent)
                if($previous.schemaSha256 -ne $release.schemaSha256) { throw 'SCHEMA_CHANGE_REQUIRES_EXPLICIT_OFFLINE_DATA_PLAN' }
                $next=Join-Path $c.InstallRoot ('service\next-'+[Guid]::NewGuid().ToString('N')+'.xml')
                & (Join-Path $PSScriptRoot 'New-ServiceConfiguration.ps1') -OperatorConfig $OperatorConfig -OutputXml $next
                if(!$?) { throw 'RENDER_FAILED' }
                Invoke-Wrapper 'stop'; Wait-Stopped
                $saved=$currentXml+'.previous-'+[Guid]::NewGuid().ToString('N')
                Move-Item -LiteralPath $currentXml -Destination $saved
                Move-Item -LiteralPath $next -Destination $currentXml
                Invoke-Wrapper 'refresh'
                & (Join-Path $PSScriptRoot 'Test-Preflight.ps1') -OperatorConfig $OperatorConfig
                if(!$?) { throw 'PREFLIGHT_FAILED_SERVICE_LEFT_STOPPED' }
                Invoke-Wrapper 'start'
            }
        }
    }
    [pscustomobject]@{Status='PASS';Action=$Action;DataDeleted=$false;ApplicationAcceptance='PENDING_HTTPS_CHECK'} | ConvertTo-Json
} catch { Write-Error ('Service action refused: '+(Get-SafeFailureCategory $_)); exit 1 }
finally {
    if($ApproveServiceChange -and $Action -ne 'Status' -and (Get-Variable -Name c -Scope Script -ErrorAction SilentlyContinue)) {
        try {
            $logs=Join-Path $script:c.StateRoot 'logs'
            $null=Assert-LocalPath $logs
            Get-ChildItem -LiteralPath $logs -File -Filter 'operator-*.log' | Where-Object { $_.Name -match '^operator-[0-9a-f]{32}\.log$' } |
                Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip $OperatorLogKeep | ForEach-Object { Remove-Item -LiteralPath $_.FullName }
        } catch { Write-Warning 'Operator log retention could not complete; inspect the protected log directory.' }
    }
}
