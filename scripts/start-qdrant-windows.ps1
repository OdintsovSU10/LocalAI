param(
  [string]$QdrantExe = "C:\qdrant\qdrant.exe",
  [string]$StoragePath = "D:\LOCAL_RAG\data\qdrant",
  [switch]$Foreground
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $QdrantExe)) {
  throw "Qdrant executable not found: $QdrantExe"
}

New-Item -ItemType Directory -Force -Path $StoragePath | Out-Null

$running = Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFileName($_.ExecutablePath) -ieq "qdrant.exe") }

if ($running) {
  $running | Select-Object ProcessId,ExecutablePath,CommandLine
  Write-Host "Qdrant is already running."
  exit 0
}

$env:QDRANT__STORAGE__STORAGE_PATH = $StoragePath

if ($Foreground) {
  & $QdrantExe
  exit $LASTEXITCODE
}

Start-Process -FilePath $QdrantExe -WorkingDirectory (Split-Path -Parent $QdrantExe) -WindowStyle Hidden
Start-Sleep -Seconds 2

$status = Invoke-RestMethod -Uri "http://127.0.0.1:6333/" -TimeoutSec 5
Write-Host "Qdrant $($status.version) is running at http://127.0.0.1:6333"
Write-Host "Storage: $StoragePath"
