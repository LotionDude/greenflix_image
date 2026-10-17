#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$NewOutputDirectory,[string]$Version='2.0.0-rc.2',[switch]$UseBuildCache,[switch]$ExportImage)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$output=[IO.Path]::GetFullPath($NewOutputDirectory)
if(Test-Path -LiteralPath $output){throw 'New Docker bundle directory required.'}
if($Version -notmatch '^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$'){throw 'Invalid release version.'}
$identity=& node (Join-Path $PSScriptRoot 'source-id.mjs') $root
if($LASTEXITCODE -ne 0){throw 'Source identity failed.'}
$image='greenflix:'+$Version
$arguments=@('build','--platform','linux/amd64','--build-arg',('SOURCE_REVISION='+$identity),'-t',$image)
if(!$UseBuildCache){$arguments+='--no-cache'}
& docker @arguments $root
if($LASTEXITCODE -ne 0){throw 'Docker build/test failed.'}
$null=New-Item -ItemType Directory -Path $output
Copy-Item -LiteralPath (Join-Path $root 'compose.yaml') -Destination $output
Copy-Item -LiteralPath (Join-Path $root '.env.example') -Destination $output
foreach($name in @('config','distribution')) {
    $target=Join-Path $output ('deploy/'+$name);$null=New-Item -ItemType Directory -Path $target -Force
    Get-ChildItem -LiteralPath (Join-Path $root ('deploy/'+$name)) -File | Where-Object {$_.Extension -in '.md','.yml','.mjs','.ps1'} | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $target}
}
foreach($name in @('compose.media.yaml','compose.smb.yaml','compose.tls.yaml','create-admin-secret.ps1')){Copy-Item -LiteralPath (Join-Path $root ('deploy/'+$name)) -Destination (Join-Path $output 'deploy')}
& node (Join-Path $PSScriptRoot 'source-id.mjs') $root (Join-Path $output 'source-identity.json')
if($LASTEXITCODE -ne 0){throw 'Source manifest failed.'}
$inspect=& docker image inspect $image
if($LASTEXITCODE -ne 0){throw 'Image inspection failed.'}
$metadata=($inspect | ConvertFrom-Json)[0]
[IO.File]::WriteAllText((Join-Path $output 'image.json'),(@{image=$image;id=$metadata.Id;architecture=$metadata.Architecture;os=$metadata.Os;bytes=$metadata.Size;source=$identity}|ConvertTo-Json))
if($ExportImage){& docker save -o (Join-Path $output ('greenflix-'+$Version+'-linux-amd64.tar')) $image;if($LASTEXITCODE -ne 0){throw 'Image export failed.'}}
& node (Join-Path $PSScriptRoot 'package-manifest.mjs') $output $Version
if($LASTEXITCODE -ne 0){throw 'Bundle checksums failed.'}
Write-Output ('Docker deployment bundle: '+$output)
