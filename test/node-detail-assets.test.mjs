import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { resolveAcceptedNodeDetailAsset } from "../desktop/renderer/src/node-detail-assets.js";

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
