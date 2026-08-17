import { extractFile, listPackage } from "@electron/asar";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

export async function verifyPackagedDesktopContract({ appPath, contract } = {}) {
  if (!contract?.release) {
    throw new Error("Packaged desktop verification requires the signed release contract.");
  }
  const resourcesPath = join(appPath, "Contents", "Resources");
  const asarPath = join(resourcesPath, "app.asar");
  const packageMetadata = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
  const expectedMetadata = {
    version: contract.version,
    relayerArtifactMode: "release",
    relayerProductName: contract.productName,
    relayerUpdateChannel: contract.channelName,
    relayerUpdateBaseUrl: contract.updateBaseUrl,
    relayerReleaseSourceCommit: contract.sourceCommit,
    relayerAppleTeamId: contract.appleTeamId,
    relayerMinimumMacOSVersion: contract.minimumMacOSVersion,
  };
  for (const [field, expected] of Object.entries(expectedMetadata)) {
    if (packageMetadata[field] !== expected) {
      throw new Error(`Packaged desktop metadata ${field} does not match the release contract.`);
    }
  }

  const entries = new Set(listPackage(asarPath).map((entry) => String(entry).replace(/^\//, "")));
  if (!entries.has("node_modules/electron-updater/package.json")) {
    throw new Error("Packaged desktop is missing its electron-updater dependency.");
  }
  if (entries.has("node_modules/prime-agent/package.json")) {
    throw new Error("Desktop release foundation must not package the deferred agent harness.");
  }

  const updateConfiguration = parseYaml(await readFile(join(resourcesPath, "app-update.yml"), "utf8"));
  if (
    updateConfiguration?.provider !== "generic" ||
    updateConfiguration?.url !== contract.updateBaseUrl ||
    updateConfiguration?.channel !== contract.providerChannel
  ) {
    throw new Error("Packaged app-update.yml does not match the sealed release feed contract.");
  }
  return { packageMetadata, updateConfiguration };
}
