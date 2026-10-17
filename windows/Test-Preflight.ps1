#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OperatorConfig,[switch]$CheckEndpoint)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Deployment.psm1') -Force
try {
    $c=Read-OperatorConfig $OperatorConfig
    $manifest=Assert-Release $c.ReleaseDirectory
    $pins=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'toolchain.lock.json') -Raw | ConvertFrom-Json
    Assert-Hash $c.JavaExe $pins.java.javaExeSha256
    Assert-Hash $c.FfprobeExe $pins.ffprobe.sha256
    Assert-Hash (Join-Path $c.InstallRoot 'service\Greenflix.exe') $pins.winsw.sha256
    foreach($path in @($c.InstallRoot,(Join-Path $c.InstallRoot 'service'),$c.ReleaseDirectory,(Join-Path $c.StateRoot 'config'))) {
        Assert-ProtectedAcl $path $c.ExpectedIdentitySid
    }
    foreach($name in @('data','logs','temp','backups')) { Assert-ProtectedAcl (Join-Path $c.StateRoot $name) $c.ExpectedIdentitySid -Writable }
    $configuration=Get-Content -LiteralPath (Join-Path $c.StateRoot 'config\application.yml') -Raw
    if($configuration -match '__[A-Z_]+__|REPLACE_WITH|(?im)^\s*(username|user-name|smb-password|network-password):' -or
       !$configuration.Contains($c.Origin)) { throw 'INVALID_EXTERNAL_CONFIGURATION' }
    $secrets=Join-Path $c.StateRoot 'config\secrets'
    Assert-ProtectedAcl $secrets $c.ExpectedIdentitySid
    $passwordHash=Get-Content -LiteralPath (Join-Path $secrets 'greenflix-admin-password-hash') -Raw
    if($passwordHash -notmatch '^[0-9a-fA-F]{96}\s*$') { throw 'INVALID_PROTECTED_PASSWORD_HASH' }
    $passwordHash=$null
    if($c.TlsMode -eq 'Direct' -and ($configuration -notmatch '(?ms)ssl:\s*\r?\n\s*enabled:\s*true' -or $configuration -notmatch 'key-store:')) { throw 'DIRECT_TLS_REQUIRED' }
    if($c.TlsMode -eq 'Direct' -and !(Test-Path -LiteralPath (Join-Path $secrets 'greenflix-tls-password'))) { throw 'PROTECTED_TLS_PASSWORD_REQUIRED' }
    if($c.TlsMode -eq 'Proxy' -and $configuration -notmatch '(?m)^\s*address:\s*127\.0\.0\.1\s*$') { throw 'PROXY_BACKEND_MUST_BIND_LOOPBACK' }
    [xml]$xml=Get-Content -LiteralPath (Join-Path $c.InstallRoot 'service\Greenflix.xml') -Raw
    if($xml.service.executable -ne $c.JavaExe.Replace('\','/') -or $xml.service.arguments -notlike ('*'+$c.ReleaseDirectory.Replace('\','/')+'/greenflix.jar*') -or
       $xml.service.arguments -match '-Xrs' -or $xml.SelectSingleNode('//password') -or $xml.SelectSingleNode('//map') -or $xml.SelectSingleNode('//download')) { throw 'SERVICE_CONFIGURATION_MISMATCH' }
    if(($xml.service.serviceaccount.domain+'\'+$xml.service.serviceaccount.user) -ne $c.ServiceAccount) { throw 'SERVICE_ACCOUNT_CONFIGURATION_MISMATCH' }
    $database=$xml.service.env | Where-Object { $_.name -eq 'GREENFLIX_DATABASE_URL' }
    if($database.value -ne ('jdbc:sqlite:'+(Join-Path $c.StateRoot ('data\'+$c.DatabaseFileName)).Replace('\','/'))) { throw 'SERVICE_DATABASE_POINTER_MISMATCH' }
    $service=Get-GreenflixService
    if($service) { Assert-ServiceIdentity $c $service }
    if($CheckEndpoint) {
        $response=Invoke-RestMethod -Uri ($c.Origin+'/actuator/health/readiness') -TimeoutSec 10
        if($response.status -ne 'UP') { throw 'APPLICATION_NOT_READY' }
    }
    # Service-token effective access and SMB acceptance are separate mandatory probes.
    [pscustomobject]@{Status='PASS';Release=$manifest.version;Configuration='CHECKED';ServiceTokenAccess='PENDING';Smb='PENDING';Endpoint=$(if($CheckEndpoint){'PASS'}else{'PENDING'})} | ConvertTo-Json
} catch { Write-Error ('Preflight refused: '+(Get-SafeFailureCategory $_)); exit 1 }
