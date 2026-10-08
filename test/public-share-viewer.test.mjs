import { beforeEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { spawnSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";

import { interactionGraph } from "../desktop/renderer/src/product-workspace/interaction-graph.js";
import { createPublicViewerAdapter } from "../desktop/renderer/src/public-share-viewer/adapter.js";
import { compiledNodeDetailCoversActions, resolveCompiledNodeDetailAction } from "../desktop/renderer/src/product-workspace/workspace.js";
import {
  bootPublicViewer,
  fitPublicTurnPopover,
  observeEmbedInspectorLayout,
  configureEmbedReading,
} from "../desktop/renderer/src/public-share-viewer/main.js";
import {
  parsePublicSnapshot,
  PublicSnapshotError,
} from "../desktop/renderer/src/public-share-viewer/snapshot.js";
import {
  publicViewerCsp,
  renderPublicViewerTemplate,
} from "../desktop/renderer/src/public-share-viewer/template.js";

function layer(id, nodeId, actions = [], { layout = true } = {}) {
  return {
    layer: {
      id,
      nodes: [nodeId],
      edges: [],
      ...(layout ? { layout: { version: 1, placements: [{ nodeId, x: .5, y: .5 }] } } : {}),
      state: "accepted",
    },
    nodes: [{
      id: nodeId,
      kind: "concept",
      icon: "box",
      title: `Node ${nodeId}`,
      detail: `Details for ${nodeId}`,
      state: "accepted",
    }],
    edges: [],
    actions,
  };
}

function action(id, sourceNodeId, targetLayerId, relation, sourceLayerId) {
  return {
    id,
    sourceNodeId,
    sourceLayerId,
    kind: "navigate",
    relation,
    label: relation === "expand" ? "Open nested layer" : "See related layer",
    variant: "pill",
    targetLayerId,
    state: "accepted",
  };
}

function fixtureJsonl({ status = "accepted", includeFailedTurn = false } = {}) {
  const rootAction = {
    id: "action:root",
    sourceNodeId: "node:interaction",
    kind: "navigate",
    relation: "expand",
    label: "Show response",
    variant: "pill",
    targetLayerId: "layer:root",
    state: "accepted",
  };
  const root = layer("layer:root", "node:root", [
    action("action:expand", "node:root", "layer:nested", "expand", "layer:root"),
  ]);
  const nested = layer("layer:nested", "node:nested", [
    action("action:reference", "node:nested", "layer:related", "reference", "layer:nested"),
  ]);
  const related = layer("layer:related", "node:related", [
    action("action:cycle", "node:related", "layer:related", "reference", "layer:related"),
  ]);
  const accepted = {
    recordType: "turn",
    id: "turn:1",
    sequence: 1,
    createdAt: "2026-09-25T00:00:00Z",
    text: "Map the fixture",
    interactionNodeId: "node:interaction",
    origin: { kind: "user" },
    completion: {
      status,
      permissionProfileId: "auto",
      harnessConfigurationName: "fixture",
      modelSelection: { providerId: "fixture", modelId: "fixture-model", modelFamilyId: 1 },
      error: "provider details must not enter the viewer model",
      attemptAdmissionId: "admission:private",
    },
    contexts: [],
    submittedInputs: [],
    acceptedView: status === "accepted" ? {
      interactionNodeId: "node:interaction",
      rootAction,
      rootLayerId: "layer:root",
      layers: [root, nested, related],
    } : null,
  };
  const records = [{
    recordType: "header",
    exportVersion: 1,
    exportedAt: "2026-09-25T00:00:00Z",
    producer: { desktopVersion: "fixture", buildCommit: "fixture", platform: "darwin", architecture: "arm64" },
    conversation: {
      id: "conversation:fixture",
      title: "Fixture conversation",
      createdAt: "2026-09-25T00:00:00Z",
      projectName: "fixture-project",
      harnessConfigurationName: "fixture",
      permissionProfileId: "auto",
    },
    turns: [{ id: "turn:1", sequence: 1 }],
  }, accepted];
  if (includeFailedTurn) {
    records[0].turns.push({ id: "turn:2", sequence: 2 });
    records.push({
      ...accepted,
      id: "turn:2",
      sequence: 2,
      text: "Failed turn",
      completion: { status: "failed", permissionProfileId: "auto", error: "private error" },
      acceptedView: null,
    });
  }
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function recordsJsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function invokeFixtureRecords() {
  const records = fixtureJsonl().trimEnd().split("\n").map(JSON.parse);
  const source = records[1];
  source.acceptedView.layers[0].actions.push({
    id: "action:invoke", sourceNodeId: "node:root", sourceLayerId: "layer:root",
    kind: "invoke", interactionText: "Continue", label: "Open accepted result", variant: "pill", state: "accepted",
  }, {
    id: "action:input", sourceNodeId: "node:root", sourceLayerId: "layer:root",
    kind: "input", label: "Choose a path", variant: "pill", state: "accepted",
    input: { control: "single_select", prompt: "Which path?", options: [{ key: "a", label: "Path A" }, { key: "b", label: "Path B" }] },
  });
  records[0].turns.push({ id: "turn:2", sequence: 2 });
  records.push({
    ...source, id: "turn:2", sequence: 2, interactionNodeId: "node:child-interaction",
    origin: { kind: "action", source_turn_id: "turn:1", source_action_id: "action:invoke" },
    acceptedView: {
      interactionNodeId: "node:child-interaction", rootLayerId: "layer:child",
      rootAction: action("action:child-root", "node:child-interaction", "layer:child", "expand"),
      layers: [layer("layer:child", "node:child")],
    },
  });
  return records;
}

function assetFixtureJsonl(bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1"/></svg>')) {
  const records = fixtureJsonl().trimEnd().split("\n").map((line) => JSON.parse(line));
  const digestSha256 = createHash("sha256").update(bytes).digest("hex");
  const asset = { id: "public-image", digestSha256, mediaType: "image/svg+xml", representation: "image" };
  const detail = {
    version: 1,
    components: [{ id: "image", order: 0, html: '<img alt="Published illustration" data-asset-mount="image">', css: "" }],
    mounts: [{ id: "image", componentId: "image", kind: "asset", host: "img", assetId: asset.id }],
    assets: [asset],
  };
  detail.integritySha256 = createHash("sha256").update(canonicalJson(detail)).digest("hex");
  records[0].exportVersion = 2;
  records[1].acceptedView.layers[0].nodes[0].authoredDetail = detail;
  records[1].acceptedView.layers[0].nodes[0].authoredDetailAssets = [{
    assetId: asset.id,
    digestSha256,
    mediaType: asset.mediaType,
    byteLength: bytes.length,
    provenance: { source: "user", fileName: "illustration.svg" },
  }];
  records.splice(1, 0, {
    recordType: "visualAssetContent",
    digestSha256,
    mediaType: asset.mediaType,
    byteLength: bytes.length,
    contentBase64: bytes.toString("base64"),
  });
  return { jsonl: `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, asset };
}

describe("public share V1 reader", () => {
  it("rejects bytes above the frozen 16 MiB share contract before parsing", () => {
    try {
      parsePublicSnapshot(new Uint8Array((16 * 1024 * 1024) + 1));
      expect.fail("expected the oversized snapshot to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(PublicSnapshotError);
      expect(error.code).toBe("file_too_large");
    }
  });

  it("validates the existing header/turn contract and exposes only accepted turns", () => {
    const snapshot = parsePublicSnapshot(fixtureJsonl({ includeFailedTurn: true }));
    expect(snapshot.interactions).toHaveLength(1);
    expect(snapshot.interactions[0].completionStatus).toBe("accepted");
    expect(snapshot.interactions[0].completionError).toBeUndefined();
    expect(snapshot.turns[0].completion.error).toBeUndefined();
    expect(snapshot.turns[0].completion.attemptAdmissionId).toBeUndefined();
    expect(snapshot.interactions[0].completionOutput.rootLayer.layer.id).toBe("layer:root");
    expect(snapshot.thread.projectId).toBe("export:project");
    expect(snapshot.state.environment.snapshot.worktreeLabel).toBe("fixture-project");
    expect(snapshot.layerFor("turn:1", "layer:related").nodes[0].id).toBe("node:related");
    expect(snapshot.turnContainingLayer("layer:nested").id).toBe("turn:1");
  });

  it("preserves valid default nodes and rejects defaults outside the public layer", () => {
    const records = fixtureJsonl().trim().split("\n").map(JSON.parse);
    const root = records[1].acceptedView.layers[0];
    root.layer.defaultNodeId = root.nodes[0].id;
    expect(parsePublicSnapshot(recordsJsonl(records)).state.visibleLayer.layer.defaultNodeId).toBe(root.nodes[0].id);
    root.layer.defaultNodeId = "node:nested";
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "default_node_outside_layer" }));
  });

  it("reads asset-bearing V2 bytes and resolves only the node's pinned visual content", async () => {
    const { jsonl, asset } = assetFixtureJsonl();
    const snapshot = parsePublicSnapshot(jsonl);
    const createObjectURL = vi.fn(() => "blob:https://share.example.test/public-image");
    const revokeObjectURL = vi.fn();
    const resolved = await snapshot.resolveNodeDetailAsset(asset, {
      crypto: webcrypto,
      URL: { createObjectURL, revokeObjectURL },
      Blob,
    });
    expect(snapshot.header.exportVersion).toBe(2);
    expect(resolved).toMatchObject({
      url: "blob:https://share.example.test/public-image",
      digestSha256: asset.digestSha256,
      mediaType: asset.mediaType,
    });
    expect(createObjectURL).toHaveBeenCalledOnce();
    resolved.release();
    expect(revokeObjectURL).toHaveBeenCalledWith(resolved.url);
    await expect(snapshot.resolveNodeDetailAsset({ ...asset, id: "not-pinned" })).rejects.toThrow();

    const records = jsonl.trimEnd().split("\n").map((line) => JSON.parse(line));
    records[1].contentBase64 = Buffer.alloc(records[1].byteLength, 65).toString("base64");
    const tampered = parsePublicSnapshot(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    await expect(tampered.resolveNodeDetailAsset(asset, {
      crypto: webcrypto,
      URL: { createObjectURL, revokeObjectURL },
      Blob,
    })).rejects.toThrow("digest mismatch");
  });

  it("preserves node and source-owned action image icons without a Detail and rejects absent pins", async () => {
    const { jsonl, asset } = assetFixtureJsonl();
    const records = jsonl.trimEnd().split("\n").map(JSON.parse);
    const turn = records.find(record => record.recordType === "turn");
    const root = turn.acceptedView.layers[0];
    const node = root.nodes[0];
    delete node.authoredDetail;
    node.icon = { kind: "image", assetId: asset.id, digestSha256: asset.digestSha256, mediaType: asset.mediaType };
    root.actions[0].icon = { ...node.icon, fit: "cover", framing: "rounded" };
    const encode = () => records.map(JSON.stringify).join("\n") + "\n";
    const snapshot = parsePublicSnapshot(encode());
    expect(snapshot.interactions[0].completionOutput.rootLayer.nodes[0].icon).toEqual(node.icon);
    const resolved = await snapshot.resolveNodeDetailAsset(asset, { crypto: webcrypto, URL: { createObjectURL: () => "blob:icon", revokeObjectURL: vi.fn() }, Blob });
    expect(resolved.url).toBe("blob:icon");
    resolved.release();
    node.authoredDetailAssets = [];
    expect(() => parsePublicSnapshot(encode())).toThrow(/inventory/);
  });

  it("carries a response-action image independently of visible node assets", async () => {
    const { jsonl, asset } = assetFixtureJsonl();
    const records = jsonl.trimEnd().split("\n").map(JSON.parse);
    const turn = records.find(record => record.recordType === "turn");
    const node = turn.acceptedView.layers[0].nodes[0];
    const association = node.authoredDetailAssets[0];
    delete node.authoredDetail;
    delete node.authoredDetailAssets;
    turn.acceptedView.rootAction.icon = { kind: "image", assetId: asset.id, digestSha256: asset.digestSha256, mediaType: asset.mediaType };
    turn.acceptedView.rootAction.iconAsset = association;
    const encode = () => records.map(JSON.stringify).join("\n") + "\n";
    expect(parsePublicSnapshot(encode()).assetContents).toHaveLength(1);
    delete turn.acceptedView.rootAction.iconAsset;
    expect(() => parsePublicSnapshot(encode())).toThrow(/association/);
  });

  it("resolves an external context icon whose node is absent from visible layers", () => {
    const { jsonl, asset } = assetFixtureJsonl();
    const records = jsonl.trimEnd().split("\n").map(JSON.parse);
    const turn = records.find(record => record.recordType === "turn");
    const node = turn.acceptedView.layers[0].nodes[0];
    const association = node.authoredDetailAssets[0];
    delete node.authoredDetail;
    delete node.authoredDetailAssets;
    turn.contexts = [{ id: "action:context", annotation: "Marine context", source: { interactionNodeId: "node:external-owner", layerId: "layer:external" }, target: {
      id: "node:external", kind: "concept", title: "Coral", detail: "A reef organism", state: "accepted",
      icon: { kind: "image", assetId: asset.id, digestSha256: asset.digestSha256, mediaType: asset.mediaType }, iconAsset: association,
    } }];
    const encode = () => records.map(JSON.stringify).join("\n") + "\n";
    expect(parsePublicSnapshot(encode()).assetContents).toHaveLength(1);
    delete turn.contexts[0].target.iconAsset;
    expect(() => parsePublicSnapshot(encode())).toThrow(/association/);
  });

  it("accepts encoded visual content above the generic string ceiling when decoded bytes remain within the 8 MiB asset limit", () => {
    const bytes = Buffer.alloc(4_540_000, 65);
    const { jsonl } = assetFixtureJsonl(bytes);
    expect(Buffer.byteLength(jsonl)).toBeLessThan(16 * 1024 * 1024);
    expect(() => parsePublicSnapshot(jsonl)).not.toThrow();
  });

  it("preserves nested navigation and reference cycles without granting execution authority", async () => {
    const records = fixtureJsonl().trimEnd().split("\n").map(JSON.parse);
    records[1].acceptedView.rootAction.label = "Chat or graph?";
    records[1].acceptedView.rootAction.icon = "columns-3";
    const adapter = createPublicViewerAdapter(parsePublicSnapshot(recordsJsonl(records)));
    expect(adapter.readOnly).toBe(true);
    expect(adapter.state.visibleLayer.layer.id).toBe("layer:root");
    expect(adapter.selection.layerPath[0]).toMatchObject({ label: "Chat or graph?", icon: "columns-3" });
    await expect(adapter.navigateLayer("layer:nested", {
      action: adapter.state.actions[0],
      sourceNode: adapter.state.nodes[0],
    })).resolves.toBe(true);
    expect(adapter.state.visibleLayer.layer.id).toBe("layer:nested");
    expect(adapter.selection.layerPath.map(({ layerId }) => layerId)).toEqual(["layer:root", "layer:nested"]);
    await expect(adapter.navigateLayer("layer:related", {
      action: adapter.state.actions[0],
      sourceNode: adapter.state.nodes[0],
    })).resolves.toBe(true);
    expect(adapter.state.visibleLayer.layer.id).toBe("layer:related");
    for (let index = 0; index < 20; index += 1) {
      await adapter.navigateLayer("layer:related", { action: adapter.state.actions[0], sourceNode: adapter.state.nodes[0] });
    }
    expect(adapter.selection.layerPath.map(({ layerId }) => layerId)).toEqual(["layer:root", "layer:nested", "layer:related"]);
    expect(adapter.selection.layerPath[0]).toMatchObject({ label: "Chat or graph?", icon: "columns-3" });
    await expect(adapter.onInvokeAction({ kind: "invoke" })).resolves.toBe(false);
    await expect(adapter.onSubmitInteraction("mutate")).resolves.toBe(false);
  });

  it("collapses a two-layer reference cycle to its existing breadcrumb", async () => {
    const records = fixtureJsonl().trimEnd().split("\n").map(JSON.parse);
    records[1].acceptedView.layers[2].actions = [action("action:cycle", "node:related", "layer:other", "reference", "layer:related")];
    records[1].acceptedView.layers.push(layer("layer:other", "node:other", [action("action:back", "node:other", "layer:related", "reference", "layer:other")]));
    const adapter = createPublicViewerAdapter(parsePublicSnapshot(recordsJsonl(records)));
    for (let index = 0; index < 20; index += 1) {
      await adapter.navigateLayer(adapter.state.actions[0].targetLayerId, { action: adapter.state.actions[0], sourceNode: adapter.state.nodes[0] });
      expect(adapter.selection.layerPath.length).toBeLessThanOrEqual(4);
    }
    expect(adapter.selection.layerPath.map(({ layerId }) => layerId)).toEqual(["layer:root", "layer:nested", "layer:related"]);
  });

  it("reads the declared 10,000-layer expansion depth and rejects a closing expand cycle", () => {
    const records = fixtureJsonl().trimEnd().split("\n").map(JSON.parse);
    const view = records[1].acceptedView;
    view.rootLayerId = "layer:0";
    view.rootAction.targetLayerId = "layer:0";
    view.layers = Array.from({ length: 10_000 }, (_, index) => layer(`layer:${index}`, `node:${index}`, index < 9_999 ? [
      action(`action:${index}`, `node:${index}`, `layer:${index + 1}`, "expand", `layer:${index}`),
    ] : []));
    expect(parsePublicSnapshot(recordsJsonl(records)).layersByTurn.get("turn:1").size).toBe(10_000);
    view.layers.at(-1).actions.push(action("action:last", "node:9999", "layer:0", "expand", "layer:9999"));
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "expand_cycle" }));
  });

  it.each(["draft", "stopped", undefined])("rejects %s root and layer action state", (state) => {
    for (const root of [true, false]) {
      const records = fixtureJsonl().trimEnd().split("\n").map(JSON.parse);
      const view = records[1].acceptedView;
      (root ? view.rootAction : view.layers[0].actions[0]).state = state;
      expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(PublicSnapshotError);
    }
  });

  it.each(["snake", "camel"])("rehydrates %s accepted invoke origins without changing the exported authored shape", async (naming) => {
    const records = invokeFixtureRecords();
    if (naming === "camel") records[2].origin = { kind: "action", sourceTurnId: "turn:1", sourceActionId: "action:invoke" };
    const snapshot = parsePublicSnapshot(recordsJsonl(records));
    const adapter = createPublicViewerAdapter(snapshot);
    const invoke = adapter.state.actions.find((item) => item.kind === "invoke");
    expect(invoke.targetLayerId).toBe("layer:child");
    expect(snapshot.turns[0].acceptedView.layers[0].actions.find((item) => item.kind === "invoke").targetLayerId).toBeUndefined();
    expect(snapshot.layerFor("turn:1", "layer:root").actions.find((item) => item.kind === "invoke")).toBe(invoke);
    await expect(adapter.navigateResolvedInvoke(invoke)).resolves.toBe(true);
    expect(adapter.state.visibleLayer.layer.id).toBe("layer:child");
    expect(adapter.selection.currentInteractionId).toBe("turn:2");
    records[2].origin = { kind: "action", sourceTurnId: "turn:1", sourceActionId: "action:expand" };
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "invoke_origin_invalid" }));
  });

  it("leaves failed invoke results inert and rejects conflicting accepted resolutions", () => {
    const records = invokeFixtureRecords();
    const acceptedChild = structuredClone(records[2]);
    records[2].completion = { status: "failed", permissionProfileId: "auto" };
    records[2].acceptedView = null;
    const snapshot = parsePublicSnapshot(recordsJsonl(records));
    expect(snapshot.interactions).toHaveLength(1);
    expect(snapshot.state.actions.find((item) => item.kind === "invoke").targetLayerId).toBeUndefined();
    records[2] = acceptedChild;
    records[0].turns.push({ id: "turn:3", sequence: 3 });
    records.push({ ...acceptedChild, id: "turn:3", sequence: 3 });
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "invoke_origin_invalid" }));
  });

  it("joins existing source-layer keys for compiled actions without inventing omitted keys", () => {
    const records = fixtureJsonl().trimEnd().split("\n").map(JSON.parse);
    const root = records[1].acceptedView.layers[0];
    root.layer.clientKey = "root-layer";
    root.nodes[0].clientKey = "root-node";
    root.actions[0].clientKey = "expand-action";
    const detail = { mounts: [{ kind: "capability", capability: { kind: "expand", action: {
      clientKey: "expand-action", sourceLayer: { clientKey: "root-layer" }, sourceNode: { clientKey: "root-node" },
    } } }] };
    const projected = parsePublicSnapshot(recordsJsonl(records)).interactions[0].completionOutput.rootLayer;
    expect(compiledNodeDetailCoversActions(detail, projected.actions, projected.nodes[0])).toBe(true);
    delete root.layer.clientKey;
    const stripped = parsePublicSnapshot(recordsJsonl(records)).interactions[0].completionOutput.rootLayer;
    expect(stripped.actions[0].sourceLayerClientKey).toBeUndefined();
    expect(compiledNodeDetailCoversActions(detail, stripped.actions, stripped.nodes[0])).toBe(false);
  });

  it("resolves generated aliases for absent provenance layers and preserves explicit legacy keys", () => {
    const records = fixtureJsonl().trimEnd().split("\n").map(JSON.parse);
    const root = records[1].acceptedView.layers[0];
    root.nodes[0].clientKey = root.nodes[0].id;
    root.actions[0].clientKey = root.actions[0].id;
    root.actions[0].sourceLayerId = "layer:earlier-source";
    const detail = { mounts: [{ kind: "capability", capability: { kind: "expand", action: {
      clientKey: root.actions[0].id, sourceNode: { clientKey: root.nodes[0].id }, sourceLayer: { clientKey: "layer:earlier-source" },
    } } }] };
    const projected = parsePublicSnapshot(recordsJsonl(records)).interactions[0].completionOutput.rootLayer;
    expect(compiledNodeDetailCoversActions(detail, projected.actions, projected.nodes[0])).toBe(true);
    root.actions[0].sourceLayerId = root.layer.id;
    root.layer.clientKey = "legacy-private-key";
    detail.mounts[0].capability.action.sourceLayer.clientKey = "legacy-private-key";
    const legacy = parsePublicSnapshot(recordsJsonl(records)).interactions[0].completionOutput.rootLayer;
    expect(compiledNodeDetailCoversActions(detail, legacy.actions, legacy.nodes[0])).toBe(true);
  });

  it("preserves reused action provenance while requiring its node in the displayed layer", () => {
    const records = fixtureJsonl().trim().split("\n").map((line) => JSON.parse(line));
    const reused = records[1].acceptedView.layers[0].actions[0];
    reused.sourceLayerId = "layer:earlier-authoring-layer";
    const parsed = parsePublicSnapshot(recordsJsonl(records));
    expect(parsed.interactions[0].completionOutput.rootLayer.actions[0].sourceLayerId).toBe(reused.sourceLayerId);
    reused.sourceNodeId = "node:not-in-displayed-layer";
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow("An action source must be a member of its layer.");
  });

  it.each([
    ["unknown record type", () => `${JSON.stringify({ recordType: "metadata" })}\n`],
    ["manifest mismatch", () => fixtureJsonl().replace('"sequence":1,"createdAt"', '"sequence":2,"createdAt"')],
    ["unresolved target", () => fixtureJsonl().replace('"targetLayerId":"layer:nested"', '"targetLayerId":"layer:missing"')],
    ["nonaccepted view", () => fixtureJsonl({ status: "failed" })],
  ])("rejects %s before mounting", (_label, source) => {
    expect(() => parsePublicSnapshot(source())).toThrow(PublicSnapshotError);
  });
});

describe("public share HTML boundary", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("embeds frozen bytes as inert JSON and emits no browser network authority", () => {
    const html = renderPublicViewerTemplate({
      snapshot: fixtureJsonl().replace("Map the fixture", "</script><script>alert(1)</script>"),
      title: 'A <shared> "thread"',
      description: "A safe description",
    });
    expect(html).toContain('id="relayerPublicSnapshot"');
    expect(html).toContain("\\u003c");
    expect(html).not.toContain("</script>\\\";");
    expect(html).toContain('name="robots" content="noindex,nofollow,noarchive"');
    expect(html).toContain('property="og:image" content="/design/share-og.svg"');
    expect(html).toContain("connect-src &#39;none&#39;");
    expect(html).toContain('src="/vendor/marked.umd.js"');
    expect(html).toContain('src="/vendor/lucide.min.js"');
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("public-share-topbar");
    expect(html).not.toContain(">Open Relayer</a>");
    expect(html).not.toContain("public-share-footer");
    expect(html).not.toContain("Also for Windows");
  });

  it("renders a worst-case 16 MiB snapshot within the page ceiling and a 384 MiB JS heap", () => {
    const templateUrl = new URL("../desktop/renderer/src/public-share-viewer/template.js", import.meta.url).href;
    const script = `
      import { renderPublicViewerTemplate } from ${JSON.stringify(templateUrl)};
      const total = 16 * 1024 * 1024;
      const header = '{"recordType":"header","exportVersion":1}\\n';
      const prefix = '{"recordType":"turn","content":"';
      const suffix = '"}\\n';
      const snapshot = Buffer.from(header + prefix + '<'.repeat(total - Buffer.byteLength(header + prefix + suffix)) + suffix);
      const html = renderPublicViewerTemplate({ snapshot, title: 'Worst-case generated-byte proof' });
      const bytes = Buffer.byteLength(html, 'utf8');
      if (snapshot.byteLength !== total || bytes <= 96 * 1024 * 1024 || bytes > 128 * 1024 * 1024) process.exit(1);
      process.stdout.write(String(bytes));
    `;
    const result = spawnSync(process.execPath, ["--max-old-space-size=384", "--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(Number(result.stdout)).toBeGreaterThan(96 * 1024 * 1024);
  });

  it("keeps the static shell aligned with the generated no-top-bar contract", () => {
    const html = readFileSync(new URL("../desktop/renderer/public-share.html", import.meta.url), "utf8");
    expect(html).not.toContain("public-share-topbar");
    expect(html).not.toContain(">Open Relayer</a>");
    expect(html).not.toContain("public-share-footer");
    expect(html).toContain('class="public-share-download-card"');
    expect(html).not.toContain("Also for Windows");
    expect(html).toContain(">Get Relayer</a>");
  });

  it("lets the production workspace own the complete browser viewport", () => {
    const styles = readFileSync(new URL("../desktop/renderer/src/public-share-viewer/viewer.css", import.meta.url), "utf8");
    expect(styles).toMatch(/\.public-share-main\s*{[^}]*height: 100vh;/s);
    expect(styles).toMatch(/\.public-share-workspace-host\s*{[^}]*height: 100%;[^}]*border: 0;[^}]*border-radius: 0;/s);
    expect(styles).toMatch(/\.public-share-shell \.thread-header\s*{[^}]*border-radius: 12px;/s);
  });

  it("aligns the turn picker to the interaction card with five visible rows", () => {
    const styles = readFileSync(new URL("../desktop/renderer/src/public-share-viewer/viewer.css", import.meta.url), "utf8");
    expect(styles).toMatch(/\.public-share-shell \.interaction-banner\s*{[^}]*position: relative;[^}]*margin-left: 0;/s);
    expect(styles).toMatch(/\.public-share-shell \.turn-picker\s*{[^}]*position: static;/s);
    expect(styles).toMatch(/\.public-share-shell \.turn-popover:not\(\.interaction-graph-popover\)\s*{[^}]*right: 0;[^}]*left: 0;[^}]*width: auto;[^}]*52px \* 5/s);
  });

  it("fits embed layout transitions while newer gestures, narrow viewports and disposal cancel pending work", async () => {
    const browser = new Window();
    browser.document.body.innerHTML = '<div id="host"><aside id="inspector" class="hidden"></aside><button id="fitGraph">Fit</button></div>';
    const host = browser.document.querySelector("#host");
    const inspector = host.querySelector("#inspector");
    const fit = vi.fn();
    host.querySelector("#fitGraph").onclick = fit;
    let notify;
    let nextId = 0;
    const frames = new Map();
    const disconnect = vi.fn();
    const windowRef = {
      innerWidth: 1320,
      MutationObserver: class {
        constructor(callback) { notify = callback; }
        observe() {}
        disconnect = disconnect;
      },
      requestAnimationFrame(callback) { frames.set(++nextId, callback); return nextId; },
      cancelAnimationFrame(id) { frames.delete(id); },
    };
    const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
    const transition = () => { inspector.classList.toggle("hidden"); notify(); };
    const stop = observeEmbedInspectorLayout(host, windowRef);
    try {
      transition(); flush(); // Opening and closing both use the real Fit control.
      transition(); flush();
      expect(fit).toHaveBeenCalledTimes(2);
      for (const type of ["pointerdown", "wheel", "keydown"]) {
        transition();
        expect(frames.size).toBe(1);
        host.dispatchEvent(new browser.Event(type, { bubbles: true }));
        expect(frames.size).toBe(0);
        flush();
      }
      stop.scheduleFit();
      windowRef.innerWidth = 700;
      flush();
      expect(fit).toHaveBeenCalledTimes(2);
      transition(); flush(); // Narrow Back to graph fits the newly visible canvas.
      expect(fit).toHaveBeenCalledTimes(3);
      windowRef.innerWidth = 1320;
      transition();
      stop();
      expect(frames.size).toBe(0);
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      await browser.close();
    }
  });

  it("keeps ordinary wheel native while preserving explicit zoom and keyboard reading", async () => {
    const browser = new Window();
    browser.document.body.innerHTML = '<div id="host"><div id="graphStage"><span class="graph-hint"></span></div><button id="closeInspector"></button><div class="inspector-content"></div></div>';
    const host=browser.document.querySelector('#host');
    const stage=host.querySelector('#graphStage');
    const zoom=vi.fn(event=>event.preventDefault());
    stage.onwheel=zoom;
    const stop=configureEmbedReading(host);
    try {
      const ordinary=new browser.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100});
      stage.dispatchEvent(ordinary);
      expect(ordinary.defaultPrevented).toBe(false);
      expect(zoom).not.toHaveBeenCalled();
      const pinch = new browser.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100});
      Object.defineProperty(pinch, 'ctrlKey', {value:true}); // happy-dom omits WheelEvent modifier fields.
      stage.dispatchEvent(pinch);
      expect(zoom).toHaveBeenCalledOnce();
      expect(stage.tabIndex).toBe(0);
      expect(host.querySelector('.inspector-content').getAttribute('aria-label')).toBe('Node details content');
      stop();
      stage.dispatchEvent(new browser.WheelEvent('wheel',{bubbles:true,deltaY:100}));
      expect(zoom).toHaveBeenCalledTimes(2);
    } finally { stop(); await browser.close(); }
  });

  it("quantizes a short viewport to complete turn rows", async () => {
    const windowRef = new Window({ url: "https://share.example.test" });
    windowRef.document.body.innerHTML = '<div id="host"><div class="interaction-banner"></div><div class="turn-popover"></div></div>';
    const host = windowRef.document.querySelector("#host");
    const banner = host.querySelector(".interaction-banner");
    banner.getBoundingClientRect = () => ({ bottom: 200 });
    Object.defineProperty(windowRef, "innerHeight", { configurable: true, value: 440 });
    try {
      fitPublicTurnPopover(host, windowRef);
      expect(host.querySelector(".turn-popover").style.maxHeight).toBe("210px");
      host.querySelector(".turn-popover").classList.add("interaction-graph-popover");
      host.querySelector(".turn-popover").style.maxHeight = "";
      fitPublicTurnPopover(host, windowRef);
      expect(host.querySelector(".turn-popover").style.maxHeight).toBe("");
    } finally {
      await windowRef.close();
    }
  });

  it("keeps the install destination fixed and rejects unsafe asset bases", () => {
    expect(() => renderPublicViewerTemplate({ snapshot: fixtureJsonl(), assetBase: "https://evil.example" })).toThrow();
    expect(() => renderPublicViewerTemplate({ snapshot: fixtureJsonl(), installUrl: "javascript:alert(1)" })).toThrow();
    expect(renderPublicViewerTemplate({
      snapshot: fixtureJsonl(),
      installUrl: `/t/${"a".repeat(32)}/install`,
    })).toContain(`/t/${"a".repeat(32)}/install`);
  });

  it("admits only an explicit embed presentation with a canonical standalone route", () => {
    for (const sharePath of [null, "", "//evil.test/t/id", "https://evil.test", "javascript:alert(1)",
      `/t/${"a".repeat(32)}?node=other`, `/t/${"a".repeat(32)}#later`, `/t/${"a".repeat(32)}/embed`]) {
      expect(() => renderPublicViewerTemplate({ snapshot: fixtureJsonl(), presentation: "embed", sharePath })).toThrow();
    }
    expect(() => renderPublicViewerTemplate({ snapshot: fixtureJsonl(), presentation: "unknown" })).toThrow();
    expect(() => renderPublicViewerTemplate({ snapshot: fixtureJsonl(), theme: "unsafe" })).toThrow();
    const html = renderPublicViewerTemplate({ snapshot: fixtureJsonl(), presentation: "embed", sharePath: `/t/${"a".repeat(32)}` });
    expect(html).toContain("connect-src &#39;none&#39;");
    expect(publicViewerCsp()).toContain("frame-ancestors 'none'");
    expect(html).not.toContain("public-share-download-card");
  });

  it("preserves the complete accepted Unicode title contract", () => {
    const title = "🧭".repeat(120);
    const html = renderPublicViewerTemplate({ snapshot: fixtureJsonl(), title });
    expect(html).toContain(`<title>${title} · Relayer</title>`);
  });

  it("preserves the complete chosen project display name in public metadata", () => {
    const projectName = "界".repeat(256);
    const html = renderPublicViewerTemplate({ snapshot: fixtureJsonl(), description: projectName });
    expect(html).toContain(`property="og:description" content="${projectName}"`);
  });

  it("publishes the CSP contract as a small deterministic value", () => {
    expect(publicViewerCsp()).toContain("connect-src 'none'");
    expect(publicViewerCsp()).toContain("script-src 'self'");
    expect(publicViewerCsp()).toContain("frame-ancestors 'none'");
  });

  it("gives a render failure exclusive ownership of the viewport", async () => {
    const windowRef = new Window({ url: `https://share.example.test/t/${"a".repeat(32)}` });
    windowRef.document.write(renderPublicViewerTemplate({ snapshot: "not-jsonl" }));
    const reload = vi.fn();
    const onRenderError = vi.fn();
    try {
      expect(bootPublicViewer({ documentRef: windowRef.document, windowRef, reload, onRenderError })).toBeNull();
      expect(onRenderError).toHaveBeenCalledOnce();
      expect(windowRef.document.querySelector("#publicViewerHost")?.classList.contains("hidden")).toBe(true);
      expect(windowRef.document.querySelector(".public-share-download-card")?.classList.contains("hidden")).toBe(true);
      expect(windowRef.document.querySelector("#publicShareError")?.classList.contains("hidden")).toBe(false);
      windowRef.document.querySelector("#publicShareReload")?.click();
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      await windowRef.close();
    }
  });

  it.each(["standalone", "embed"])("boots %s ProductWorkspace and navigates accepted history without execution", async (presentation) => {
    const windowRef = new Window({ url: `https://share.example.test/t/${"a".repeat(32)}` });
    const records = invokeFixtureRecords();
    const root = records[1].acceptedView.layers[0];
    root.layer.defaultNodeId = root.nodes[0].id;
    root.layer.nodes.push("node:other");
    root.nodes.push({ id: "node:other", kind: "concept", icon: "box", title: "Other share choice", detail: "", state: "accepted" });
    root.layer.layout.placements.push({ nodeId: "node:other", x: .8, y: .8 });
    root.actions.push({ id: "action:unresolved", sourceNodeId: "node:root", sourceLayerId: "layer:root",
      kind: "invoke", interactionText: "Do new work", label: "Unexecuted action", variant: "pill", state: "accepted" });
    const sharePath = `/t/${"a".repeat(32)}`;
    const page = renderPublicViewerTemplate({ snapshot: recordsJsonl(records), presentation, sharePath, theme: presentation === "embed" ? "light" : "system" });
    windowRef.document.write(page);
    const previous = {
      DOMParser: globalThis.DOMParser,
      document: globalThis.document,
      lucide: globalThis.lucide,
      marked: globalThis.marked,
      window: globalThis.window,
    };
    globalThis.window = windowRef;
    globalThis.document = windowRef.document;
    globalThis.DOMParser = windowRef.DOMParser;
    globalThis.lucide = {
      Circle: {},
      createElement(_icon, attributes) {
        const svg = windowRef.document.createElementNS("http://www.w3.org/2000/svg", "svg");
        for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, String(value));
        return svg;
      },
    };
    globalThis.marked = { parse: (value) => `<p><a href="HTTPS://example.test/docs">${value}</a></p>` };
    try {
      const originalUrl = windowRef.location.href;
      const onRenderError = vi.fn();
      const viewer = bootPublicViewer({ documentRef: windowRef.document, windowRef, onRenderError });
      expect(onRenderError).not.toHaveBeenCalled();
      expect(viewer).not.toBeNull();
      if (presentation === "embed") expect(windowRef.document.documentElement.dataset.theme).toBe("light");
      expect(viewer.adapter.selection.currentInteractionId).toBe("turn:1");
      expect(windowRef.document.querySelector(".interaction-graph-stepper")).toBeTruthy();
      expect(windowRef.document.querySelector(".interaction-graph-popover")).toBeTruthy();
      expect(windowRef.document.querySelector("#publicViewerHost")?.classList.contains("hidden")).toBe(false);
      const downloadCard = windowRef.document.querySelector(".public-share-download-card");
      if (presentation === "standalone") {
        expect(downloadCard?.parentElement?.classList.contains("thread-header")).toBe(true);
        expect(downloadCard?.textContent).toContain("Get Relayer");
        expect(windowRef.document.querySelector(".public-share-embed-branding")).toBeNull();
      } else {
        expect(downloadCard).toBeNull();
        const link = windowRef.document.querySelector(".public-share-embed-branding a");
        expect(link.getAttribute("href")).toBe(sharePath);
        expect(link.target).toBe("_blank");
        expect(link.rel).toBe("noopener noreferrer");
      }
      expect(windowRef.document.querySelector("#environmentPanel")).toBeNull();
      windowRef.document.querySelector(".graph-node")?.click();
      await vi.waitFor(() => expect(windowRef.document.querySelector('a[href="HTTPS://example.test/docs"]')).toMatchObject({
        target: "_blank",
      }));
      expect(windowRef.document.querySelector('a[href="HTTPS://example.test/docs"]').rel).toBe("noreferrer noopener");
      expect(windowRef.document.querySelector("#nodeInputActions").textContent).toContain("Path A");
      expect(windowRef.document.querySelector("#nodeInputActions").textContent).toContain("Path B");
      expect([...windowRef.document.querySelectorAll("#nodeInputActions button")].every((button) => button.disabled)).toBe(true);
      const unresolved = windowRef.document.querySelector('[data-action-id="action:unresolved"]');
      expect(unresolved.disabled).toBe(true);
      unresolved.click();
      expect(viewer.adapter.selection.currentInteractionId).toBe("turn:1");
      await expect(viewer.adapter.onInvokeAction()).resolves.toBe(false);
      await expect(viewer.adapter.onSubmitInteraction()).resolves.toBe(false);
      const navigator = windowRef.document.querySelector("#turnPickerButton");
      expect(navigator.classList.contains("interaction-graph-trigger")).toBe(true);
      expect(navigator.textContent).not.toMatch(/Turn \d+ of/);
      expect(windowRef.document.querySelector("#turnPopover").classList.contains("hidden")).toBe(true);
      const invokeButton = windowRef.document.querySelector('[data-action-id="action:invoke"]');
      expect(invokeButton.disabled).toBe(false);
      invokeButton.click();
      await vi.waitFor(() => expect(viewer.adapter.selection.currentInteractionId).toBe("turn:2"));
      expect(viewer.adapter.state.visibleLayer.layer.id).toBe("layer:child");
      viewer.adapter.selectTurnById("turn:1");
      viewer.render();
      await windowRef.happyDOM.waitUntilComplete();
      windowRef.document.querySelector('[data-action-id="action:expand"]').click();
      await vi.waitFor(() => expect(viewer.adapter.state.visibleLayer.layer.id).toBe("layer:nested"));
      windowRef.document.querySelector('.graph-node').click();
      await windowRef.happyDOM.waitUntilComplete();
      windowRef.document.querySelector('[data-action-id="action:reference"]').click();
      await vi.waitFor(() => expect(viewer.adapter.state.visibleLayer.layer.id).toBe("layer:related"));
      windowRef.document.querySelector("#turnPickerButton").click();
      expect(windowRef.document.querySelectorAll(".interaction-graph-node")).toHaveLength(2);
      windowRef.document.querySelector('.interaction-graph-node[data-turn-id="turn:1"]').click();
      await vi.waitFor(() => expect(viewer.adapter.state.visibleLayer.layer.id).toBe("layer:root"));
      expect(windowRef.document.querySelector("#turnPopover").classList.contains("hidden")).toBe(true);

      expect(windowRef.location.href).toBe(originalUrl);
      viewer.adapter.selectTurnById("turn:2");
      viewer.adapter.selectTurnById("turn:1");
      viewer.render();
      await windowRef.happyDOM.waitUntilComplete();
      windowRef.document.querySelector('[data-node="node:other"]').click();
      await windowRef.happyDOM.waitUntilComplete();
      expect(viewer.adapter.selection.selectedNodeId).toBe("node:other");
      // Dragging keeps the grabbed point under the pointer: the node moves by the pointer's
      // travel instead of jumping its centre to the pointer.
      windowRef.HTMLElement.prototype.setPointerCapture ??= () => {};
      const dragged = windowRef.document.querySelector('[data-node="node:other"]');
      const zoom = Number(dragged.style.getPropertyValue("--graph-zoom"));
      const [startX, startY] = [Number(dragged.dataset.worldX), Number(dragged.dataset.worldY)];
      dragged.dispatchEvent(new windowRef.PointerEvent("pointerdown", { bubbles: true, pointerId: 7, buttons: 1, clientX: 300, clientY: 200 }));
      dragged.dispatchEvent(new windowRef.PointerEvent("pointermove", { bubbles: true, pointerId: 7, buttons: 1, clientX: 340, clientY: 230 }));
      const moved = windowRef.document.querySelector('[data-node="node:other"]');
      expect(Number(moved.dataset.worldX) - startX).toBeCloseTo(40 / zoom, 6);
      expect(Number(moved.dataset.worldY) - startY).toBeCloseTo(30 / zoom, 6);
      moved.dispatchEvent(new windowRef.PointerEvent("pointerup", { bubbles: true, pointerId: 7 }));
      viewer.dispose();
      windowRef.document.open();
      windowRef.document.write(page);
      const otherShare = bootPublicViewer({ documentRef: windowRef.document, windowRef, onRenderError });
      await windowRef.happyDOM.waitUntilComplete();
      expect(otherShare.adapter.selection.selectedNodeId).toBe(root.layer.defaultNodeId);
      expect(windowRef.localStorage.getItem("relayerLayerSelectionsV1")).toBeNull();
      otherShare.dispose();
    } finally {
      globalThis.DOMParser = previous.DOMParser;
      globalThis.document = previous.document;
      globalThis.lucide = previous.lucide;
      globalThis.marked = previous.marked;
      globalThis.window = previous.window;
      await windowRef.close();
    }
  });
});


