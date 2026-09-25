import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPublicViewerAdapter } from "../desktop/renderer/src/public-share-viewer/adapter.js";
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

describe("public share V1 reader", () => {
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

  it("preserves nested navigation and reference cycles without granting execution authority", async () => {
    const adapter = createPublicViewerAdapter(parsePublicSnapshot(fixtureJsonl()));
    expect(adapter.readOnly).toBe(true);
    expect(adapter.state.visibleLayer.layer.id).toBe("layer:root");
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
    await expect(adapter.onInvokeAction({ kind: "invoke" })).resolves.toBe(false);
    await expect(adapter.onSubmitInteraction("mutate")).resolves.toBe(false);
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
    expect(html).toContain('property="og:image" content="./assets/relayer-share-og.svg"');
    expect(html).toContain("connect-src &#39;none&#39;");
    expect(html).not.toContain("vendor/marked");
    expect(html).not.toContain("vendor/lucide");
    expect(html).not.toContain("fetch(");
  });

  it("keeps the install destination fixed and rejects unsafe asset bases", () => {
    expect(() => renderPublicViewerTemplate({ snapshot: fixtureJsonl(), assetBase: "https://evil.example" })).toThrow();
    expect(() => renderPublicViewerTemplate({ snapshot: fixtureJsonl(), installUrl: "javascript:alert(1)" })).toThrow();
  });

  it("publishes the CSP contract as a small deterministic value", () => {
    expect(publicViewerCsp()).toContain("connect-src 'none'");
    expect(publicViewerCsp()).toContain("script-src 'self'");
    expect(publicViewerCsp()).toContain("frame-ancestors 'none'");
  });
});
