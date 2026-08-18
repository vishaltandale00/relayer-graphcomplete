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
    files: [
      "**/*",
      "!dist/**/*",
      "!eval-dist/**/*",
      "!eval-main/**/*",
      "!eval-renderer/**/*",
      "!preload/eval-*.cjs",
      "!packaging/**/*",
      "!release/**/*",
      "!renderer/**/*",
    ],
    extraResources: [
      { from: resolve(repositoryRoot, "target/aarch64-apple-darwin/release/relayer-app-server"), to: "bin/relayer-app-server" },
      { from: resolve(repositoryRoot, "target/aarch64-apple-darwin/release/relayer-graph-server"), to: "bin/relayer-graph-server" },
      { from: resolve(repositoryRoot, "harnesses/codex-basic.yaml"), to: "harnesses/codex-basic.yaml" },
      { from: resolve(repositoryRoot, "packages/graph-client/dist"), to: "graph-client" },
      { from: resolve(desktopRoot, "renderer"), to: "renderer" },
    ],
    artifactName: `${release ? "Relayer" : "Relayer-DEV"}-\${version}-mac-\${arch}.\${ext}`,
    afterPack: "desktop/packaging/verify-bundled-app-server.mjs",
    afterSign: release ? "desktop/release/verify-macos-app.mjs" : undefined,
    // Do not set ElectronSquirrelPreventDowngrades with Electron 43. Its bundled
    // Squirrel predicate rejects valid numeric versions. The updater service and
    // publisher enforce monotonic versions before native installation begins.
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
    },
    publish: release
      ? [{ provider: "generic", url: contract.updateBaseUrl, channel: contract.providerChannel }]
      : undefined,
  };
}

export default async function desktopBuilderConfig() {
  return createDesktopBuilderConfig(await loadDesktopReleaseContract({ desktopRoot }));
}
