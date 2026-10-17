#requires -Version 5.1
# Local, rights-cleared sample only. Never downloads to a media share.
$ErrorActionPreference = 'Stop'
$target = Join-Path $PSScriptRoot 'test-results/gate3-media'
$null = New-Item -ItemType Directory -Path $target -Force
$file = Join-Path $target 'known-h264-aac.mp4'
if (!(Test-Path -LiteralPath $file)) { Invoke-WebRequest -UseBasicParsing -Uri 'https://www.w3schools.com/html/mov_bbb.mp4' -OutFile $file }
if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne '3BB938FB70049E3E45F533B37CCAE995AE96516E04C2F35B0C1142E47B2A39C1') { throw 'Fixture checksum mismatch. No asset was registered.' }
Write-Output 'Local MP4 fixture verified. Attribution: (c) 2008 Blender Foundation / www.bigbuckbunny.org, CC BY 3.0; W3Schools sample excerpt.'
