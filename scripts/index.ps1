param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [string]$Title = ""
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Test-Path "node_modules")) {
  npm install
}

$body = @{
  path = $Path
  title = $Title
} | ConvertTo-Json

$utf8Body = [System.Text.Encoding]::UTF8.GetBytes($body)
$source = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/api/sources" -Body $utf8Body -ContentType "application/json; charset=utf-8"
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/api/sources/$($source.id)/index"
