#requires -Version 5.1
<#
Explicit OFFLINE development-only V8 to consolidated V1 conversion. Stops on any mismatch.
Never changes the source, deletes output, repairs history, cleans, baselines, or switches configuration.
#>
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SourceDatabase,
      [Parameter(Mandatory=$true)][string]$NewOutputDirectory,
      [Parameter(Mandatory=$true)][switch]$OfflineDevelopmentV8ToV1)
$ErrorActionPreference='Stop'
if (!$OfflineDevelopmentV8ToV1) { throw 'Explicit development conversion acknowledgement required.' }
$project=Split-Path $PSScriptRoot -Parent
$backend=Join-Path $project 'backend'
$sourcePath=(Resolve-Path -LiteralPath $SourceDatabase).Path
$outputPath=[IO.Path]::GetFullPath($NewOutputDirectory)
if (Test-Path -LiteralPath $outputPath) { throw 'Use a new isolated output directory; existing output is never overwritten.' }
Push-Location $backend
try {
    & .\mvnw.cmd -B -q test-compile dependency:build-classpath '-Dmdep.outputFile=target/test-classpath.txt'
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile offline verification tooling.' }
    $dependencies=[IO.File]::ReadAllText((Join-Path $backend 'target/test-classpath.txt')).Trim()
    $classpath=(Join-Path $backend 'target/test-classes')+[IO.Path]::PathSeparator+(Join-Path $backend 'target/classes')+[IO.Path]::PathSeparator+$dependencies
    & java --enable-native-access=ALL-UNNAMED -cp $classpath com.greenflix.tools.DevelopmentBaseline --offline-development-v8-to-v1 $sourcePath $outputPath
    if ($LASTEXITCODE -ne 0) { throw 'Conversion was not verified. Do not switch databases; inspect the retained isolated output.' }
} finally { Pop-Location }
