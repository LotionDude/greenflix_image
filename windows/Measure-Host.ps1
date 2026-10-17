#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][int]$JavaProcessId,[Parameter(Mandatory)][string]$NewOutputFile,
      [ValidateRange(5,7500)][int]$Seconds=300,[ValidateRange(1,30)][int]$IntervalSeconds=2)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Deployment.psm1') -Force
$output=Assert-LocalPath $NewOutputFile
if(Test-Path -LiteralPath $output) { throw 'NEW_RESULT_REQUIRED' }
$process=Get-Process -Id $JavaProcessId
if($process.ProcessName -ne 'java') { throw 'JAVA_PROCESS_REQUIRED' }
$started=$process.StartTime.ToUniversalTime()
$samples=@();$counterStatus='PENDING_COUNTERS_NOT_AVAILABLE'
$timer=[Diagnostics.Stopwatch]::StartNew()
while($timer.Elapsed.TotalSeconds -lt $Seconds) {
    $process=Get-Process -Id $JavaProcessId -ErrorAction SilentlyContinue
    if(!$process -or $process.StartTime.ToUniversalTime() -ne $started) { break }
    $counters=@{}
    foreach($counter in @('\Network Interface(*)\Bytes Total/sec','\PhysicalDisk(_Total)\Disk Bytes/sec','\SMB Client Shares(*)\Data Bytes/sec')) { try {
        $values=Get-Counter $counter -ErrorAction Stop
        foreach($sample in $values.CounterSamples) {
            # Instance names contain share/server names; retain category and aggregate only.
            $category=if($sample.Path -like '*network interface*'){'networkBytesPerSecond'}elseif($sample.Path -like '*physicaldisk*'){'diskBytesPerSecond'}else{'smbBytesPerSecond'}
            if(!$counters.ContainsKey($category)){$counters[$category]=0.0};$counters[$category]+=$sample.CookedValue
        }
        $counterStatus='PASS_AVAILABLE_COUNTERS_SAMPLED'
    } catch { if($counterStatus -ne 'PASS_AVAILABLE_COUNTERS_SAMPLED'){$counterStatus='PENDING_COUNTERS_UNAVAILABLE_OR_LOCALIZED'} } }
    $samples+=[pscustomobject]@{Utc=[DateTime]::UtcNow.ToString('o');CpuSeconds=$process.CPU;WorkingSetBytes=$process.WorkingSet64;PrivateBytes=$process.PrivateMemorySize64;Handles=$process.HandleCount;Threads=$process.Threads.Count;Io=$counters}
    Start-Sleep -Seconds $IntervalSeconds
}
Write-NewUtf8 $output (@{Format=1;StartedUtc=$started.ToString('o');CounterStatus=$counterStatus;Samples=$samples} | ConvertTo-Json -Depth 6)
Write-Output 'Host resource samples saved. Evaluate baseline, peak and post-load recovery; sampling alone is not acceptance.'
