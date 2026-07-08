param(
  [string]$Model = "BAAI/bge-reranker-v2-m3",
  [int]$Port = 8080,
  [switch]$InstallOnly,
  [switch]$ForceInstall
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Venv = Join-Path $Root ".venv-reranker"
$Python = Join-Path $Venv "Scripts\python.exe"
$Requirements = Join-Path $PSScriptRoot "requirements-reranker.txt"
$Service = Join-Path $PSScriptRoot "reranker-service.py"

function Test-RerankerHealth {
  param([int]$HealthPort)

  try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:$HealthPort/health" -TimeoutSec 2
    return [bool]$response.ok
  } catch {
    return $false
  }
}

if ($ForceInstall -or -not (Test-Path -LiteralPath $Python)) {
  Write-Host "Creating reranker virtual environment: $Venv"
  py -3 -m venv $Venv
  & $Python -m pip install --upgrade pip
  & $Python -m pip install -r $Requirements
}

if ($InstallOnly) {
  Write-Host "Reranker dependencies are installed."
  exit 0
}

if (Test-RerankerHealth -HealthPort $Port) {
  Write-Host "Reranker is already running at http://127.0.0.1:$Port/rerank"
  exit 0
}

$env:RAG_RERANKER_MODEL = $Model
$env:RAG_RERANKER_PORT = [string]$Port

Write-Host "Starting reranker at http://127.0.0.1:$Port/rerank"
Write-Host "Model: $Model"
& $Python $Service
