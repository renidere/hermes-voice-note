#requires -Version 5.1
# Run on a disposable, elevated GitHub Windows runner.
param(
    [Parameter(Mandatory=$true)][string]$ClientDirectory,
    [Parameter(Mandatory=$true)][string]$Launcher,
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$clock = [Diagnostics.Stopwatch]::StartNew()
function Assert($Condition, [string]$Code) { if (-not $Condition) { throw ('VOICE_SMOKE:' + $Code) } }
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function Tree-Snapshot([string]$Path) {
    $rows = @(Get-ChildItem -LiteralPath $Path -Force -Recurse | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($Path.Length)
        if ($_.PSIsContainer) { 'D|' + $relative } else { 'F|' + $relative + '|' + (Hash $_.FullName) }
    })
    $rows -join "`n"
}
function Protocol-Snapshot {
    $rows = foreach ($key in @('Registry::HKEY_CURRENT_USER\Software\Classes\hermes', 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\hermes')) {
        if (-not (Test-Path -LiteralPath $key)) { $key + '|absent'; continue }
        $items = @((Get-Item -LiteralPath $key)) + @(Get-ChildItem -LiteralPath $key -Recurse)
        foreach ($item in $items | Sort-Object Name) {
            $item.Name
            foreach ($name in $item.GetValueNames() | Sort-Object) {
                $item.Name + '|' + $name + '|' + $item.GetValueKind($name) + '|' + (ConvertTo-Json -Compress -InputObject $item.GetValue($name))
            }
        }
    }
    $rows -join "`n"
}
function Persistent-Environment {
    $rows = foreach ($scope in @('User', 'Machine')) {
        foreach ($name in $names) {
            $scope + '|' + $name + '|' + [Environment]::GetEnvironmentVariable($name, $scope)
        }
    }
    $rows -join "`n"
}
function Fixture-Processes {
    if ($null -eq $launchStart) { return }
    Get-CimInstance Win32_Process -Filter "Name='hermes-light-3b42157.exe'" | Where-Object {
        $_.ExecutablePath -ieq $exe -and $_.CreationDate.ToUniversalTime() -ge $launchStart
    }
}
function Stop-Identity($Identity) {
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Identity.ProcessId)
    if ($current -and $current.ExecutablePath -ieq $Identity.ExecutablePath -and $current.CreationDate -eq $Identity.CreationDate) {
        try { Stop-Process -Id $current.ProcessId -Force -ErrorAction Stop } catch {
            $remaining = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Identity.ProcessId)
            if ($remaining -and $remaining.ExecutablePath -ieq $Identity.ExecutablePath -and $remaining.CreationDate -eq $Identity.CreationDate) { throw }
        }
    }
}
function Stop-Fixture {
    $until = $clock.Elapsed.TotalSeconds + 8
    foreach ($identity in @($launchers.ToArray())) { Stop-Identity $identity }
    do {
        foreach ($identity in @(Fixture-Processes)) { Stop-Identity $identity }
        Start-Sleep -Milliseconds 200
    } while (@(Fixture-Processes).Count -gt 0 -and $clock.Elapsed.TotalSeconds -lt $until)
    Assert (@(Fixture-Processes).Count -eq 0) 'FIXTURE_PROCESS_CLEANUP_FAILED'
}

