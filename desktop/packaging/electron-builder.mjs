import { resolve } from "node:path";
import { PACKAGED_PROVIDER_MODULES } from "../main/providers/provider-adapter-registry.mjs";

import {
  electronBuilderSigningIdentity,
  loadDesktopReleaseContract,
} from "../release/contract.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(desktopRoot, "..");

export function createDesktopBuilderConfig(
  contract,
  { environment = process.env, argv = process.argv } = {},
) {
  const release = contract.release;
  const target = contract;
  const serverTarget = environment.RELAYER_DESKTOP_RUST_TARGET || target.rustTarget;
  const cargoTargetRoot = environment.RELAYER_CARGO_TARGET_DIR
    ? resolve(environment.RELAYER_CARGO_TARGET_DIR)
    : resolve(repositoryRoot, "target");
  if (!release && environment.CI === "true" && !argv.includes("--dir")) {
    throw new Error("Distributable desktop builds require the explicit signed release contract.");
  }

  return {
    appId: contract.appId,
    productName: contract.productName,
    electronVersion: "43.0.0",
    npmRebuild: false,
    asar: true,
    asarUnpack: ["node_modules/chrome-devtools-mcp/**/*"],
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
      "!**/{__fixtures__,__tests__,test,tests}/**/*",
      "!**/*.{fixture,spec,test}.{cjs,js,mjs}",
      "!node_modules/@openai/codex/package.json",
      "!node_modules/@openai/codex/**/*",
      "!node_modules/@openai/codex-darwin-*/**/*",
      "!node_modules/@openai/codex-linux-*/**/*",
      "!node_modules/@openai/codex-win32-*/**/*",
      "!node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
      "!node_modules/@earendil-works/**/{docs,examples}/**/*",
      "!node_modules/@earendil-works/**/{README,CHANGELOG}.md",
      "!node_modules/@earendil-works/**/*.d.ts",
      "!node_modules/@earendil-works/**/*.map",
      "!node_modules/@earendil-works/pi-coding-agent/postinstall.cjs",
      "!node_modules/@earendil-works/pi-ai/dist/providers/faux.*",
      "!main/providers/implementations/*.mjs",
      ...PACKAGED_PROVIDER_MODULES.map((modulePath) => `main/${modulePath}`),
    ],
    extraResources: [
      { from: resolve(cargoTargetRoot, `${serverTarget}/release/relayer-app-server${target.platform === "win32" ? ".exe" : ""}`), to: `bin/relayer-app-server${target.platform === "win32" ? ".exe" : ""}` },
      { from: resolve(cargoTargetRoot, `${serverTarget}/release/relayer-graph-server${target.platform === "win32" ? ".exe" : ""}`), to: `bin/relayer-graph-server${target.platform === "win32" ? ".exe" : ""}` },
      { from: resolve(repositoryRoot, "harnesses/codex-basic.yaml"), to: "harnesses/codex-basic.yaml" },
      { from: resolve(repositoryRoot, "harnesses/claude-basic.yaml"), to: "harnesses/claude-basic.yaml" },
      { from: resolve(repositoryRoot, "harnesses/prime-agent-basic.yaml"), to: "harnesses/prime-agent-basic.yaml" },
      { from: resolve(repositoryRoot, "harnesses/prime-agent-deep.yaml"), to: "harnesses/prime-agent-deep.yaml" },
      { from: resolve(repositoryRoot, "permissions/desktop.json"), to: "permissions/desktop.json" },
      { from: resolve(repositoryRoot, "packages/graph-client/dist"), to: "graph-client" },
      { from: resolve(repositoryRoot, "python/relayer-graph/src/relayer_graph"), to: "python/relayer-graph/src/relayer_graph", filter: ["**/*.py"] },
      { from: resolve(repositoryRoot, "vendor/prime-agent/manifest.json"), to: "prime-agent/manifest.json" },
      { from: resolve(desktopRoot, "renderer"), to: "renderer" },
    ],
    artifactName: `${release ? "Relayer" : "Relayer-DEV"}-\${version}-\${os}-\${arch}.\${ext}`,
    afterPack: "desktop/packaging/verify-bundled-app-server.mjs",
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
