$ErrorActionPreference = "Stop"

$running = Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFileName($_.ExecutablePath) -ieq "qdrant.exe") }

if (-not $running) {
  Write-Host "Qdrant is not running."
  exit 0
}

foreach ($process in $running) {
  Stop-Process -Id $process.ProcessId -Force
  Write-Host "Stopped Qdrant PID $($process.ProcessId)"
}
