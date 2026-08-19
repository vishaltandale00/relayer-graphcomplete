import { desktopTargetByKey } from "./target.mjs";

export const DESKTOP_UPDATE_BASE_URL = "https://updates.relayerlabs.ai/desktop/macos/arm64";

export const DESKTOP_UPDATE_BASE_URLS = Object.freeze({
  "macos-arm64": DESKTOP_UPDATE_BASE_URL,
  "macos-x64": "https://updates.relayerlabs.ai/desktop/macos/x64",
  "windows-x64": "https://updates.relayerlabs.ai/desktop/windows/x64",
});

export function packagedDesktopReleaseMetadata(
  metadata,
  { platform = process.platform, architecture = process.arch } = {},
) {
  if (metadata?.relayerArtifactMode !== "release") return null;
  if (metadata.relayerUpdateChannel !== "stable" && metadata.relayerUpdateChannel !== "preview") return null;
  const targetKey = String(metadata.relayerReleaseTarget || "");
  if (!DESKTOP_UPDATE_BASE_URLS[targetKey]) return null;
  if (metadata.relayerUpdateBaseUrl !== DESKTOP_UPDATE_BASE_URLS[targetKey]) return null;
  const target = desktopTargetByKey(targetKey);
  if (metadata.relayerReleasePlatform !== target.distributionPlatform) return null;
  if (metadata.relayerReleaseArchitecture !== target.architecture) return null;
  if (platform !== target.platform || architecture !== target.architecture) return null;
  return Object.freeze({
    channel: metadata.relayerUpdateChannel,
    updateBaseUrl: metadata.relayerUpdateBaseUrl,
    targetKey,
  });
}
