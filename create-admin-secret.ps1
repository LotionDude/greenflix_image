#Requires -Version 5.1
param(
    [string]$Namespace,
    [string]$SecretName = 'greenflix-admin'
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 (.NET Framework 4.7.2+) or PowerShell 7.
# Password/hash remain in memory/stdin, not command arguments or files.
$securePassword = Read-Host 'Shared admin password (32-256 Unicode code points)' -AsSecureString
$password = [System.Net.NetworkCredential]::new('', $securePassword).Password
try {
    $codePoints = 0
    for ($index = 0; $index -lt $password.Length; $index++) {
        $codePoints++
        if ([char]::IsHighSurrogate($password[$index]) -and $index + 1 -lt $password.Length -and [char]::IsLowSurrogate($password[$index + 1])) { $index++ }
    }
    if ($codePoints -lt 32 -or $codePoints -gt 256) { throw 'Password length must be 32-256 code points.' }
    $salt = New-Object byte[] 16
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($salt) } finally { $random.Dispose() }
    $passwordBytes = [Text.Encoding]::UTF8.GetBytes($password)
    $kdf = [Security.Cryptography.Rfc2898DeriveBytes]::new($passwordBytes, $salt, 310000, [Security.Cryptography.HashAlgorithmName]::SHA256)
    try { $derived = $kdf.GetBytes(32) } finally { $kdf.Dispose() }
    $hash = [BitConverter]::ToString([byte[]]($salt + $derived)).Replace('-', '').ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($Namespace)) {
        # Local generation only. The operator explicitly receives the configuration hash.
        Write-Output $hash
        return
    }
    $secret = @{ apiVersion = 'v1'; kind = 'Secret'; metadata = @{ name = $SecretName; namespace = $Namespace }; type = 'Opaque'; stringData = @{ 'password-hash' = $hash } }
    $resourceVersion = & oc get secret $SecretName -n $Namespace --ignore-not-found -o 'jsonpath={.metadata.resourceVersion}'
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Secret metadata.' }
    $operation = if ($resourceVersion) { $secret.metadata.resourceVersion = $resourceVersion; 'replace' } else { 'create' }
    # Avoid a last-applied annotation containing the hash.
    $secret | ConvertTo-Json -Depth 5 -Compress | & oc $operation -f -
    if ($LASTEXITCODE -ne 0) { throw 'Secret creation/rotation failed.' }
    Write-Host 'Restart the sole deployment to load the hash and invalidate sessions.'
} finally {
    if ($passwordBytes) { [Array]::Clear($passwordBytes, 0, $passwordBytes.Length) }
    $password = $null; $hash = $null; $derived = $null; $secret = $null
    $securePassword.Dispose()
}
