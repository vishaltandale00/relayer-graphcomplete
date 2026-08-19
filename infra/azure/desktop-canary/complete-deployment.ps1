[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [string]$SubscriptionId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [string]$TestUserObjectId,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$TestUserUpn,

  [string]$ResourceGroupName = 'relayer-desktop-canary',

  [string]$HostPoolName = 'relayer-win-canary-hp',

  [string]$VirtualMachineName = 'relayer-win11',

  [switch]$EnableStartVmOnConnect,

  [switch]$DeallocateWhenComplete
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$avdApplicationId = '9cdead84-a844-4324-93f2-b2e6bb768d07'
$powerRoleName = 'Desktop Virtualization Power On Off Contributor'
$subscriptionScope = "/subscriptions/$SubscriptionId"

Set-AzContext -SubscriptionId $SubscriptionId | Out-Null

$testUsers = @(Get-AzADUser -ObjectId $TestUserObjectId -Select UserType -AppendSelected)
if ($testUsers.Count -ne 1) {
  throw "Expected exactly one test user for object ID $TestUserObjectId; found $($testUsers.Count)."
}
$testUser = $testUsers[0]
if ($testUser.UserType -ne 'Member') {
  throw "The AVD test identity must be an Entra member user; $TestUserUpn is $($testUser.UserType)."
}
if ($testUser.UserPrincipalName -ne $TestUserUpn) {
  throw "Test user object ID resolves to $($testUser.UserPrincipalName), not $TestUserUpn."
}

$sessionHosts = @(Get-AzWvdSessionHost `
  -SubscriptionId $SubscriptionId `
  -ResourceGroupName $ResourceGroupName `
  -HostPoolName $HostPoolName)

if ($sessionHosts.Count -ne 1) {
  throw "Expected exactly one registered session host in $HostPoolName; found $($sessionHosts.Count)."
}

$sessionHost = $sessionHosts[0]
if ($sessionHost.Status -ne 'Available') {
  throw "Session host $($sessionHost.Name) is not Available; current status is $($sessionHost.Status)."
}

$assignmentParameters = @{
  AssignedUser = $TestUserUpn
  Force = $true
  HostPoolName = $HostPoolName
  Name = $sessionHost.Name.Split('/')[-1]
  ResourceGroupName = $ResourceGroupName
  SubscriptionId = $SubscriptionId
}

if ($PSCmdlet.ShouldProcess($sessionHost.Name, "assign personal desktop to $TestUserUpn")) {
  Update-AzWvdSessionHost @assignmentParameters | Out-Null
}

if ($EnableStartVmOnConnect) {
  $avdServicePrincipals = @(Get-AzADServicePrincipal -ApplicationId $avdApplicationId)
  if ($avdServicePrincipals.Count -ne 1) {
    throw "Expected exactly one Azure Virtual Desktop service principal; found $($avdServicePrincipals.Count)."
  }

  $avdServicePrincipal = $avdServicePrincipals[0]
  $existingRole = Get-AzRoleAssignment `
    -ObjectId $avdServicePrincipal.Id `
    -RoleDefinitionName $powerRoleName `
    -Scope $subscriptionScope `
    -ErrorAction SilentlyContinue

  if (-not $existingRole) {
    if ($PSCmdlet.ShouldProcess($subscriptionScope, "assign $powerRoleName to Azure Virtual Desktop")) {
      New-AzRoleAssignment `
        -ObjectId $avdServicePrincipal.Id `
        -ObjectType ServicePrincipal `
        -RoleDefinitionName $powerRoleName `
        -Scope $subscriptionScope | Out-Null
    }
  }

  if ($PSCmdlet.ShouldProcess($HostPoolName, 'enable Start VM on Connect')) {
    Update-AzWvdHostPool `
      -SubscriptionId $SubscriptionId `
      -ResourceGroupName $ResourceGroupName `
      -Name $HostPoolName `
      -StartVMOnConnect:$true | Out-Null
  }
}

if ($DeallocateWhenComplete) {
  if ($PSCmdlet.ShouldProcess($VirtualMachineName, 'stop and deallocate canary VM')) {
    Stop-AzVM `
      -ResourceGroupName $ResourceGroupName `
      -Name $VirtualMachineName `
      -Force | Out-Null
  }
}

if ($WhatIfPreference) {
  Write-Output 'What-If completed. No assignment, role, host-pool, or VM state was changed.'
  return
}

Write-Output "Session host $($sessionHost.Name) is assigned to $TestUserUpn."
if ($EnableStartVmOnConnect) {
  Write-Output 'Start VM on Connect is enabled and its subscription-scoped service role is present.'
}
