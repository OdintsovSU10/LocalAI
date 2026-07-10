param(
  [switch]$NoBrowser,
  [switch]$CheckOnly,
  [switch]$NoDify,
  [string]$Url = "http://127.0.0.1:8787/settings/sources",
  [string]$DifyUrl = "",
  [string]$DifyDir = "",
  [string]$DifyComposeFile = "",
  [string]$DifyStartCommand = "",
  [string]$DifyStartDirectory = ""
)

$ErrorActionPreference = "Stop"

$Launcher = Join-Path $PSScriptRoot "launch-portal.ps1"
if (-not (Test-Path -LiteralPath $Launcher)) {
  throw "Launcher script not found: $Launcher"
}

$launchArgs = @{
  Url = $Url
}

if ($NoBrowser) { $launchArgs.NoBrowser = $true }
if ($CheckOnly) { $launchArgs.CheckOnly = $true }
if ($NoDify) { $launchArgs.NoDify = $true }
if (-not [string]::IsNullOrWhiteSpace($DifyUrl)) { $launchArgs.DifyUrl = $DifyUrl }
if (-not [string]::IsNullOrWhiteSpace($DifyDir)) { $launchArgs.DifyDir = $DifyDir }
if (-not [string]::IsNullOrWhiteSpace($DifyComposeFile)) { $launchArgs.DifyComposeFile = $DifyComposeFile }
if (-not [string]::IsNullOrWhiteSpace($DifyStartCommand)) { $launchArgs.DifyStartCommand = $DifyStartCommand }
if (-not [string]::IsNullOrWhiteSpace($DifyStartDirectory)) { $launchArgs.DifyStartDirectory = $DifyStartDirectory }

& $Launcher @launchArgs