describe("public interaction graph", () => {
  function attachedRecords() {
    const records = invokeFixtureRecords();
    records[0].exportVersion = 3;
    // A owns the layers; B also presents them. C attaches while viewing B.
    const owner = records[1];
    const presenter = records[2];
    presenter.acceptedView.layers[0].actions.push(action("action:prior", "node:child", "layer:nested", "reference", "layer:child"));
    presenter.acceptedView.layers.push(...structuredClone(owner.acceptedView.layers.slice(1)));
    records[0].turns.push({ id: "turn:3", sequence: 3 });
    const contexts = ["nested", "nested", "related"].map((name, index) => ({
      id: `action:context${index}`, target: structuredClone(owner.acceptedView.layers.find(item => item.layer.id === `layer:${name}`).nodes[0]),
      source: { interactionNodeId: "node:child-interaction", layerId: `layer:${name}`, ownerTurnId: "turn:1" }, annotations: [],
    }));
    records.push({ ...structuredClone(presenter), id: "turn:3", sequence: 3, text: "Attached follow-up",
      interactionNodeId: "node:third-interaction", origin: { kind: "user" }, contexts,
      acceptedView: { interactionNodeId: "node:third-interaction", rootLayerId: "layer:third",
        rootAction: action("action:third-root", "node:third-interaction", "layer:third", "expand"),
        layers: [layer("layer:third", "node:third")] },
    });
    return records;
  }

  it("groups attachments by exact exported owner, never by presenting occurrence or chronology", () => {
    const snapshot = parsePublicSnapshot(recordsJsonl(attachedRecords()));
    const graph = interactionGraph(snapshot.interactions, "turn:3");
    expect(graph.incomplete).toBe(false);
    expect(graph.contextCount).toBe(3);
    expect(graph.edges).toEqual([
      { source: "turn:1", target: "turn:2", layers: [], invocationActionId: "action:invoke" },
      { source: "turn:1", target: "turn:3", layers: [
        { layerId: "layer:nested", nodeIds: ["node:nested"] },
        { layerId: "layer:related", nodeIds: ["node:related"] },
      ], invocationActionId: null },
    ]);
  });

  it.each([1, 2, 3])("keeps V%s graph cards and proven invocation edges when attachment ownership is unavailable", version => {
    const records = attachedRecords(); records[0].exportVersion = version;
    for (const context of records[3].contexts) {
      delete context.source.ownerTurnId;
      context.source.interactionNodeId = "node:outside";
    }
    const snapshot = parsePublicSnapshot(recordsJsonl(records));
    const graph = interactionGraph(snapshot.interactions, "turn:3");
    expect(graph.nodes.map(node => node.id)).toEqual(["turn:1", "turn:2", "turn:3"]);
    expect(graph.incomplete).toBe(true);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].invocationActionId).toBe("action:invoke");
  });

  it.each(["outside", "later", "membership", "conflict", "version"])("rejects %s portable owner claims", fault => {
    const records = attachedRecords();
    const context = records[3].contexts[0];
    if (fault === "outside") context.source.ownerTurnId = "turn:99";
    if (fault === "later") context.source.ownerTurnId = "turn:3";
    if (fault === "membership") context.target.id = "node:third";
    if (fault === "conflict") records[3].contexts[1].source.ownerTurnId = "turn:2";
    if (fault === "version") records[0].exportVersion = 2;
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "context_owner_invalid" }));
  });
});

