$dir = "$PSScriptRoot\default-skins"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$skins = @{
  "steve" = "https://assets.mojang.com/SkinTemplates/steve.png"
  "alex"  = "https://assets.mojang.com/SkinTemplates/alex.png"
}
foreach ($s in $skins.GetEnumerator()) {
  Invoke-WebRequest -Uri $s.Value -OutFile "$dir\$($s.Key).png"
  Write-Host "OK: $($s.Key).png"
}
