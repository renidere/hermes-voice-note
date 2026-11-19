$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}
$repo = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repo 'install\Start-Voice-Note.ps1'
# Keep this first: an absent feature must fail before fixture/tool setup.
Assert (Test-Path -LiteralPath $installer -PathType Leaf) 'Installer source install/Start-Voice-Note.ps1 must exist'
$launcher = Join-Path $repo 'install\Start-Voice-Note.cmd'
Assert (Test-Path -LiteralPath $launcher -PathType Leaf) 'Launcher source install/Start-Voice-Note.cmd must exist'
Assert ($env:OS -eq 'Windows_NT') 'Run with Windows PowerShell 5.1 on Windows'
$powerShell = Join-Path $PSHOME 'powershell.exe'
$cmd = Join-Path $env:SystemRoot 'System32\cmd.exe'
$envNames = @('LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'HERMES_HOME', 'HERMES_DESKTOP_USER_DATA_DIR', 'HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION')
$saved = @{}
foreach ($name in $envNames) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$work = Join-Path ([IO.Path]::GetTempPath()) ('voice-note-install-tests-' + [Guid]::NewGuid().ToString('N'))
$script:caseNumber = 0
$script:checks = 0
$script:heldProcess = $null
$script:holdFile = $null
$script:junctions = New-Object 'System.Collections.Generic.List[string]'

function Put([string]$Path, [string]$Text) {
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Snapshot([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root)) { return '<absent>' }
    $rows = New-Object 'System.Collections.Generic.List[string]'
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Root)
    while ($pending.Count -gt 0) {
        foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            $relative = $entry.FullName.Substring($Root.Length)
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                $rows.Add("LINK $relative")
            } elseif ($entry.PSIsContainer) {
                $rows.Add("DIR $relative"); $pending.Push($entry.FullName)
            } else {
                $rows.Add("$relative $(Hash $entry.FullName) $($entry.LastWriteTimeUtc.Ticks)")
            }
        }
    }
    return (($rows | Sort-Object) -join "`n")
}
function Save-Manifest($Fixture) {
    $Fixture.Manifest | ConvertTo-Json -Depth 8 | ForEach-Object { Put $Fixture.ManifestPath $_ }
}
function New-Fixture {
    $script:caseNumber++
    $root = Join-Path $work ("case-$script:caseNumber пакет with spaces")
    $package = Join-Path $root 'client пакет'
    $local = Join-Path $root 'local app data'
    [void][IO.Directory]::CreateDirectory($package)
    $env:LOCALAPPDATA = $local
    $env:APPDATA = Join-Path $root 'roaming'
    $env:USERPROFILE = Join-Path $root 'profile'
    $env:HOME = $env:USERPROFILE
    $env:TEMP = Join-Path $root 'temp'
    $env:TMP = $env:TEMP
    [void][IO.Directory]::CreateDirectory($env:TEMP)
    $env:HERMES_HOME = Join-Path $root 'stable hermes'
    $env:HERMES_DESKTOP_USER_DATA_DIR = Join-Path $root 'stable desktop'
    $env:HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION = 'inherited-do-not-use'
    Put (Join-Path $env:HERMES_HOME 'credentials.json') '{"syntheticSecret":"do-not-copy"}'
    Put (Join-Path $env:HERMES_HOME 'settings.json') '{"syntheticSetting":"do-not-copy"}'
    Put (Join-Path $env:HERMES_DESKTOP_USER_DATA_DIR 'desktop-plugins.json') '{"hermes-voice-note":{"enabled":false}}'
    $delivery = Join-Path $package 'voice-note-delivery'
    [void][IO.Directory]::CreateDirectory($delivery)
    Copy-Item -LiteralPath $installer -Destination (Join-Path $delivery 'Start-Voice-Note.ps1')
    Copy-Item -LiteralPath $launcher -Destination (Join-Path $package 'Start-Voice-Note.cmd')
    $exe = Join-Path $package 'hermes-light-3b42157.exe'
    Copy-Item -LiteralPath (Join-Path $work 'fixture-client.exe') -Destination $exe
    Put (Join-Path $package 'voice-note-plugin\plugin.js') '/* synthetic plugin v1; never loaded */'
    Put (Join-Path $package 'resources\app.asar') 'synthetic app.asar, not an Electron client'
    Put (Join-Path $package 'locales\en-US.pak') 'synthetic locale'
    Put (Join-Path $package 'chrome_100_percent.pak') 'synthetic application file'
    $files = [ordered]@{}
    foreach ($relative in @('hermes-light-3b42157.exe', 'voice-note-plugin/plugin.js', 'resources/app.asar', 'locales/en-US.pak', 'chrome_100_percent.pak')) {
        $files[$relative] = Hash (Join-Path $package $relative)
    }
    $data = Join-Path $local 'HermesVoiceNote\desktop'
    $target = Join-Path $data 'hermes-home\desktop-plugins\hermes-voice-note\plugin.js'
    $f = [pscustomobject]@{
        Root = $root; Package = $package; Exe = $exe; Data = $data; Target = $target
        Receipt = Join-Path (Split-Path -Parent $target) '.voice-note-delivery.json'
        ManifestPath = Join-Path $delivery 'manifest.json'
        Manifest = [ordered]@{ schemaVersion = 1; pluginId = 'hermes-voice-note'; executable = 'hermes-light-3b42157.exe'; files = $files }
    }
    Save-Manifest $f
    return $f
}
function Run-Installer($Fixture, [switch]$Launch) {
    # Windows PowerShell wraps native stderr as ErrorRecord; rejection is an exit-code assertion.
    $ErrorActionPreference = 'Continue'
    $beforeEnv = @{}
    foreach ($name in $envNames) { $beforeEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    if ($Launch) {
        $entry = Join-Path $Fixture.Package 'Start-Voice-Note.cmd'
        $output = & $cmd /d /s /c "`"`"$entry`"`"" 2>&1
    } else {
        $entry = Join-Path $Fixture.Package 'voice-note-delivery\Start-Voice-Note.ps1'
        $output = & $powerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $entry -InstallOnly 2>&1
    }
    $code = $LASTEXITCODE
    foreach ($name in $envNames) {
        Assert ([Environment]::GetEnvironmentVariable($name, 'Process') -ceq $beforeEnv[$name]) "Parent environment unchanged: $name"
    }
    return [pscustomobject]@{ Code = $code; Output = ($output -join "`n") }
}
function Installed($Fixture) {
    Assert (Test-Path -LiteralPath $Fixture.Target -PathType Leaf) 'Plugin published to dedicated hermes-home'
    Assert ((Hash $Fixture.Target) -ceq $Fixture.Manifest.files['voice-note-plugin/plugin.js']) 'Published plugin bytes match manifest'
    $receipt = Get-Content -LiteralPath $Fixture.Receipt -Raw | ConvertFrom-Json
    Assert ($receipt.schemaVersion -eq 1) 'Receipt schemaVersion'
    Assert ($receipt.pluginId -ceq 'hermes-voice-note') 'Receipt pluginId'
    Assert ($receipt.pluginSha256 -ceq (Hash $Fixture.Target)) 'Receipt bound to installed bytes'
}
function Success($Fixture) {
    $r = Run-Installer $Fixture
    Assert ($r.Code -eq 0) "InstallOnly succeeds: $($r.Output)"
    Installed $Fixture
    Assert (-not (Test-Path -LiteralPath ($Fixture.Exe + '.capture'))) 'InstallOnly never launches client'
    $script:checks++
}
function Reject($Fixture, [string]$Reason) {
    $source = Snapshot $Fixture.Package
    $destination = Snapshot $Fixture.Data
    $stableHome = Snapshot $env:HERMES_HOME
    $stableDesktop = Snapshot $env:HERMES_DESKTOP_USER_DATA_DIR
    $r = Run-Installer $Fixture
    Assert ($r.Code -ne 0) "Must reject $Reason"
    Assert ((Snapshot $Fixture.Package) -ceq $source) "Source preserved: $Reason"
    Assert ((Snapshot $Fixture.Data) -ceq $destination) "Destination preserved: $Reason"
    Assert ((Snapshot $env:HERMES_HOME) -ceq $stableHome) "Stable home preserved: $Reason"
    Assert ((Snapshot $env:HERMES_DESKTOP_USER_DATA_DIR) -ceq $stableDesktop) "Stable desktop preserved: $Reason"
    Assert (-not (Test-Path -LiteralPath ($Fixture.Exe + '.capture'))) "No client launch: $Reason"
    $script:checks++
}
function Junction([string]$Link, [string]$Destination) {
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Link))
    [void][IO.Directory]::CreateDirectory($Destination)
    $null = & $cmd /d /c "mklink /J `"$Link`" `"$Destination`"" 2>&1
    Assert ($LASTEXITCODE -eq 0) 'Fixture junction creation succeeds (NTFS required)'
    $script:junctions.Add($Link)
}

