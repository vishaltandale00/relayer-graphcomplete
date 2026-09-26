import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GraphVisualAssets, type VisualAssetScope } from "../src/visual-assets.js";

describe("graph visual asset file transport", () => {
  it("round trips a downloaded file through add without losing its digest or exposing mutable stored bytes", async () => {
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const expectedDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    let added: Record<string, unknown> | undefined;
    const client = new GraphVisualAssets(async (_path, init) => {
      const { operation } = JSON.parse(String(init?.body)) as { operation: Record<string, unknown> };
      if (operation.kind === "download") return {
        name: "illustration.svg", mediaType: "image/svg+xml", expectedDigest, contentBase64: bytes.toString("base64"),
      };
      added = operation;
      return { id: "copy", digest: expectedDigest };
    });
    const file = await client.download("original", { kind: "library" });
    (await file.read()).fill(0);
    expect(Buffer.from(await file.read())).toEqual(bytes);
    await client.add({ file, scope: { kind: "thread", threadId: 1 }, name: "Copy" });
    expect(added?.file).toEqual({
      name: "illustration.svg", mediaType: "image/svg+xml", expectedDigest, contentBase64: bytes.toString("base64"),
    });
  });

  it("rejects downloaded bytes that do not match their advertised digest", async () => {
    const client = new GraphVisualAssets(async () => ({
      name: "image.svg", mediaType: "image/svg+xml", contentBase64: Buffer.from("changed").toString("base64"),
      expectedDigest: `sha256:${"0".repeat(64)}`,
    }));
    await expect(client.download("original", { kind: "library" })).rejects.toThrow("corrupt");
  });

  it("captures add metadata before an asynchronous file read", async () => {
    let release!: (bytes: Uint8Array) => void;
    let posted: Record<string, unknown> | undefined;
    const client = new GraphVisualAssets(async (_path, init) => {
      posted = JSON.parse(String(init?.body)).operation as Record<string, unknown>;
      return { id: "new", digest: "sha256:original" };
    });
    const scope: Extract<VisualAssetScope, { kind: "thread" }> = { kind: "thread", threadId: 1 };
    const mutableScope = scope as { kind: "thread"; threadId: number };
    const input = {
      scope, name: "Original", tagIds: ["original-tag"],
      file: { name: "original.png", mediaType: "image/png", read: () => new Promise<Uint8Array>((resolve) => { release = resolve; }) },
    };
    const pending = client.add(input);
    mutableScope.threadId = 99;
    input.name = "Changed";
    input.file.name = "changed.png";
    input.tagIds.push("new-tag");
    release(new Uint8Array([1]));
    await pending;
    expect(posted).toMatchObject({ scope: { kind: "thread", threadId: 1 }, name: "Original", tagIds: ["original-tag"], file: { name: "original.png" } });
  });
});
