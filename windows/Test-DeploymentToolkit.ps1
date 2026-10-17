#requires -Version 5.1
# Local checks only; no services, remote paths, ACL changes or credential prompts.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Deployment.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Validation.psm1') -Force
$count=0
function Assert([bool]$Value) { if(!$Value){throw 'TOOLKIT_ASSERTION_FAILED'}; $script:count++ }
function Reject([scriptblock]$Action) { $denied=$false;try{& $Action}catch{$denied=$true};Assert $denied }
Reject { Assert-LocalPath '\\never-contact.invalid\share\data' }
Reject { Assert-LocalPath 'C:\' }
Reject { Assert-LocalPath 'relative\data' }
Reject { Assert-ChildPath 'C:\root' 'C:\root-other\file' }
Assert-ChildPath 'C:\root' 'C:\root\child';$count++
foreach($file in Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object { $_.Extension -in '.ps1','.psm1' }) {
    $tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors)
    Assert ($errors.Count -eq 0)
}
[xml]$template=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Greenflix.xml.template') -Raw
Assert ($template.service.arguments -notmatch '-Xrs' -and $template.service.arguments -match 'spring.config.location' -and $template.service.arguments -match 'ExitOnOutOfMemoryError')
Assert ($template.service.onfailure[-1].action -eq 'none')
Assert ($template.service.startmode -eq 'Automatic' -and $template.service.delayedAutoStart -eq 'true')
Assert (@($template.service.env | Where-Object name -eq 'GREENFLIX_FFPROBE_PATH').value -eq '__FFPROBE_EXE__')
Assert (!$template.SelectSingleNode('//password') -and !$template.SelectSingleNode('//map') -and !$template.SelectSingleNode('//download'))
foreach($name in @('Initialize-Layout','Restore-Snapshot')) {
    $script=(Join-Path $PSScriptRoot ($name+'.ps1')).Replace("'","''")
    $probeArguments=if($name -eq 'Initialize-Layout'){"-OperatorConfig 'unused.json'"}else{"-BackupDirectory 'unused' -NewDataDirectory 'unused' -ReleaseDirectory 'unused' -JavaExe 'unused'"}
    $result=Invoke-BoundedPowerShell -Code "& '$script' $probeArguments; exit `$LASTEXITCODE" -TimeoutSeconds 10
    Assert ($result.ExitCode -eq 1 -and !$result.TimedOut)
}
$base=Join-Path $PSScriptRoot ('results\release-test-'+[Guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $base -Force
try {
    $files=@()
    foreach($name in @('greenflix.jar','a.txt','b.txt','c.txt','d.txt')) {
        $path=Join-Path $base $name;Write-NewUtf8 $path 'fixture'
        $files+=@{path=$name;sha256=(Get-FileHash -LiteralPath $path).Hash;bytes=7}
    }
    Write-NewUtf8 (Join-Path $base 'release-manifest.json') (@{format=1;schemaVersion='1';files=$files} | ConvertTo-Json -Depth 4)
    $null=Assert-Release $base;$count++
    Write-NewUtf8 (Join-Path $base 'extra.txt') 'unknown';Reject { Assert-Release $base }
    Remove-Item -LiteralPath (Join-Path $base 'extra.txt')
    [IO.File]::WriteAllText((Join-Path $base 'a.txt'),'changed');Reject { Assert-Release $base }
    Reject { Write-NewUtf8 (Join-Path $base 'b.txt') 'overwrite' }
} finally {
    $resolved=[IO.Path]::GetFullPath($base);$expected=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'results'))+'\'
    if(!$resolved.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase)){throw 'UNSAFE_CLEANUP'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
@{Status='PASS';Checks=$count;Scope='LOCAL_TOOLKIT_ONLY';Service='PENDING';Smb='PENDING'} | ConvertTo-Json
