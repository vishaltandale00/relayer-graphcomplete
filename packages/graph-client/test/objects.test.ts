import { afterEach, describe, expect, it, vi } from "vitest";
import { DETAIL_AUTHORING_LIMITS, EdgeObject, LayerLayoutObject, LayerObject, NodeObject, NodePlacementObject, RelayerGraphClient, assetRef, html, type ActionObject } from "../src/index.js";
import { edgeId, layerId, nodeId } from "../src/objects.js";

describe("agent-facing graph objects", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not require the model to invent durable IDs", async () => {
    const node = new NodeObject("box", "Queue", "Waiting work", "concept", "queue");
    const edge = new EdgeObject([node, 9], "queue-worker");
    const layer = new LayerObject(
      [node, 9],
      [edge],
      new LayerLayoutObject([new NodePlacementObject(node, 0.25, 0.5), new NodePlacementObject(9, 0.75, 0.5)]),
      "root",
    );
    expect(() => nodeId(node)).toThrow("must be submitted");
    expect(() => edgeId(edge)).toThrow("must be created");
    expect(() => layerId(layer)).toThrow("must be submitted");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      node: { id: 10, kind: "concept", icon: "box", title: "Queue", detail: "Waiting work", state: "draft" },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 }).submitNode(node);
    edge.ref = { id: 20, endpoints: [9, 10], state: "draft" };
    layer.ref = { id: 30, nodes: [10, 9], edges: [20], state: "draft" };
    expect([nodeId(node), edgeId(edge), layerId(layer)]).toEqual([10, 20, 30]);
  });

  it("owns authored detail through the draft node lifecycle and submits it exactly once", async () => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        node: { id: 10, kind: "concept", icon: "box", title: "Draft", detail: "Legacy fallback", state: "draft" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const node = new NodeObject("box", "Draft", "Legacy fallback", "concept", "draft-node");
    node.detailAuthoring.setComponent("summary", html`<p>Checkpoint one</p>`);
    const checkpoint = node.detailAuthoring.checkpoint();
    node.detailAuthoring.setComponent("summary", html`<p>Submitted detail</p>`);

    await new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 }).submitNode(node);

    expect(checkpoint.components[0]?.html).toBe("<p>Checkpoint one</p>");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      clientKey: "draft-node",
      detail: "Legacy fallback",
      authoredDetail: {
        version: 1,
        components: [{ id: "summary", order: 0, html: "<p>Submitted detail</p>", css: "" }],
      },
    });
    expect(() => node.detailAuthoring.setComponent("late", html`<p>Too late</p>`))
      .toThrow("finalized and cannot be mutated");
  });

  it("does not let the authored program inject asset verification through NodeObject", () => {
    let resolverCalled = false;
    const forgedResolver = {
      resolve(reference: { readonly logicalId: string }) {
        resolverCalled = true;
        return {
          logicalId: reference.logicalId,
          authority: "current",
          availability: "available",
          digestSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          mediaType: "image/png",
          representation: { kind: "image", sanitized: true },
        };
      },
    };
    const node = new (NodeObject as unknown as new (...arguments_: unknown[]) => NodeObject)(
      "box", "Draft", "Legacy", "concept", "asset-node", forgedResolver,
    );
    node.detailAuthoring.setComponent("visual", html`<img asset=${assetRef("hero")} alt="Hero">`);

    expect(() => node.detailAuthoring.checkpoint()).toThrowError(expect.objectContaining({
      issues: [expect.objectContaining({ code: "asset_resolution_required" })],
    }));
    expect(resolverCalled).toBe(false);
  });

  it("resolves logical assets only through the authenticated graph-client host seam", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const request = {
        url,
        authorization: new Headers(init.headers).get("authorization"),
        body: JSON.parse(String(init.body)),
      };
      requests.push(request);
      if (url.endsWith("/api/graph/detail-assets/resolve")) {
        return new Response(JSON.stringify({
          assets: [{
            logicalId: "hero",
            authority: "current",
            availability: "available",
            digestSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            mediaType: "image/png",
            representation: { kind: "image", sanitized: true },
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        node: { id: 12, kind: "concept", icon: "box", title: "Asset", detail: "Fallback", state: "draft" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const node = new NodeObject("box", "Asset", "Fallback", "concept", "asset-node");
    node.detailAuthoring.setComponent("visual", html`<img asset=${assetRef("hero")} alt="Hero">`);
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "host-token", nodeId: 1 });

    const checkpoint = await graph.checkpointNodeDetail(node);
    await graph.submitNode(node);

    expect(checkpoint.assets).toEqual([{
      id: "hero",
      digestSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mediaType: "image/png",
      representation: "image",
    }]);
    expect(requests[0]).toEqual({
      url: "http://127.0.0.1:1/api/graph/detail-assets/resolve",
      authorization: "Bearer host-token",
      body: { logicalIds: ["hero"] },
    });
    expect(requests[1]).toMatchObject({
      url: "http://127.0.0.1:1/api/graph/detail-assets/resolve",
      authorization: "Bearer host-token",
      body: { logicalIds: ["hero"] },
    });
    expect(requests[2]).toMatchObject({
      url: "http://127.0.0.1:1/api/graph/nodes",
      authorization: "Bearer host-token",
      body: { authoredDetail: checkpoint },
    });
  });

  it("rejects hostile authenticated asset responses as deterministic typed errors", async () => {
    const valid = (logicalId: string) => ({
      logicalId,
      authority: "current",
      availability: "available",
      digestSha256: "a".repeat(64),
      mediaType: "image/png",
      representation: { kind: "image", sanitized: true },
    });
    const cases: readonly {
      readonly name: string;
      readonly logicalIds: readonly string[];
      readonly body: unknown;
      readonly path: string;
    }[] = [
      { name: "null body", logicalIds: ["hero"], body: null, path: "response" },
      { name: "missing assets", logicalIds: ["hero"], body: {}, path: "assets" },
      { name: "extra response field", logicalIds: ["hero"], body: { assets: [valid("hero")], extra: true }, path: "response" },
      { name: "missing record", logicalIds: ["hero"], body: { assets: [] }, path: "assets" },
      { name: "extra record", logicalIds: ["hero"], body: { assets: [valid("hero"), valid("extra")] }, path: "assets" },
      { name: "duplicate record", logicalIds: ["hero", "logo"], body: { assets: [valid("hero"), valid("hero")] }, path: "assets[1].logicalId" },
      { name: "wrong identity", logicalIds: ["hero"], body: { assets: [valid("other")] }, path: "assets[0].logicalId" },
      { name: "non-object record", logicalIds: ["hero"], body: { assets: [null] }, path: "assets[0]" },
      { name: "extra record field", logicalIds: ["hero"], body: { assets: [{ ...valid("hero"), injected: true }] }, path: "assets[0]" },
      { name: "invalid authority", logicalIds: ["hero"], body: { assets: [{ ...valid("hero"), authority: "root" }] }, path: "assets[0].authority" },
      { name: "invalid availability", logicalIds: ["hero"], body: { assets: [{ ...valid("hero"), availability: "maybe" }] }, path: "assets[0].availability" },
      { name: "invalid digest", logicalIds: ["hero"], body: { assets: [{ ...valid("hero"), digestSha256: "A".repeat(64) }] }, path: "assets[0].digestSha256" },
      { name: "invalid media", logicalIds: ["hero"], body: { assets: [{ ...valid("hero"), mediaType: "text/html" }] }, path: "assets[0].mediaType" },
      { name: "invalid representation", logicalIds: ["hero"], body: { assets: [{ ...valid("hero"), representation: { kind: "video", sanitized: true } }] }, path: "assets[0].representation.kind" },
      { name: "non-boolean sanitization", logicalIds: ["hero"], body: { assets: [{ ...valid("hero"), representation: { kind: "image", sanitized: "true" } }] }, path: "assets[0].representation.sanitized" },
    ];

    for (const [caseIndex, hostile] of cases.entries()) {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(hostile.body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      vi.stubGlobal("fetch", fetchMock);
      const node = new NodeObject("box", hostile.name, "Fallback", "concept", `hostile-${caseIndex}`);
      for (const [assetIndex, logicalId] of hostile.logicalIds.entries()) {
        node.detailAuthoring.setComponent(`visual-${assetIndex}`, html`<img asset=${assetRef(logicalId)} alt="Visual">`);
      }
      const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "host-token", nodeId: 1 });

      await expect(graph.checkpointNodeDetail(node)).rejects.toMatchObject({
        name: "GraphApiError",
        status: 200,
        code: "invalid_detail_asset_response",
        path: hostile.path,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects malformed logical asset IDs before authenticated transport", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "host-token", nodeId: 1 });
    const invalidIds = [" ", "nul\0asset", "é".repeat(65)];

    for (const [index, logicalId] of invalidIds.entries()) {
      const node = new NodeObject("box", "Asset", "Fallback", "concept", `invalid-asset-${index}`);
      node.detailAuthoring.setComponent("visual", html`<span asset=${assetRef(logicalId)} aria-hidden="true"></span>`);
      await expect(graph.checkpointNodeDetail(node)).rejects.toThrowError(expect.objectContaining({
        issues: [expect.objectContaining({ code: "asset_identity_invalid", componentId: "visual" })],
      }));
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds and deduplicates logical asset references before authenticated transport", async () => {
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { logicalIds: readonly string[] };
      requests.push(body);
      return new Response(JSON.stringify({
        assets: body.logicalIds.map((logicalId) => ({
          logicalId,
          authority: "current",
          availability: "available",
          digestSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          mediaType: "image/png",
          representation: { kind: "image", sanitized: true },
        })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "host-token", nodeId: 1 });
    const deduped = new NodeObject("box", "Assets", "Fallback", "concept", "deduped-assets");
    deduped.detailAuthoring.setComponent("first", html`<span asset=${assetRef("shared")} aria-hidden="true"></span>`);
    deduped.detailAuthoring.setComponent("second", html`<span asset=${assetRef("shared")} aria-hidden="true"></span>`);

    await graph.checkpointNodeDetail(deduped);

    expect(requests).toEqual([{ logicalIds: ["shared"] }]);

    const excessive = new NodeObject("box", "Assets", "Fallback", "concept", "excessive-assets");
    for (let index = 0; index <= DETAIL_AUTHORING_LIMITS.maxAssetsPerPackage; index += 1) {
      excessive.detailAuthoring.setComponent(`asset-${index}`, html`<span asset=${assetRef(`asset-${index}`)} aria-hidden="true"></span>`);
    }
    await expect(graph.checkpointNodeDetail(excessive)).rejects.toThrowError(expect.objectContaining({
      issues: [expect.objectContaining({ code: "asset_package_limit_exceeded" })],
    }));
    expect(requests).toHaveLength(1);

    const excessiveReferences = new NodeObject("box", "Assets", "Fallback", "concept", "excessive-asset-references");
    for (let index = 0; index <= DETAIL_AUTHORING_LIMITS.maxAssetReferencesPerPackage; index += 1) {
      excessiveReferences.detailAuthoring.setComponent(`reference-${index}`, html`<span asset=${assetRef("shared")} aria-hidden="true"></span>`);
    }
    await expect(graph.checkpointNodeDetail(excessiveReferences)).rejects.toThrowError(expect.objectContaining({
      issues: [expect.objectContaining({ code: "asset_reference_limit_exceeded" })],
    }));
    expect(requests).toHaveLength(1);
  });

  it("freezes before a failed submit and retries with byte-identical authored detail", async () => {
    let resolverRequests = 0;
    let nodeRequests = 0;
    const submittedBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/graph/detail-assets/resolve")) {
        resolverRequests += 1;
        return new Response(JSON.stringify({
          assets: [{
            logicalId: "retry-hero",
            authority: "current",
            availability: "available",
            digestSha256: resolverRequests === 1
              ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
              : "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            mediaType: "image/png",
            representation: { kind: "image", sanitized: true },
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      nodeRequests += 1;
      submittedBodies.push(String(init.body));
      if (nodeRequests === 1) {
        return new Response(JSON.stringify({ error: { code: "temporary_failure", message: "retry" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        node: { id: 13, kind: "concept", icon: "box", title: "Retry", detail: "Fallback", state: "draft" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const node = new NodeObject("box", "Retry", "Fallback", "concept", "retry-node");
    node.detailAuthoring.setComponent("visual", html`<img asset=${assetRef("retry-hero")} alt="Retry hero">`);
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });

    await expect(graph.submitNode(node)).rejects.toMatchObject({ status: 503, code: "temporary_failure" });
    expect(() => node.detailAuthoring.setComponent("late", html`<p>Drift</p>`)).toThrow("finalized");
    await expect(graph.submitNode(node)).resolves.toMatchObject({ id: 13 });

    expect(resolverRequests).toBe(1);
    expect(submittedBodies).toHaveLength(2);
    expect(submittedBodies[1]).toBe(submittedBodies[0]);
  });

  it("single-flights first finalization and transport across concurrent submissions", async () => {
    let releaseResolution!: () => void;
    const resolutionGate = new Promise<void>((resolve) => { releaseResolution = resolve; });
    let resolverRequests = 0;
    const submittedBodies: string[] = [];
    const mutationResults: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/graph/detail-assets/resolve")) {
        resolverRequests += 1;
        const requestNumber = resolverRequests;
        await resolutionGate;
        return new Response(JSON.stringify({
          assets: [{
            logicalId: "single-flight-logo",
            authority: "current",
            availability: "available",
            digestSha256: requestNumber === 1 ? "a".repeat(64) : "b".repeat(64),
            mediaType: "image/png",
            representation: { kind: "image", sanitized: true },
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      submittedBodies.push(String(init.body));
      try {
        node.detailAuthoring.setComponent("late", html`<p>Drift</p>`);
        mutationResults.push("mutated");
      } catch {
        mutationResults.push("frozen");
      }
      return new Response(JSON.stringify({
        node: { id: 14, kind: "concept", icon: "box", title: "Concurrent", detail: "Fallback", state: "draft" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const node = new NodeObject("box", "Concurrent", "Fallback", "concept", "concurrent-node");
    node.detailAuthoring.setComponent("visual", html`<img asset=${assetRef("single-flight-logo")} alt="Logo">`);
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });

    const submissions = [graph.submitNode(node), graph.submitNode(node)];
    await vi.waitFor(() => expect(resolverRequests).toBeGreaterThan(0));
    releaseResolution();
    await expect(Promise.all(submissions)).resolves.toHaveLength(2);

    expect(resolverRequests).toBe(1);
    expect(submittedBodies).toHaveLength(1);
    expect(mutationResults).toEqual(["frozen"]);
  });

  it("drops failed compilation finalization so the unfrozen author can repair", async () => {
    let nodeRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      nodeRequests += 1;
      return new Response(JSON.stringify({
        node: { id: 15, kind: "concept", icon: "box", title: "Repair", detail: "Fallback", state: "draft" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const node = new NodeObject("box", "Repair", "Fallback", "concept", "repair-node");
    node.detailAuthoring.setComponent("content", html`<script>unsafe()</script>`);
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });

    await expect(graph.submitNode(node)).rejects.toThrowError(expect.objectContaining({
      issues: [expect.objectContaining({ code: "unsafe_html_element" })],
    }));
    node.detailAuthoring.setComponent("content", html`<p>Repaired</p>`);
    await expect(graph.submitNode(node)).resolves.toMatchObject({ id: 15 });

    expect(nodeRequests).toBe(1);
    expect(() => node.detailAuthoring.setComponent("late", html`<p>Drift</p>`)).toThrow("finalized");
  });

  it("keeps the legacy string-only submit request backward compatible while locking its empty builder", async () => {
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      request = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        node: { id: 11, kind: "concept", icon: "box", title: "Legacy", detail: "Markdown detail", state: "draft" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const node = new NodeObject("box", "Legacy", "Markdown detail", "concept", "legacy-node");

    await new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 }).submitNode(node);

    expect(request).toEqual({
      clientKey: "legacy-node",
      kind: "concept",
      icon: "box",
      title: "Legacy",
      detail: "Markdown detail",
    });
    expect(() => node.detailAuthoring.setComponent("late", html`<p>Too late</p>`)).toThrow("finalized");
  });

  it("serializes a versioned authored layout from node references", async () => {
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/graph/nodes")) {
        const input = JSON.parse(String(init.body)) as Record<string, string>;
        return new Response(JSON.stringify({
          node: {
            id: input.clientKey === "left" ? 10 : 11,
            kind: input.kind,
            icon: input.icon,
            title: input.title,
            detail: input.detail,
            state: "draft",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      request = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        layer: { id: 30, nodes: [10, 11], edges: [], layout: request?.layout, state: "draft" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const left = new NodeObject("box", "Left", "Left detail", "concept", "left");
    const right = new NodeObject("box", "Right", "Right detail", "concept", "right");
    const layer = new LayerObject(
      [left, right],
      [],
      new LayerLayoutObject([new NodePlacementObject(left, 0.2, 0.5), new NodePlacementObject(right, 0.8, 0.5)]),
      "comparison",
    );

    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
    await graph.submitNode(left);
    await graph.submitNode(right);
    await graph.submitLayer(layer);

    expect(request).toMatchObject({
      clientKey: "comparison",
      layout: { version: 1, placements: [{ nodeId: 10, x: 0.2, y: 0.5 }, { nodeId: 11, x: 0.8, y: 0.5 }] },
    });
    expect(layer.ref?.layout).toEqual(request?.layout);
  });

  it("rejects an unresolved placement reference before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const node = new NodeObject("box", "Pending", "Not submitted");
    const layer = new LayerObject([1], [], new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)]));

    await expect(new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 }).submitLayer(layer))
      .rejects.toThrow("must be submitted");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains a generated action key when the same object is retried", async () => {
    const keys: string[] = [];
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { clientKey: string } & Record<string, unknown>;
      keys.push(body.clientKey);
      requests.push(body);
      return new Response(JSON.stringify({
        action: { id: 40, sourceNodeId: 1, sourceLayerId: 2, kind: "invoke", label: "Ask", variant: "pill", icon: null, description: null, interactionText: "Continue", state: "draft" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
    const action: ActionObject = { kind: "invoke", label: "Ask", interactionText: "Continue", sourceLayer: 2 };

    await graph.addAction(1, action);
    await graph.addAction(1, action);

    expect(action.clientKey).toBeTypeOf("string");
    expect(keys).toEqual([action.clientKey, action.clientKey]);
    expect(requests[0]).toMatchObject({ variant: "pill", icon: null, description: null });
  });

  it("prepares a canonical child pointer from one persisted invoke action", async () => {
    let observed: { url: string; body: unknown; authorization: string | null } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      observed = {
        url,
        body: JSON.parse(String(init.body)),
        authorization: new Headers(init.headers).get("authorization"),
      };
      return new Response(JSON.stringify({ interactionNode: 91 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "parent", nodeId: 1 });
    const action: ActionObject = {
      kind: "invoke",
      label: "Child",
      interactionText: "Do child work",
      sourceLayer: 7,
      ref: {
        id: 44,
        sourceNodeId: 2,
        sourceLayerId: 7,
        kind: "invoke",
        label: "Child",
        variant: "pill",
        interactionText: "Do child work",
        state: "accepted",
      },
    };

    await expect(graph.prepareComplete(action)).resolves.toEqual({ interactionNode: 91 });
    expect(observed).toEqual({
      url: "http://127.0.0.1:1/api/graph/completions/prepare",
      body: { actionId: 44 },
      authorization: "Bearer parent",
    });
  });

  it("authors structured input actions without a provider side channel", async () => {
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      request = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ action: { id: 42, ...request, state: "draft" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });

    await graph.addAction(10, {
      kind: "input",
      sourceLayer: 20,
      label: "Choose evidence",
      control: "multi_select",
      prompt: "Which evidence should be emphasized?",
      options: [{ key: "logs", label: "Logs" }, { key: "traces", label: "Traces" }],
      minimumSelections: 1,
      clientKey: "evidence-input",
    });

    expect(request).toEqual({
      clientKey: "evidence-input",
      sourceNodeId: 10,
      sourceLayerId: 20,
      kind: "input",
      label: "Choose evidence",
      variant: "pill",
      icon: null,
      description: null,
      control: "multi_select",
      prompt: "Which evidence should be emphasized?",
      options: [{ key: "logs", label: "Logs" }, { key: "traces", label: "Traces" }],
      minimumSelections: 1,
    });

    await graph.addAction(10, {
      kind: "input",
      sourceLayer: 20,
      label: "Explain",
      control: "text",
      prompt: "Explain the tradeoff",
      clientKey: "text-input",
    });
    expect(request).not.toHaveProperty("options");
  });

  it("exposes nullable interaction lease identity on node reads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      nodes: [{
        id: 10,
        leasedActionId: 42,
        kind: "user-interaction",
        icon: "user",
        title: "Result",
        detail: "Result",
        state: "accepted",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 10 });
    const [source] = await graph.getNeighbors(10);
    expect(source?.leasedActionId).toBe(42);
  });

  it("reads normalized interaction context without authority provenance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      interaction: { id: 10, kind: "user-interaction", icon: "user", title: "Compare", detail: "Compare", state: "accepted" },
      contexts: [{
        type: "interaction.context",
        targetNode: { id: 7, kind: "concept", icon: "box", title: "Boundary", detail: "Evidence", state: "accepted" },
        annotations: ["First", "Second"],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 10 });

    const input = await graph.getInteractionInput();

    expect(input.contexts[0]).toMatchObject({
      type: "interaction.context",
      targetNode: { id: 7, title: "Boundary" },
      annotations: ["First", "Second"],
    });
    expect(input.contexts[0]).not.toHaveProperty("id");
    expect(input.contexts[0]).not.toHaveProperty("sourceNodeId");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:1/api/graph/input",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer token" }) }),
    );
  });

  it("reads the hidden personal presentation graph through its dedicated capability boundary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      attachment: { interactionNodeId: 10, versionInteractionNodeId: 90, rootLayerId: 91 },
      graph: {
        nodeId: 90,
        rootLayerId: 91,
        rootAction: { id: 92, sourceNodeId: 90, kind: "navigate", relation: "expand", label: "Personal presentation", variant: "pill", targetLayerId: 91, state: "accepted" },
        layers: [{
          layer: { id: 91, nodes: [93], edges: [], state: "accepted" },
          nodes: [{ id: 93, kind: "presentation-preference", icon: "compass", title: "Decision-useful center", detail: "Foreground the conclusion.", state: "accepted" }],
          edges: [], actions: [],
        }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 10 });

    const presentation = await graph.getPersonalPresentation();

    expect(presentation.attachment.versionInteractionNodeId).toBe(90);
    expect(presentation.graph.layers[0]?.nodes[0]?.kind).toBe("presentation-preference");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:1/api/graph/personal-presentation",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer token" }) }),
    );
  });

  it("reads submitted input snapshots without child or occurrence authority", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      interaction: { id: 10, kind: "user-interaction", icon: "user", title: "", detail: "", state: "accepted" },
      contexts: [],
      submittedInputs: [{
        action: { control: "single_select", prompt: "Choose evidence", options: [{ key: "logs", label: "Logs" }] },
        value: { selected: [{ key: "logs", label: "Logs" }] },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 10 });

    const input = await graph.getInteractionInput();

    expect(input.submittedInputs?.[0]).toEqual({
      action: { control: "single_select", prompt: "Choose evidence", options: [{ key: "logs", label: "Logs" }] },
      value: { selected: [{ key: "logs", label: "Logs" }] },
    });
    expect(input.submittedInputs?.[0]).not.toHaveProperty("actionId");
    expect(input.submittedInputs?.[0]).not.toHaveProperty("occurrence");
  });

  it("discards a submitted layer and refreshes its object reference", async () => {
    let request: { url: string; method?: string } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      request = { url, ...(init.method === undefined ? {} : { method: init.method }) };
      return new Response(JSON.stringify({
        layer: { id: 30, nodes: [10], edges: [], state: "stopped" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
    const layer = new LayerObject(
      [10],
      [],
      new LayerLayoutObject([new NodePlacementObject(10, 0.5, 0.5)]),
      "abandoned",
    );
    layer.ref = { id: 30, nodes: [10], edges: [], state: "draft" };

    const stopped = await graph.discardLayer(layer);

    expect(request).toEqual({
      url: "http://127.0.0.1:1/api/graph/layers/30/discard",
      method: "POST",
    });
    expect(stopped.state).toBe("stopped");
    expect(layer.ref).toEqual(stopped);
  });

  it("serializes card presentation as canonical action data", async () => {
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      request = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        action: {
          id: 41,
          sourceNodeId: 1,
          sourceLayerId: 3,
          kind: "navigate",
          relation: "reference",
          label: "Compare approaches",
          variant: "card",
          icon: "git-compare",
          description: "Lay out the tradeoffs before choosing.",
          targetLayerId: 9,
          state: "draft",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });

    const action = await graph.addAction(1, {
      kind: "navigate",
      relation: "reference",
      label: "Compare approaches",
      target: 9,
      sourceLayer: 3,
      variant: "card",
      icon: "git-compare",
      description: "Lay out the tradeoffs before choosing.",
    });

    expect(request).toMatchObject({
      kind: "navigate",
      relation: "reference",
      label: "Compare approaches",
      sourceLayerId: 3,
      targetLayerId: 9,
      variant: "card",
      icon: "git-compare",
      description: "Lay out the tradeoffs before choosing.",
    });
    expect(action.variant).toBe("card");
  });

  it("keeps every actionable validation issue from a rejected tool call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: "layer_node_count",
        path: "nodes",
        message: "Repair both layer problems.",
        issues: [
          { code: "layer_node_count", path: "nodes", message: "Split the layer." },
          { code: "duplicate_layer_node", path: "nodes", message: "Remove the duplicate node." },
        ],
      },
    }), { status: 422, headers: { "content-type": "application/json" } })));
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });

    await expect(graph.submitLayer(new LayerObject([1], [], new LayerLayoutObject([new NodePlacementObject(1, 0.5, 0.5)]))))
      .rejects.toMatchObject({
      code: "layer_node_count",
      issues: [
        { code: "layer_node_count" },
        { code: "duplicate_layer_node" },
      ],
      });
  });
});
