import { publicState } from "../public-share-viewer/snapshot.js";

const THREAD_ID = "draft-preview";
const TURN_ID = "draft-preview-turn";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

/**
 * Turn the graph server's draft snapshot into the read model the public viewer
 * adapter drives. A node target becomes a one-node layer. The draft is shown
 * as the user would see it once accepted; nothing here is persisted.
 */
export function draftPreviewReadModel(input) {
  if (input?.version !== 1 || !Array.isArray(input.nodes) || !input.nodes.length) {
    throw new Error("Draft preview snapshot is invalid.");
  }
  // Present the draft as the user will see it once accepted, not as a draft.
  const accepted = (record) => ({ ...record, state: "accepted" });
  const nodes = input.nodes.map(accepted);
  const edges = (input.edges ?? []).map(accepted);
  const node = nodes[0];
  const layer = input.layer ? accepted(input.layer) : {
    id: `draft-preview-node-${node.id}`,
    nodes: [node.id],
    edges: [],
    defaultNodeId: node.id,
    layout: { version: 1, placements: [{ nodeId: node.id, x: 0.5, y: 0.5 }] },
    state: "accepted",
  };
  const rootLayer = { layer, nodes, edges, actions: [] };
  const thread = {
    id: THREAD_ID, title: "Draft preview", projectId: null, rootInteractionId: TURN_ID,
    harnessConfigurationName: "draft-preview", harnessId: "draft-preview", permissionProfileId: "auto",
    createdAt: CREATED_AT, updatedAt: CREATED_AT, imported: false, active: true,
  };
  const interaction = {
    id: TURN_ID, threadId: THREAD_ID, sequence: 1, text: "", createdAt: CREATED_AT, graphNodeId: null,
    origin: { kind: "user" }, contexts: [], submittedInputs: [], completionStatus: "accepted",
    harnessConfigurationName: "draft-preview", modelSelection: null, permissionProfileId: "auto",
    completionOutput: { nodeId: null, rootAction: null, rootLayer },
  };
  const assets = new Map((input.assets ?? []).map((asset) => [
    `${asset.id}\0${asset.digestSha256}\0${asset.mediaType}`, asset,
  ]));
  const snapshot = {
    thread,
    interactions: [interaction],
    projectName: null,
    header: {},
    state: null,
    layerFor: (_turnId, layerId) => (String(layerId) === String(layer.id) ? rootLayer : null),
    // Adapter hydration and navigation use the same accepted-only contract as
    // portable snapshots; a preview never grants callable action authority.
    actionsForLayer: (resolved) => (resolved?.actions ?? []).filter((action) => action.state === "accepted"),
    invokeDestinationTurnId: () => null,
    async resolveNodeDetailAsset(asset) {
      const content = assets.get(`${asset?.id}\0${asset?.digestSha256}\0${asset?.mediaType}`);
      if (!content) throw new Error("Visual asset is not part of this draft preview.");
      const bytes = Uint8Array.from(atob(content.contentBase64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: content.mediaType }));
      return Object.freeze({ url, digestSha256: content.digestSha256, mediaType: content.mediaType, release: () => URL.revokeObjectURL(url) });
    },
  };
  snapshot.state = publicState(snapshot);
  return snapshot;
}
