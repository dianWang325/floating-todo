param([string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Installer smoke is restricted to disposable CI runners' }
$destination = Join-Path $env:RUNNER_TEMP 'TodoListInstallerSmoke'
$binary = Join-Path $destination 'floating-todo.exe'
$legacyKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\floating todo'
$productKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\待办清单'
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
$shell = New-Object -ComObject WScript.Shell
$shortcutProbe = Join-Path $env:RUNNER_TEMP 'shortcut-probe.lnk'

# Model an existing installation using the previous product name.
New-Item -Path $destination -ItemType Directory -Force | Out-Null
New-Item -Path $legacyKey -Force | Out-Null
Set-ItemProperty -LiteralPath $legacyKey -Name InstallLocation -Value "`"$destination`""
foreach ($folder in @($desktop, $programs)) {
  foreach ($name in @('floating todo', '悬浮待办')) {
    # WScript's shortcut implementation uses the runner's ANSI codepage.
    # Save via an ASCII path, then rename with the Unicode filesystem API.
    $shortcut = $shell.CreateShortcut($shortcutProbe)
    $shortcut.TargetPath = $binary
    $shortcut.Save()
    Move-Item -LiteralPath $shortcutProbe -Destination (Join-Path $folder "$name.lnk") -Force
  }
}
if (-not $Installer) {
  $candidates = @(Get-ChildItem src-tauri/target/release/bundle/nsis/*x64-setup.exe)
  if ($candidates.Count -ne 1) { throw 'Expected one Windows installer' }
  $Installer = $candidates[0].FullName
}
$process = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$destination") -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'Installer failed' }
$registration = Get-ItemProperty -LiteralPath $productKey
if ($registration.DisplayName -ne '待办清单') { throw 'Wrong installed product name' }
if ($registration.InstallLocation.Trim('"') -ne $destination) { throw 'Install location changed' }
if (Test-Path -LiteralPath $legacyKey) { throw 'Duplicate legacy registration remains' }
foreach ($folder in @($desktop, $programs)) {
  foreach ($name in @('floating todo', '悬浮待办')) {
    if (Test-Path -LiteralPath (Join-Path $folder "$name.lnk")) { throw 'Legacy shortcut remains' }
  }
  Copy-Item -LiteralPath (Join-Path $folder '待办清单.lnk') -Destination $shortcutProbe -Force
  $shortcut = $shell.CreateShortcut($shortcutProbe)
  if ($shortcut.TargetPath -ne $binary) { throw 'Renamed shortcut has wrong target' }
}
./tests/native-smoke.ps1 -Executable $binary
