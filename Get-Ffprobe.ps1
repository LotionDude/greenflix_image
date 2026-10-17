#requires -Version 5.1
# Optional, explicit local test provisioning. Extracts FFprobe only; never installs or executes FFmpeg.
[CmdletBinding()]
param([string]$NewOutputDirectory)
$ErrorActionPreference='Stop'
$destination=Join-Path $PSScriptRoot 'tools/ffprobe'
if($NewOutputDirectory) {
    if(![IO.Path]::IsPathRooted($NewOutputDirectory) -or $NewOutputDirectory.StartsWith('\\')) { throw 'New absolute local staging directory required.' }
    $destination=[IO.Path]::GetFullPath($NewOutputDirectory)
    if(Test-Path -LiteralPath $destination) { throw 'New FFprobe staging directory must not exist.' }
} elseif(Test-Path -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'release-manifest.json')) {
    throw 'Use -NewOutputDirectory outside the immutable release directory.'
}
$null=New-Item -ItemType Directory -Path $destination -Force
$archive=Join-Path $destination 'ffprobe-source-package.zip'
$packageHash='60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
$binaryHash='f0d36ecbbdd3bcfac3efa078c96c7271c2e68b3810595552ac3b7f17e9a65c52'
if(!(Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip' -OutFile $archive
}
if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $packageHash) { throw 'FFprobe package checksum mismatch.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($archive)
try {
    $entry=$zip.Entries | Where-Object { $_.FullName.EndsWith('/bin/ffprobe.exe') } | Select-Object -First 1
    if(!$entry) { throw 'Expected FFprobe package member is absent.' }
    $existing=Join-Path $destination 'ffprobe.exe'
    if(Test-Path -LiteralPath $existing) {
        if((Get-FileHash -LiteralPath $existing -Algorithm SHA256).Hash.ToLowerInvariant() -ne $binaryHash) { throw 'Existing FFprobe differs; no overwrite is permitted.' }
    } else { [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$existing,$false) }
} finally { $zip.Dispose() }
$executable=Join-Path $destination 'ffprobe.exe'
if((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $binaryHash) { throw 'FFprobe executable checksum mismatch.' }
$versionOutput=& $executable -version
if($LASTEXITCODE -ne 0) { throw 'FFprobe version verification failed.' }
$versionOutput | Select-Object -First 1
Write-Output 'Verified local FFprobe 9.0.2. No PATH, service or system installation changed.'