try {
    [void][IO.Directory]::CreateDirectory($work)
    # Only this synthetic executable is ever launched; it has no network/audio/provider code.
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
public static class VoiceNoteFixtureClient {
    public static void Main() {
        string own = Process.GetCurrentProcess().MainModule.FileName;
        File.WriteAllLines(own + ".capture", new string[] {
            own,
            Environment.GetEnvironmentVariable("HERMES_HOME") ?? "",
            Environment.GetEnvironmentVariable("HERMES_DESKTOP_USER_DATA_DIR") ?? "",
            Environment.GetEnvironmentVariable("HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION") ?? ""
        });
        while (File.Exists(own + ".hold")) Thread.Sleep(50);
    }
}
'@ -OutputAssembly (Join-Path $work 'fixture-client.exe') -OutputType ConsoleApplication

    $f = New-Fixture
    $stableHome = Snapshot $env:HERMES_HOME
    $stableDesktop = Snapshot $env:HERMES_DESKTOP_USER_DATA_DIR
    $store = Join-Path $f.Data 'desktop-plugins.json'
    Put $store '{"hermes-voice-note":{"enabled":false},"other":{"enabled":true}}'
    Put (Join-Path $f.Data 'unrelated\keep.txt') 'keep unrelated data'
    $unrelated = Snapshot (Join-Path $f.Data 'unrelated')
    $storeHash = Hash $store
    Success $f
    Assert ((Hash $store) -ceq $storeHash) 'Explicit disabled choice is not edited'
    Assert ((Snapshot (Join-Path $f.Data 'unrelated')) -ceq $unrelated) 'Unrelated files preserved'
    Assert ((Snapshot $env:HERMES_HOME) -ceq $stableHome) 'Never alter inherited stable home'
    Assert ((Snapshot $env:HERMES_DESKTOP_USER_DATA_DIR) -ceq $stableDesktop) 'Never alter inherited desktop'
    Assert (-not (Test-Path -LiteralPath (Join-Path $f.Data 'hermes-home\credentials.json'))) 'Never copy stable credentials'
    Assert (-not (Test-Path -LiteralPath (Join-Path $f.Data 'hermes-home\settings.json'))) 'Never copy stable settings'
    $time = (Get-Item -LiteralPath $f.Target).LastWriteTimeUtc.Ticks
    $receiptTime = (Get-Item -LiteralPath $f.Receipt).LastWriteTimeUtc.Ticks
    Start-Sleep -Milliseconds 1100
    Success $f
    Assert ((Get-Item -LiteralPath $f.Target).LastWriteTimeUtc.Ticks -eq $time) 'Idempotence preserves plugin mtime'
    Assert ((Get-Item -LiteralPath $f.Receipt).LastWriteTimeUtc.Ticks -eq $receiptTime) 'Idempotence preserves receipt mtime'

    $oldHash = Hash $f.Target
    Put (Join-Path $f.Package 'voice-note-plugin\plugin.js') '/* synthetic plugin v2 */'
    $f.Manifest.files['voice-note-plugin/plugin.js'] = Hash (Join-Path $f.Package 'voice-note-plugin\plugin.js')
    Save-Manifest $f
    Success $f
    $backups = @(Get-ChildItem -LiteralPath (Split-Path -Parent $f.Target) -File -Force | Where-Object { $_.FullName -ne $f.Target -and $_.FullName -ne $f.Receipt -and (Hash $_.FullName) -ceq $oldHash })
    Assert ($backups.Count -ge 1) 'Owned update retains previous plugin bytes as backup'

    foreach ($relative in @('hermes-light-3b42157.exe', 'resources/app.asar', 'voice-note-plugin/plugin.js', 'locales/en-US.pak', 'chrome_100_percent.pak')) {
        $f = New-Fixture
        Put (Join-Path $f.Package $relative) 'tampered bytes'
        Reject $f "hash mismatch $relative"
    }
    foreach ($relative in @('hermes-light-3b42157.exe', 'resources/app.asar', 'voice-note-plugin/plugin.js')) {
        $f = New-Fixture
        Remove-Item -LiteralPath (Join-Path $f.Package $relative)
        Reject $f "missing required file $relative"
        $f = New-Fixture
        $f.Manifest.files.Remove($relative)
        Save-Manifest $f
        Reject $f "required file omitted from manifest: $relative"
    }
    foreach ($field in @('schemaVersion', 'pluginId', 'executable')) {
        $f = New-Fixture
        if ($field -eq 'schemaVersion') { $f.Manifest[$field] = 2 }
        elseif ($field -eq 'pluginId') { $f.Manifest[$field] = 'other-plugin' }
        else { $f.Manifest[$field] = 'other.exe'; Copy-Item -LiteralPath $f.Exe -Destination (Join-Path $f.Package 'other.exe'); $f.Manifest.files['other.exe'] = Hash (Join-Path $f.Package 'other.exe') }
        Save-Manifest $f
        Reject $f "invalid $field"
    }
    $f = New-Fixture
    Put (Join-Path $f.Package 'unlisted-app.dll') 'mixed application build'
    Reject $f 'application file absent from manifest'
    $f = New-Fixture
    Put $f.ManifestPath '{broken json'
    Reject $f 'malformed manifest'
    $f = New-Fixture
    Remove-Item -LiteralPath $f.ManifestPath
    Reject $f 'missing manifest'
    foreach ($hashValue in @('not-a-sha256', ('A' * 64))) {
        $f = New-Fixture
        $f.Manifest.files['voice-note-plugin/plugin.js'] = $hashValue
        Save-Manifest $f
        Reject $f 'invalid/non-lowercase SHA256'
    }
    foreach ($badPath in @('../outside.js', '..\outside.js', 'C:\outside.js', '/outside.js', 'resources/../../outside.js', 'resources/app.asar:stream')) {
        $f = New-Fixture
        Put (Join-Path $f.Root 'outside.js') 'outside sentinel'
        $outside = Snapshot (Join-Path $f.Root 'profile')
        $f.Manifest.files[$badPath] = Hash (Join-Path $f.Root 'outside.js')
        Save-Manifest $f
        Reject $f "non-contained path $badPath"
        Assert ((Snapshot (Join-Path $f.Root 'profile')) -ceq $outside) 'Outside profile unchanged'
    }
    $f = New-Fixture
    Put $f.Target 'unowned plugin, do not overwrite'
    Reject $f 'conflicting unowned target'
    $f = New-Fixture
    Success $f
    Put $f.Target 'user-modified owned plugin'
    Reject $f 'receipt does not authorize overwriting locally modified bytes'

    $f = New-Fixture
    Success $f
    Put (Join-Path $f.Package 'resources\app.asar') 'mixed build after previous install'
    Reject $f 'invalid update preserves existing owned installation'

    $f = New-Fixture
    $outside = Join-Path $f.Root 'source alias'
    Junction $outside $f.Package
    $f.Package = $outside
    $f.Exe = Join-Path $outside 'hermes-light-3b42157.exe'
    Reject $f 'reparse package root'

    $f = New-Fixture
    $outside = Join-Path $f.Root 'outside source'
    Move-Item -LiteralPath (Join-Path $f.Package 'resources') -Destination $outside
    Junction (Join-Path $f.Package 'resources') $outside
    $beforeOutside = Snapshot $outside
    Reject $f 'reparse source subtree'
    Assert ((Snapshot $outside) -ceq $beforeOutside) 'Reparse source referent preserved'
    $f = New-Fixture
    $outside = Join-Path $f.Root 'outside data'
    Put (Join-Path $outside 'keep.txt') 'outside sentinel'
    Junction $f.Data $outside
    $beforeOutside = Snapshot $outside
    Reject $f 'reparse data root'
    Assert ((Snapshot $outside) -ceq $beforeOutside) 'Reparse data referent preserved'
    $f = New-Fixture
    $outside = Join-Path $f.Root 'outside target'
    Put (Join-Path $outside 'plugin.js') 'outside plugin'
    Junction (Split-Path -Parent $f.Target) $outside
    $beforeOutside = Snapshot $outside
    Reject $f 'reparse plugin target parent'
    Assert ((Snapshot $outside) -ceq $beforeOutside) 'Reparse target referent preserved'

    $f = New-Fixture
    Success $f
    $script:holdFile = $f.Exe + '.hold'
    Put $script:holdFile 'hold synthetic client only'
    $script:heldProcess = Start-Process -FilePath $f.Exe -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath ($f.Exe + '.capture')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    Assert (Test-Path -LiteralPath ($f.Exe + '.capture')) 'Synthetic running-process control is ready'
    Remove-Item -LiteralPath ($f.Exe + '.capture')
    Put (Join-Path $f.Data 'draft.wav') 'synthetic unsent WAV sentinel'
    $draftHash = Hash (Join-Path $f.Data 'draft.wav')
    Put (Join-Path $f.Package 'voice-note-plugin\plugin.js') '/* synthetic running update */'
    $f.Manifest.files['voice-note-plugin/plugin.js'] = Hash (Join-Path $f.Package 'voice-note-plugin\plugin.js')
    Save-Manifest $f
    Reject $f 'owned update while named client is running'
    $script:heldProcess.Refresh()
    Assert (-not $script:heldProcess.HasExited) 'Installer must not kill a running client'
    Assert ((Hash (Join-Path $f.Data 'draft.wav')) -ceq $draftHash) 'Unsent WAV preserved'
    Remove-Item -LiteralPath $script:holdFile
    Assert ($script:heldProcess.WaitForExit(10000)) 'Synthetic client exits cooperatively'
    $script:heldProcess = $null
    $script:holdFile = $null
    Success $f

    $f = New-Fixture
    $r = Run-Installer $f -Launch
    Assert ($r.Code -eq 0) "Actual CMD entrypoint succeeds: $($r.Output)"
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath ($f.Exe + '.capture')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    Assert (Test-Path -LiteralPath ($f.Exe + '.capture')) 'CMD directly launches packaged synthetic EXE, not hermes://'
    $capture = [IO.File]::ReadAllLines($f.Exe + '.capture')
    Assert ($capture.Length -eq 4) 'Capture contains only executable and three allowlisted environment values'
    Assert ($capture[0] -ieq $f.Exe) 'Exact absolute packaged executable launched'
    Assert ($capture[1] -ieq (Join-Path $f.Data 'hermes-home')) 'Dedicated HERMES_HOME ignores inherited stable value'
    Assert ($capture[2] -ieq $f.Data) 'Dedicated user data ignores inherited stable value'
    Assert ($capture[3] -ceq '1') 'Protocol registration skipped in launched process'
    Installed $f
    $script:checks++
    Write-Host "PASS: $script:checks Windows offline delivery scenarios"
} finally {
    if ($script:holdFile -and (Test-Path -LiteralPath $script:holdFile)) { Remove-Item -LiteralPath $script:holdFile -Force }
    if ($script:heldProcess) { [void]$script:heldProcess.WaitForExit(10000) }
    foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    # Remove junctions themselves before recursive cleanup, never their referents.
    foreach ($link in $script:junctions) { if (Test-Path -LiteralPath $link) { [IO.Directory]::Delete($link) } }
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
foreach ($name in $envNames) {
    Assert ([Environment]::GetEnvironmentVariable($name, 'Process') -ceq $saved[$name]) "Original environment restored: $name"
}
