# CLT Quick Start
Write-Host "=== ABC Logistics Control Tower ===" -ForegroundColor Cyan
Write-Host "Building and starting via Docker Compose..." -ForegroundColor Green
Write-Host ""
Set-Location $PSScriptRoot
docker compose up --build
