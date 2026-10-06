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
if ($receipt.schemaVersion -ne 2 -or $receipt.target -ne 'windows-x64' -or $receipt.channel -ne 'preview' -or $receipt.signing.mode -ne 'azure-artifact-signing') { throw 'Sealed Windows Preview candidate required' }
$artifact=@($receipt.artifacts | Where-Object name -like '*.exe')
if ($artifact.Count -ne 1 -or [IO.Path]::GetFileName($Installer) -ne $artifact[0].name -or (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact[0].sha256) { throw 'Installer identity mismatch' }
function Read-Signature([string]$Path,[string]$Role) {
  $s=Get-AuthenticodeSignature -LiteralPath $Path
  if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -ne $receipt.signing.publisherName -or !$s.TimeStamperCertificate) { throw "Invalid sealed-publisher signature: $Role" }
  [PSCustomObject]@{role=$Role;path=$Path;sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant();status=[string]$s.Status;subject=$s.SignerCertificate.Subject;thumbprint=$s.SignerCertificate.Thumbprint;timestampThumbprint=$s.TimeStamperCertificate.Thumbprint}
}
$EvidenceDirectory=[IO.Path]::GetFullPath($EvidenceDirectory)
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$out=Join-Path $EvidenceDirectory "$Phase.json"
if(Test-Path -LiteralPath $out){throw 'Keep existing first-install evidence; choose a new evidence directory'}
$signatures=@(Read-Signature $Installer 'installer')
if ($Phase -eq 'prepare') {
  if (Test-Path -LiteralPath $InstalledExecutable) { throw 'First-install executable already exists; use a fresh ordinary-user profile' }
  if ((Test-Path -LiteralPath $FreshUserData) -and @(Get-ChildItem -LiteralPath $FreshUserData -Force).Count -ne 0) { throw 'Fresh user data is not empty' }
  [IO.File]::WriteAllText($out, ([PSCustomObject]@{schema='windows-first-install-preflight/v1';at=[DateTime]::UtcNow.ToString('o');sourceCommit=$receipt.sourceCommit;version=$receipt.version;workflowRunId=$receipt.candidateWorkflowRunId;workflowRunAttempt=$receipt.candidateWorkflowRunAttempt;freshProfile=$FreshUserData;emptyBeforeInstall=$true;signatures=$signatures} | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
  Write-Output 'Installer identity verified. Install interactively in the fresh ordinary-user account; this is not a gate pass.'
  exit
}
$app=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($InstalledExecutable))
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
if (!$SevenZip) { throw 'Installed-phase qualification requires the locked 7zip-bin executable to compare exact installer payload bytes' }
& $node (Join-Path $PSScriptRoot 'collect-windows-installer-files.mjs') $Installer $SevenZip $app (Join-Path $EvidenceDirectory 'installer-payload.json')
if ($LASTEXITCODE -ne 0) { throw 'Installed payload bytes differ from the candidate installer' }
$version=& $node --version
if ($LASTEXITCODE -ne 0 -or $version -ne 'v22.23.2') { throw 'Installed app-owned Node failed' }
$modules=@()
foreach($process in @(Get-Process -Name relayer-app-server,relayer-graph-server -ErrorAction SilentlyContinue)) {
  if (!$process.Path.StartsWith($app,[StringComparison]::OrdinalIgnoreCase)) { continue }
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
[IO.File]::WriteAllText($out, ([PSCustomObject]@{schema='windows-first-install-runtime/v1';at=[DateTime]::UtcNow.ToString('o');installedExecutable=$InstalledExecutable;sourceCommit=$metadata.sourceCommit;version=$metadata.version;nodeVersion=$version;unicodeStdinPreserved=$true;crtLoadedModules=$modules;signatures=$signatures} | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Write-Output 'Installed signatures and actual local CRT loads captured. Live graph, navigation, shutdown and reopen evidence remain required.'
