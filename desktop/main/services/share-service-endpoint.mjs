import { developmentDesktopHost } from "../../shared/target.mjs";

export const PRODUCTION_SHARE_SERVICE_ENDPOINT = "https://share.relayerlabs.ai";

function parseOrigin(value, { allowLoopbackHttp = false } = {}) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new TypeError("Share service endpoint must be an absolute HTTPS or loopback URL.");
  }
  const loopback = url.protocol === "http:"
    && allowLoopbackHttp
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !loopback) {
    throw new TypeError("Share service endpoint must use HTTPS or loopback HTTP in development.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("Share service endpoint must be a credential-free origin without a path, query, or fragment.");
  }
  return url.origin;
}

export function resolveShareServiceEndpoint({
  isPackaged = true,
  packagedRelease,
  metadata,
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
} = {}) {
  // Stable promotion reuses the signed Preview bytes, including their channel
  // metadata. Both distributions must therefore carry the same service origin.
  if (["stable", "preview"].includes(packagedRelease?.channel)) return PRODUCTION_SHARE_SERVICE_ENDPOINT;
  if (isPackaged && metadata?.relayerArtifactMode === "development") {
    const target = developmentDesktopHost({ platform, architecture });
    if (
      metadata.relayerProductName === "Relayer Dev"
      && /^(?:0|[1-9]\d{0,31})\.(?:0|[1-9]\d{0,31})\.(?:0|[1-9]\d{0,31})$/.test(metadata.version || "")
      && metadata.relayerUpdateChannel === "development"
      && metadata.relayerUpdateBaseUrl === null
      && metadata.relayerReleaseTarget === target.key
      && metadata.relayerReleasePlatform === target.distributionPlatform
      && metadata.relayerReleaseArchitecture === target.architecture
    ) return PRODUCTION_SHARE_SERVICE_ENDPOINT;
  }
  if (isPackaged) throw new TypeError("Packaged desktop release metadata is invalid.");
  const developmentOverride = environment.RELAYER_SHARE_SERVICE_ENDPOINT;
  return developmentOverride
    ? parseOrigin(developmentOverride, { allowLoopbackHttp: true })
    : PRODUCTION_SHARE_SERVICE_ENDPOINT;
}
