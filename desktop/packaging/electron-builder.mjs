import { resolve } from "node:path";

import {
  electronBuilderSigningIdentity,
  loadDesktopReleaseContract,
} from "../release/contract.mjs";
import { desktopTargetFromEnvironment } from "../shared/target.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(desktopRoot, "..");

export function createDesktopBuilderConfig(contract) {
  const release = contract.release;
  const target = release ? contract : desktopTargetFromEnvironment(process.env);
  const serverTarget = process.env.RELAYER_DESKTOP_RUST_TARGET || target.rustTarget;
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
      relayerReleaseTarget: contract.targetKey,
      relayerReleasePlatform: contract.distributionPlatform,
      relayerReleaseArchitecture: contract.architecture,
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
      { from: resolve(repositoryRoot, `target/${serverTarget}/release/relayer-app-server${target.platform === "win32" ? ".exe" : ""}`), to: `bin/relayer-app-server${target.platform === "win32" ? ".exe" : ""}` },
      { from: resolve(repositoryRoot, `target/${serverTarget}/release/relayer-graph-server${target.platform === "win32" ? ".exe" : ""}`), to: `bin/relayer-graph-server${target.platform === "win32" ? ".exe" : ""}` },
      { from: resolve(repositoryRoot, "harnesses/codex-basic.yaml"), to: "harnesses/codex-basic.yaml" },
      { from: resolve(repositoryRoot, "permissions/desktop.json"), to: "permissions/desktop.json" },
      { from: resolve(repositoryRoot, "packages/graph-client/dist"), to: "graph-client" },
      { from: resolve(desktopRoot, "renderer"), to: "renderer" },
    ],
    artifactName: `${release ? "Relayer" : "Relayer-DEV"}-\${version}-\${os}-\${arch}.\${ext}`,
    afterPack: target.platform === "darwin" ? "desktop/packaging/verify-bundled-app-server.mjs" : undefined,
    afterSign: release
      ? target.platform === "darwin"
        ? "desktop/release/verify-macos-app.mjs"
        : "desktop/release/verify-windows-app.mjs"
      : undefined,
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
    dmg: { sign: release },
    win: {
      icon: resolve(desktopRoot, "renderer/assets/relayer-logo.svg"),
      target: [{ target: "nsis", arch: [target.architecture] }],
      verifyUpdateCodeSignature: release,
      azureSignOptions: release && target.platform === "win32" ? {
        endpoint: contract.artifactSigningEndpoint,
        codeSigningAccountName: contract.artifactSigningAccountName,
        certificateProfileName: contract.artifactSigningCertificateProfileName,
        publisherName: contract.publisherName,
        fileDigest: "SHA256",
        timestampDigest: "SHA256",
        timestampRfc3161: "http://timestamp.acs.microsoft.com",
      } : undefined,
    },
    publish: release
      ? [{ provider: "generic", url: contract.updateBaseUrl, channel: contract.providerChannel }]
      : undefined,
  };
}

export default async function desktopBuilderConfig() {
  return createDesktopBuilderConfig(await loadDesktopReleaseContract({ desktopRoot }));
}
