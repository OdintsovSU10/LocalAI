param(
  [string]$TaskName = "LocalAI Reranker",
  [string]$Model = "BAAI/bge-reranker-v2-m3",
  [int]$Port = 8080
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$StartScript = Join-Path $PSScriptRoot "start-reranker-windows.ps1"
$PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $StartScript)) {
  throw "Reranker start script not found: $StartScript"
}

& $StartScript -InstallOnly

$arguments = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$StartScript`"",
  "-Model", "`"$Model`"",
  "-Port", $Port
) -join " "

$action = New-ScheduledTaskAction `
  -Execute $PowerShell `
  -Argument $arguments `
  -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

$userId = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
$principal = New-ScheduledTaskPrincipal `
  -UserId $userId `
  -LogonType Interactive `
  -RunLevel Limited

$task = New-ScheduledTask `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Starts the LocalAI reranker service at Windows logon."

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName' for user $userId."
Write-Host "It will start reranker at Windows logon: http://127.0.0.1:$Port/rerank"
