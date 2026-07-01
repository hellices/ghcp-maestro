$ErrorActionPreference = 'Continue'
$src = "c:\Users\inhwanhwang\vscode\ghcp-maestro"
$stage = "$env:TEMP\ghcp-maestro-pkg"
$utf8 = New-Object Text.UTF8Encoding $false

# Copy latest sources
Copy-Item "$src\vscode-extension\package.json" "$stage\package.json" -Force
Copy-Item "$src\vscode-extension\extension.mjs" "$stage\extension.mjs" -Force
Copy-Item "$src\vscode-extension\runtime-bridge.mjs" "$stage\runtime-bridge.mjs" -Force
Copy-Item "$src\vscode-extension\adapters\*" "$stage\adapters\" -Recurse -Force
Copy-Item "$src\vscode-extension\chat\*" "$stage\chat\" -Recurse -Force
Copy-Item "$src\vscode-extension\state\*" "$stage\state\" -Recurse -Force
Copy-Item "$src\vscode-extension\views\*" "$stage\views\" -Recurse -Force
Remove-Item "$stage\runtime" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$src\extensions\ghcp-maestro\runtime" "$stage\runtime" -Recurse -Force

# Re-apply import path rewrites (source imports sibling ../extensions/... which doesn't exist in the packaged layout)
$extFile = "$stage\extension.mjs"
$ext = [IO.File]::ReadAllText($extFile, $utf8)
$ext2 = $ext -replace [regex]::Escape('"../extensions/ghcp-maestro/runtime/'), '"./runtime/'
[IO.File]::WriteAllText($extFile, $ext2, $utf8)

$partFile = "$stage\chat\participant.mjs"
$part = [IO.File]::ReadAllText($partFile, $utf8)
$part2 = $part -replace [regex]::Escape('"../../extensions/ghcp-maestro/runtime/'), '"../runtime/'
[IO.File]::WriteAllText($partFile, $part2, $utf8)

# Re-add publisher (source vscode-extension/package.json now has it; harmless if already present)
$pkgFile = "$stage\package.json"
$pkg = [IO.File]::ReadAllText($pkgFile, $utf8)
if ($pkg -notmatch '"publisher"') {
    $pkg = $pkg -replace '("version"\s*:\s*"[^"]+"\s*,)', ('$1' + "`n  " + '"publisher": "local",')
    [IO.File]::WriteAllText($pkgFile, $pkg, $utf8)
    $pkg = [IO.File]::ReadAllText($pkgFile, $utf8)
}

# Re-add copilot-sdk runtime dep (source doesn't declare it; packaging needs it).
# Use ^1.0.0 to tolerate the mismatch between npm registry latest and the
# actual installed dist tag we end up with.
if ($pkg -notmatch '@github/copilot-sdk') {
    $pkg = $pkg -replace '\}\s*\}\s*$', "}, `"dependencies`": { `"@github/copilot-sdk`": `"^1.0.0`" } }"
    [IO.File]::WriteAllText($pkgFile, $pkg, $utf8)
}

Write-Host "--- staged extension.mjs sibling imports ---"
Select-String -Path $extFile -Pattern 'runtime/' | Select-Object -First 5 Line

Write-Host "--- staged package.json head ---"
Get-Content $pkgFile -TotalCount 12 -Encoding UTF8

Write-Host "--- staged package.json tail ---"
Get-Content $pkgFile -Tail 6 -Encoding UTF8

# Repackage
Push-Location $stage
try {
    npx --yes @vscode/vsce@latest package --allow-missing-repository -o "$stage\ghcp-maestro-vscode-0.1.0.vsix" 2>&1 | Select-Object -Last 6
} finally {
    Pop-Location
}

# Install
& "C:\Users\inhwanhwang\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd" --install-extension "$stage\ghcp-maestro-vscode-0.1.0.vsix" --force 2>&1 | Select-Object -Last 3
