import { resolve } from "node:path";

const desktopRoot = resolve(import.meta.dirname, "..");
const release = process.env.RELAYER_DESKTOP_RELEASE === "1";
const updateChannel = process.env.RELAYER_DESKTOP_CHANNEL === "preview" ? "beta" : "latest";

if (!release && process.env.CI === "true" && !process.argv.includes("--dir")) {
  throw new Error("Distributable desktop builds require RELAYER_DESKTOP_RELEASE=1 and signing credentials.");
}

export default {
  appId: release ? "ai.relayer.desktop" : "ai.relayer.desktop.development",
  productName: release ? "Relayer" : "Relayer Dev",
  electronVersion: "43.0.0",
  npmRebuild: false,
  asar: true,
  forceCodeSigning: release,
  directories: { app: desktopRoot, output: resolve(desktopRoot, "dist") },
  extraMetadata: {
    main: "main/index.mjs",
    relayerProductName: release ? "Relayer" : "Relayer Dev",
    relayerUpdateChannel: release ? updateChannel : "development",
  },
  files: [
    "**/*",
    "!dist/**/*",
    "!packaging/**/*",
  ],
  artifactName: `${release ? "Relayer" : "Relayer-DEV"}-\${version}-mac-\${arch}.\${ext}`,
  mac: {
    category: "public.app-category.developer-tools",
    icon: resolve(desktopRoot, "renderer/assets/relayer-logo.svg"),
    target: [{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] }],
    identity: release ? undefined : null,
    hardenedRuntime: release,
    entitlements: resolve(import.meta.dirname, "macos/entitlements.mac.plist"),
    entitlementsInherit: resolve(import.meta.dirname, "macos/entitlements.mac.inherit.plist"),
    notarize: release,
  },
  publish: release ? [{ provider: "generic", url: process.env.RELAYER_DESKTOP_UPDATE_BASE_URL || "https://updates.relayerlabs.ai/desktop/macos/arm64", channel: updateChannel }] : undefined,
};
