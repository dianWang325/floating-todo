param([Parameter(Mandatory = $true)][string]$Executable)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') {
    throw 'This wrapper configures the disposable GitHub Actions runner. Run test:native directly on a development machine.'
}

# Elevated WebView2 hosts read debugging overrides from HKLM (runtime 150+).
# Scope them to this executable and restore each value after the test.
$appName = [IO.Path]::GetFileName($Executable)
$policyRoot = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2'
$profile = Join-Path $env:RUNNER_TEMP ('floating-todo-smoke-' + [guid]::NewGuid())
$settings = @{
    AdditionalBrowserArguments = '--remote-debugging-port=9222'
    UserDataFolder = $profile
}
$previous = @()
$previousProfile = $env:FLOATING_TODO_SMOKE_PROFILE
try {
    foreach ($setting in $settings.GetEnumerator()) {
        $path = Join-Path $policyRoot $setting.Key
        if (-not (Test-Path -LiteralPath $path)) {
            New-Item -Path $path -Force | Out-Null
        }
        $key = Get-Item -LiteralPath $path
        $exists = $key.GetValueNames() -contains $appName
        $previous += @{
            Path = $path
            Exists = $exists
            Value = $key.GetValue($appName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            Kind = if ($exists) { $key.GetValueKind($appName) } else { 'String' }
        }
        New-ItemProperty -LiteralPath $path -Name $appName -Value $setting.Value -PropertyType String -Force | Out-Null
    }
    $env:FLOATING_TODO_SMOKE_PROFILE = $profile
    node tests/native-smoke.mjs $Executable
    if ($LASTEXITCODE -ne 0) { throw "Native smoke test failed with exit code $LASTEXITCODE" }
} finally {
    $env:FLOATING_TODO_SMOKE_PROFILE = $previousProfile
    foreach ($setting in $previous) {
        if ($setting.Exists) {
            New-ItemProperty -LiteralPath $setting.Path -Name $appName -Value $setting.Value -PropertyType $setting.Kind -Force | Out-Null
        } else {
            Remove-ItemProperty -LiteralPath $setting.Path -Name $appName
        }
    }
}
