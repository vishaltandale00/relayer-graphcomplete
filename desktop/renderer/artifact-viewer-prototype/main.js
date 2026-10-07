// PROTOTYPE — throwaway (issue #684). Mounts the real ProductWorkspace on a fixture
// thread and adds the full-screen artifact viewer on top. Layers whose renderer is
// "artifact" open in the viewer instead of the graph canvas.
import { createProductWorkspace, loadDesignFonts } from "../src/product-workspace/index.js";
import { createPublicViewerAdapter } from "../src/public-share-viewer/adapter.js";
import { parsePublicSnapshot } from "../src/public-share-viewer/snapshot.js";
import { createArtifactViewer } from "./viewer.js";
import { createDrafts } from "./drafts.js";
import { mountSwitcher, currentVariant, currentAnnotateMode } from "./switcher.js";
import { mountStatePanel } from "./state-panel.js";

const params = new URLSearchParams(location.search);
const surface = ["share", "eval"].includes(params.get("surface")) ? params.get("surface") : "product";
const variant = currentVariant();
const annotateMode = currentAnnotateMode();
document.body.dataset.surface = surface;
document.body.dataset.variant = variant;

const [config, snapshotText] = await Promise.all([
  fetch("/proto/config").then((response) => response.json()),
  fetch("/proto/snapshot.jsonl").then((response) => response.text()),
]);
const snapshot = parsePublicSnapshot(snapshotText);
const adapter = createPublicViewerAdapter(snapshot);
const drafts = createDrafts();
const sent = [];

function layerFor(layerId) {
  for (const interaction of adapter.state.interactions) {
    const layer = snapshot.layerFor(interaction.id, layerId);
    if (layer) return layer;
  }
  return null;
}

let workspace;
const host = document.querySelector("#workspaceHost");
const render = () => {
  workspace.render();
  mirrorDraftsIntoComposer();
};

// The stand-in for Complete: a sent interaction becomes a new accepted turn whose
// interaction node refers to the artifact node and carries the annotations (D8, D40).
function appendInteraction({ text, annotations }) {
  const sequence = adapter.state.interactions.length + 1;
  const turnId = `turn:${sequence}`;
  const interactionNodeId = `node:interaction-${sequence}`;
  const layerId = `layer:feedback-${sequence}`;
  const byArtifact = new Map();
  for (const annotation of annotations) {
    if (!byArtifact.has(annotation.nodeId)) byArtifact.set(annotation.nodeId, []);
    byArtifact.get(annotation.nodeId).push(annotation);
  }
  const contexts = [...byArtifact].map(([nodeId, items], index) => {
    const artifactLayer = layerFor(items[0].layerId);
    return {
      id: `context:${sequence}-${index}`,
      target: { nodeId, sourceInteractionNodeId: "node:interaction-1", sourceLayerId: items[0].layerId },
      targetNode: structuredClone(artifactLayer.nodes[0]),
      annotations: items.map((item) => ({ id: item.id, comment: item.text, location: item.location, screenshot: item.screenshot ? "(image attached)" : null })),
    };
  });
  const lines = annotations.map((item, index) => `${index + 1}. **${item.nodeTitle}** — ${item.location}: ${item.text || "(no note)"}`);
  const responseNode = {
    id: `node:feedback-${sequence}`, kind: "concept", icon: "sparkles", state: "accepted",
    title: annotations.length ? `${annotations.length} annotation${annotations.length === 1 ? "" : "s"} received` : "Message received",
    detail: `*Prototype stand-in for the agent's next response. In the product, Complete runs here.*\n\n**Your message:** ${text || "(none)"}\n\n${lines.join("\n")}\n\nScreenshots travel with the interaction node — the real interaction node has no image field yet (issue #684, D40).`,
  };
  const rootLayer = {
    layer: { id: layerId, nodes: [responseNode.id], edges: [], layout: { version: 1, placements: [{ nodeId: responseNode.id, x: 0.5, y: 0.5 }] }, state: "accepted" },
    nodes: [responseNode], edges: [], actions: [],
  };
  const interaction = {
    id: turnId, threadId: adapter.thread.id, sequence, text: text || "(annotations only)", createdAt: new Date().toISOString(),
    graphNodeId: interactionNodeId, origin: { kind: "user" }, contexts, submittedInputs: [],
    completionStatus: "accepted", harnessConfigurationName: "prototype-fixture", modelSelection: null, permissionProfileId: "auto",
    completionOutput: {
      nodeId: interactionNodeId,
      rootAction: { id: `action:response-${sequence}`, sourceNodeId: interactionNodeId, sourceLayerId: null, kind: "navigate", relation: "expand", label: "Response", variant: "pill", targetLayerId: layerId, state: "accepted" },
      rootLayer,
    },
  };
  adapter.state.interactions.push(interaction);
  sent.push({ turnId, interactionNode: { id: interactionNodeId, text: interaction.text, contexts, annotations } });
  adapter.selectTurnById(turnId, { responseRoot: true });
  render();
  return interaction;
}

