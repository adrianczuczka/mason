# Download a self-contained Mason release; works in Windows PowerShell 5.1+.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($architecture) { 'ARM64' { 'arm64' } 'AMD64' { 'x64' } default { throw "Unsupported architecture: $architecture" } }
$version = $env:MASON_VERSION
if (-not $version) {
    $response = Invoke-WebRequest -UseBasicParsing -Method Head -Uri 'https://github.com/adrianczuczka/mason/releases/latest'
    $url = if ($response.BaseResponse.ResponseUri) { $response.BaseResponse.ResponseUri.AbsoluteUri } else { $response.BaseResponse.RequestMessage.RequestUri.AbsoluteUri }
    $version = ($url -split '/')[-1]
}
$version = $version -replace '^v', ''
if ($version -cnotmatch '^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$') { throw 'Invalid Mason release version.' }
$asset = "mason-win32-$arch.zip"
$base = if ($env:MASON_RELEASE_BASE) { $env:MASON_RELEASE_BASE.TrimEnd('/') } else { 'https://github.com/adrianczuczka/mason/releases/download' }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('mason-install-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $archive = Join-Path $temp 'bundle.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "$base/v$version/$asset" -OutFile $archive
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/v$version/SHA256SUMS").Content
    if ($checksums -is [byte[]]) { $checksums = [Text.Encoding]::UTF8.GetString($checksums) }
    $checksumLines = @($checksums -split "`n" | Where-Object { $_ -cmatch ('^[a-f0-9]{64}\s+' + [regex]::Escape($asset) + '\s*$') })
    if ($checksumLines.Count -ne 1) { throw 'Missing or ambiguous release checksum.' }
    $expected = ($checksumLines[0] -split '\s+')[0]
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Mason archive checksum mismatch; installation unchanged.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if (-not $name.StartsWith("mason-win32-$arch/") -or ($name -split '/') -contains '..') { throw 'Unsafe archive entry.' }
        }
    } finally { $zip.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $temp)
    $bundle = Join-Path $temp "mason-win32-$arch"
    & (Join-Path $bundle 'node.exe') (Join-Path $bundle 'app/dist/mason.js') internal-install
    if ($LASTEXITCODE -ne 0) { throw "Mason installation failed ($LASTEXITCODE)." }
} finally { Remove-Item -LiteralPath $temp -Recurse -Force }
