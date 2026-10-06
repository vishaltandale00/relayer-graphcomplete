[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('prepare','installed')][string]$Phase,
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$ReleaseReceipt,
  [Parameter(Mandatory=$true)][string]$InstalledExecutable,
  [Parameter(Mandatory=$true)][string]$FreshUserData,
  [Parameter(Mandatory=$true)][string]$EvidenceDirectory,
  [string]$SevenZip
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$receipt=Get-Content -LiteralPath $ReleaseReceipt -Raw | ConvertFrom-Json
if ($receipt.schemaVersion -ne 2 -or $receipt.appId -ne 'ai.relayer.desktop' -or $receipt.product -ne 'Relayer' -or $receipt.target -ne 'windows-x64' -or $receipt.channel -ne 'preview' -or $receipt.signing.mode -ne 'azure-artifact-signing') { throw 'Sealed Windows Preview candidate required' }
$artifact=@($receipt.artifacts | Where-Object name -like '*.exe')
if ($artifact.Count -ne 1 -or [IO.Path]::GetFileName($Installer) -ne $artifact[0].name -or (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact[0].sha256) { throw 'Installer identity mismatch' }
function Read-Signature([string]$Path,[string]$Role) {
  $s=Get-AuthenticodeSignature -LiteralPath $Path
  if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -ne $receipt.signing.publisherName -or !$s.TimeStamperCertificate) { throw "Invalid sealed-publisher signature: $Role" }
  [PSCustomObject]@{role=$Role;path=$Path;sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant();status=[string]$s.Status;subject=$s.SignerCertificate.Subject;thumbprint=$s.SignerCertificate.Thumbprint;timestampThumbprint=$s.TimeStamperCertificate.Thumbprint}
}
# electron-builder 26.15.3 derives APP_GUID as UUID.v5(ai.relayer.desktop,
# 50e065bc-3134-11e6-9bab-38c9862bdaf3). These are its real NSIS keys.
$nsisGuid='84f14565-3886-5a18-8e80-eb3a9f9c3c18'
$nsisInstallKey="Software\$nsisGuid"
$nsisUninstallKey="Software\Microsoft\Windows\CurrentVersion\Uninstall\$nsisGuid"
function Read-OrdinaryIdentity {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $administratorSid='S-1-5-32-544'
  $adminMember=@($identity.Groups | Where-Object { $_.Value -eq $administratorSid }).Count -ne 0
  if (!$identity.IsAuthenticated -or $identity.User.Value -in @('S-1-5-18','S-1-5-19','S-1-5-20') -or $adminMember) { throw 'Qualification requires the fresh ordinary user, not an administrator or service identity' }
  $profile=[Environment]::GetFolderPath('UserProfile')
  $appData=[Environment]::GetFolderPath('ApplicationData')
  if (!$profile -or !$appData -or [IO.Path]::GetFullPath($FreshUserData) -ne [IO.Path]::GetFullPath((Join-Path $appData 'Relayer'))) { throw 'Fresh user data must be this Windows identity actual Relayer profile' }
  [PSCustomObject]@{sid=$identity.User.Value;name=$identity.Name;ordinaryUser=$true;authenticated=$true;administratorGroupMember=$false;userProfile=$profile;appDataDirectory=$appData;localAppDataDirectory=[Environment]::GetFolderPath('LocalApplicationData');programFilesDirectory=[Environment]::GetFolderPath('ProgramFiles');programFilesX86Directory=[Environment]::GetFolderPath('ProgramFilesX86')}
}
function Assert-AbsentPath([string]$Path) {
  try { $null=Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
  catch [System.Management.Automation.ItemNotFoundException] { return }
  throw "First install requires the entire path to be absent: $Path"
}
function Read-InstallationRegistrations {
  $checks=@(); $registrations=@()
  foreach($hive in @('CurrentUser','LocalMachine')) {
    foreach($view in @('Registry32','Registry64')) {
      $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive,[Microsoft.Win32.RegistryView]::$view)
      try {
        foreach($keyPath in @($nsisInstallKey,$nsisUninstallKey)) {
          $key=$base.OpenSubKey($keyPath)
          if ($key) { try { $registrations+=[PSCustomObject]@{hive=$hive;view=$view;key=$keyPath;kind='production-nsis';installLocation=$key.GetValue('InstallLocation')} } finally { $key.Dispose() } }
        }
        # Earlier production identities can have another GUID. The pinned
        # builder writes DisplayName as productName + numeric version.
        $uninstall=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
        if ($uninstall) {
          try {
            foreach($name in $uninstall.GetSubKeyNames()) {
              $entry=$uninstall.OpenSubKey($name)
              if (!$entry) { continue }
              try {
                $display=[string]$entry.GetValue('DisplayName')
                if ($display -match '^Relayer(?:$|\s+\d+(?:\.\d+)*\b)') { $registrations+=[PSCustomObject]@{hive=$hive;view=$view;key="Software\Microsoft\Windows\CurrentVersion\Uninstall\$name";kind='production-display-name';displayName=$display;installLocation=$entry.GetValue('InstallLocation')} }
              } finally { $entry.Dispose() }
            }
          } finally { $uninstall.Dispose() }
        }
        $checks+=[PSCustomObject]@{hive=$hive;view=$view;installKey=$nsisInstallKey;uninstallKey=$nsisUninstallKey;checked=$true}
      } finally { $base.Dispose() }
    }
  }
  [PSCustomObject]@{checks=$checks;registrations=$registrations}
}
$identity=Read-OrdinaryIdentity
$InstalledExecutable=[IO.Path]::GetFullPath($InstalledExecutable)
$FreshUserData=[IO.Path]::GetFullPath($FreshUserData)
if ([IO.Path]::GetFileName($InstalledExecutable) -ne 'Relayer.exe') { throw 'Explicit production Relayer.exe install path required' }
$app=[IO.Path]::GetDirectoryName($InstalledExecutable)
$EvidenceDirectory=[IO.Path]::GetFullPath($EvidenceDirectory)
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$out=Join-Path $EvidenceDirectory "$Phase.json"
if(Test-Path -LiteralPath $out){throw 'Keep existing first-install evidence; choose a new evidence directory'}
$signatures=@(Read-Signature $Installer 'installer')
if ($Phase -eq 'prepare') {
  $directories=@($app)
  foreach($parent in @((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs'),[Environment]::GetFolderPath('ProgramFiles'),[Environment]::GetFolderPath('ProgramFilesX86'))) {
    if (!$parent) { continue }
    foreach($name in @('Relayer','relayer-desktop')) { $directories+=Join-Path $parent $name }
  }
  $checkedDirectories=@($directories | Select-Object -Unique | ForEach-Object {
    $path=[IO.Path]::GetFullPath($_); Assert-AbsentPath $path; [PSCustomObject]@{path=$path;absent=$true}
  })
  Assert-AbsentPath $FreshUserData
  $registry=Read-InstallationRegistrations
  if ($registry.registrations.Count -ne 0) { throw ('Existing production Relayer installation registration: '+($registry.registrations | ConvertTo-Json -Compress -Depth 5)) }
  [IO.File]::WriteAllText($out, ([PSCustomObject]@{schema='windows-first-install-preflight/v1';at=[DateTime]::UtcNow.ToString('o');sourceCommit=$receipt.sourceCommit;version=$receipt.version;workflowRunId=$receipt.candidateWorkflowRunId;workflowRunAttempt=$receipt.candidateWorkflowRunAttempt;freshProfile=$FreshUserData;emptyBeforeInstall=$true;userDataAbsent=$true;identity=$identity;installation=@{appDirectory=$app;directories=$checkedDirectories;registryChecks=$registry.checks;registrations=$registry.registrations};signatures=$signatures} | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  Write-Output 'Installer identity verified. Install interactively in the fresh ordinary-user account; this is not a gate pass.'
  exit
}
$signatures+=Read-Signature $InstalledExecutable 'electron'
$signatures+=Read-Signature (Join-Path $app 'resources\bin\relayer-app-server.exe') 'app-server'
$signatures+=Read-Signature (Join-Path $app 'resources\bin\relayer-graph-server.exe') 'graph-server'
$node=Join-Path $app 'resources\node\node.exe'
$signatures+=Read-Signature $node 'node'
$metadataPath=Join-Path $EvidenceDirectory 'installed-metadata.json'
& $node (Join-Path $PSScriptRoot 'read-windows-install-metadata.mjs') (Join-Path $app 'resources\app.asar') $metadataPath
if ($LASTEXITCODE -ne 0) { throw 'Installed metadata inspection failed' }
$metadata=Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
if ($metadata.sourceCommit -ne $receipt.sourceCommit -or $metadata.version -ne $receipt.version -or $metadata.target -ne 'windows-x64' -or $metadata.channel -ne 'preview' -or $metadata.artifactMode -ne 'release') { throw 'Installed package source/version identity mismatch' }
if (!$SevenZip) { throw 'Installed-phase qualification requires the pinned electron-builder 7zip executable to compare exact installer payload bytes' }
& $node (Join-Path $PSScriptRoot 'collect-windows-installer-files.mjs') $Installer $SevenZip $app (Join-Path $EvidenceDirectory 'installer-payload.json')
if ($LASTEXITCODE -ne 0) { throw 'Installed payload bytes differ from the candidate installer' }
$version=& $node --version
if ($LASTEXITCODE -ne 0 -or $version -ne 'v22.23.2') { throw 'Installed app-owned Node failed' }
$modules=@()
foreach($process in @(Get-Process -Name relayer-app-server,relayer-graph-server -ErrorAction SilentlyContinue)) {
  $expectedProcess=Join-Path $app ('resources\bin\'+$process.ProcessName+'.exe')
  if (![string]::Equals($process.Path,$expectedProcess,[StringComparison]::OrdinalIgnoreCase)) { continue }
  foreach($module in $process.Modules){
    if($module.ModuleName -match '^(msvcp|vcruntime|concrt)\d.*\.dll$') {
      $expected=[IO.Path]::GetFullPath((Join-Path $app ('resources\bin\'+$module.ModuleName)))
      $modules+=[PSCustomObject]@{name=$module.ModuleName;path=$module.FileName;processId=$process.Id;fromAppDirectory=($module.FileName -eq $expected)}
    }
  }
}
if ($modules.Count -eq 0 -or @($modules | Where-Object { !$_.fromAppDirectory }).Count -ne 0) { throw 'Actual app-local CRT loading has not been proven' }
# An executable stdin checkpoint, separate from the provider's live graph run.
$OutputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$sample=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('Y2Fmw6kg5rGJ5a2XIPCfjKTvuI8='))
$stdinProof=('console.log('+($sample | ConvertTo-Json -Compress)+')') | & $node --input-type=module
if ($LASTEXITCODE -ne 0 -or $stdinProof -ne $sample) { throw 'Unicode Node stdin roundtrip failed' }
[IO.File]::WriteAllText($out, ([PSCustomObject]@{schema='windows-first-install-runtime/v1';at=[DateTime]::UtcNow.ToString('o');installedExecutable=$InstalledExecutable;freshProfile=$FreshUserData;identity=$identity;sourceCommit=$metadata.sourceCommit;version=$metadata.version;nodeVersion=$version;unicodeStdinPreserved=$true;crtLoadedModules=$modules;signatures=$signatures} | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Write-Output 'Installed signatures and actual local CRT loads captured. Live graph, navigation, shutdown and reopen evidence remain required.'
