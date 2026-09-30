param(
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputPath) {
  $OutputPath = Join-Path $sourceRoot '.qa\portable-build\B1 Prep.exe'
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$sourcePath = Join-Path $sourceRoot 'portable\Launcher.cs'
$iconPath = Join-Path $sourceRoot 'b1prep.ico'
foreach ($required in @($sourcePath, $iconPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing launcher input: $required" }
}

$compiler = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe')
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $compiler) { throw 'The Windows .NET Framework C# compiler was not found.' }

[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputPath)) | Out-Null
& $compiler /nologo /target:winexe /platform:anycpu /optimize+ /reference:System.Windows.Forms.dll "/win32icon:$iconPath" "/out:$OutputPath" $sourcePath
if ($LASTEXITCODE -ne 0) { throw "Launcher compilation failed with exit code $LASTEXITCODE." }
Write-Output "Built $OutputPath"
