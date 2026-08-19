[CmdletBinding(SupportsShouldProcess)]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$windowsCloudLoginApplicationId = '270efc09-cd0d-444b-a71f-39af4910ec45'
$requiredScopes = @(
  'Application.Read.All'
  'Application-RemoteDesktopConfig.ReadWrite.All'
)

Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
Import-Module Microsoft.Graph.Applications -ErrorAction Stop

$graphContext = Get-MgContext -ErrorAction SilentlyContinue
$missingScopes = if ($graphContext) {
  @($requiredScopes | Where-Object { $_ -notin $graphContext.Scopes })
} else {
  @($requiredScopes)
}
if (-not $graphContext -or $missingScopes.Count -gt 0) {
  if ($WhatIfPreference) {
    throw "What-If requires an existing Microsoft Graph session with scopes: $($requiredScopes -join ', ')."
  }
  Connect-MgGraph -Scopes $requiredScopes -NoWelcome
}

$servicePrincipals = @(Get-MgServicePrincipal -Filter "appId eq '$windowsCloudLoginApplicationId'")
if ($servicePrincipals.Count -ne 1) {
  throw "Expected exactly one Windows Cloud Login service principal; found $($servicePrincipals.Count)."
}

$servicePrincipal = $servicePrincipals[0]
$configuration = Get-MgServicePrincipalRemoteDesktopSecurityConfiguration `
  -ServicePrincipalId $servicePrincipal.Id

if ($configuration.IsRemoteDesktopProtocolEnabled) {
  Write-Output 'Microsoft Entra authentication for RDP is already enabled for Windows Cloud Login.'
  return
}

if ($PSCmdlet.ShouldProcess(
  "Windows Cloud Login service principal $($servicePrincipal.Id)",
  'enable Microsoft Entra authentication for RDP'
)) {
  Update-MgServicePrincipalRemoteDesktopSecurityConfiguration `
    -ServicePrincipalId $servicePrincipal.Id `
    -IsRemoteDesktopProtocolEnabled
}

if ($WhatIfPreference) {
  Write-Output 'What-If completed. Windows Cloud Login was not changed.'
  return
}

$configuration = Get-MgServicePrincipalRemoteDesktopSecurityConfiguration `
  -ServicePrincipalId $servicePrincipal.Id
if (-not $configuration.IsRemoteDesktopProtocolEnabled) {
  throw 'Windows Cloud Login did not report Microsoft Entra authentication for RDP as enabled.'
}

Write-Output 'Microsoft Entra authentication for RDP is enabled for Windows Cloud Login.'
