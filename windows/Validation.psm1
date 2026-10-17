Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-ApprovedInput {
    param([string]$Root, [string]$File)
    foreach ($value in @($Root, $File)) {
        if ([string]::IsNullOrWhiteSpace($value) -or $value -notmatch '^\\\\[^\\]+\\[^\\]+' -or
            $value -match '[\x00-\x1f\x7f/<>:"|?*\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]' -or
            $value -match '^\\\\[?.]\\') { throw 'INVALID_INPUT' }
        $parts = $value.Substring(2).TrimEnd('\').Split('\')
        foreach ($part in $parts) {
            if (!$part -or $part -eq '.' -or $part -eq '..' -or $part -match '[ .]$') { throw 'INVALID_INPUT' }
        }
        if ($parts[0] -match '^\s|\s$' -or $parts[1] -match '^\s|\s$') { throw 'INVALID_INPUT' }
    }
    $prefix = $Root.TrimEnd('\') + '\'
    if (!$File.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        ![IO.Path]::GetExtension($File).Equals('.mp4', [StringComparison]::OrdinalIgnoreCase)) { throw 'INVALID_INPUT' }
}

function Initialize-ReadProbe {
    if (-not ('Greenflix.Validation.ReadProbe' -as [type])) {
        Add-Type -Path (Join-Path $PSScriptRoot 'ReadProbe.cs')
    }
}

function Invoke-SmbProbe {
    param([string]$Root, [string]$File, [int]$ParallelReads, [int]$Iterations, [int]$BytesPerRead)
    Initialize-ReadProbe
    $stage = 'ROOT'
    try {
        Assert-ApprovedInput $Root $File
        # Reject client-visible links/junctions in the approved root and file ancestry.
        $parts = $File.Substring(2).Split('\')
        $path = '\\' + $parts[0] + '\' + $parts[1]
        for ($index = 2; $index -lt $parts.Length; $index++) {
            if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [ArgumentException]::new() }
            $path += '\' + $parts[$index]
        }
        # One entry is enough to prove enumeration; never walk the library recursively.
        $iterator = [IO.Directory]::EnumerateFileSystemEntries($Root).GetEnumerator()
        try { $null = $iterator.MoveNext() } finally { if ($iterator -is [IDisposable]) { $iterator.Dispose() } }
        $stage = 'FILE'
        $attributes = [IO.File]::GetAttributes($File)
        if (($attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) -ne 0) { throw [ArgumentException]::new() }
        $info = [IO.FileInfo]::new($File)
        $modified = $info.LastWriteTimeUtc.ToString('o')
        $stage = 'READ'
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $read = [Greenflix.Validation.ReadProbe]::Run($File, $ParallelReads, $Iterations, $BytesPerRead)
        $timer.Stop()
        [PSCustomObject]@{ Status='PASS'; Category='OK'; Stage='COMPLETE'; DirectoryEnumeration=$true;
            Length=$read.Length; LastWriteUtc=$modified; Offsets=$read.Offsets; BytesRead=$read.BytesRead;
            ParallelReads=$ParallelReads; Iterations=$Iterations; HandlesDisposed=$read.HandlesDisposed;
            LargeOffsets= $(if ($read.LargeOffsetsTested) { 'PASS' } else { 'NOT_TESTED_FILE_TOO_SMALL' });
            ElapsedMs=$timer.ElapsedMilliseconds; PerformanceAcceptance='NOT_ASSESSED' }
    } catch {
        $category = if ($_.Exception.Message -eq 'INVALID_INPUT') { 'INVALID_INPUT' } else { [Greenflix.Validation.ReadProbe]::Failure($_.Exception) }
        [PSCustomObject]@{ Status='FAIL'; Category=$category; Stage=$stage }
    }
}

function Invoke-BoundedPowerShell {
    param([string]$Code, [string]$InputJson = '', [int]$TimeoutSeconds = 30)
    $exe = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Join-Path $PSHOME $exe
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Code))
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8
    $start.StandardErrorEncoding = [Text.Encoding]::UTF8
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        # Payload (including UNC) goes through stdin, never the command line or logs.
        $process.StandardInput.Write($InputJson)
        $process.StandardInput.Close()
        if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            $null = $process.WaitForExit(5000)
            return [PSCustomObject]@{ ExitCode=124; Output=''; TimedOut=$true }
        }
        [PSCustomObject]@{ ExitCode=$process.ExitCode; Output=$stdout.GetAwaiter().GetResult(); TimedOut=$false }
    } finally { $process.Dispose() }
}

Export-ModuleMember -Function Assert-ApprovedInput, Initialize-ReadProbe, Invoke-SmbProbe, Invoke-BoundedPowerShell
