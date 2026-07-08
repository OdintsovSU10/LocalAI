param(
  [switch]$SafeMode,
  [switch]$NoBrowser,
  [switch]$CheckOnly,
  [string]$Url = "http://127.0.0.1:8787/settings/sources"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$PortalHealthUrl = "http://127.0.0.1:8787/api/health"
$QdrantHealthUrl = "http://127.0.0.1:6333/"
$RerankerHealthUrl = "http://127.0.0.1:8080/health"

function Write-Step {
  param([string]$Message)
  Write-Host "[LocalAI] $Message"
}

function Test-HttpOk {
  param(
    [string]$Uri,
    [int]$TimeoutSec = 2
  )

  try {
    $response = Invoke-RestMethod -Uri $Uri -TimeoutSec $TimeoutSec
    if ($null -ne $response.ok) {
      return [bool]$response.ok
    }
    return $true
  } catch {
    return $false
  }
}

function Wait-HttpOk {
  param(
    [string]$Uri,
    [int]$TimeoutSec = 35
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpOk -Uri $Uri) {
      return $true
    }
    Start-Sleep -Milliseconds 700
  }
  return $false
}

function Assert-CommandAvailable {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is not available in PATH."
  }
}

function Ensure-NodeDependencies {
  Set-Location $Root
  Assert-CommandAvailable -Name "node"
  Assert-CommandAvailable -Name "npm"

  if (-not (Test-Path -LiteralPath (Join-Path $Root "node_modules"))) {
    if ($CheckOnly) {
      Write-Step "node_modules is missing; first launch will run npm install."
      return
    }
    Write-Step "Installing Node dependencies..."
    npm install
  }
}

function Start-QdrantIfNeeded {
  if ($SafeMode) {
    Write-Step "Safe mode: skipping Qdrant."
    return
  }
  if (Test-HttpOk -Uri $QdrantHealthUrl) {
    Write-Step "Qdrant is already running."
    return
  }
  if ($CheckOnly) {
    Write-Step "Qdrant is not running; launcher would start it."
    return
  }

  $script = Join-Path $PSScriptRoot "start-qdrant-windows.ps1"
  Write-Step "Starting Qdrant..."
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script
  } catch {
    Write-Warning "Qdrant was not started: $($_.Exception.Message)"
  }
}

function Start-RerankerIfNeeded {
  if ($SafeMode) {
    Write-Step "Safe mode: skipping reranker."
    return
  }
  if (Test-HttpOk -Uri $RerankerHealthUrl) {
    Write-Step "Reranker is already running."
    return
  }
  if ($CheckOnly) {
    Write-Step "Reranker is not running; launcher would start it in background."
    return
  }

  $script = Join-Path $PSScriptRoot "start-reranker-windows.ps1"
  Write-Step "Starting reranker in background..."
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script) `
    -WorkingDirectory $Root `
    -WindowStyle Hidden
}

function Start-BackendIfNeeded {
  if (Test-HttpOk -Uri $PortalHealthUrl) {
    Write-Step "Backend is already running."
    return
  }
  if ($CheckOnly) {
    Write-Step "Backend is not running; launcher would start it."
    return
  }

  Write-Step "Starting backend..."
  Start-Process -FilePath "node" `
    -ArgumentList @("apps/rag-api/src/server.js") `
    -WorkingDirectory $Root `
    -WindowStyle Hidden

  if (-not (Wait-HttpOk -Uri $PortalHealthUrl -TimeoutSec 40)) {
    throw "Backend did not become ready at $PortalHealthUrl."
  }
}

Write-Step "Preparing portal..."
Set-Location $Root
Ensure-NodeDependencies
Start-QdrantIfNeeded
Start-RerankerIfNeeded
Start-BackendIfNeeded

if (-not $CheckOnly -and -not $NoBrowser) {
  Write-Step "Opening $Url"
  Start-Process $Url
}

if ($CheckOnly) {
  Write-Step "Check finished. No services were started."
} else {
  Write-Step "Portal is ready."
  Start-Sleep -Seconds 2
}
