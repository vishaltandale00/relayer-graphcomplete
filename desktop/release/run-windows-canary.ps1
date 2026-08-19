[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SeedInstaller,
  [Parameter(Mandatory = $true)][string]$SeedReleaseReceipt,
  [Parameter(Mandatory = $true)][string]$TargetInstaller,
  [Parameter(Mandatory = $true)][string]$TargetReleaseReceipt,
  [Parameter(Mandatory = $true)][string]$PreviewPublicationReceipt,
  [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
  [string]$CodexHome,
  [int]$TimeoutMinutes = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-RequiredPath([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "$Label does not exist: $Path" }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Assert-SignedFile([string]$Path, [string]$PublisherName) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne "Valid") {
    throw "Authenticode verification failed for $Path`: $($signature.Status) $($signature.StatusMessage)"
  }
  if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -ne $PublisherName) {
    throw "The signer for $Path is not the sealed publisher $PublisherName."
  }
  if (-not $signature.TimeStamperCertificate) { throw "The signature for $Path is not timestamped." }
  return $signature
}

function Wait-ForPath([string]$Path, [datetime]$Deadline) {
  while ((Get-Date) -lt $Deadline) {
    if (Test-Path -LiteralPath $Path) { return }
    Start-Sleep -Seconds 1
  }
  throw "Timed out waiting for $Path."
}

function Stop-Relayer {
  [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Low")]
  param()

  foreach ($process in @(Get-Process -Name "Relayer" -ErrorAction SilentlyContinue)) {
    if ($PSCmdlet.ShouldProcess("Relayer process $($process.Id)", "stop")) {
      Stop-Process -Id $process.Id -Force
    }
  }
  Start-Sleep -Seconds 2
}

function Save-Screenshot([string]$Path) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Read-CanaryRecordLog([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  $records = @()
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line.Trim()) { $records += ($line | ConvertFrom-Json) }
  }
  return $records
}

if (-not [Environment]::UserInteractive) { throw "The Windows canary requires an interactive desktop session." }
$currentSessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object SessionId -eq $currentSessionId)) {
  throw "The Windows canary must run inside the signed-in desktop session."
}

$SeedInstaller = Resolve-RequiredPath $SeedInstaller "Seed installer"
$SeedReleaseReceipt = Resolve-RequiredPath $SeedReleaseReceipt "Seed release receipt"
$TargetInstaller = Resolve-RequiredPath $TargetInstaller "Target installer"
$TargetReleaseReceipt = Resolve-RequiredPath $TargetReleaseReceipt "Target release receipt"
$PreviewPublicationReceipt = Resolve-RequiredPath $PreviewPublicationReceipt "Preview publication receipt"
$EvidenceDirectory = [IO.Path]::GetFullPath($EvidenceDirectory)
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null

$seedReceipt = Get-Content -LiteralPath $SeedReleaseReceipt -Raw | ConvertFrom-Json
$targetReceipt = Get-Content -LiteralPath $TargetReleaseReceipt -Raw | ConvertFrom-Json
$publicationReceipt = Get-Content -LiteralPath $PreviewPublicationReceipt -Raw | ConvertFrom-Json
if ($targetReceipt.schemaVersion -ne 2 -or $targetReceipt.target -ne "windows-x64" -or $targetReceipt.channel -ne "preview") {
  throw "Target release receipt is not a Windows x64 Preview candidate."
}
if ($publicationReceipt.target -ne "windows-x64" -or $publicationReceipt.version -ne $targetReceipt.version) {
  throw "Preview publication receipt does not match the target release receipt."
}
if ($seedReceipt.target -ne "windows-x64" -or $seedReceipt.channel -ne "preview") {
  throw "Seed release receipt is not a Windows x64 Preview candidate."
}
$publisherName = [string]$targetReceipt.signing.publisherName
if (-not $publisherName) { throw "Target release receipt is missing its publisher name." }

