// PRD 11.11: agents declare artifacts on node objects and artifact layers on layer objects.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayerObject, NodeObject, RelayerGraphClient } from "../src/index.js";

const FINGERPRINT = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("artifact nodes and layers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends artifact details with the node and keeps the server's fingerprinted copy", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        node: {
          id: 7, clientKey: request.clientKey, kind: "concept", icon: "globe", title: "Landing page",
          detail: "The site", state: "draft",
          artifact: { ...(request.artifact as object), fingerprint: FINGERPRINT },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    const node = new NodeObject("globe", "Landing page", "The site", "concept", "landing");
    node.artifact = { kind: "website", source: { file: "site/index.html", root: "site" }, part: { route: "#pricing" }, viewport: "phone" };
    const accepted = await new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 }).submitNode(node);
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body)).artifact).toEqual(node.artifact);
    expect(accepted.artifact?.fingerprint).toBe(FINGERPRINT);
    expect(Object.isFrozen(accepted.artifact)).toBe(true);
  });

  it("copies artifact details without running the author's code", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
    const ran = vi.fn(() => "/pricing");
    const cases = [
      { kind: "url", source: { url: "https://example.com/" }, part: { get route() { return ran(); } } },
      { kind: "url", source: { url: "https://example.com/" }, part: { route: "/pricing", toJSON: () => ran() } },
      { kind: "url", source: new Proxy({ url: "https://example.com/" }, { get: () => ran() }) },
      { kind: "url", source: { url: "https://example.com/" }, seed: { localStorage: { at: new Date(0) } } },
    ];
    for (const artifact of cases) {
      const node = new NodeObject("globe", "Deployed site", "The site", "concept", "deployed");
      node.artifact = artifact as never;
      await expect(client.submitNode(node)).rejects.toMatchObject({ issues: [expect.objectContaining({ code: "node_envelope_invalid" })] });
    }
    expect(ran).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("omits artifact for ordinary nodes", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ node: { id: 8, clientKey: request.clientKey, kind: "concept", icon: "box", title: "Plain", detail: "Plain", state: "draft" } }));
    });
    vi.stubGlobal("fetch", fetch);
    await new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 }).submitNode(new NodeObject("box", "Plain", "Plain"));
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).not.toHaveProperty("artifact");
  });

  it("builds a one-node artifact layer and sends its renderer", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) =>
      new Response(JSON.stringify({ layer: { ...JSON.parse(String(init.body)), id: 30, state: "draft" } })));
    vi.stubGlobal("fetch", fetch);
    const layer = LayerObject.forArtifact(7, "landing-viewer");
    expect(layer.renderer).toBe("artifact");
    await new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 }).submitLayer(layer);
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toMatchObject({
      clientKey: "landing-viewer",
      renderer: "artifact",
      nodes: [7],
      edges: [],
      defaultNodeId: 7,
      layout: { placements: [{ nodeId: 7, x: 0.5, y: 0.5 }], edgeShape: "default" },
    });
  });
});
