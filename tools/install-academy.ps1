param(
  [string]$Target = 'D:\B1_Prep'
)

$ErrorActionPreference = 'Stop'
$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$targetRoot = (Resolve-Path -LiteralPath $Target).Path
if ($sourceRoot.TrimEnd('\') -eq $targetRoot.TrimEnd('\')) { throw 'Source and target must be different directories.' }
if (-not (Test-Path -LiteralPath (Join-Path $targetRoot 'public\index.html'))) { throw 'Target is not the existing B1 Prep application.' }

$interfaceFiles = @(
  'public\index.html',
  'public\js\app.js',
  'public\js\shell.js',
  'public\js\ui.js',
  'public\js\dashboard.js',
  'public\shell-refresh.css',
  'public\studio.css'
)
$documentFiles = @('DESIGN_NOTES.md', 'exam-product-review.md', 'README.md')
foreach ($relative in ($interfaceFiles + $documentFiles)) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relative))) { throw "Missing staged file: $relative" }
}

$backupRoot = Join-Path $targetRoot ('_backup_academy_' + (Get-Date -Format 'yyyyMMdd_HHmmss'))
New-Item -ItemType Directory -Path $backupRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $targetRoot 'public') -Destination $backupRoot -Recurse
foreach ($relative in $documentFiles) {
  $existingDocument = Join-Path $targetRoot $relative
  if (Test-Path -LiteralPath $existingDocument) { Copy-Item -LiteralPath $existingDocument -Destination $backupRoot }
}

# New assets go first; the entry HTML goes last. Already loaded study pages
# keep their current modules until the learner refreshes.
$filesToInstall = @(
  'public\js\dashboard.js', 'public\shell-refresh.css', 'public\studio.css',
  'public\js\shell.js', 'public\js\ui.js', 'public\js\app.js'
) + $documentFiles + @('public\index.html')
foreach ($relative in $filesToInstall) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot $relative) -Destination (Join-Path $targetRoot $relative) -Force
  $sourceHash = (Get-FileHash -LiteralPath (Join-Path $sourceRoot $relative) -Algorithm SHA256).Hash
  $installedHash = (Get-FileHash -LiteralPath (Join-Path $targetRoot $relative) -Algorithm SHA256).Hash
  if ($sourceHash -ne $installedHash) { throw "Installed file does not match the reviewed source: $relative. Backup: $backupRoot" }
}

Write-Output "Installed $($interfaceFiles.Count) interface files and $($documentFiles.Count) product documents."
Write-Output "Backup: $backupRoot"
Write-Output 'Learner progress, API settings, content packs and the running server were not replaced.'
