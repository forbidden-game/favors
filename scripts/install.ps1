$ErrorActionPreference = "Stop"

$Repo = "forbidden-game/favors"
$InstallDir = if ($env:FAVORS_HOME) { $env:FAVORS_HOME } else { Join-Path $env:LOCALAPPDATA "Favors" }

function Get-ArchName {
  if ([Environment]::Is64BitOperatingSystem) { "x64" } else { throw "Unsupported Windows architecture" }
}

function Get-SourceDir {
  $ScriptDir = Split-Path -Parent $MyInvocation.ScriptName
  if (-not $ScriptDir) { $ScriptDir = Get-Location }
  $Root = Resolve-Path (Join-Path $ScriptDir "..")
  $LocalBin = Join-Path $Root "bin/favorsd.exe"
  $LocalWeb = Join-Path $Root "web/index.html"
  if ((Test-Path $LocalBin) -and (Test-Path $LocalWeb)) { return $Root.Path }

  $Temp = Join-Path ([IO.Path]::GetTempPath()) ("favors-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $Temp | Out-Null
  $Archive = if ($env:FAVORS_PACKAGE) { $env:FAVORS_PACKAGE } else { Join-Path $Temp ("favors-windows-" + (Get-ArchName) + ".zip") }
  if (-not $env:FAVORS_PACKAGE) {
    $Url = "https://github.com/$Repo/releases/latest/download/favors-windows-$(Get-ArchName).zip"
    Invoke-WebRequest -Uri $Url -OutFile $Archive
  }
  Expand-Archive -Path $Archive -DestinationPath $Temp -Force
  return (Get-ChildItem -Path $Temp -Directory -Filter "favors-*" | Select-Object -First 1).FullName
}

$Source = Get-SourceDir
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "data") | Out-Null
Get-Process favorsd -ErrorAction SilentlyContinue | Stop-Process -Force
if ((Resolve-Path $Source).Path -ne (Resolve-Path $InstallDir -ErrorAction SilentlyContinue).Path) {
  foreach ($Name in @("bin", "web", "extension", "scripts")) {
    $Target = Join-Path $InstallDir $Name
    if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
    Copy-Item -Recurse -Path (Join-Path $Source $Name) -Destination $Target
  }
}

$RunCmd = Join-Path $InstallDir "run-favors.cmd"
@"
@echo off
set FAVORS_ROOT=$InstallDir
set FAVORS_WEB_DIR=$InstallDir\web
set FAVORS_DATA_DIR=$InstallDir\data
cd /d "$InstallDir"
start "" /min "$InstallDir\bin\favorsd.exe"
"@ | Set-Content -Encoding ASCII -Path $RunCmd

$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
New-ItemProperty -Path $RunKey -Name "Favors" -Value "`"$RunCmd`"" -PropertyType String -Force | Out-Null
Start-Process -FilePath $RunCmd -WindowStyle Hidden

Write-Host "Favors installed in $InstallDir"
Write-Host "Open http://127.0.0.1:8123"
Write-Host "Chrome extension path: $InstallDir\extension"
