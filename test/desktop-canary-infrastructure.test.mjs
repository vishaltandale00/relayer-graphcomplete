import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("desktop canary infrastructure", () => {
  it("gives the Windows VM the identity required by AADLoginForWindows", async () => {
    const template = await readFile(
      new URL("../infra/azure/desktop-canary/main.bicep", import.meta.url),
      "utf8",
    );
    expect(template).toMatch(
      /resource sessionHost 'Microsoft\.Compute\/virtualMachines@[^']+' = \{[\s\S]*?identity: \{\s*type: 'SystemAssigned'\s*\}[\s\S]*?resource entraJoin/,
    );
  });

  it("uses automatic-upgrade settings supported by the Windows VM extensions", async () => {
    const template = await readFile(
      new URL("../infra/azure/desktop-canary/main.bicep", import.meta.url),
      "utf8",
    );
    const entraExtension = template.slice(
      template.indexOf("resource entraJoin"),
      template.indexOf("resource avdAgent"),
    );
    const avdExtension = template.slice(
      template.indexOf("resource avdAgent"),
      template.indexOf("resource automaticShutdown"),
    );
    expect(entraExtension).toContain("autoUpgradeMinorVersion: true");
    expect(avdExtension).toContain("autoUpgradeMinorVersion: true");
    expect(entraExtension).not.toContain("enableAutomaticUpgrade");
    expect(avdExtension).not.toContain("enableAutomaticUpgrade");
  });

  it("rejects external identities even when their permission level is Member", async () => {
    const script = await readFile(
      new URL("../infra/azure/desktop-canary/complete-deployment.ps1", import.meta.url),
      "utf8",
    );
    expect(script).toContain("-Select UserType,CreationType,ExternalUserState");
    expect(script).toContain("$testUser.UserPrincipalName -match '#EXT#'");
    expect(script).toContain("$testUser.CreationType -eq 'Invitation'");
    expect(script).toContain("$testUser.ExternalUserState");
    expect(script).toContain("must authenticate natively in this tenant");
  });

  it("configures and verifies the tenant-level Windows Cloud Login prerequisite", async () => {
    const script = await readFile(
      new URL("../infra/azure/desktop-canary/enable-windows-cloud-login.ps1", import.meta.url),
      "utf8",
    );
    expect(script).toContain("270efc09-cd0d-444b-a71f-39af4910ec45");
    expect(script).toContain("Application-RemoteDesktopConfig.ReadWrite.All");
    expect(script).toContain("Update-MgServicePrincipalRemoteDesktopSecurityConfiguration");
    expect(script).toContain("IsRemoteDesktopProtocolEnabled");
    expect(script).toContain("SupportsShouldProcess");
  });
});
