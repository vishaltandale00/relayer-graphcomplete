targetScope = 'resourceGroup'

@description('Azure region for the temporary Windows desktop canary environment.')
param location string = resourceGroup().location

@description('Object ID of the Microsoft Entra member user who will run the canary.')
param testUserObjectId string

@description('User principal name of the Microsoft Entra member user who will run the canary.')
param testUserUpn string

@description('Local administrator username for break-glass VM maintenance. Do not use the test user UPN.')
@secure()
param adminUsername string

@description('Local administrator password supplied only at deployment time.')
@secure()
param adminPassword string

@description('Four-hour registration-token lifetime, evaluated when the deployment starts.')
param registrationTokenExpiration string = dateTimeAdd(utcNow(), 'PT4H')

@description('Daily automatic shutdown time in 24-hour HHmm form.')
@minLength(4)
@maxLength(4)
param shutdownTime string = '2300'

@description('Windows time-zone identifier used by the shutdown schedule.')
param shutdownTimeZone string = 'Eastern Standard Time'

@description('Microsoft-maintained Azure Virtual Desktop DSC package used to register the session host.')
#disable-next-line no-hardcoded-env-urls
param avdAgentConfigurationUri string = 'https://wvdportalstorageblob.blob.core.windows.net/galleryartifacts/Configuration_1.0.02774.414.zip'

param hostPoolName string = 'relayer-win-canary-hp'
param applicationGroupName string = 'relayer-win-canary-dag'
param workspaceName string = 'relayer-win-canary-ws'
param virtualNetworkName string = 'relayer-win-canary-vnet'
param subnetName string = 'session-hosts'
param networkSecurityGroupName string = 'relayer-win-canary-nsg'
param virtualMachineName string = 'relayer-win11'
param virtualMachineSize string = 'Standard_D2s_v7'

var desktopVirtualizationUserRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '1d18fff3-a72a-46b5-b4a9-0b38a3cd7e63'
)
var virtualMachineUserLoginRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'fb879df8-f326-4884-b1cf-06f3ad86be52'
)
var resourceTags = {
  application: 'relayer-desktop'
  environment: 'canary'
  owner: 'relayer-labs'
  purpose: 'interactive-windows-release-validation'
}

resource networkSecurityGroup 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: networkSecurityGroupName
  location: location
  tags: resourceTags
  properties: {
    securityRules: []
  }
}

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: virtualNetworkName
  location: location
  tags: resourceTags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.40.0.0/16'
      ]
    }
  }
}

resource sessionHostSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: virtualNetwork
  name: subnetName
  properties: {
    addressPrefix: '10.40.1.0/24'
    defaultOutboundAccess: true
    networkSecurityGroup: {
      id: networkSecurityGroup.id
    }
    privateEndpointNetworkPolicies: 'Enabled'
    privateLinkServiceNetworkPolicies: 'Enabled'
  }
}

resource hostPool 'Microsoft.DesktopVirtualization/hostPools@2023-09-05' = {
  name: hostPoolName
  location: location
  tags: resourceTags
  properties: {
    customRdpProperty: 'enablerdsaadauth:i:1;redirectclipboard:i:1;redirectprinters:i:0;redirectcomports:i:0;redirectsmartcards:i:0;drivestoredirect:s:;devicestoredirect:s:;usbdevicestoredirect:s:;audiomode:i:0;videoplaybackmode:i:1;redirectwebauthn:i:1;use multimon:i:1;'
    description: 'Temporary personal desktop for interactive Relayer Windows release validation.'
    friendlyName: 'Relayer Windows release canary'
    hostPoolType: 'Personal'
    loadBalancerType: 'Persistent'
    maxSessionLimit: 1
    personalDesktopAssignmentType: 'Direct'
    preferredAppGroupType: 'Desktop'
    publicNetworkAccess: 'Enabled'
    registrationInfo: {
      expirationTime: registrationTokenExpiration
      registrationTokenOperation: 'Update'
    }
    startVMOnConnect: false
    validationEnvironment: false
  }
}

resource desktopApplicationGroup 'Microsoft.DesktopVirtualization/applicationGroups@2023-09-05' = {
  name: applicationGroupName
  location: location
  tags: resourceTags
  properties: {
    applicationGroupType: 'Desktop'
    description: 'Full desktop for the Relayer Windows release canary.'
    friendlyName: 'Relayer Windows canary desktop'
    hostPoolArmPath: hostPool.id
  }
}

