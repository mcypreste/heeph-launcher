# Baixa a skin de um jogador Minecraft via API Mojang
param([string]$Username = "Heeph", [string]$OutDir = "$PSScriptRoot\default-skins")

$profile = Invoke-RestMethod -Uri "https://api.mojang.com/users/profiles/minecraft/$Username"
$uuid = $profile.id
Write-Host "UUID: $uuid"

$session = Invoke-RestMethod -Uri "https://sessionserver.mojang.com/session/minecraft/profile/$uuid"
$texProp = $session.properties | Where-Object { $_.name -eq "textures" } | Select-Object -First 1
$texJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($texProp.value)) | ConvertFrom-Json
$skinUrl = $texJson.textures.SKIN.url
Write-Host "Skin URL: $skinUrl"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$outFile = "$OutDir\$($Username.ToLower()).png"
Invoke-WebRequest -Uri $skinUrl -OutFile $outFile
Write-Host "Salvo em: $outFile"
