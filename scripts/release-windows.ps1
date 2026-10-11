# Publish a new version from a Windows PC (when GitHub Actions is unavailable).
# 1. Bump "version" in package.json (e.g. 0.2.0 -> 0.2.1) and commit.
# 2. Create a token: https://github.com/settings/tokens?type=beta
#    (repository: tiktok_live, permission "Contents: Read and write").
# 3. In PowerShell from the repository folder:  .\scripts\release-windows.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Устанавливаю Node.js LTS через winget...'
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

if (-not $env:GH_TOKEN) {
  $secure = Read-Host 'GitHub token (Contents: write)' -AsSecureString
  $env:GH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
Write-Host "Выпускаю v$version"
npm ci
npm test
if ($LASTEXITCODE -ne 0) { throw 'Тесты не прошли — выпуск отменён' }
npx electron-builder --win nsis portable --x64 --publish always
if ($LASTEXITCODE -ne 0) { throw 'Сборка не удалась' }
Write-Host "Готово: https://github.com/YugayV/tiktok_live/releases/tag/v$version"
