param(
  [switch]$NoSafeMode,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $PSScriptRoot "start-portal-full.ps1"
$Desktop = [Environment]::GetFolderPath("Desktop")
$PowerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$IconLocation = Join-Path $env:SystemRoot "System32\shell32.dll"

function New-PortalShortcut {
  param(
    [string]$Name,
    [string]$ExtraArguments = ""
  )

  $shortcutPath = Join-Path $Desktop "$Name.lnk"
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Launcher`"$ExtraArguments"

  if ($DryRun) {
    [pscustomobject]@{
      Shortcut = $shortcutPath
      Target = $PowerShellExe
      Arguments = $arguments
      WorkingDirectory = $Root
    }
    return
  }

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $PowerShellExe
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $Root
  $shortcut.Description = "Launch LocalAI RAG Portal and local services"
  $shortcut.IconLocation = "$IconLocation,220"
  $shortcut.WindowStyle = 1
  $shortcut.Save()

  Write-Host "Created shortcut: $shortcutPath"
}

function Remove-LegacyPortalShortcut {
  param([string]$Name)

  $shortcutPath = Join-Path $Desktop "$Name.lnk"
  if (-not (Test-Path -LiteralPath $shortcutPath)) {
    return
  }

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcutText = "$($shortcut.TargetPath) $($shortcut.Arguments) $($shortcut.WorkingDirectory)"
  if ($shortcutText -notlike "*$Root*") {
    Write-Warning "Skipping unrelated shortcut: $shortcutPath"
    return
  }

  if ($DryRun) {
    [pscustomobject]@{
      RemoveShortcut = $shortcutPath
    }
    return
  }

  Remove-Item -LiteralPath $shortcutPath -Force
  Write-Host "Removed legacy shortcut: $shortcutPath"
}

if (-not (Test-Path -LiteralPath $Launcher)) {
  throw "Launcher script not found: $Launcher"
}

New-PortalShortcut -Name "LocalAI RAG Portal"
Remove-LegacyPortalShortcut -Name "LocalAI RAG Portal (Safe Mode)"
