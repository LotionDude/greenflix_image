#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OperatorConfig,[Parameter(Mandatory)][string]$OutputXml)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Deployment.psm1') -Force
try {
    $c=Read-OperatorConfig $OperatorConfig
    $null=Assert-LocalPath $OutputXml
    $manifest=Assert-Release $c.ReleaseDirectory
    $pins=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'toolchain.lock.json') -Raw | ConvertFrom-Json
    Assert-Hash $c.JavaExe $pins.java.javaExeSha256
    Assert-Hash $c.FfprobeExe $pins.ffprobe.sha256
    Assert-Hash (Join-Path $c.InstallRoot 'service\Greenflix.exe') $pins.winsw.sha256
    $account=$c.ServiceAccount.Split('\')
    $values=@{
        JAVA_EXE=$c.JavaExe; FFPROBE_EXE=$c.FfprobeExe; TEMP_DIR=(Join-Path $c.StateRoot 'temp'); APP_JAR=(Join-Path $c.ReleaseDirectory 'greenflix.jar');
        CONFIG_DIR=(Join-Path $c.StateRoot 'config'); WORK_DIR=(Join-Path $c.StateRoot 'data'); DOMAIN=$account[0];
        GMSA_NAME=$account[1].TrimEnd('$'); LOG_DIR=(Join-Path $c.StateRoot 'logs'); DATA_DIR=(Join-Path $c.StateRoot 'data'); DATABASE_NAME=$c.DatabaseFileName
    }
    $xml=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Greenflix.xml.template') -Raw
    foreach($name in $values.Keys) { $xml=$xml.Replace('__'+$name+'__',[Security.SecurityElement]::Escape($values[$name].Replace('\','/'))) }
    [xml]$document=$xml
    if($document.service.OuterXml -match '__[A-Z_]+__' -or $document.SelectSingleNode('//password|//download|//map') -or $document.service.arguments -match '-Xrs') { throw 'UNRESOLVED_OR_UNSAFE_SERVICE_CONFIGURATION' }
    Write-NewUtf8 $OutputXml $xml
    '{"Status":"PASS","Scope":"CONFIGURATION_RENDERED_ONLY"}'
} catch { Write-Error ('Service rendering refused: '+(Get-SafeFailureCategory $_)); exit 1 }
