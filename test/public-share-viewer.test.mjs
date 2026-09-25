import { beforeEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";

import { createPublicViewerAdapter } from "../desktop/renderer/src/public-share-viewer/adapter.js";
import {
  bootPublicViewer,
  fitPublicTurnPopover,
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
    expect(html).toContain('property="og:image" content="/assets/relayer-share-og.svg"');
    expect(html).toContain("connect-src &#39;none&#39;");
    expect(html).toContain('src="/vendor/marked.umd.js"');
    expect(html).toContain('src="/vendor/lucide.min.js"');
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("public-share-topbar");
    expect(html).not.toContain(">Open Relayer</a>");
    expect(html).not.toContain("public-share-footer");
  });

  it("keeps the static shell aligned with the generated no-top-bar contract", () => {
    const html = readFileSync(new URL("../desktop/renderer/public-share.html", import.meta.url), "utf8");
    expect(html).not.toContain("public-share-topbar");
    expect(html).not.toContain(">Open Relayer</a>");
    expect(html).not.toContain("public-share-footer");
    expect(html).toContain('class="public-share-download-card"');
    expect(html).toContain("Explore this thread, then build your own.");
  });

  it("lets the production workspace own the complete browser viewport", () => {
    const styles = readFileSync(new URL("../desktop/renderer/src/public-share-viewer/viewer.css", import.meta.url), "utf8");
    expect(styles).toMatch(/\.public-share-main\s*{[^}]*height: 100vh;/s);
    expect(styles).toMatch(/\.public-share-workspace-host\s*{[^}]*height: 100%;[^}]*border: 0;[^}]*border-radius: 0;/s);
  });

  it("aligns the turn picker to the interaction card with five visible rows", () => {
    const styles = readFileSync(new URL("../desktop/renderer/src/public-share-viewer/viewer.css", import.meta.url), "utf8");
    expect(styles).toMatch(/\.public-share-shell \.interaction-banner\s*{[^}]*position: relative;/s);
    expect(styles).toMatch(/\.public-share-shell \.turn-picker\s*{[^}]*position: static;/s);
    expect(styles).toMatch(/\.public-share-shell \.turn-popover\s*{[^}]*right: 0;[^}]*left: 0;[^}]*width: auto;[^}]*52px \* 5/s);
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

  it("preserves the complete accepted Unicode title contract", () => {
    const title = "🧭".repeat(120);
    const html = renderPublicViewerTemplate({ snapshot: fixtureJsonl(), title });
    expect(html).toContain(`<title>${title} · Relayer</title>`);
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

  it("boots the real ProductWorkspace at the first turn without changing the page URL", async () => {
    const windowRef = new Window({ url: `https://share.example.test/t/${"a".repeat(32)}` });
    windowRef.document.write(renderPublicViewerTemplate({ snapshot: fixtureJsonl() }));
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
    globalThis.marked = { parse: (value) => `<p><a href="https://example.test/docs">${value}</a></p>` };
    try {
      const originalUrl = windowRef.location.href;
      const onRenderError = vi.fn();
      const viewer = bootPublicViewer({ documentRef: windowRef.document, windowRef, onRenderError });
      expect(onRenderError).not.toHaveBeenCalled();
      expect(viewer).not.toBeNull();
      expect(viewer.adapter.selection.currentInteractionId).toBe("turn:1");
      expect(windowRef.document.querySelector("#publicViewerHost")?.classList.contains("hidden")).toBe(false);
      const downloadCard = windowRef.document.querySelector(".public-share-download-card");
      expect(downloadCard?.parentElement?.classList.contains("workspace-layout")).toBe(true);
      expect(downloadCard?.textContent).toContain("Relayer for Mac");
      expect(downloadCard?.textContent).toContain("Download");
      expect(windowRef.document.body.textContent).toContain("Environment");
      windowRef.document.querySelector(".graph-node")?.click();
      await vi.waitFor(() => expect(windowRef.document.querySelector('a[href="https://example.test/docs"]')).toMatchObject({
        target: "_blank",
      }));
      await viewer.adapter.navigateLayer("layer:nested", {
        action: viewer.adapter.state.actions[0],
        sourceNode: viewer.adapter.state.nodes[0],
      });
      viewer.render();
      expect(windowRef.location.href).toBe(originalUrl);
      viewer.dispose();
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
