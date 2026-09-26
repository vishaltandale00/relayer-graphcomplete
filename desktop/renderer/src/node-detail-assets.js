import { request } from "./api.js";

const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/svg+xml"]);
const MAX_BYTES = 8 * 1024 * 1024;

// Bytes are addressed through an accepted node, never by a catalog ID or digest alone.
export async function resolveAcceptedNodeDetailAsset(asset, context, dependencies = {}) {
  const { threadId, interactionId, nodeId, layerId } = context;
  if ([threadId, interactionId, nodeId, layerId].some((id) => !/^[1-9]\d*$/.test(String(id)))
    || !asset?.id || !/^[a-f0-9]{64}$/.test(asset.digestSha256)
    || !MEDIA_TYPES.has(asset.mediaType)) {
    throw new Error("Visual asset context is invalid.");
  }
  const read = dependencies.request ?? request;
  const response = await read(`/api/threads/${threadId}/interactions/${interactionId}/nodes/${nodeId}/detail-assets/${encodeURIComponent(asset.id)}?layerId=${layerId}`);
  const encoded = response?.contentBase64;
  if (response?.assetId !== asset.id || response.digestSha256 !== asset.digestSha256
    || response.mediaType !== asset.mediaType
    || !Number.isSafeInteger(response.byteLength) || response.byteLength < 1 || response.byteLength > MAX_BYTES
    || typeof encoded !== "string" || encoded.length !== 4 * Math.ceil(response.byteLength / 3)
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("Visual asset bytes do not match the accepted package.");
  }
  const decoded = atob(encoded);
  if (decoded.length !== response.byteLength || btoa(decoded) !== encoded) throw new Error("Visual asset length mismatch.");
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  const digest = await (dependencies.crypto ?? globalThis.crypto).subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hex !== asset.digestSha256) throw new Error("Visual asset digest mismatch.");
  const urls = dependencies.URL ?? URL;
  const url = urls.createObjectURL(new Blob([bytes], { type: asset.mediaType }));
  let released = false;
  return {
    url, digestSha256: hex, mediaType: asset.mediaType,
    release() {
      if (!released) urls.revokeObjectURL(url);
      released = true;
    },
  };
}