Assert ($env:OS -eq 'Windows_NT' -and $env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_OS -eq 'Windows') 'DISPOSABLE_WINDOWS_CI_REQUIRED'
Assert (-not [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) 'RUNNER_TEMP_REQUIRED'
Assert ([IO.Path]::IsPathRooted($ClientDirectory) -and [IO.Path]::IsPathRooted($Launcher)) 'ABSOLUTE_INPUT_PATHS_REQUIRED'
$client = (Get-Item -LiteralPath $ClientDirectory).FullName.TrimEnd('\')
$launcherFile = (Get-Item -LiteralPath $Launcher).FullName
Assert ([IO.Path]::GetExtension($launcherFile) -ieq '.cmd') 'PRODUCTION_CMD_REQUIRED'
$output = [IO.Path]::GetFullPath($OutputDirectory)
Assert (-not ($output -ieq $client -or $output.StartsWith($client + '\', [StringComparison]::OrdinalIgnoreCase))) 'OUTPUT_MUST_NOT_MODIFY_CLIENT'
[void][IO.Directory]::CreateDirectory($output)
Assert (-not (Test-Path -LiteralPath (Join-Path $output 'result.json'))) 'FRESH_OUTPUT_REQUIRED'
$root = Join-Path ([IO.Path]::GetFullPath($env:RUNNER_TEMP)) ('voice-bundled-' + [Guid]::NewGuid().ToString('N'))
Assert ($root -notmatch '["%!\r\n]') 'UNSAFE_CMD_FIXTURE_PATH'
$bundle = Join-Path $root ('client space ' + [char]0x0416)
$exe = Join-Path $bundle 'hermes-light-3b42157.exe'
$ruleName = 'VoiceNoteCI-' + [Guid]::NewGuid().ToString('N')
$fixture = [Guid]::NewGuid().ToString('N')
$prefix = 'VOICE_BUNDLED_' + $fixture + '_'
$names = @('LOCALAPPDATA','APPDATA','USERPROFILE','HOME','HERMES_HOME','HERMES_DESKTOP_USER_DATA_DIR','HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION','HERMES_DESKTOP_BOOT_FAKE','HERMES_DESKTOP_BOOT_FAKE_ERROR','HERMES_DESKTOP_SKIP_QUIT_CONFIRM','HERMES_DESKTOP_CDP_PORT','HERMES_DESKTOP_DEV_SERVER','ELECTRON_RUN_AS_NODE','NODE_OPTIONS')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$result = [ordered]@{
    passed=$false; nativeSdkVerified=$false; recordControlObserved=$false
    staleDiskCopyShadowed=$false; stableHomeUntouched=$false; protocolUnchanged=$false
    processOnlyVerified=$false; repeatLaunchVerified=$false; actualUserDeliveryVerified=$false
    launchesVerified=0; probeStatus='NOT_OBSERVED'; stage='prepare'
}
$launchStart = $null
$launchers = New-Object 'Collections.Generic.List[object]'
$ruleAttempted = $false
$guardSnapshotReady = $false
$homesReady = $false
try {
    Assert (Test-Path -LiteralPath (Join-Path $client 'resources\app.asar')) 'PACKAGED_CLIENT_REQUIRED'
    $sourceExe = Join-Path $client 'hermes-light-3b42157.exe'
    $exeHash = Hash $sourceExe
    $launcherHash = Hash $launcherFile
    [void][IO.Directory]::CreateDirectory($bundle)
    Get-ChildItem -LiteralPath $client -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $bundle -Recurse }
    $entrypoint = Join-Path $bundle 'Start-Voice-Note.cmd'
    Copy-Item -LiteralPath $launcherFile -Destination $entrypoint -Force
    Assert ((Hash $exe) -ceq $exeHash -and (Hash $entrypoint) -ceq $launcherHash) 'FIXTURE_COPY_MISMATCH'
    $protocol = Protocol-Snapshot
    $persistentEnv = Persistent-Environment
    $guardSnapshotReady = $true
    $env:LOCALAPPDATA = Join-Path $root ('local app data ' + [char]0x0416)
    $env:APPDATA = Join-Path $root 'roaming'
    $env:USERPROFILE = Join-Path $root 'user'
    $env:HOME = $env:USERPROFILE
    $env:HERMES_HOME = Join-Path $root 'inherited stable home'
    $env:HERMES_DESKTOP_USER_DATA_DIR = Join-Path $root 'inherited stable desktop'
    foreach ($homePath in @($env:HERMES_HOME, $env:HERMES_DESKTOP_USER_DATA_DIR, $env:APPDATA, $env:LOCALAPPDATA, $env:USERPROFILE, (Join-Path $env:USERPROFILE 'AppData\Roaming'), (Join-Path $env:USERPROFILE 'AppData\Local'))) {
        [void][IO.Directory]::CreateDirectory($homePath)
    }
    [IO.File]::WriteAllText((Join-Path $env:HERMES_HOME 'sentinel.txt'), $fixture)
    [IO.File]::WriteAllText((Join-Path $env:HERMES_DESKTOP_USER_DATA_DIR 'sentinel.txt'), $fixture)
    $stableHome = Tree-Snapshot $env:HERMES_HOME
    $stableDesktop = Tree-Snapshot $env:HERMES_DESKTOP_USER_DATA_DIR
    $homesReady = $true
    $data = Join-Path $env:LOCALAPPDATA 'HermesVoiceNote\desktop'
    $plugins = Join-Path $data 'hermes-home\desktop-plugins'
    $stale = Join-Path $plugins 'hermes-voice-note\plugin.js'
    $probe = Join-Path $plugins 'zz-voice-bundled-check\plugin.js'
    foreach ($file in @($stale, $probe)) { [void][IO.Directory]::CreateDirectory((Split-Path -Parent $file)) }
    $utf8 = New-Object Text.UTF8Encoding($false)
    # Evaluation proves the disk door saw the stale file; register must never run.
    $staleJs = @'
const shadow = globalThis['voice_shadow___FIXTURE__'] = { evaluated: true, registered: false };
export default {
  id: 'hermes-voice-note', name: 'CI stale shadow sentinel',
  register() { shadow.registered = true; }
};
'@
    [IO.File]::WriteAllText($stale, $staleJs.Replace('__FIXTURE__', $fixture), $utf8)
    $staleHash = Hash $stale
    # This probe never creates UI, records, sends, retains a session, or makes RPCs.
    $probeJs = @'
import { host } from '@hermes/plugin-sdk';
export default {
  id: 'zz-voice-bundled-check', name: 'CI bundled check',
  register(ctx) {
    const sdk = typeof host.state?.focusedSessionOwner?.get === 'function'
      && typeof host.retainSession === 'function'
      && typeof host.composer?.submit === 'function';
    const home = ctx.storage.get('fixture', null) === __EXPECTED_STORAGE__;
    if (home) ctx.storage.set('fixture', '__FIXTURE__');
    let last = '', routed = false, writing = false;
    const started = Date.now();
    const check = async () => {
      if (writing) return;
      const buttons = [...document.querySelectorAll('.hermes-voice-note button[aria-label="\u0417\u0430\u043f\u0438\u0441\u0430\u0442\u044c"]')];
      const record = buttons.some(button => {
        const rect = button.getBoundingClientRect();
        if (!button.isConnected || button.type !== 'button' || button.disabled || rect.width <= 0 || rect.height <= 0
          || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
        for (let node = button; node; node = node.parentElement) {
          const css = getComputedStyle(node);
          if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0) return false;
        }
        return true;
      });
      // '/' is the source-defined empty-chat route, not a session creation verb.
      if (!record && !routed && Date.now() - started > 1000) { routed = true; host.navigate('/'); }
      const shadow = globalThis['voice_shadow___FIXTURE__'];
      const status = !home ? 'HOME_REUSE_MISMATCH' : !sdk ? 'SDK_MISSING'
        : shadow?.registered ? 'STALE_REGISTERED' : !record ? 'SDK_ONLY'
        : !shadow?.evaluated ? 'RECORD_WAITING_STALE' : 'OK';
      if (status !== last) {
        writing = true;
        try { if (await ctx.os.writeClipboard('__MARKER__' + status)) last = status; }
        finally { writing = false; }
      }
    };
    ctx.setInterval(() => { void check(); }, 250);
    void check();
  }
};
'@
    $result.stage = 'network-guard'
    Assert ((Get-Service -Name MpsSvc).Status -eq 'Running') 'FIREWALL_SERVICE_REQUIRED'
    $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore)
    Assert ($profiles.Count -eq 3 -and @($profiles | Where-Object { $_.Enabled -ne 'True' }).Count -eq 0) 'ALL_FIREWALL_PROFILES_MUST_BE_ENABLED'
    $ruleAttempted = $true
    $null = New-NetFirewallRule -Name $ruleName -DisplayName $ruleName -Direction Outbound -Action Block -Program $exe -Profile Any -Enabled True
    $active = @(Get-NetFirewallRule -PolicyStore ActiveStore -Name $ruleName)
    Assert ($active.Count -eq 1 -and $active[0].Enabled -eq 'True' -and $active[0].Direction -eq 'Outbound' -and $active[0].Action -eq 'Block') 'ACTIVE_OUTBOUND_BLOCK_REQUIRED'
    $enforcement = @($active[0].EnforcementStatus | ForEach-Object { [string]$_ })
    $result['firewallEnforcement'] = $enforcement
    # NetSecurity reports one status per applicable/inactive profile, as strings.
    Assert ($active[0].Profile -eq 'Any' -and $active[0].PrimaryStatus -eq 'OK' -and $enforcement -contains 'Enforced' -and @($enforcement | Where-Object { $_ -notin @('Enforced','ProfileInactive') }).Count -eq 0) 'FIREWALL_BLOCK_MUST_BE_FULLY_ENFORCED'
    $apps = @($active[0] | Get-NetFirewallApplicationFilter)
    Assert ($apps.Count -eq 1 -and $apps[0].Program -ieq $exe) 'EXACT_EXE_FIREWALL_FILTER_REQUIRED'
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VoiceBundledWindow {
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
    $env:HERMES_DESKTOP_BOOT_FAKE = '1'
    $env:HERMES_DESKTOP_BOOT_FAKE_ERROR = 'WINDOWS_CI_BACKEND_DISABLED'
    $env:HERMES_DESKTOP_SKIP_QUIT_CONFIRM = '1'
    $env:HERMES_DESKTOP_CDP_PORT = 'off'
    $env:HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION = $null
    $env:HERMES_DESKTOP_DEV_SERVER = $null
    $env:ELECTRON_RUN_AS_NODE = $null
    $env:NODE_OPTIONS = $null
    # Do not supply the launcher's isolation/protocol variables: its own contract must set them.
    foreach ($attempt in 1..2) {
        Assert ($clock.Elapsed.TotalSeconds -lt 145) 'TOTAL_NATIVE_BUDGET_EXHAUSTED'
        $result.stage = 'native-launch-' + $attempt
        $result.probeStatus = 'NOT_OBSERVED'
        $marker = $prefix + $attempt + '_'
        $expected = if ($attempt -eq 1) { 'null' } else { "'" + $fixture + "'" }
        $js = $probeJs.Replace('__EXPECTED_STORAGE__', $expected).Replace('__FIXTURE__', $fixture).Replace('__MARKER__', $marker)
        [IO.File]::WriteAllText($probe, $js, $utf8)
        if ($null -eq $launchStart) { $launchStart = [DateTime]::UtcNow }
        $launch = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -WorkingDirectory $root -ArgumentList ('/d /s /c ""' + $entrypoint + '""') -WindowStyle Hidden -PassThru
        $cmd = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $launch.Id)
        if ($cmd -and $cmd.ExecutablePath -ieq (Join-Path $env:SystemRoot 'System32\cmd.exe') -and $cmd.CreationDate.ToUniversalTime() -ge $launchStart) { $launchers.Add($cmd) }
        $until = [Math]::Min(150, $clock.Elapsed.TotalSeconds + 60)
        $windowObserved = $false
        while ($clock.Elapsed.TotalSeconds -lt $until) {
            $windowObserved = $false
            $clipboard = ''
            try { $clipboard = [string](Get-Clipboard -Raw -ErrorAction Stop) } catch { }
            foreach ($status in @('HOME_REUSE_MISMATCH','SDK_MISSING','STALE_REGISTERED','SDK_ONLY','RECORD_WAITING_STALE','OK')) {
                if ($clipboard -ceq ($marker + $status)) { $result.probeStatus = $status }
            }
            foreach ($identity in @(Fixture-Processes)) {
                $candidate = Get-Process -Id $identity.ProcessId -ErrorAction SilentlyContinue
                # CIM timestamps lose sub-microsecond precision; still bind the handle to path/start identity.
                if ($candidate -and $candidate.Path -ieq $identity.ExecutablePath -and [Math]::Abs(($candidate.StartTime.ToUniversalTime() - $identity.CreationDate.ToUniversalTime()).TotalMilliseconds) -lt 1 -and $candidate.MainWindowHandle -ne [IntPtr]::Zero -and [VoiceBundledWindow]::IsWindowVisible($candidate.MainWindowHandle)) { $windowObserved = $true }
            }
            if ($result.probeStatus -in @('HOME_REUSE_MISMATCH','SDK_MISSING','STALE_REGISTERED')) { break }
            if ($result.probeStatus -eq 'OK' -and $windowObserved) { break }
            Start-Sleep -Milliseconds 250
        }
        $result.nativeSdkVerified = $result.probeStatus -in @('SDK_ONLY','RECORD_WAITING_STALE','OK')
        $result.recordControlObserved = $result.probeStatus -in @('RECORD_WAITING_STALE','OK')
        Assert $result.nativeSdkVerified 'NATIVE_PUBLIC_SDK_NOT_VERIFIED'
        # shortcut: backend-disabled rendering only; a hidden/absent composer fails, never becomes an SDK-only pass.
        Assert $result.recordControlObserved 'RECORD_CONTROL_NOT_OBSERVED_WITH_BACKEND_DISABLED_AT_EMPTY_CHAT_ROUTE'
        Assert ($result.probeStatus -eq 'OK') 'STALE_DISK_SHADOW_OR_SAME_HOME_NOT_VERIFIED'
        Assert ($windowObserved -and @(Fixture-Processes).Count -gt 0) 'VISIBLE_NATIVE_WINDOW_REQUIRED'
        Assert ((Hash $stale) -ceq $staleHash) 'STALE_DISK_COPY_WAS_MODIFIED_OR_DELETED'
        Assert ((Hash $exe) -ceq $exeHash -and (Hash $entrypoint) -ceq $launcherHash) 'FIXTURE_PRODUCT_BYTES_CHANGED'
        $result.staleDiskCopyShadowed = $true
        $result.launchesVerified = $attempt
        Stop-Fixture
    }
    $result.repeatLaunchVerified = $true
    $result.passed = $true
    $result.stage = 'passed'
} catch {
    $result['errorLine'] = $_.InvocationInfo.ScriptLineNumber
    $result['errorType'] = $_.Exception.GetType().FullName
    $message = $_.Exception.Message
    $result.error = if ($message.StartsWith('VOICE_SMOKE:')) { $message.Substring(12) } else { 'WINDOWS_PREREQUISITE_OR_NATIVE_API_FAILURE' }
} finally {
    try {
        $result['fixtureProcessCount'] = @(Fixture-Processes).Count
        if ($homesReady) {
            $expectedHome = Join-Path $env:LOCALAPPDATA 'HermesVoiceNote\desktop\hermes-home'
            $desktopLog = Join-Path $expectedHome 'logs\desktop.log'
            if (Test-Path -LiteralPath $desktopLog) { Copy-Item -LiteralPath $desktopLog -Destination (Join-Path $output 'desktop.log') }
            $wrongLog = Join-Path $env:HERMES_HOME 'logs\desktop.log'
            if (Test-Path -LiteralPath $wrongLog) { Copy-Item -LiteralPath $wrongLog -Destination (Join-Path $output 'inherited-home-desktop.log') }
        }
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $screen = [Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bitmap = New-Object Drawing.Bitmap($screen.Width, $screen.Height)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size)
            $bitmap.Save((Join-Path $output 'native-window.png'), [Drawing.Imaging.ImageFormat]::Png)
        } finally { $graphics.Dispose(); $bitmap.Dispose() }
    } catch { $result['diagnosticCaptureFailed'] = $true }
    try {
        Stop-Fixture
        if ($guardSnapshotReady) {
            Assert ((Protocol-Snapshot) -ceq $protocol) 'PROTOCOL_REGISTRATION_CHANGED'
            $result.protocolUnchanged = $true
            Assert ((Persistent-Environment) -ceq $persistentEnv) 'PERSISTENT_ENVIRONMENT_CHANGED'
            $result.processOnlyVerified = $true
        }
        if ($homesReady) {
            Assert ((Tree-Snapshot $env:HERMES_HOME) -ceq $stableHome -and (Tree-Snapshot $env:HERMES_DESKTOP_USER_DATA_DIR) -ceq $stableDesktop) 'INHERITED_STABLE_HOME_CHANGED'
            $result.stableHomeUntouched = $true
        }
    } catch {
        $result.passed = $false
        $result.stage = 'cleanup-or-isolation'
        $result.error = 'FIXTURE_CLEANUP_OR_ISOLATION_GUARD_FAILED'
    }
    if ($ruleAttempted) {
        try {
            # Keep the block if an owned process could not be stopped.
            Assert (@(Fixture-Processes).Count -eq 0) 'LIVE_FIXTURE_REQUIRES_FIREWALL_BLOCK'
            Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
            Assert (@(Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue).Count -eq 0) 'FIREWALL_RULE_CLEANUP_FAILED'
        } catch {
            $result.passed = $false
            $result.stage = 'firewall-cleanup'
            $result.error = 'FIREWALL_CLEANUP_FAILED_BLOCK_MAY_BE_RETAINED'
        }
    }
    try {
        $clipboard = [string](Get-Clipboard -Raw -ErrorAction Stop)
        if ($clipboard.StartsWith($prefix, [StringComparison]::Ordinal)) { Set-Clipboard -Value '' }
    } catch { }
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $output 'result.json') -Encoding UTF8
}
if (-not $result.passed) { throw ('Native bundled smoke failed at ' + $result.stage + ': ' + $result.error) }
Write-Host 'PASS: two native launches, public SDK, actual bundled Record control, stale-copy precedence and isolation guards'
