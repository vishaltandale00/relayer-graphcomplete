import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { resolveAcceptedNodeDetailAsset, resolveImportedInvocationAsset, resolveNativeInvocationAsset } from "../desktop/renderer/src/node-detail-assets.js";

function fixture() {
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const asset = { id: "visual/a", digestSha256: createHash("sha256").update(bytes).digest("hex"), mediaType: "image/svg+xml" };
  const response = { assetId: asset.id, digestSha256: asset.digestSha256, mediaType: asset.mediaType, byteLength: bytes.length, contentBase64: bytes.toString("base64") };
  const dependencies = { request: vi.fn(async () => response), crypto: webcrypto, URL: { createObjectURL: vi.fn(() => "blob:accepted"), revokeObjectURL: vi.fn() } };
  return { asset, response, dependencies, context: { threadId: 1, interactionId: 2, nodeId: 3, layerId: 4 } };
}

describe("accepted node detail asset delivery", () => {
  it("checks bytes before creating a releasable blob and uses the selected accepted graph", async () => {
    const { asset, context, dependencies } = fixture();
    const result = await resolveAcceptedNodeDetailAsset(asset, context, dependencies);
    expect(dependencies.request).toHaveBeenCalledWith("/api/threads/1/interactions/2/nodes/3/detail-assets/visual%2Fa?layerId=4");
    expect(result.url).toBe("blob:accepted");
    expect(dependencies.URL.createObjectURL.mock.calls[0][0].type).toBe(asset.mediaType);
    result.release(); result.release();
    expect(dependencies.URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:accepted");
  });

  it.each([
    ["assetId", "different"], ["digestSha256", "0".repeat(64)], ["mediaType", "text/html"],
    ["byteLength", 0], ["byteLength", 8 * 1024 * 1024 + 1], ["contentBase64", "!!!!"],
  ])("rejects mismatched %s before allocating a blob", async (key, value) => {
    const { asset, context, dependencies, response } = fixture();
    response[key] = value;
    await expect(resolveAcceptedNodeDetailAsset(asset, context, dependencies)).rejects.toThrow();
    expect(dependencies.URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects changed bytes even when the response claims the pinned digest", async () => {
    const { asset, context, dependencies, response } = fixture();
    response.contentBase64 = Buffer.alloc(response.byteLength, 65).toString("base64");
    await expect(resolveAcceptedNodeDetailAsset(asset, context, dependencies)).rejects.toThrow("digest mismatch");
    expect(dependencies.URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("does not request bytes without graph authority", async () => {
    const { asset, context, dependencies } = fixture();
    await expect(resolveAcceptedNodeDetailAsset(asset, { ...context, interactionId: undefined }, dependencies)).rejects.toThrow();
    expect(dependencies.request).not.toHaveBeenCalled();
  });
});


describe("inert imported Current asset delivery", () => {
  it.each(["valid", "wrong-node", "wrong-layer", "unowned-pin", "changed-bytes", "missing-content"])("resolves local exact pins with no native request (%s)", async corruption => {
    const { asset, response, dependencies } = fixture();
    const context = { nodeId: "node:current", layerId: "layer:current" };
    const association = { assetId: asset.id, digestSha256: asset.digestSha256, mediaType: asset.mediaType, byteLength: response.byteLength };
    const history = { inert: true, record: { current: { layers: [{ layer: { id: context.layerId }, nodes: [{ id: context.nodeId, authoredDetailAssets: [association] }], actions: [] }] } }, visualAssetContents: [structuredClone(response)] };
    if (corruption === "wrong-node") context.nodeId = "node:other";
    if (corruption === "wrong-layer") context.layerId = "layer:other";
    if (corruption === "unowned-pin") association.assetId = "other-asset";
    if (corruption === "changed-bytes") history.visualAssetContents[0].contentBase64 = Buffer.from("x".repeat(response.byteLength)).toString("base64");
    if (corruption === "missing-content") history.visualAssetContents = [];
    if (corruption === "valid") {
      const result = await resolveImportedInvocationAsset(asset, history, context, dependencies);
      expect(result.url).toBe("blob:accepted");
      result.release(); result.release();
      expect(dependencies.URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:accepted");
    } else {
      await expect(resolveImportedInvocationAsset(asset, history, context, dependencies)).rejects.toThrow();
      expect(dependencies.URL.createObjectURL).not.toHaveBeenCalled();
    }
    expect(dependencies.request).not.toHaveBeenCalled();
  });
});

describe("inert imported frozen-source icon delivery", () => {
  it.each([
    "valid", "wrong-node", "wrong-layer", "wrong-call", "not-inert", "wrong-icon",
    "wrong-pin", "wrong-digest", "wrong-media", "missing-pin", "omitted", "missing-content",
    "changed-bytes", "oversized-bytes",
  ])("resolves only the retained per-call SVG without native reads (%s)", async scenario => {
    const { asset, response, dependencies } = fixture();
    const context = { frozenSource: true, nodeId: "node:source", layerId: "source-layer:invocation:a" };
    const source = {
      parentNodeId: context.nodeId,
      icon: { kind: "image", assetId: asset.id, digestSha256: asset.digestSha256, mediaType: asset.mediaType },
      iconAsset: { assetId: asset.id, digestSha256: asset.digestSha256, mediaType: asset.mediaType, byteLength: response.byteLength },
    };
    const history = { inert: true, record: { id: "invocation:a", source }, visualAssetContents: [structuredClone(response)] };
    if (scenario === "wrong-node") context.nodeId = "node:other";
    if (scenario === "wrong-layer") context.layerId = "source-layer:invocation:b";
    if (scenario === "wrong-call") history.record.id = "invocation:b";
    if (scenario === "not-inert") history.inert = false;
    if (scenario === "wrong-icon") source.icon.assetId = "other";
    if (scenario === "wrong-pin") source.iconAsset.assetId = "other";
    if (scenario === "wrong-digest") source.iconAsset.digestSha256 = "0".repeat(64);
    if (scenario === "wrong-media") source.iconAsset.mediaType = "text/html";
    if (scenario === "missing-pin") delete source.iconAsset;
    if (scenario === "omitted") source.iconAssetOmitted = true;
    if (scenario === "missing-content") history.visualAssetContents = [];
    if (scenario === "changed-bytes") history.visualAssetContents[0].contentBase64 = Buffer.alloc(response.byteLength, 65).toString("base64");
    if (scenario === "oversized-bytes") source.iconAsset.byteLength = history.visualAssetContents[0].byteLength = 8 * 1024 * 1024 + 1;
    if (scenario === "valid") {
      const result = await resolveImportedInvocationAsset(asset, history, context, dependencies);
      const blob = dependencies.URL.createObjectURL.mock.calls[0][0];
      expect(blob.type).toBe("image/svg+xml");
      expect(Buffer.from(await blob.arrayBuffer()).toString()).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
      result.release(); result.release();
      expect(dependencies.URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:accepted");
    } else {
      await expect(resolveImportedInvocationAsset(asset, history, context, dependencies)).rejects.toThrow();
      expect(dependencies.URL.createObjectURL).not.toHaveBeenCalled();
    }
    expect(dependencies.request).not.toHaveBeenCalled();
  });
});

describe("graph-owned native Current asset delivery", () => {
  it.each(["valid", "returned-root-valid", "wrong-source", "wrong-key", "wrong-node", "wrong-layer", "child-anchor"])("uses only the real source Product read scope (%s)", async scenario => {
    const { asset, dependencies, context } = fixture();
    const sourceInteraction = { id: 2, threadId: 1, graphNodeId: 50 };
    const call = { graphOnly: true, sourceInteractionId: 2, actionId: 8, invocationKey: "call-a", resultCompletionStatus: "stopped",
      nativeInvocation: { sourceAction: { id: 8, sourceNodeId: 9 }, parentNode: { id: 9 },
        invocation: { id: 70, invocationKey: "call-a", sourceCompletionId: 50, sourceActionId: 8, parentNodeId: 9, childInteractionNodeId: 700,
          actionSnapshot: { actionId: 8, sourceNodeId: 9 }, state: { completionId: 700, currentLayerId: 4, lifecycle: "stopped" } },
        current: { nodeId: 700, rootLayerId: 4, layers: [{ layer: { id: 4, state: "accepted" }, nodes: [{ id: 3, state: "accepted" }], actions: [], edges: [] }] } } };
    const view = { ...context, sourceInteraction, interaction: { id: "native-current:70" } };
    if (scenario === "returned-root-valid") {
      view.nodeId = 700;
      call.resultCompletionStatus = "accepted";
      call.nativeInvocation.invocation.state.lifecycle = "succeeded";
      call.nativeInvocation.current.rootAction = { state: "accepted", kind: "navigate", sourceNodeId: 700, targetLayerId: 4,
        icon: { kind: "image", assetId: asset.id, digestSha256: asset.digestSha256, mediaType: asset.mediaType } };
    }
    if (scenario === "wrong-source") view.sourceInteraction = { ...sourceInteraction, graphNodeId: 51 };
    if (scenario === "wrong-key") call.invocationKey = "other";
    if (scenario === "wrong-node") view.nodeId = 5;
    if (scenario === "wrong-layer") view.layerId = 6;
    if (scenario === "child-anchor") view.nodeId = 700;
    if (scenario === "valid" || scenario === "returned-root-valid") {
      const result = await resolveNativeInvocationAsset(asset, call, view, dependencies);
      expect(dependencies.request).toHaveBeenCalledExactlyOnceWith(`/api/threads/1/interactions/2/nodes/${view.nodeId}/detail-assets/visual%2Fa?layerId=4`);
      result.release();
    } else {
      await expect(resolveNativeInvocationAsset(asset, call, view, dependencies)).rejects.toThrow("native Current");
      expect(dependencies.request).not.toHaveBeenCalled();
    }
  });
});