describe("V3 current converted-invoke snapshots", () => {
  function convertedRecords() {
    const records = invokeFixtureRecords();
    records[0].exportVersion = 3;
    const source = records[1].acceptedView;
    const converted = source.layers[0].actions.find(action => action.kind === "invoke");
    Object.assign(converted, { kind: "navigate", relation: "expand", targetLayerId: "layer:child", convertedFromInvoke: true });
    delete converted.interactionText;
    source.layers.push(structuredClone(records[2].acceptedView.layers[0]));
    return records;
  }
  it("preserves current navigation and validates its exact accepted origin", async () => {
    const records = convertedRecords();
    const snapshot = parsePublicSnapshot(recordsJsonl(records));
    const adapter = createPublicViewerAdapter(snapshot);
    const converted = adapter.state.actions.find(action => action.convertedFromInvoke);
    expect(converted.kind).toBe("navigate");
    await expect(adapter.navigateResolvedInvoke(converted)).resolves.toBe(true);
    expect(adapter.state.visibleLayer.layer.id).toBe("layer:child");
    expect(adapter.selection.currentInteractionId).toBe("turn:2");
    expect(adapter.state.currentInteractionId).toBe("turn:2");
    records[2].acceptedView.rootLayerId = "layer:root";
    records[2].acceptedView.rootAction.targetLayerId = "layer:root";
    records[2].acceptedView.layers = structuredClone(records[1].acceptedView.layers);
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "invoke_origin_invalid" }));
  });
  it("navigates an included converted result within its source when the result turn is omitted", async () => {
    const records = convertedRecords();
    records.pop();
    records[0].turns.pop();
    const adapter = createPublicViewerAdapter(parsePublicSnapshot(recordsJsonl(records)));
    const converted = adapter.state.actions.find(action => action.convertedFromInvoke);
    await expect(adapter.navigateResolvedInvoke(converted)).resolves.toBe(true);
    expect(adapter.state.visibleLayer.layer.id).toBe("layer:child");
    expect(adapter.selection.currentInteractionId).toBe("turn:1");
  });
  it.each([1, 2])("rejects conversion provenance in V%s", version => {
    const records = convertedRecords(); records[0].exportVersion = version;
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "converted_invoke_version" }));
  });
  it("retains the declared reused-source turn instead of choosing its first occurrence", () => {
    const records = convertedRecords();
    const reused = structuredClone(records[1]);
    Object.assign(reused, { id: "turn:2", sequence: 2, interactionNodeId: "node:reused-interaction" });
    Object.assign(reused.acceptedView, { interactionNodeId: "node:reused-interaction", rootLayerId: "layer:reused" });
    Object.assign(reused.acceptedView.rootAction, { id: "action:reused-root", sourceNodeId: "node:reused-interaction", targetLayerId: "layer:reused" });
    Object.assign(reused.acceptedView.layers[0].layer, { id: "layer:reused", clientKey: "reused-source" });
    Object.assign(records[2], { id: "turn:3", sequence: 3 });
    records[2].origin.source_turn_id = "turn:2";
    records.splice(2, 0, reused);
    records[0].turns.push({ id: "turn:3", sequence: 3 });
    const snapshot = parsePublicSnapshot(recordsJsonl(records));
    const invocation = interactionGraph(snapshot.interactions, "turn:3").edges.find(edge => edge.invocationActionId === "action:invoke");
    expect(invocation.source).toBe("turn:2");
    expect(invocation.target).toBe("turn:3");
    const other = structuredClone(reused.acceptedView.layers[0].actions.find(action => action.convertedFromInvoke));
    Object.assign(other, { id: "action:other-conversion", clientKey: "other-conversion" });
    reused.acceptedView.layers[0].actions.push(other);
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "invoke_origin_invalid" }));
    // A conflicting action discovered after the result is equally ambiguous.
    [records[2], records[3]] = [records[3], records[2]];
    Object.assign(records[2], { id: "turn:2", sequence: 2 });
    records[2].origin.source_turn_id = "turn:1";
    Object.assign(records[3], { id: "turn:3", sequence: 3 });
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "invoke_origin_invalid" }));
    // Omitting the result keeps the external navigation without inventing lineage.
    records.splice(2, 1);
    Object.assign(records[2], { id: "turn:2", sequence: 2 });
    records[0].turns.pop();
    expect(parsePublicSnapshot(recordsJsonl(records)).interactions).toHaveLength(2);

  });
  it("rejects an included converted result with erased invocation lineage", () => {
    const records = convertedRecords();
    records[2].origin = { kind: "user" };
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "invoke_origin_invalid" }));
    [records[1], records[2]] = [records[2], records[1]];
    Object.assign(records[1], { id: "turn:1", sequence: 1 });
    Object.assign(records[2], { id: "turn:2", sequence: 2 });
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "invoke_origin_invalid" }));

  });
  it("rejects a converted origin pointing to an unaccepted result", () => {
    const records = convertedRecords();
    records[2].completion = { ...records[2].completion, status: "failed" };
    records[2].acceptedView = null;
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "invoke_origin_invalid" }));
  });
  it("rejects a forged conversion shape", () => {
    const records = convertedRecords();
    records[1].acceptedView.layers[0].actions.find(action => action.convertedFromInvoke).relation = "reference";
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "converted_invoke_shape" }));
  });
  it("permits node-owned V3 navigation but rejects missing source membership and root conversion", () => {
    const records = convertedRecords();
    const converted = records[1].acceptedView.layers[0].actions.find(action => action.convertedFromInvoke);
    delete converted.sourceLayerId;
    expect(parsePublicSnapshot(recordsJsonl(records)).header.exportVersion).toBe(3);
    converted.sourceNodeId = "node:absent";
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "action_source_outside_layer" }));
    converted.sourceNodeId = "node:root";
    records[1].acceptedView.rootAction.convertedFromInvoke = true;
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "invalid_root_action" }));
  });
  it("keeps repeated native completion keys unambiguous by exact source node", () => {
    const records = convertedRecords();
    for (const turn of records.slice(1)) {
      for (const resolved of turn.acceptedView.layers) {
        resolved.layer.clientKey = "answer-layer";
        resolved.nodes[0].clientKey = "answer-node";
        if (resolved.layer.id === "layer:child") {
          resolved.actions.push({ id: "action:second-follow-up", sourceNodeId: "node:child", sourceLayerId: "layer:child", clientKey: "follow-up", kind: "invoke", interactionText: "Next", label: "Next", variant: "pill", state: "accepted" });
        } else if (resolved.layer.id === "layer:root") {
          resolved.actions.find(action => action.convertedFromInvoke).clientKey = "follow-up";
        }
      }
    }
    const snapshot = parsePublicSnapshot(recordsJsonl(records));
    const root = snapshot.layerFor("turn:1", "layer:root");
    const child = snapshot.layerFor("turn:1", "layer:child");
    const reference = { clientKey: "follow-up", sourceNode: { clientKey: "answer-node" }, sourceLayer: { clientKey: "answer-layer" } };
    const actions = [...root.actions, ...child.actions];
    expect(resolveCompiledNodeDetailAction(actions, reference, root.nodes[0]).id).toBe("action:invoke");
    expect(resolveCompiledNodeDetailAction(actions, reference, child.nodes[0]).id).toBe("action:second-follow-up");
    const collision = structuredClone(records[1].acceptedView.layers[0].actions.find(action => action.convertedFromInvoke));
    collision.id = "action:ambiguous";
    records[1].acceptedView.layers[0].actions.push(collision);
    expect(() => parsePublicSnapshot(recordsJsonl(records))).toThrow(expect.objectContaining({ code: "duplicate_action_client_key" }));
  });
  it("retains V2 visual assets in V3", () => {
    const records = assetFixtureJsonl().jsonl.trimEnd().split("\n").map(JSON.parse);
    records[0].exportVersion = 3;
    expect(parsePublicSnapshot(recordsJsonl(records)).assetContents).toHaveLength(1);
  });
});

