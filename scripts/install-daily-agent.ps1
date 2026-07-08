param(
  [string]$TaskName = "LocalAI Daily Index Agent",
  [string]$At = "03:00",
  [switch]$ForceReindex
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Test-Path "node_modules")) {
  npm install
}

$time = [DateTime]::ParseExact($At, "HH:mm", [System.Globalization.CultureInfo]::InvariantCulture)
$runAt = [DateTime]::Today.Add($time.TimeOfDay)
$nodePath = (Get-Command node -ErrorAction Stop).Source
$scriptPath = Join-Path $projectRoot "scripts\daily-agent.mjs"
$agentArgs = "`"$scriptPath`" --quiet"
if ($ForceReindex) {
  $agentArgs += " --force"
}

$action = New-ScheduledTaskAction -Execute $nodePath -Argument $agentArgs -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $runAt
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Description "Daily LocalAI scan, OCR/indexing and embeddings refresh for configured sources."

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName' at $At."
Write-Host "Run once now: npm run agent:run"
Write-Host "Force full reindex: npm run agent:force"
