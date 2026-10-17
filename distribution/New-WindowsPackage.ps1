#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$NewOutputDirectory,
      [Parameter(Mandatory)][string]$VerifiedJar,[Parameter(Mandatory)][string]$BuildProof,
      [string]$RuntimeDirectory,[string]$RuntimeArchive,[string]$Version='2.0.0-rc.2',[switch]$BuildInstaller)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$output=[IO.Path]::GetFullPath($NewOutputDirectory)
if(Test-Path -LiteralPath $output){throw 'New output directory required; existing releases are preserved.'}
if($Version -notmatch '^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$'){throw 'Use a semantic release version.'}
$pins=Get-Content -LiteralPath (Join-Path $root 'deploy/windows/toolchain.lock.json') -Raw | ConvertFrom-Json
if(!$RuntimeDirectory){$RuntimeDirectory=Join-Path $root 'deploy/tools/temurin25/jdk-25.0.4.1+1-jre'}
if(!$RuntimeArchive){$RuntimeArchive=Join-Path $root 'deploy/tools/temurin25/temurin25.zip'}
if((& jpackage --version) -ne $pins.build.jpackage){throw 'Use the pinned Windows jpackage build tool.'}
if((Get-FileHash -LiteralPath $RuntimeArchive).Hash -ne $pins.java.archiveSha256){throw 'Pinned runtime archive required.'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$runtimeZip=[IO.Compression.ZipFile]::OpenRead($RuntimeArchive)
try {
    $members=@()
    foreach($entry in $runtimeZip.Entries | Where-Object {$_.Name}) {
        $member=$entry.FullName.Substring($entry.FullName.IndexOf('/')+1)
        if($member -match '(^|/)\.\.(/|$)' -or [IO.Path]::IsPathRooted($member)){throw 'Unsafe runtime archive member.'}
        $members+=$member
        $stream=$entry.Open();$digest=[Security.Cryptography.SHA256]::Create()
        try{$expected=[BitConverter]::ToString($digest.ComputeHash($stream)).Replace('-','')}finally{$stream.Dispose();$digest.Dispose()}
        if((Get-FileHash -LiteralPath (Join-Path $RuntimeDirectory $member)).Hash -ne $expected){throw 'Runtime differs from its verified archive.'}
    }
    $actual=@(Get-ChildItem -LiteralPath $RuntimeDirectory -File -Recurse | ForEach-Object {$_.FullName.Substring([IO.Path]::GetFullPath($RuntimeDirectory).TrimEnd('\').Length+1).Replace('\','/')})
    if(Compare-Object ($members|Sort-Object) ($actual|Sort-Object)){throw 'Unlisted runtime member refused.'}
} finally {$runtimeZip.Dispose()}
if((Get-FileHash -LiteralPath (Join-Path $RuntimeDirectory 'bin/java.exe')).Hash -ne $pins.java.javaExeSha256){throw 'Bundled Java hash differs from toolchain.lock.json.'}
$probe=Join-Path $root 'deploy/tools/ffprobe/ffprobe.exe'
if((Get-FileHash -LiteralPath $probe).Hash -ne $pins.ffprobe.sha256){throw 'Provision the pinned Windows FFprobe using deploy/Get-Ffprobe.ps1.'}
if((Get-FileHash -LiteralPath (Join-Path $root 'deploy/tools/ffprobe/ffprobe-source-package.zip')).Hash -ne $pins.ffprobe.archiveSha256){throw 'Pinned probe/license archive required.'}
& node (Join-Path $root 'deploy/build-proof.mjs') verify $root $VerifiedJar $BuildProof
if($LASTEXITCODE -ne 0){throw 'Fresh application build proof required.'}
$null=New-Item -ItemType Directory -Path $output
$inputDirectory=Join-Path $output 'input';$null=New-Item -ItemType Directory -Path $inputDirectory
Copy-Item -LiteralPath $VerifiedJar -Destination (Join-Path $inputDirectory 'greenflix.jar')
$packageVersion=$Version.Split('-')[0]
& jpackage --type app-image --name Greenflix --app-version $packageVersion --vendor Greenflix --description 'Greenflix web application' `
    --input $inputDirectory --dest $output --main-jar greenflix.jar --main-class org.springframework.boot.loader.launch.PropertiesLauncher `
    --runtime-image $RuntimeDirectory --win-console --java-options '--enable-native-access=ALL-UNNAMED' `
    --java-options '-Dloader.main=com.greenflix.operations.PortableLauncher' --java-options '-Dgreenflix.home=$APPDIR/..' `
    --java-options '-XX:MaxRAMPercentage=65' --java-options '-XX:+ExitOnOutOfMemoryError'
if($LASTEXITCODE -ne 0){throw 'Windows application image creation failed.'}
$image=Join-Path $output 'Greenflix'
$null=New-Item -ItemType Directory -Path (Join-Path $image 'tools')
Copy-Item -LiteralPath $probe -Destination (Join-Path $image 'tools/ffprobe.exe')
# Extract upstream license/readme only. The archive contains no user data.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead((Join-Path $root 'deploy/tools/ffprobe/ffprobe-source-package.zip'))
try {
    $license=Join-Path $image 'licenses/ffprobe';$null=New-Item -ItemType Directory -Path $license -Force
    foreach($entry in $zip.Entries | Where-Object { $_.Name -match '^(LICENSE|README)(\.|$)' }){
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,(Join-Path $license $entry.Name),$false)
    }
} finally {$zip.Dispose()}
$null=New-Item -ItemType Directory -Path (Join-Path $image 'config/examples') -Force
Get-ChildItem -LiteralPath (Join-Path $root 'deploy/config') -File | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $image 'config/examples')}
# Reuse the existing service/restore toolkit against this app/ release directory.
foreach($name in @('windows','acceptance')) {
    $target=Join-Path $image ('app/deploy/'+$name);$null=New-Item -ItemType Directory -Path $target -Force
    Get-ChildItem -LiteralPath (Join-Path $root ('deploy/'+$name)) -File | Where-Object {$_.Extension -in '.ps1','.psm1','.cs','.md','.mjs','.json','.template'} | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $target}
}
Copy-Item -LiteralPath $BuildProof -Destination (Join-Path $image 'app/build-verification.json')
Copy-Item -LiteralPath (Join-Path $root 'deploy/create-admin-secret.ps1') -Destination (Join-Path $image 'tools/create-admin-secret.ps1')
foreach($name in @('Start-Greenflix.ps1','Stop-Greenflix.ps1','Test-Configuration.ps1','Initialize-Configuration.ps1')) {Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $image}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $image 'README.md')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD-PARTY.md') -Destination (Join-Path $image 'THIRD-PARTY.md')
& node (Join-Path $PSScriptRoot 'source-id.mjs') $root (Join-Path $image 'app/source-identity.json')
if($LASTEXITCODE -ne 0){throw 'Source identity failed.'}
& node (Join-Path $root 'deploy/release-manifest.mjs') (Join-Path $image 'app') $root $Version 1792195200
if($LASTEXITCODE -ne 0){throw 'Service release manifest failed.'}
& node (Join-Path $PSScriptRoot 'package-manifest.mjs') $image $Version
if($LASTEXITCODE -ne 0){throw 'Package manifest failed.'}
$installerStatus='Installer not requested. Run the portable acceptance tests before claiming launcher verification.'
if($BuildInstaller) {
    & jpackage --type exe --name Greenflix --app-version $packageVersion --app-image $image --dest (Join-Path $output 'installer') --vendor Greenflix --win-per-user-install
    if($LASTEXITCODE -ne 0){throw 'Installer packaging failed. The portable application image is preserved.'}
    $installerStatus='BUILT: installer execution requires separate operator approval.'
}
Write-Output ('Portable image: '+$image)
Write-Output $installerStatus
