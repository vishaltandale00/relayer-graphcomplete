[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$InstalledExecutable,
 [Parameter(Mandatory=$true)][string]$FreshProfile,
 [Parameter(Mandatory=$true)][string]$ExpectedSid,
 [Parameter(Mandatory=$true)][ValidateSet('running','stopped')][string]$State
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if (!$identity.IsAuthenticated -or $identity.User.Value -ne $ExpectedSid -or $ExpectedSid -in @('S-1-5-18','S-1-5-19','S-1-5-20') -or @($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' }).Count -ne 0) { throw 'The inspected ordinary Windows user must collect process evidence' }
$app=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($InstalledExecutable))
if ([IO.Path]::GetFullPath($FreshProfile) -ne [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Relayer'))) { throw 'Process profile differs from the actual ordinary user profile' }
$paths=@{'electron'=[IO.Path]::GetFullPath($InstalledExecutable);'app-server'=(Join-Path $app 'resources\bin\relayer-app-server.exe');'graph-server'=(Join-Path $app 'resources\bin\relayer-graph-server.exe')}
$processes=@()
foreach($process in @(Get-CimInstance Win32_Process -Filter "Name='Relayer.exe' OR Name='relayer-app-server.exe' OR Name='relayer-graph-server.exe'")) {
 # Another Windows user can have a same-named app whose image path is hidden.
 # Establish ownership first; an unreadable owner remains indeterminate.
 $owner=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
 if ($owner.ReturnValue -ne 0) { throw 'Cannot inspect candidate process owner' }
 if ($owner.Sid -ne $ExpectedSid) { continue }
 if (!$process.ExecutablePath) { throw 'Cannot inspect a candidate process executable path' }
 $role=@($paths.Keys | Where-Object { [string]::Equals($paths[$_],$process.ExecutablePath,[StringComparison]::OrdinalIgnoreCase) })
 if ($role.Count -ne 1) { continue }
 # Electron renderer/GPU helpers share its image but have --type; do not mistake
 # them for the primary desktop owner. Never retain command lines or tokens.
 if ($State -eq 'running' -and $role[0] -eq 'electron' -and $process.CommandLine -match '(?:^|\s)--type(?:=|\s)') { continue }
 $processes+=[PSCustomObject]@{role=$role[0];pid=[int]$process.ProcessId;parentPid=[int]$process.ParentProcessId;createdAt=$process.CreationDate.ToUniversalTime().ToString('o');path=$process.ExecutablePath;userSid=$owner.Sid;sha256=(Get-FileHash -LiteralPath $process.ExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()}
}
if ($State -eq 'stopped' -and $processes.Count -ne 0) { throw 'Candidate app processes are still running' }
if ($State -eq 'running') {
 foreach($role in @('electron','app-server','graph-server')) { if (@($processes | Where-Object role -eq $role).Count -ne 1) { throw 'Exactly one candidate Electron owner and each Rust server must be running' } }
 $electron=@($processes | Where-Object role -eq 'electron')[0]
 if (@($processes | Where-Object { $_.role -ne 'electron' -and $_.parentPid -ne $electron.pid }).Count -ne 0) { throw 'Candidate Rust servers are not owned by this Electron generation' }
}
[PSCustomObject]@{schema='windows-installed-processes/v1';observedAt=[DateTime]::UtcNow.ToString('o');state=$State;installedRoot=$app;freshProfile=[IO.Path]::GetFullPath($FreshProfile);userSid=$ExpectedSid;processes=$processes} | ConvertTo-Json -Depth 5 -Compress
