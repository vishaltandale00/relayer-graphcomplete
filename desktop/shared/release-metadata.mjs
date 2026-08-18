export const DESKTOP_UPDATE_BASE_URL = "https://updates.relayerlabs.ai/desktop/macos/arm64";

export function packagedDesktopReleaseMetadata(metadata) {
  if (metadata?.relayerArtifactMode !== "release") return null;
  if (metadata.relayerUpdateChannel !== "stable" && metadata.relayerUpdateChannel !== "preview") return null;
  if (metadata.relayerUpdateBaseUrl !== DESKTOP_UPDATE_BASE_URL) return null;
  return Object.freeze({
    channel: metadata.relayerUpdateChannel,
    updateBaseUrl: metadata.relayerUpdateBaseUrl,
  });
}