$targetArtifact = @($targetReceipt.artifacts | Where-Object { $_.name -like "*.exe" })
if ($targetArtifact.Count -ne 1) { throw "Target release receipt must seal exactly one Windows installer." }
$targetHash = (Get-FileHash -LiteralPath $TargetInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
if ($targetHash -ne [string]$targetArtifact[0].sha256) { throw "Target installer SHA-256 does not match its release receipt." }
$seedArtifact = @($seedReceipt.artifacts | Where-Object { $_.name -like "*.exe" })
if ($seedArtifact.Count -ne 1) { throw "Seed release receipt must seal exactly one Windows installer." }
$seedHash = (Get-FileHash -LiteralPath $SeedInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
if ($seedHash -ne [string]$seedArtifact[0].sha256) { throw "Seed installer SHA-256 does not match its release receipt." }
Assert-SignedFile $TargetInstaller $publisherName | Out-Null
Assert-SignedFile $SeedInstaller $publisherName | Out-Null

$installDirectory = Join-Path $env:LOCALAPPDATA "Programs\Relayer"
$applicationPath = Join-Path $installDirectory "Relayer.exe"
$uninstallerPath = Join-Path $installDirectory "Uninstall Relayer.exe"
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$firstInstallScreenshot = Join-Path $EvidenceDirectory "windows-target-first-install.png"
$availableScreenshot = Join-Path $EvidenceDirectory "windows-preview-available.png"
$readyScreenshot = Join-Path $EvidenceDirectory "windows-preview-ready.png"
$installedScreenshot = Join-Path $EvidenceDirectory "windows-preview-installed.png"
$stateLog = Join-Path $EvidenceDirectory "windows-preview-update.jsonl"
$outputPath = Join-Path $EvidenceDirectory "windows-preview-canary.json"

Stop-Relayer
if (Test-Path -LiteralPath $uninstallerPath) {
  Start-Process -FilePath $uninstallerPath -ArgumentList "/S" -Wait
}

Write-Information "Installing the exact signed target installer interactively. Complete any Windows prompts normally." -InformationAction Continue
$env:RELAYER_DESKTOP_USER_DATA_DIR = Join-Path $EvidenceDirectory "first-install-user-data"
if ($CodexHome) { $env:RELAYER_CODEX_HOME = [IO.Path]::GetFullPath($CodexHome) }
Start-Process -FilePath $TargetInstaller -Wait
Wait-ForPath $applicationPath $deadline
Assert-SignedFile $applicationPath $publisherName | Out-Null
$targetProcess = Get-Process -Name "Relayer" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $targetProcess) {
  $targetProcess = Start-Process -FilePath $applicationPath -PassThru
  Start-Sleep -Seconds 5
}
$acceptance = Read-Host "Confirm the target installer was allowed by Windows and Relayer visibly launched. Type ACCEPTED"
if ($acceptance -ne "ACCEPTED") { throw "Windows first-install acceptance was not confirmed." }
Save-Screenshot $firstInstallScreenshot

Stop-Relayer
if (-not (Test-Path -LiteralPath $uninstallerPath)) { throw "Target installation did not create its uninstaller." }
Start-Process -FilePath $uninstallerPath -ArgumentList "/S" -Wait
Start-Process -FilePath $SeedInstaller -ArgumentList "/S" -Wait
Wait-ForPath $applicationPath $deadline
Assert-SignedFile $applicationPath $publisherName | Out-Null
Stop-Relayer

$seedVersion = [string]$seedReceipt.version
$installedSeedVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($applicationPath).ProductVersion
if (-not $installedSeedVersion.StartsWith($seedVersion)) {
  throw "Installed seed version $installedSeedVersion does not match $seedVersion."
}

$updateUserData = Join-Path $EvidenceDirectory "update-user-data"
New-Item -ItemType Directory -Path $updateUserData -Force | Out-Null
$settingsPath = Join-Path $updateUserData "desktop-settings.json"
$settingsJson = @{ appearance = "light"; updateChannel = "preview" } | ConvertTo-Json
[IO.File]::WriteAllText($settingsPath, $settingsJson, [Text.UTF8Encoding]::new($false))
Remove-Item -LiteralPath $stateLog -Force -ErrorAction SilentlyContinue
$env:RELAYER_DESKTOP_USER_DATA_DIR = $updateUserData
$env:RELAYER_DESKTOP_CANARY_LOG = $stateLog
$seedProcess = Start-Process -FilePath $applicationPath -PassThru

Write-Information "Relayer seed $seedVersion is running. Connect Codex if needed, open Settings, and click Check for updates." -InformationAction Continue
Write-Information "When the update appears, use the visible Download update and Restart to update controls." -InformationAction Continue
$capturedAvailable = $false
$capturedReady = $false
$targetVersion = [string]$targetReceipt.version
$relaunchRecord = $null
while ((Get-Date) -lt $deadline) {
  $records = @(Read-CanaryRecordLog $stateLog)
  if (-not $capturedAvailable -and ($records | Where-Object {
    $_.state.phase -eq "available" -and $_.state.availableVersion -eq $targetVersion
  })) {
    Save-Screenshot $availableScreenshot
    $capturedAvailable = $true
    Write-Information "Captured the visible available state. Continue with Download update." -InformationAction Continue
  }
  if (-not $capturedReady -and ($records | Where-Object {
    $_.state.phase -eq "ready" -and $_.state.availableVersion -eq $targetVersion
  })) {
    Save-Screenshot $readyScreenshot
    $capturedReady = $true
    Write-Information "Captured the visible ready state. Continue with Restart to update." -InformationAction Continue
  }
  $relaunchRecord = $records | Where-Object {
    $_.state.phase -eq "idle" -and $_.state.version -eq $targetVersion -and
      $_.state.channel -eq "preview" -and $_.processId -ne $seedProcess.Id
  } | Select-Object -Last 1
  if ($relaunchRecord) { break }
  Start-Sleep -Seconds 2
}
if (-not $capturedAvailable -or -not $capturedReady -or -not $relaunchRecord) {
  throw "Timed out before the complete Preview update and relaunch sequence was observed."
}

$runningTarget = Get-Process -Id $relaunchRecord.processId -ErrorAction SilentlyContinue
if (-not $runningTarget) { throw "The relaunched target process is no longer running." }
$installedTargetVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($applicationPath).ProductVersion
if (-not $installedTargetVersion.StartsWith($targetVersion)) {
  throw "Relaunched application version $installedTargetVersion does not match $targetVersion."
}
Assert-SignedFile $applicationPath $publisherName | Out-Null
$postUpdate = Read-Host "Open Relayer Settings so Preview, version, and Up to date are visible, then type CAPTURE"
if ($postUpdate -ne "CAPTURE") { throw "Post-update visible evidence was not confirmed." }
Save-Screenshot $installedScreenshot

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$nodeArguments = @(
  (Join-Path $PSScriptRoot "canary-evidence.mjs"),
  "--target-release-receipt", $TargetReleaseReceipt,
  "--preview-publication-receipt", $PreviewPublicationReceipt,
  "--seed-release-receipt", $SeedReleaseReceipt,
  "--state-log", $stateLog,
  "--screenshot-first-install", $firstInstallScreenshot,
  "--screenshot-available", $availableScreenshot,
  "--screenshot-ready", $readyScreenshot,
  "--screenshot-installed", $installedScreenshot,
  "--output", $outputPath,
  "--host", $env:COMPUTERNAME,
  "--os", (Get-CimInstance Win32_OperatingSystem).Caption,
  "--architecture", "x64",
  "--running", "true",
  "--signature-verified", "true",
  "--platform-acceptance-verified", "true"
)
Push-Location $repositoryRoot
try {
  & node @nodeArguments
  if ($LASTEXITCODE -ne 0) { throw "Canary evidence sealing failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}
Write-Information "Windows canary evidence written to $outputPath" -InformationAction Continue