it("V3 reference backlinks preserve legacy arrival and expansion-cycle guards", () => {
  const records = fixtureJsonl().trimEnd().split("\n").map(JSON.parse);
  records[0].exportVersion = 3;
  const layers = records[1].acceptedView.layers;
  layers[2].actions.push(action("action:back", "node:related", "layer:root", "reference", "layer:related"));
  expect(() => parsePublicSnapshot(recordsJsonl(records))).not.toThrow();
  for (const version of [1, 2]) {
    const older = structuredClone(records);
    older[0].exportVersion = version;
    expect(() => parsePublicSnapshot(recordsJsonl(older))).toThrow(expect.objectContaining({ code: "mixed_target_relations" }));
  }
  const cycle = structuredClone(records);
  cycle[1].acceptedView.layers[0].actions.push(action("action:cycle-root", "node:root", "layer:root", "expand", "layer:root"));
  expect(() => parsePublicSnapshot(recordsJsonl(cycle))).toThrow(expect.objectContaining({ code: "expand_cycle" }));
  const referencedCycle = structuredClone(records);
  referencedCycle[1].acceptedView.layers[0].actions[0].relation = "reference";
  referencedCycle[1].acceptedView.layers[1].actions.push(action("action:referenced-cycle", "node:nested", "layer:nested", "expand", "layer:nested"));
  expect(() => parsePublicSnapshot(recordsJsonl(referencedCycle))).toThrow(expect.objectContaining({ code: "expand_cycle" }));
  layers[2].actions.at(-1).targetLayerId = "layer:nested";
  expect(() => parsePublicSnapshot(recordsJsonl(records))).not.toThrow();
  for (const version of [1, 2]) {
    const older = structuredClone(records);
    older[0].exportVersion = version;
    expect(() => parsePublicSnapshot(recordsJsonl(older))).toThrow(expect.objectContaining({ code: "mixed_target_relations" }));
  }
});

