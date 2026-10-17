#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SourceDatabase,
      [Parameter(Mandatory=$true)][string]$NewOutputDirectory,
      [Parameter(Mandatory=$true)][switch]$OfflineAdditiveGate6)
$ErrorActionPreference='Stop'
if (!$OfflineAdditiveGate6) { throw 'Explicit offline development acknowledgement required.' }
$project=Split-Path $PSScriptRoot -Parent
$backend=Join-Path $project 'backend'
$sourcePath=(Resolve-Path -LiteralPath $SourceDatabase).Path
$outputPath=[IO.Path]::GetFullPath($NewOutputDirectory)
if (Test-Path -LiteralPath $outputPath) { throw 'Use a new isolated output directory.' }
Push-Location $backend
try {
    & .\mvnw.cmd -B -q test-compile dependency:build-classpath '-Dmdep.outputFile=target/test-classpath.txt'
    if ($LASTEXITCODE -ne 0) { throw 'Offline tooling compilation failed.' }
    $dependencies=[IO.File]::ReadAllText((Join-Path $backend 'target/test-classpath.txt')).Trim()
    $classpath=(Join-Path $backend 'target/test-classes')+[IO.Path]::PathSeparator+(Join-Path $backend 'target/classes')+[IO.Path]::PathSeparator+$dependencies
    & java --enable-native-access=ALL-UNNAMED -cp $classpath com.greenflix.tools.Gate6DevelopmentUpgrade --offline-additive-gate6 $sourcePath $outputPath
    if ($LASTEXITCODE -ne 0) { throw 'Upgrade was not verified. Retain the old configuration and all output.' }
} finally { Pop-Location }
