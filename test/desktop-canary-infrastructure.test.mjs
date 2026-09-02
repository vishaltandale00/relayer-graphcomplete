import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("desktop canary infrastructure", () => {
  it("deploys the Windows canary VM with Entra identity, supported extension upgrades, and native-tenant authentication", async () => {
    const [template, deploymentScript, cloudLoginScript] = await Promise.all([
      readFile(new URL("../infra/azure/desktop-canary/main.bicep", import.meta.url), "utf8"),
      readFile(new URL("../infra/azure/desktop-canary/complete-deployment.ps1", import.meta.url), "utf8"),
      readFile(new URL("../infra/azure/desktop-canary/enable-windows-cloud-login.ps1", import.meta.url), "utf8"),
    ]);

    expect(template, "Windows VM identity required by AADLoginForWindows").toMatch(
      /resource sessionHost 'Microsoft\.Compute\/virtualMachines@[^']+' = \{[\s\S]*?identity: \{\s*type: 'SystemAssigned'\s*\}[\s\S]*?resource entraJoin/,
    );
    const entraExtension = template.slice(
      template.indexOf("resource entraJoin"),
      template.indexOf("resource avdAgent"),
    );
    const avdExtension = template.slice(
      template.indexOf("resource avdAgent"),
      template.indexOf("resource automaticShutdown"),
    );
    expect(entraExtension, "Entra extension automatic minor-version upgrade").toContain("autoUpgradeMinorVersion: true");
    expect(avdExtension, "AVD agent extension automatic minor-version upgrade").toContain("autoUpgradeMinorVersion: true");
    expect(entraExtension, "Entra extension avoids unsupported enableAutomaticUpgrade").not.toContain("enableAutomaticUpgrade");
    expect(avdExtension, "AVD agent extension avoids unsupported enableAutomaticUpgrade").not.toContain("enableAutomaticUpgrade");

    expect(deploymentScript, "audit UserType, CreationType, and ExternalUserState").toContain("-Select UserType,CreationType,ExternalUserState");
    expect(deploymentScript, "reject #EXT# external identities").toContain("$testUser.UserPrincipalName -match '#EXT#'");
    expect(deploymentScript, "reject invitation-created users").toContain("$testUser.CreationType -eq 'Invitation'");
    expect(deploymentScript, "check ExternalUserState").toContain("$testUser.ExternalUserState");
    expect(deploymentScript, "native tenant authentication message").toContain("must authenticate natively in this tenant");

    expect(cloudLoginScript, "Windows Cloud Login prerequisite app ID").toContain("270efc09-cd0d-444b-a71f-39af4910ec45");
    expect(cloudLoginScript, "Windows Cloud Login prerequisite permission").toContain("Application-RemoteDesktopConfig.ReadWrite.All");
    expect(cloudLoginScript, "service principal configuration update").toContain("Update-MgServicePrincipalRemoteDesktopSecurityConfiguration");
    expect(cloudLoginScript, "RDP enablement verification").toContain("IsRemoteDesktopProtocolEnabled");
    expect(cloudLoginScript, "WhatIf-safe script").toContain("SupportsShouldProcess");
  });
});