describe("public share edge shapes", () => {
  function shapedRecords() {
    const records = invokeFixtureRecords();
    const root = records[1].acceptedView.layers[0];
    // "Start" joined the layer after "Root", but its placement puts it first in reading order.
    for (const [id, title] of [["node:start", "Start"], ["node:end", "End"]]) {
      root.layer.nodes.push(id);
      root.nodes.push({ id, kind: "concept", icon: "box", title, detail: "", state: "accepted" });
    }
    for (const [id, endpoints] of [["edge:start-root", ["node:root", "node:start"]], ["edge:root-end", ["node:root", "node:end"]]]) {
      root.layer.edges.push(id);
      root.edges.push({ id, endpoints, state: "accepted" });
    }
    root.layer.layout = {
      version: 1,
      placements: [{ nodeId: "node:start", x: .1, y: .2 }, { nodeId: "node:root", x: .5, y: .6 }, { nodeId: "node:end", x: .9, y: .3 }],
      edgeShape: "arc-circle",
      // One edge overrides the layer: straight, over the top through a waypoint.
      edgeRoutes: [{ edgeId: "edge:root-end", shape: "straight", ends: [{ nodeId: "node:end", side: "top" }, { nodeId: "node:root" }], waypoints: [{ x: .5, y: .05 }] }],
    };
    return records;
  }

  it("keeps each layer's edge shape and reading order from snapshot to canvas", async () => {
    const records = shapedRecords();
    const snapshot = parsePublicSnapshot(recordsJsonl(records));
    expect(snapshot.layerFor("turn:1", "layer:root").layer.layout).toEqual(records[1].acceptedView.layers[0].layer.layout);
    // A layer shared before edge shapes existed keeps no shape and reads as the default.
    expect(snapshot.layerFor("turn:2", "layer:child").layer.layout).toEqual({ version: 1, placements: [{ nodeId: "node:child", x: .5, y: .5 }] });
    const malformed = shapedRecords();
    malformed[1].acceptedView.layers[0].layer.layout.edgeShape = 3;
    expect(() => parsePublicSnapshot(recordsJsonl(malformed))).toThrow(expect.objectContaining({ code: "layout_edge_shape_invalid" }));
    const misrouted = shapedRecords();
    misrouted[1].acceptedView.layers[0].layer.layout.edgeRoutes[0].ends[1].nodeId = "node:start";
    expect(() => parsePublicSnapshot(recordsJsonl(misrouted))).toThrow(expect.objectContaining({ code: "layout_edge_route_invalid" }));

    const windowRef = new Window({ url: `https://share.example.test/t/${"b".repeat(32)}` });
    windowRef.document.write(renderPublicViewerTemplate({ snapshot: recordsJsonl(records), presentation: "standalone", sharePath: `/t/${"b".repeat(32)}`, theme: "system" }));
    const previous = { DOMParser: globalThis.DOMParser, document: globalThis.document, lucide: globalThis.lucide, window: globalThis.window };
    globalThis.window = windowRef;
    globalThis.document = windowRef.document;
    globalThis.DOMParser = windowRef.DOMParser;
    globalThis.lucide = { Circle: {}, createElement: () => windowRef.document.createElementNS("http://www.w3.org/2000/svg", "svg") };
    try {
      const viewer = bootPublicViewer({ documentRef: windowRef.document, windowRef, onRenderError: vi.fn() });
      await windowRef.happyDOM.waitUntilComplete();
      const canvas = windowRef.document.querySelector("#edgeCanvas");
      // Tab and screen-reader order follow the placements, not layer membership.
      expect([...windowRef.document.querySelectorAll("[data-node]")].map((node) => node.dataset.node)).toEqual(["node:start", "node:root", "node:end"]);
      expect(canvas.getAttribute("data-edge-shape")).toBe("arc-circle");
      const edgePath = (id) => windowRef.document.querySelector(`[data-edge="${id}"] .graph-edge`).getAttribute("d");
      const [startRoot, rootEnd] = [edgePath("edge:start-root"), edgePath("edge:root-end")];
      expect(startRoot).toMatch(/^M[^MA]+A[^MA]+$/);
      // The routed edge draws in its own shape: straight segments out of End's top, through its waypoint.
      const routed = windowRef.document.querySelector('[data-edge="edge:root-end"]');
      expect([routed.hasAttribute("data-edge-routed"), routed.getAttribute("data-edge-shape")]).toEqual([true, "straight"]);
      expect(rootEnd).toMatch(/^M[^A-Z]+L[^A-Z]+L[^A-Z]+L[^A-Z]+$/);
      const points = (d) => d.match(/-?[\d.]+/g).map(Number).reduce((list, value, index, all) => (index % 2 ? list : [...list, { x: value, y: all[index + 1] }]), []);
      expect(canvas.querySelector("marker, [marker-start], [marker-mid], [marker-end]")).toBeNull();
      // Dragging a node reshapes only the edges it is on.
      windowRef.HTMLElement.prototype.setPointerCapture ??= () => {};
      const start = windowRef.document.querySelector('[data-node="node:start"]');
      start.dispatchEvent(new windowRef.PointerEvent("pointerdown", { bubbles: true, pointerId: 3, buttons: 1, clientX: 100, clientY: 100 }));
      start.dispatchEvent(new windowRef.PointerEvent("pointermove", { bubbles: true, pointerId: 3, buttons: 1, clientX: 100, clientY: 160 }));
      expect(edgePath("edge:start-root")).not.toBe(startRoot);
      expect(edgePath("edge:root-end")).toBe(rootEnd);
      start.dispatchEvent(new windowRef.PointerEvent("pointerup", { bubbles: true, pointerId: 3 }));
      // Dragging End, which the route leaves from, carries its waypoint part of the way, without turning it.
      const end = windowRef.document.querySelector('[data-node="node:end"]');
      end.dispatchEvent(new windowRef.PointerEvent("pointerdown", { bubbles: true, pointerId: 4, buttons: 1, clientX: 500, clientY: 100 }));
      end.dispatchEvent(new windowRef.PointerEvent("pointermove", { bubbles: true, pointerId: 4, buttons: 1, clientX: 500, clientY: 160 }));
      const [before, after] = [points(rootEnd), points(edgePath("edge:root-end"))];
      const moved = (index) => ({ x: after[index].x - before[index].x, y: after[index].y - before[index].y });
      expect(moved(0).y).toBeGreaterThan(0);
      expect(moved(2).x).toBeCloseTo(0, 6);
      expect(moved(2).y).toBeGreaterThan(0);
      expect(moved(2).y).toBeLessThan(moved(0).y);
      expect(after[3]).toEqual(before[3]);
      end.dispatchEvent(new windowRef.PointerEvent("pointerup", { bubbles: true, pointerId: 4 }));

      viewer.adapter.selectTurnById("turn:2");
      viewer.render();
      await windowRef.happyDOM.waitUntilComplete();
      expect(windowRef.document.querySelector("#edgeCanvas").getAttribute("data-edge-shape")).toBe("arc-outward");
      viewer.dispose();
    } finally {
      Object.assign(globalThis, previous);
      await windowRef.close();
    }
  });
});