resource workspace 'Microsoft.DesktopVirtualization/workspaces@2023-09-05' = {
  name: workspaceName
  location: location
  tags: resourceTags
  properties: {
    applicationGroupReferences: [
      desktopApplicationGroup.id
    ]
    description: 'Workspace for the temporary Relayer Windows release canary.'
    friendlyName: 'Relayer Windows release canary'
    publicNetworkAccess: 'Enabled'
  }
}

resource desktopApplicationGroupUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(desktopApplicationGroup.id, testUserObjectId, desktopVirtualizationUserRoleId)
  scope: desktopApplicationGroup
  properties: {
    principalId: testUserObjectId
    principalType: 'User'
    roleDefinitionId: desktopVirtualizationUserRoleId
  }
}

resource sessionHostNic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: '${virtualMachineName}-nic'
  location: location
  tags: resourceTags
  properties: {
    enableAcceleratedNetworking: true
    ipConfigurations: [
      {
        name: 'ipconfig'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: sessionHostSubnet.id
          }
        }
      }
    ]
  }
}

resource sessionHost 'Microsoft.Compute/virtualMachines@2024-03-01' = {
  name: virtualMachineName
  location: location
  tags: resourceTags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hardwareProfile: {
      vmSize: virtualMachineSize
    }
    licenseType: 'Windows_Client'
    networkProfile: {
      networkInterfaces: [
        {
          id: sessionHostNic.id
          properties: {
            deleteOption: 'Delete'
          }
        }
      ]
    }
    osProfile: {
      adminPassword: adminPassword
      adminUsername: adminUsername
      computerName: virtualMachineName
    }
    securityProfile: {
      securityType: 'TrustedLaunch'
      uefiSettings: {
        secureBootEnabled: true
        vTpmEnabled: true
      }
    }
    storageProfile: {
      imageReference: {
        offer: 'windows-11'
        publisher: 'MicrosoftWindowsDesktop'
        sku: 'win11-24h2-avd'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        deleteOption: 'Delete'
        diskSizeGB: 128
        managedDisk: {
          storageAccountType: 'StandardSSD_LRS'
        }
      }
    }
  }
}

resource sessionHostUserLogin 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sessionHost.id, testUserObjectId, virtualMachineUserLoginRoleId)
  scope: sessionHost
  properties: {
    principalId: testUserObjectId
    principalType: 'User'
    roleDefinitionId: virtualMachineUserLoginRoleId
  }
}

resource entraJoin 'Microsoft.Compute/virtualMachines/extensions@2024-03-01' = {
  parent: sessionHost
  name: 'AADLoginForWindows'
  location: location
  properties: {
    autoUpgradeMinorVersion: true
    publisher: 'Microsoft.Azure.ActiveDirectory'
    type: 'AADLoginForWindows'
    typeHandlerVersion: '1.0'
  }
}

resource avdAgent 'Microsoft.Compute/virtualMachines/extensions@2024-03-01' = {
  parent: sessionHost
  name: 'MicrosoftPowershellDSC'
  location: location
  properties: {
    autoUpgradeMinorVersion: true
    protectedSettings: {
      properties: {
        #disable-next-line use-resource-symbol-reference
        registrationInfoToken: reference(hostPool.id).registrationInfo.token
      }
    }
    publisher: 'Microsoft.Powershell'
    settings: {
      configurationFunction: 'Configuration.ps1\\AddSessionHost'
      modulesUrl: avdAgentConfigurationUri
      properties: {
        aadJoin: true
        hostPoolName: hostPool.name
      }
    }
    type: 'DSC'
    typeHandlerVersion: '2.73'
  }
  dependsOn: [
    entraJoin
  ]
}

resource automaticShutdown 'Microsoft.DevTestLab/schedules@2018-09-15' = {
  name: 'shutdown-computevm-${virtualMachineName}'
  location: location
  tags: resourceTags
  properties: {
    dailyRecurrence: {
      time: shutdownTime
    }
    notificationSettings: {
      status: 'Disabled'
      timeInMinutes: 30
    }
    status: 'Enabled'
    targetResourceId: sessionHost.id
    taskType: 'ComputeVmShutdownTask'
    timeZoneId: shutdownTimeZone
  }
  dependsOn: [
    avdAgent
  ]
}

output applicationGroupId string = desktopApplicationGroup.id
output hostPoolName string = hostPool.name
output sessionHostVmId string = sessionHost.id
output sessionHostVmName string = sessionHost.name
output testUserUpn string = testUserUpn
output workspaceId string = workspace.id
