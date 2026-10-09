$ErrorActionPreference = 'Stop'
$extensionRoot = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $extensionRoot 'manifest.json') -Raw | ConvertFrom-Json
$outputDirectory = Join-Path $extensionRoot 'dist'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$files = @('manifest.json', 'background.js', 'core.js', 'filesystem.js', 'zip.js', 'manager.html', 'manager.js', 'style.css', 'README.md') | ForEach-Object { Join-Path $extensionRoot $_ }
$outputFile = Join-Path $outputDirectory "github-extension-loader-v$($manifest.version).zip"
Compress-Archive -LiteralPath $files -DestinationPath $outputFile -Force
Write-Output $outputFile