describe("artifact layers in a shared snapshot (ART-008)", () => {
  it("open as a card for local files and a sandboxed frame for https, without leaving the graph", async () => {
    const records = fixtureJsonl().trimEnd().split("\n").map(JSON.parse);
    const view = records[1].acceptedView;
    const artifactLayer = (id, nodeId, title, artifact) => {
      const resolved = layer(id, nodeId);
      resolved.layer.renderer = "artifact";
      Object.assign(resolved.nodes[0], { title, artifact });
      return resolved;
    };
    view.layers.push(
      artifactLayer("layer:site", "node:site", "Landing page", { kind: "website", source: { file: "site/index.html", root: "site" }, fingerprint: `sha256:${"a".repeat(64)}` }),
      artifactLayer("layer:deployed", "node:deployed", "Deployed site", { kind: "url", source: { url: "https://example.com/" } }),
    );
    view.layers[0].actions.push(
      action("action:site", "node:root", "layer:site", "expand", "layer:root"),
      action("action:deployed", "node:root", "layer:deployed", "expand", "layer:root"),
    );
    const windowRef = new Window({ url: `https://share.example.test/t/${"a".repeat(32)}` });
    windowRef.document.write(renderPublicViewerTemplate({ snapshot: recordsJsonl(records), sharePath: `/t/${"a".repeat(32)}` }));
    const previous = { DOMParser: globalThis.DOMParser, document: globalThis.document, lucide: globalThis.lucide, marked: globalThis.marked, window: globalThis.window };
    Object.assign(globalThis, { window: windowRef, document: windowRef.document, DOMParser: windowRef.DOMParser, marked: { parse: (value) => value } });
    globalThis.lucide = { Circle: {}, createElement: () => windowRef.document.createElementNS("http://www.w3.org/2000/svg", "svg") };
    try {
      const onRenderError = vi.fn();
      const viewer = bootPublicViewer({ documentRef: windowRef.document, windowRef, onRenderError });
      expect(onRenderError).not.toHaveBeenCalled();
      windowRef.document.querySelector(".graph-node").click();
      await windowRef.happyDOM.waitUntilComplete();
      windowRef.document.querySelector('[data-action-id="action:site"]').click();
      await vi.waitFor(() => expect(windowRef.document.querySelector(".artifact-viewer")).toBeTruthy());
      expect(windowRef.document.querySelector(".artifact-card-note").textContent).toBe("Available in Relayer on the machine that made it.");
      expect(windowRef.document.querySelector(".artifact-viewer iframe")).toBeNull();
      expect(viewer.adapter.state.visibleLayer.layer.id).toBe("layer:root");
      windowRef.document.dispatchEvent(new windowRef.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(windowRef.document.querySelector(".artifact-viewer")).toBeNull();
      windowRef.document.querySelector('[data-action-id="action:deployed"]').click();
      await vi.waitFor(() => expect(windowRef.document.querySelector(".artifact-viewer iframe")).toBeTruthy());
      expect(windowRef.document.querySelector(".artifact-viewer iframe").getAttribute("srcdoc")).toContain('src="https://example.com/"');
      expect(publicViewerCsp()).toContain("frame-src https:");
      // Disposing the share viewer closes an open artifact overlay too.
      viewer.dispose();
      expect(windowRef.document.querySelector(".artifact-viewer")).toBeNull();
    } finally {
      Object.assign(globalThis, previous);
      await windowRef.close();
    }
  });
});
