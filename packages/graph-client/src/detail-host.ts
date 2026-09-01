import type { CompiledNodeDetail, NodeDetailAuthoring } from "./detail.js";

export interface HostResolvedDetailAsset {
  readonly logicalId: string;
  readonly authority: "current" | "stale";
  readonly availability: "available" | "unavailable" | "revoked";
  readonly digestSha256: string;
  readonly mediaType: string;
  readonly representation: { readonly kind: "image"; readonly sanitized: boolean };
}

interface HostDetailAccess {
  bindOwner(clientKey: string): void;
  assetIds(): readonly string[];
  checkpoint(assets: readonly (HostResolvedDetailAsset | null)[], finalize: boolean): CompiledNodeDetail;
  finalized(): CompiledNodeDetail | undefined;
}

const HOST_DETAIL_ACCESS = new WeakMap<NodeDetailAuthoring, HostDetailAccess>();

export function registerDetailHostAccess(authoring: NodeDetailAuthoring, access: HostDetailAccess): void {
  HOST_DETAIL_ACCESS.set(authoring, access);
}

export function bindDetailOwner(authoring: NodeDetailAuthoring, clientKey: string): void {
  hostDetail(authoring).bindOwner(clientKey);
}

function hostDetail(authoring: NodeDetailAuthoring): HostDetailAccess {
  const access = HOST_DETAIL_ACCESS.get(authoring);
  if (access === undefined) throw new TypeError("Node Detail authoring was not created by this graph-client host");
  return access;
}

export function detailAssetIds(authoring: NodeDetailAuthoring): readonly string[] {
  return hostDetail(authoring).assetIds();
}

export function checkpointWithHostAssets(
  authoring: NodeDetailAuthoring,
  assets: readonly (HostResolvedDetailAsset | null)[],
): CompiledNodeDetail {
  return hostDetail(authoring).checkpoint(assets, false);
}

export function finalizeWithHostAssets(
  authoring: NodeDetailAuthoring,
  assets: readonly (HostResolvedDetailAsset | null)[],
): CompiledNodeDetail {
  return hostDetail(authoring).checkpoint(assets, true);
}

export function finalizedDetail(authoring: NodeDetailAuthoring): CompiledNodeDetail | undefined {
  return hostDetail(authoring).finalized();
}
