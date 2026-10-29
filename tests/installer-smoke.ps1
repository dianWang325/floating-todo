$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Installer smoke is restricted to disposable CI runners' }
$destination = Join-Path $env:RUNNER_TEMP 'TodoListInstallerSmoke'
$binary = Join-Path $destination 'floating-todo.exe'
$legacyKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\floating todo'
$productKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\待办清单'
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
$shell = New-Object -ComObject WScript.Shell

# Model an existing installation using the previous product name.
New-Item -Path $destination -ItemType Directory -Force | Out-Null
New-Item -Path $legacyKey -Force | Out-Null
Set-ItemProperty -LiteralPath $legacyKey -Name InstallLocation -Value "`"$destination`""
foreach ($folder in @($desktop, $programs)) {
  foreach ($name in @('floating todo', '悬浮待办')) {
    $shortcut = $shell.CreateShortcut((Join-Path $folder "$name.lnk"))
    $shortcut.TargetPath = $binary
    $shortcut.Save()
  }
}
$installer = @(Get-ChildItem src-tauri/target/release/bundle/nsis/*x64-setup.exe)
if ($installer.Count -ne 1) { throw 'Expected one Windows installer' }
$process = Start-Process -FilePath $installer[0].FullName -ArgumentList @('/S', "/D=$destination") -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'Installer failed' }
$registration = Get-ItemProperty -LiteralPath $productKey
if ($registration.DisplayName -ne '待办清单') { throw 'Wrong installed product name' }
if ($registration.InstallLocation.Trim('"') -ne $destination) { throw 'Install location changed' }
if (Test-Path -LiteralPath $legacyKey) { throw 'Duplicate legacy registration remains' }
foreach ($folder in @($desktop, $programs)) {
  foreach ($name in @('floating todo', '悬浮待办')) {
    if (Test-Path -LiteralPath (Join-Path $folder "$name.lnk")) { throw 'Legacy shortcut remains' }
  }
  $shortcut = $shell.CreateShortcut((Join-Path $folder '待办清单.lnk'))
  if ($shortcut.TargetPath -ne $binary) { throw 'Renamed shortcut has wrong target' }
}
./tests/native-smoke.ps1 -Executable $binary
