import { resolve } from "node:path";

import {
  electronBuilderSigningIdentity,
  loadDesktopReleaseContract,
} from "../release/contract.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(desktopRoot, "..");

export function createDesktopBuilderConfig(contract) {
  const release = contract.release;
  if (!release && process.env.CI === "true" && !process.argv.includes("--dir")) {
    throw new Error("Distributable desktop builds require the explicit signed release contract.");
  }

  return {
    appId: contract.appId,
    productName: contract.productName,
    electronVersion: "43.0.0",
    npmRebuild: false,
    asar: true,
    forceCodeSigning: release,
    directories: { app: desktopRoot, output: resolve(desktopRoot, "dist") },
    extraMetadata: {
      main: "main/index.mjs",
      relayerArtifactMode: contract.artifactMode,
      relayerProductName: contract.productName,
      relayerUpdateChannel: contract.channelName,
      relayerUpdateBaseUrl: contract.updateBaseUrl,
      relayerReleaseSourceCommit: contract.sourceCommit,
      relayerAppleTeamId: contract.appleTeamId,
      relayerMinimumMacOSVersion: contract.minimumMacOSVersion,
    },
    files: ["**/*", "!dist/**/*", "!packaging/**/*", "!release/**/*", "!renderer/**/*"],
    extraResources: [
      { from: resolve(repositoryRoot, "target/release/relayer-app-server"), to: "bin/relayer-app-server" },
      { from: resolve(desktopRoot, "renderer"), to: "renderer" },
    ],
    artifactName: `${release ? "Relayer" : "Relayer-DEV"}-\${version}-mac-\${arch}.\${ext}`,
    afterSign: release ? "desktop/release/verify-macos-app.mjs" : undefined,
    mac: {
      category: "public.app-category.developer-tools",
      icon: resolve(desktopRoot, "renderer/assets/relayer-logo.svg"),
      target: [
        { target: "dmg", arch: [contract.architecture] },
        { target: "zip", arch: [contract.architecture] },
      ],
      identity: release ? electronBuilderSigningIdentity(contract.signingIdentity) : null,
      hardenedRuntime: release,
      gatekeeperAssess: false,
      minimumSystemVersion: contract.minimumMacOSVersion,
      entitlements: resolve(import.meta.dirname, "macos/entitlements.mac.plist"),
      entitlementsInherit: resolve(import.meta.dirname, "macos/entitlements.mac.inherit.plist"),
      notarize: release,
      strictVerify: true,
      extendInfo: release ? { ElectronSquirrelPreventDowngrades: true } : undefined,
    },
    publish: release
      ? [{ provider: "generic", url: contract.updateBaseUrl, channel: contract.providerChannel }]
      : undefined,
  };
}

export default async function desktopBuilderConfig() {
  return createDesktopBuilderConfig(await loadDesktopReleaseContract({ desktopRoot }));
}
