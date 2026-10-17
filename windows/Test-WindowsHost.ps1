#requires -Version 5.1
<# .SYNOPSIS
Read-only host inventory. No installation, feature changes, firewall changes,
service registration or credential collection. Unknown is never treated as pass.
#>
[CmdletBinding()]
param(
    [string]$ApprovedUncRoot,
    [string]$RepresentativeMp4,
    [string]$ServiceName = 'Greenflix',
    [string]$ExpectedIdentitySid
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Validation.psm1') -Force
function Get-Evidence {
    param([scriptblock]$Query)
    try { & $Query } catch { 'UNKNOWN_OR_ACCESS_DENIED' }
}
$report = [ordered]@{ SchemaVersion=1; TimestampUtc=[DateTime]::UtcNow.ToString('o'); Scope='CURRENT_HOST_ONLY' }
$report.OS = Get-Evidence { Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OperatingSystemSKU,OSArchitecture }
$report.Computer = Get-Evidence { Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,HypervisorPresent,@{n='MemoryGiB';e={[math]::Round($_.TotalPhysicalMemory/1GB,2)}} }
$report.CPU = Get-Evidence { @(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,VirtualizationFirmwareEnabled,SecondLevelAddressTranslationExtensions,VMMonitorModeExtensions) }
$report.LocalDisks = Get-Evidence { @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,FileSystem,@{n='SizeGiB';e={[math]::Round($_.Size/1GB,2)}},@{n='FreeGiB';e={[math]::Round($_.FreeSpace/1GB,2)}}) }
$report.IdentitySid = Get-Evidence { [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
$report.IdentityMatchesExpected = if ($ExpectedIdentitySid) { $report.IdentitySid -eq $ExpectedIdentitySid } else { 'NOT_REQUESTED' }
$report.Java = Get-Evidence {
    $r = Invoke-BoundedPowerShell -TimeoutSeconds 10 -Code @'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$java = Get-Command java -ErrorAction SilentlyContinue
if (!$java) { '{"Status":"MISSING"}'; exit }
$lines = (& $java.Source -version 2>&1 | Out-String)
$version = [regex]::Match($lines, '(?m)(?:openjdk|java) version "([^"]+)"').Groups[1].Value
@{ Status=$(if ($LASTEXITCODE -eq 0 -and $version) {'FOUND'} else {'UNKNOWN'}); Version=$version; Java25=($version -match '^25(?:\.|$)') } | ConvertTo-Json -Compress
'@
    if ($r.TimedOut -or $r.ExitCode -ne 0) { 'UNKNOWN' } else { $r.Output | ConvertFrom-Json }
}
$report.Docker = Get-Evidence {
    $r = Invoke-BoundedPowerShell -TimeoutSeconds 12 -Code @'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if (!(Get-Command docker -ErrorAction SilentlyContinue)) { '{"Status":"CLI_MISSING"}'; exit }
$value = & docker version --format '{{json .}}' 2>$null | Out-String
if ($LASTEXITCODE -ne 0) { '{"Status":"ENGINE_UNAVAILABLE"}'; exit }
$v = $value | ConvertFrom-Json
@{ Status='ENGINE_AVAILABLE'; ClientVersion=$v.Client.Version; ServerVersion=$v.Server.Version; EngineOS=$v.Server.Os; EngineArch=$v.Server.Arch } | ConvertTo-Json -Compress
'@
    if ($r.TimedOut -or $r.ExitCode -ne 0) { 'UNKNOWN' } else { $r.Output | ConvertFrom-Json }
}
$report.DockerDesktop = Get-Evidence { @{ Installed=(Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')); Service=@(Get-CimInstance Win32_Service -Filter "Name='com.docker.service'" | Select-Object State,StartMode) } }
$report.WSL = Get-Evidence {
    # Read-only command output stays inside the subprocess; names and paths omitted.
    $r = Invoke-BoundedPowerShell -TimeoutSeconds 12 -Code @'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if (!(Get-Command wsl.exe -ErrorAction SilentlyContinue)) { '{"Status":"MISSING"}'; exit }
$listing = (& wsl.exe --list --verbose 2>$null | Out-String).Replace([string][char]0,'')
$exitCode = $LASTEXITCODE
@{ Status=$(if ($exitCode -eq 0) {'LISTED'} else {'UNAVAILABLE'}); Wsl2DistributionObserved=[bool]($listing -match '(?m)\s2\s*$') } | ConvertTo-Json -Compress
'@
    if ($r.TimedOut -or $r.ExitCode -ne 0) { 'UNKNOWN' } else { $r.Output | ConvertFrom-Json }
}
$report.WindowsFeatures = Get-Evidence { @('Microsoft-Windows-Subsystem-Linux','VirtualMachinePlatform','Microsoft-Hyper-V-All') | ForEach-Object { Get-WindowsOptionalFeature -Online -FeatureName $_ | Select-Object FeatureName,State } }
$report.Service = Get-Evidence {
    if ($ServiceName -notmatch '^[A-Za-z0-9_-]+$') { throw 'Invalid service name' }
    $service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    if (!$service) { 'NOT_INSTALLED' } else {
        $identityMatch = 'NOT_REQUESTED'
        if ($ExpectedIdentitySid) {
            try { $identityMatch = ([Security.Principal.NTAccount]::new($service.StartName).Translate([Security.Principal.SecurityIdentifier]).Value -eq $ExpectedIdentitySid) } catch { $identityMatch = 'UNKNOWN' }
        }
        @{ State=$service.State; StartMode=$service.StartMode; IdentityMatchesExpected=$identityMatch }
    }
}
$report.WorkstationService = Get-Evidence { Get-Service LanmanWorkstation | Select-Object Status,StartType }
$report.SmbPort445 = 'NOT_REQUESTED'
if ($ApprovedUncRoot) {
    # Validate before resolving or contacting any supplied host.
    $validationFile = if ($RepresentativeMp4) { $RepresentativeMp4 } else { $ApprovedUncRoot.TrimEnd('\') + '\probe.mp4' }
    Assert-ApprovedInput $ApprovedUncRoot $validationFile
    $hostName = $ApprovedUncRoot.Substring(2).Split('\')[0]
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $connection = $client.ConnectAsync($hostName,445)
        $report.SmbPort445 = if ($connection.Wait(3000) -and $client.Connected) { 'REACHABLE' } else { 'UNREACHABLE_OR_TIMEOUT' }
    } catch { $report.SmbPort445 = 'UNREACHABLE_OR_TIMEOUT' } finally { $client.Dispose() }
}
$report.ShareRead = 'NOT_REQUESTED_REQUIRES_APPROVED_ROOT_AND_FILE'
if ($ApprovedUncRoot -and $RepresentativeMp4) {
    # Run independently so Test-SmbRead exit codes cannot terminate this inventory.
    $script = (Join-Path $PSScriptRoot 'Test-SmbRead.ps1').Replace("'", "''")
    $payload = @{ Root=$ApprovedUncRoot; File=$RepresentativeMp4; Sid=$ExpectedIdentitySid } | ConvertTo-Json -Compress
    $r = Invoke-BoundedPowerShell -TimeoutSeconds 45 -InputJson $payload -Code "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(`$false); `$p=[Console]::In.ReadToEnd()|ConvertFrom-Json; & '$script' -ApprovedUncRoot `$p.Root -RepresentativeMp4 `$p.File -ExpectedIdentitySid `$p.Sid"
    $report.ShareRead = if ($r.TimedOut) { 'TIMEOUT_INCONCLUSIVE' } else { Get-Evidence { $r.Output | ConvertFrom-Json } }
}
$report.OperatorRequired = @('Hypervisor owner must confirm nested virtualization exposure; guest flags alone are insufficient.',
    'Confirm service logon right, noninteractive network credentials and share + NTFS read-only ACLs.',
    'Confirm local SQLite disk, data/log/temp ACLs, free space, native DLL loading and backup ownership.',
    'Verify internal HTTPS certificate, DNS, port access and cold boot without interactive login.',
    'No service or feature was installed or started by this inventory.')
$report | ConvertTo-Json -Depth 8
