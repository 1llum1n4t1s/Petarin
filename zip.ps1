# ぺたりん を Chrome Web Store 提出用 ZIP にパッケージング
$ErrorActionPreference = "Stop"

Write-Host "ぺたりん をパッケージングします..." -ForegroundColor Cyan

$scriptDir = Split-Path -Parent ($MyInvocation.MyCommand.Path ?? $PSCommandPath ?? $PWD)
if ($scriptDir) { Set-Location $scriptDir }

Write-Host "アイコンを生成しています..." -ForegroundColor Yellow
pnpm install --silent
if ($LASTEXITCODE -ne 0) { throw "pnpm install に失敗しました" }
pnpm run generate-icons
if ($LASTEXITCODE -ne 0) { throw "アイコン生成に失敗しました" }

$zipName = "petarin-chrome.zip"
if (Test-Path $zipName) { Remove-Item $zipName -Force }

$tempDir = "temp-build"
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item -ItemType Directory -Path $tempDir | Out-Null

Copy-Item "manifest.json" -Destination $tempDir
Copy-Item "icons" -Destination $tempDir -Recurse
Copy-Item "src" -Destination $tempDir -Recurse
if (Test-Path "_locales") { Copy-Item "_locales" -Destination $tempDir -Recurse }

Get-ChildItem -Path $tempDir -Recurse -Include "*.DS_Store", "*.swp", "*~" | Remove-Item -Force

Write-Host "ZIP を作成しています..." -ForegroundColor Cyan
Compress-Archive -Path "$tempDir/*" -DestinationPath $zipName -Force
Remove-Item $tempDir -Recurse -Force

if (Test-Path $zipName) {
    $kb = [math]::Round((Get-Item $zipName).Length / 1KB, 2)
    Write-Host "ZIP を作成しました: $zipName ($kb KB)" -ForegroundColor Green
} else {
    Write-Host "ZIP の作成に失敗しました" -ForegroundColor Red
    exit 1
}
