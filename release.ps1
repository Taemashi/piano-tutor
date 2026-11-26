# Publica una nueva versión: .\release.ps1 [patch|minor|major]   (por defecto patch)
# Sube la versión, hace commit y tag, compila el instalador y lo publica en GitHub Releases.
param([string]$Bump = 'patch')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (git status --porcelain) { throw 'Hay cambios sin guardar. Haz commit primero.' }
$env:GH_TOKEN = (gh auth token)

npm version $Bump -m 'Versión %s'     # actualiza package.json, hace commit y crea el tag
git push origin HEAD --follow-tags
npx electron-builder --win --publish always
Write-Host 'Listo: la nueva versión está en GitHub Releases y la app instalada se actualizará sola.'
