#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OperatorConfig,[ValidateRange(1,168)][int]$Hours=24)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Deployment.psm1') -Force
try {
    $config=Read-OperatorConfig $OperatorConfig
    $service=Get-GreenflixService
    if($service){Assert-ServiceIdentity $config $service}
    $events=@();$available=$true
    foreach($log in @('System','Application')) { try {
        $filter=@{LogName=$log;StartTime=(Get-Date).AddHours(-$Hours)}
        if($log -eq 'System'){$filter.ProviderName='Service Control Manager';$filter.Id=7000,7009,7011,7023,7024,7031,7034,7036,7040}
        foreach($event in Get-WinEvent -FilterHashtable $filter -MaxEvents 300 -ErrorAction Stop) {
            $values=@($event.Properties | ForEach-Object {[string]$_.Value})
            if($values -contains 'Greenflix' -or $event.ProviderName -eq 'Greenflix') {
                # Messages/properties can expose paths/accounts. Keep only safe event metadata.
                $events+=@{Log=$log;Id=$event.Id;Level=$event.Level;Utc=$event.TimeCreated.ToUniversalTime().ToString('o')}
            }
        }
    } catch { $available=$false } }
    [pscustomobject]@{Service=$(if($service){$service.State}else{'NOT_INSTALLED'});StartMode=$(if($service){$service.StartMode}else{$null});
        ExitCode=$(if($service){$service.ExitCode}else{$null});ServiceExitCode=$(if($service){$service.ServiceSpecificExitCode}else{$null});
        EventQuery=$(if($available){'COMPLETE_BOUNDED_QUERY'}else{'PENDING_ACCESS_OR_NO_MATCHING_EVENTS'});Events=$events;ApplicationReadiness='CHECK_HTTPS_READINESS'} | ConvertTo-Json -Depth 5
} catch { Write-Error ('Diagnostics unavailable: '+(Get-SafeFailureCategory $_));exit 1 }
