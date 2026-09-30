param(
  [string]$LearnerSource = 'D:\B1_Prep',
  [string]$NodeVersion = 'v24.21.0'
)

$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildRoot = Join-Path $sourceRoot '.qa\portable-build'
$stageRoot = Join-Path $buildRoot 'B1_Prep'
$downloadRoot = Join-Path $buildRoot 'downloads'
$archiveName = "node-$NodeVersion-win-x64.zip"
$archivePath = Join-Path $downloadRoot $archiveName
$checksumPath = Join-Path $downloadRoot 'SHASUMS256.txt'
if (Test-Path -LiteralPath $stageRoot) { throw "Staging folder already exists: $stageRoot" }

$checksumLines = @(Get-Content -LiteralPath $checksumPath | Where-Object { $_ -match ('\s' + [regex]::Escape($archiveName) + '$') })
if ($checksumLines.Count -ne 1) { throw 'Exact Node archive checksum not found.' }
$expectedHash = ($checksumLines[0] -split '\s+')[0]
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Node archive checksum mismatch.' }

foreach ($relative in @('server.js', 'package.json', 'public\index.html', 'data\seed.json', 'portable\start.cmd', 'portable\portable-launcher.cjs', 'portable\README.txt')) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relative))) { throw "Missing application file: $relative" }
}
New-Item -ItemType Directory -Path $stageRoot | Out-Null
foreach ($directory in @('public', 'data')) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot $directory) -Destination $stageRoot -Recurse
}
foreach ($relative in @('server.js', 'package.json', 'b1prep.ico', '.env.example', 'README.md', 'DESIGN_NOTES.md', 'exam-product-review.md')) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot $relative) -Destination $stageRoot
}
foreach ($relative in @('start.cmd', 'portable-launcher.cjs', 'README.txt', 'Sync-to-Home.cmd')) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot "portable\$relative") -Destination $stageRoot
}
New-Item -ItemType Directory -Path (Join-Path $stageRoot 'tools') | Out-Null
foreach ($relative in @('check.js', 'recover-progress.js', 'sync-home.js')) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot "tools\$relative") -Destination (Join-Path $stageRoot 'tools')
}

[pscustomobject]@{
  homePath = [IO.Path]::GetFullPath($LearnerSource)
  homeComputer = [Environment]::MachineName
  portablePort = 4381
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stageRoot 'sync-home.json') -Encoding UTF8

# Copy only learner settings and durable progress, never browser profiles or test data.
# F-5: the key and the record travel with the media, and a delete inside the installed app
# cannot reach media that is not attached. That is stated in the bundle, never claimed
# deleted - mitigation by disclosure, not deletion.
$learnerFiles = @('.env', 'progress.json', 'progress.json.bak', 'progress.json.pre-recovery')
$copiedLearnerFiles = @()
foreach ($relative in $learnerFiles) {
  $learnerFile = Join-Path $LearnerSource $relative
  if (Test-Path -LiteralPath $learnerFile) {
    Copy-Item -LiteralPath $learnerFile -Destination $stageRoot
    $copiedLearnerFiles += $relative
    if ($relative -like 'progress.json*') {
      $state = Get-Content -LiteralPath (Join-Path $stageRoot $relative) -Raw | ConvertFrom-Json
      if ($null -eq $state.nodes) { throw "Invalid learner record: $relative" }
    }
  }
}

# F-5: say plainly, on the media itself, that these copies are outside the app's delete path.
$deletionNotice = @(
  'Hatoove / B1 Prep - Hinweis zum Loeschen / deletion notice',
  '',
  'Diese Dateien liegen auf einem Wechseldatentraeger (z. B. SSD). Das installierte',
  'Programm kann Daten auf einem nicht angeschlossenen Datentraeger nicht loeschen.',
  '"Alles zuruecksetzen" loescht nur die Kopien auf dem Laufwerk, auf dem es laeuft.',
  'Auf diesem Datentraeger bleiben sie erhalten:',
  '',
  ($copiedLearnerFiles | ForEach-Object { "  - $_" }),
  '',
  'Das ist eine Offenlegung, KEINE Loeschung: die Kopie wandert mit dem Datentraeger.',
  'Um sie zu entfernen, loeschen Sie die Dateien auf dem Datentraeger selbst.',
  '',
  'English: this copy travels with the removable media and is outside the app delete path.',
  'This is mitigation by disclosure, not deletion.',
  ''
)
$deletionNotice | Set-Content -LiteralPath (Join-Path $stageRoot 'DELETION-NOTICE.txt') -Encoding UTF8
if ($copiedLearnerFiles.Count -gt 0) {
  Write-Warning ("The provider key and learner progress were copied to the media ({0}). A delete inside the install cannot reach them." -f ($copiedLearnerFiles -join ', '))
}

# Extract only the executable and its license; npm and installation tools are not needed.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$runtimeRoot = Join-Path $stageRoot 'runtime'
New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  foreach ($entryName in @('node.exe', 'LICENSE')) {
    $entry = $archive.GetEntry("node-$NodeVersion-win-x64/$entryName")
    if ($null -eq $entry) { throw "Missing runtime archive entry: $entryName" }
    $outputName = if ($entryName -eq 'LICENSE') { 'LICENSE.txt' } else { $entryName }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $runtimeRoot $outputName), $false)
  }
} finally { $archive.Dispose() }
@(
  "Node.js $NodeVersion, Windows x64"
  "Source: https://nodejs.org/dist/$NodeVersion/$archiveName"
  "Archive SHA-256: $expectedHash"
) | Set-Content -LiteralPath (Join-Path $runtimeRoot 'VERSION.txt') -Encoding UTF8

& (Join-Path $PSScriptRoot 'build-launcher.ps1') -OutputPath (Join-Path $stageRoot 'B1 Prep.exe')

$manifest = @(Get-ChildItem -LiteralPath $stageRoot -File -Recurse -Force | ForEach-Object {
  [pscustomobject]@{
    Path = [IO.Path]::GetRelativePath($stageRoot, $_.FullName)
    Length = $_.Length
    SHA256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  }
})
$manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $buildRoot 'manifest.json') -Encoding UTF8
Write-Output "Staged $($manifest.Count) files at $stageRoot"
Write-Output 'Learner files copied without printing their contents. Live installation unchanged.'