const viewer = createArtifactViewer({
  root: document.querySelector("#artifactViewerRoot"),
  config,
  surface,
  variant,
  annotateMode,
  drafts,
  layerFor,
  onNavigateGraph: async (layerId, navigation) => {
    const changed = await adapter.navigateLayer(layerId, navigation);
    if (changed) render();
  },
  onSend: ({ text, annotations }) => appendInteraction({ text, annotations }),
  onClose: () => render(),
});

workspace = createProductWorkspace({
  root: host,
  mode: surface === "product" ? "interactive" : "review",
  getState: () => adapter.state,
  getThread: () => adapter.thread,
  selection: adapter.selection,
  layerSelectionMemoryOwner: {},
  showThread: () => {},
  showEmpty: () => {},
  getNavigationHistory: () => ({ canGoBack: false, canGoForward: false }),
  onNavigateHistory: async () => false,
  onSelectTurn: (delta) => { if (adapter.selectTurn(delta)) render(); },
  onSelectTurnById: (turnId, navigation) => { if (adapter.selectTurnById(turnId, navigation)) render(); },
  onSelectionChange: (nodeId) => { adapter.selection.selectedNodeId = nodeId; },
  onSubmitInteraction: async (text) => {
    // The main thread composer sends the shared draft too, so chips added in the
    // viewer go out from here when the user leaves the viewer first (variant C).
    appendInteraction({ text, annotations: drafts.take() });
  },
  onNavigateLayer: async (layerId, navigation) => {
    const target = layerFor(layerId);
    if (target?.layer?.renderer === "artifact") {
      viewer.open(target, { via: navigation?.action?.label });
      return false;
    }
    const changed = await adapter.navigateLayer(layerId, navigation);
    if (changed) render();
    return changed;
  },
  onNavigateResolvedInvoke: async () => false,
  onInvokeAction: async () => false,
  resolveNodeDetailAsset: (asset) => snapshot.resolveNodeDetailAsset(asset),
  onDecideApproval: async () => false,
  annotationApi: null,
  contextDraftApi: null,
  inputDraftApi: null,
  inputOperatorAvailable: false,
});

// One shared draft (D27): chips added in the viewer also sit above the thread composer.
function mirrorDraftsIntoComposer() {
  const composer = host.querySelector("#threadComposer");
  if (!composer) return;
  let tray = host.querySelector(".av-main-tray");
  if (!tray) {
    tray = document.createElement("div");
    tray.className = "av-main-tray";
    composer.before(tray);
  }
  const items = drafts.list();
  tray.hidden = items.length === 0;
  tray.replaceChildren(...items.map((item) => {
    const chip = document.createElement("span");
    chip.className = "av-chip";
    chip.title = `${item.nodeTitle} · ${item.location}\n${item.text}`;
    if (item.screenshot) {
      const img = document.createElement("img");
      img.src = item.screenshot;
      img.alt = "";
      chip.append(img);
    }
    const label = document.createElement("span");
    label.textContent = `${item.nodeTitle} · ${item.location}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remove annotation");
    remove.onclick = () => drafts.remove(item.id);
    chip.append(label, remove);
    return chip;
  }));
}
drafts.subscribe(() => mirrorDraftsIntoComposer());

await loadDesignFonts(document).catch(() => {});
render();
mountSwitcher({ variant, annotateMode, surface });
mountStatePanel(() => ({
  surface,
  variant,
  annotateMode,
  viewer: viewer.state(),
  drafts: drafts.list().map(({ screenshot, ...rest }) => ({ ...rest, screenshot: screenshot ? `${screenshot.slice(0, 40)}…` : null })),
  sentInteractions: sent.map((entry) => ({ ...entry, interactionNode: { ...entry.interactionNode, annotations: entry.interactionNode.annotations.map(({ screenshot, ...rest }) => ({ ...rest, screenshot: screenshot ? "(jpeg data URL)" : null })) } })),
  processesEndpoint: "/proto/processes",
}));

const openLayer = params.get("open");
if (openLayer) {
  const target = layerFor(openLayer);
  if (target) viewer.open(target, { via: "matrix link" });
}
window.__prototype = { adapter, viewer, drafts, render, layerFor };
