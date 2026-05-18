# Higgsfield 拡張パック ビルドスクリプト (Windows x64)
# GitHub Actions の windows-latest 上で実行する想定
$ErrorActionPreference = "Stop"

$nodeVersion = "v20.18.0"
$nodeArch = "x64"
$hfPkg = "@higgsfield/cli"
$workDir = "$pwd\_work\higgsfield-extension-windows"
$distDir = "$pwd\dist"
$extDir = "$workDir\payload\higgsfield"

Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$extDir\bin" | Out-Null
New-Item -ItemType Directory -Force -Path "$extDir\node_modules" | Out-Null
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

# ───── 1. Node.js Windows zip 取得 ─────
$nodeZip = "node-$nodeVersion-win-$nodeArch.zip"
$nodeUrl = "https://nodejs.org/dist/$nodeVersion/$nodeZip"
Write-Host "==> Download $nodeUrl"
Invoke-WebRequest -Uri $nodeUrl -OutFile "$workDir\$nodeZip"
Expand-Archive -Path "$workDir\$nodeZip" -DestinationPath $workDir -Force
$nodeRoot = "$workDir\node-$nodeVersion-win-$nodeArch"
Copy-Item "$nodeRoot\node.exe" "$extDir\bin\node.exe"
# npm は node_modules\npm
Copy-Item -Recurse "$nodeRoot\node_modules\npm" "$extDir\node_modules\"

# ───── 2. higgsfield CLI を npm install ─────
Write-Host "==> npm install $hfPkg"
& "$extDir\bin\node.exe" "$extDir\node_modules\npm\bin\npm-cli.js" install --prefix "$extDir" $hfPkg --no-save --no-audit --no-fund --quiet

# ───── 3. higgsfield ラッパー (.cmd) を作成 ─────
$hfBin = Get-ChildItem -Path "$extDir\node_modules\@higgsfield\cli" -Filter "higgsfield.js" -Recurse | Select-Object -First 1
if (-not $hfBin) {
    Write-Error "higgsfield.js が見つかりません"
    exit 1
}
# 拡張パック内の相対パス
$hfRel = $hfBin.FullName.Substring($extDir.Length + 1)

$wrapperLines = @(
  '@echo off',
  'setlocal',
  'set "EXT_ROOT=%~dp0.."',
  '"%EXT_ROOT%\bin\node.exe" "%EXT_ROOT%\' + $hfRel + '" %*'
)
$wrapperLines -join "`r`n" | Set-Content -Path "$extDir\bin\higgsfield.cmd" -NoNewline -Encoding ASCII

# ───── 4. README + 自動インストーラ ─────
$readmeLines = @(
  'GORI GORI KUN - Higgsfield 拡張パック (Windows)',
  '================================================',
  '',
  'このフォルダごと、以下の場所にコピーしてください:',
  '  %APPDATA%\app.codexframefactory\extensions\',
  '',
  '同梱の install.bat をダブルクリックして自動配置できます。',
  '',
  'インストール後、GORI GORI KUN を再起動してください。'
)
$readmeLines -join "`r`n" | Set-Content -Path "$workDir\payload\README.txt" -NoNewline -Encoding UTF8

$installerLines = @(
  '@echo off',
  'setlocal',
  'set "SRC=%~dp0higgsfield"',
  'set "DEST=%APPDATA%\app.codexframefactory\extensions"',
  'if not exist "%DEST%" mkdir "%DEST%"',
  'echo Installing Higgsfield extension to %DEST%\higgsfield ...',
  'if exist "%DEST%\higgsfield" rmdir /S /Q "%DEST%\higgsfield"',
  'xcopy /E /I /Y "%SRC%" "%DEST%\higgsfield" >nul',
  'echo.',
  'echo OK. GORI GORI KUN を再起動してください。',
  'pause'
)
$installerLines -join "`r`n" | Set-Content -Path "$workDir\payload\install.bat" -NoNewline -Encoding ASCII

# ───── 5. zip 化 ─────
$zipPath = "$distDir\GORI-HiggsField-Extension_windows.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath }
Compress-Archive -Path "$workDir\payload\*" -DestinationPath $zipPath
Write-Host "Built: $zipPath"
Get-Item $zipPath | Format-Table Name, Length
