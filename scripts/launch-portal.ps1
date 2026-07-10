param(
  [switch]$SafeMode,
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

$Root = Split-Path -Parent $PSScriptRoot
$PortalHealthUrl = "http://127.0.0.1:8787/api/health"
$QdrantHealthUrl = "http://127.0.0.1:6333/"
$RerankerHealthUrl = "http://127.0.0.1:8080/health"
$DockerDesktopExe = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"

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

function EnvOrDefault {
  param(
    [string]$Value,
    [string]$EnvName,
    [string]$Default = ""
  )

  if (-not [string]::IsNullOrWhiteSpace($Value)) {
    return $Value
  }

  $envValue = [Environment]::GetEnvironmentVariable($EnvName)
  if (-not [string]::IsNullOrWhiteSpace($envValue)) {
    return $envValue
  }

  return $Default
}

function Test-DockerReady {
  if (-not (Get-Command "docker" -ErrorAction SilentlyContinue)) {
    return $false
  }

  & docker info *> $null
  return $LASTEXITCODE -eq 0
}

function Wait-DockerReady {
  param([int]$TimeoutSec = 90)

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-DockerReady) {
      return $true
    }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Start-DockerDesktopIfNeeded {
  if (Test-DockerReady) {
    Write-Step "Docker engine is already running."
    return $true
  }

  if ($CheckOnly) {
    Write-Step "Docker engine is not running; launcher would start Docker Desktop."
    return $false
  }

  if (-not (Test-Path -LiteralPath $DockerDesktopExe)) {
    Write-Warning "Docker Desktop executable not found: $DockerDesktopExe"
    return $false
  }

  Write-Step "Starting Docker Desktop..."
  Start-Process -FilePath $DockerDesktopExe -WindowStyle Hidden
  if (Wait-DockerReady -TimeoutSec 120) {
    Write-Step "Docker engine is ready."
    return $true
  }

  Write-Warning "Docker engine did not become ready in time."
  return $false
}

function Find-ComposeFileInDirectory {
  param([string]$Directory)

  if ([string]::IsNullOrWhiteSpace($Directory) -or -not (Test-Path -LiteralPath $Directory)) {
    return $null
  }

  $names = @(
    "docker-compose.yaml",
    "docker-compose.yml",
    "compose.yaml",
    "compose.yml"
  )

  foreach ($name in $names) {
    $candidate = Join-Path $Directory $name
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  return $null
}

function Resolve-DifyComposeFile {
  $explicitComposeFile = EnvOrDefault -Value $DifyComposeFile -EnvName "LOCALAI_DIFY_COMPOSE_FILE"
  if (-not [string]::IsNullOrWhiteSpace($explicitComposeFile) -and (Test-Path -LiteralPath $explicitComposeFile)) {
    return (Resolve-Path -LiteralPath $explicitComposeFile).Path
  }

  $explicitDifyDir = EnvOrDefault -Value $DifyDir -EnvName "LOCALAI_DIFY_DIR"
  $candidates = @()
  if (-not [string]::IsNullOrWhiteSpace($explicitDifyDir)) {
    $candidates += $explicitDifyDir
    $candidates += (Join-Path $explicitDifyDir "docker")
  }

  foreach ($candidate in $candidates) {
    $composeFile = Find-ComposeFileInDirectory -Directory $candidate
    if ($composeFile) {
      return $composeFile
    }
  }

  return $null
}

function Start-DifyCommandIfConfigured {
  param(
    [string]$EffectiveDifyUrl
  )

  $startCommand = EnvOrDefault -Value $DifyStartCommand -EnvName "LOCALAI_DIFY_START_COMMAND"
  if ([string]::IsNullOrWhiteSpace($startCommand)) {
    return $false
  }

  $startDirectory = EnvOrDefault -Value $DifyStartDirectory -EnvName "LOCALAI_DIFY_START_DIR"
  if ([string]::IsNullOrWhiteSpace($startDirectory)) {
    $startDirectory = EnvOrDefault -Value $DifyDir -EnvName "LOCALAI_DIFY_DIR" -Default $Root
  }

  if ($CheckOnly) {
    Write-Step "Dify is not reachable; launcher would run LOCALAI_DIFY_START_COMMAND."
    return $true
  }

  if (-not (Test-Path -LiteralPath $startDirectory)) {
    Write-Warning "Dify start directory was not found: $startDirectory"
    return $true
  }

  Write-Step "Starting Dify using LOCALAI_DIFY_START_COMMAND..."
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $startCommand) `
    -WorkingDirectory $startDirectory `
    -WindowStyle Hidden

  if (-not [string]::IsNullOrWhiteSpace($EffectiveDifyUrl)) {
    if (Wait-HttpOk -Uri $EffectiveDifyUrl -TimeoutSec 90) {
      Write-Step "Dify is ready at $EffectiveDifyUrl."
    } else {
      Write-Warning "Dify start command was launched, but $EffectiveDifyUrl did not become reachable yet."
    }
  }

  return $true
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

function Start-DifyIfNeeded {
  if ($SafeMode -or $NoDify) {
    Write-Step "Safe mode or NoDify: skipping Dify."
    return
  }

  $effectiveDifyUrl = EnvOrDefault -Value $DifyUrl -EnvName "LOCALAI_DIFY_URL"
  if (-not [string]::IsNullOrWhiteSpace($effectiveDifyUrl) -and (Test-HttpOk -Uri $effectiveDifyUrl -TimeoutSec 2)) {
    Write-Step "Dify is already reachable at $effectiveDifyUrl."
    return
  }

  if (Start-DifyCommandIfConfigured -EffectiveDifyUrl $effectiveDifyUrl) {
    return
  }

  $composeFile = Resolve-DifyComposeFile
  if (-not $composeFile) {
    if ([string]::IsNullOrWhiteSpace($effectiveDifyUrl)) {
      Write-Step "Dify URL/start command are not configured; launcher will skip Dify startup."
      Write-Step "Set LOCALAI_DIFY_URL and, if needed, LOCALAI_DIFY_START_COMMAND."
    } else {
      Write-Warning "Dify is not reachable at $effectiveDifyUrl. Start Dify manually or set LOCALAI_DIFY_START_COMMAND."
    }
    return
  }

  if ($CheckOnly) {
    Write-Step "Dify is not reachable; launcher would run docker compose for $composeFile."
    return
  }

  if (-not (Start-DockerDesktopIfNeeded)) {
    Write-Warning "Dify was not started because Docker is not ready."
    return
  }

  $composeDir = Split-Path -Parent $composeFile
  $composeName = Split-Path -Leaf $composeFile
  Write-Step "Starting Dify via Docker Compose: $composeFile"
  Push-Location $composeDir
  try {
    & docker compose -f $composeName up -d
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Dify docker compose returned exit code $LASTEXITCODE."
      return
    }
  } finally {
    Pop-Location
  }

  if (Wait-HttpOk -Uri $effectiveDifyUrl -TimeoutSec 90) {
    Write-Step "Dify is ready at $effectiveDifyUrl."
  } else {
    Write-Warning "Dify was started, but $effectiveDifyUrl did not become reachable yet."
  }
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
Start-DifyIfNeeded
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
