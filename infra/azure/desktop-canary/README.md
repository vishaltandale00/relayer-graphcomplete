# Windows desktop canary infrastructure

This directory defines the one-user Azure Virtual Desktop environment used for interactive Windows release validation. It is intentionally separate from Windows signing infrastructure and is not deployed by CI.

Nothing in this directory authorizes an Azure deployment, a Microsoft license purchase, or a subscription-scoped role assignment. Run `What-If` first and deploy only after the subscription owner approves the compute, retained-disk, and license costs.

## What the template creates

- one personal/direct-assignment Azure Virtual Desktop host pool;
- one full-desktop application group and one workspace;
- one Entra-joined Windows 11 Enterprise multi-session 24H2 x64 VM with a system-assigned managed identity required by `AADLoginForWindows`;
- `Standard_D2s_v7`, 2 vCPU and 8 GiB memory;
- a 128 GiB Standard SSD OS disk;
- a dedicated VNet, subnet, NSG, and NIC with no public IP and no custom inbound rule;
- Desktop Virtualization User and Virtual Machine User Login assignments for one Entra member user;
- an 11 PM Eastern automatic-shutdown schedule.

The template creates the host pool with Start VM on Connect disabled. Microsoft requires the host pool to exist before that feature is enabled, and the Azure Virtual Desktop service principal needs the subscription-scoped `Desktop Virtualization Power On Off Contributor` role. `complete-deployment.ps1` performs that explicit post-deployment step and directly assigns the one registered session host to the test user.

## Test-only outbound-access choice

The subnet explicitly enables Azure default outbound access so the VM can register with Azure Virtual Desktop, activate Windows, update, and download canary dependencies. This does not create a public-IP resource or an inbound path to the VM. It does give the VM ephemeral outbound internet access.

This is a deliberate cost tradeoff for one temporary test host. A NAT Gateway is the normal explicit egress choice, but it continues billing while the VM is deallocated. Do not reuse this network design as a production desktop landing zone.

## Preconditions

Before deployment, verify all of the following:

1. The test identity is a native Microsoft Entra **member** user in this tenant, not an external B2B identity whose permission level was changed to Member.
2. The user has an eligible AVD license, such as Microsoft 365 Business Premium.
3. The subscription owner approves the billable VM, disk, and outbound-data costs.
4. The deployer can create resources and role assignments in the target subscription.
5. The `Microsoft.DesktopVirtualization`, `Microsoft.Compute`, `Microsoft.Network`, and `Microsoft.DevTestLab` providers are registered.
6. `Standard_D2s_v7` and the `MicrosoftWindowsDesktop:windows-11:win11-24h2-avd:latest` image are available in the chosen region.
7. A native administrator with Application Administrator, Cloud Application Administrator, or a stronger role has enabled Microsoft Entra authentication for RDP on the Windows Cloud Login service principal.

Use a dedicated native identity such as `avd-test@vishalrelayerlabs.onmicrosoft.com`. Do not deploy against a guest-form UPN containing `#EXT#`. `complete-deployment.ps1` also rejects users whose Graph-backed `CreationType` or `ExternalUserState` identifies them as external.

## Enable tenant-level Windows Cloud Login

The host pool already sets `enablerdsaadauth:i:1`, but that property is not sufficient by itself. Microsoft Entra must also allow RDP authentication through the tenant's Windows Cloud Login service principal. This is a tenant-level configuration, so it is intentionally separate from the resource-group Bicep deployment.

Run this once as the native tenant administrator from PowerShell or Azure Cloud Shell with Microsoft Graph PowerShell 2.9.0 or later:

```powershell
Connect-MgGraph `
  -Scopes 'Application.Read.All','Application-RemoteDesktopConfig.ReadWrite.All' `
  -NoWelcome

./enable-windows-cloud-login.ps1 -WhatIf
./enable-windows-cloud-login.ps1
```

The script fails closed unless the Windows Cloud Login service principal resolves exactly once, verifies the final `isRemoteDesktopProtocolEnabled` state, and leaves an already-enabled tenant unchanged.

## Review and deploy from Azure Cloud Shell

Use PowerShell Cloud Shell so the Az modules and signed-in subscription context are available. Copy `main.parameters.example.json` to a private working file and replace only the test user object ID and UPN. Never put the local administrator password in a file or commit it.

```powershell
$subscriptionId = '<subscription-id>'
$resourceGroup = 'relayer-desktop-canary'
$location = 'eastus'
$adminUsername = 'relayerlocal'
$adminPassword = Read-Host 'Temporary local administrator password' -AsSecureString

Set-AzContext -SubscriptionId $subscriptionId
Register-AzResourceProvider -ProviderNamespace Microsoft.DesktopVirtualization
Register-AzResourceProvider -ProviderNamespace Microsoft.Compute
Register-AzResourceProvider -ProviderNamespace Microsoft.Network
Register-AzResourceProvider -ProviderNamespace Microsoft.DevTestLab

New-AzResourceGroup -Name $resourceGroup -Location $location

New-AzResourceGroupDeployment `
  -Name 'relayer-desktop-canary-what-if' `
  -ResourceGroupName $resourceGroup `
  -TemplateFile ./main.bicep `
  -TemplateParameterFile ./main.parameters.private.json `
  -adminUsername $adminUsername `
  -adminPassword $adminPassword `
  -WhatIf
```

Review the What-If output. Remove `-WhatIf` only after explicit deployment approval. Resource creation starts Azure charges.

Wait until Azure Virtual Desktop shows exactly one `Available` session host, then preview the post-deployment mutations:

```powershell
./complete-deployment.ps1 `
  -SubscriptionId $subscriptionId `
  -TestUserObjectId '<test-user-object-id>' `
  -TestUserUpn 'avd-test@vishalrelayerlabs.onmicrosoft.com' `
  -EnableStartVmOnConnect `
  -DeallocateWhenComplete `
  -WhatIf
```

After reviewing that output, run the same command without `-WhatIf`. The script fails closed unless exactly one healthy session host exists.

## Cost shutdown and deletion

Automatic shutdown stops the VM nightly, but Azure documents that it does not replace session sign-out policy and does not guarantee deallocation immediately after a user disconnects. After every canary, run:

```powershell
Stop-AzVM -ResourceGroupName relayer-desktop-canary -Name relayer-win11 -Force
```

The Standard SSD continues billing while retained. After preserving all release evidence and confirming the environment is no longer needed, delete the dedicated resource group through a separately approved operation.
