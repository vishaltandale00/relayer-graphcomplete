// PRD 11.11: agents declare artifacts on node objects and artifact layers on layer objects.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphAuthoringWriteError, LayerObject, NodeObject, RelayerGraphClient, type ArtifactDetails } from "../src/index.js";

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

describe("scoped artifact nodes and layers", () => {
  afterEach(() => vi.unstubAllGlobals());

  const SITE: ArtifactDetails = { kind: "website", source: { file: "site/index.html", root: "site" }, part: { route: "#pricing" }, viewport: "phone" };

  function wire(reject?: (body: Record<string, unknown>) => boolean) {
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    let next = 10;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push({ path, body });
      if (reject?.(body)) {
        return new Response(JSON.stringify({ error: { code: "artifact_path_outside_thread", message: "Keep artifact files inside the thread folder", issues: [] } }), { status: 422 });
      }
      const id = next++;
      if (path.endsWith("/nodes")) {
        const { artifact, ...node } = body;
        return new Response(JSON.stringify({ node: { ...node, id, state: "draft", ...(artifact === undefined ? {} : { artifact: { ...(artifact as object), fingerprint: FINGERPRINT } }) } }));
      }
      if (path.endsWith("/layers")) return new Response(JSON.stringify({ layer: { ...body, id, state: "draft" } }));
      return new Response(JSON.stringify({ action: { ...body, id } }));
    });
    vi.stubGlobal("fetch", fetch);
    return { requests, fetch };
  }
  const client = () => new RelayerGraphClient({ url: "http://graph.test", token: "test", nodeId: 1 });
  function assemble(graph: RelayerGraphClient, artifact: ArtifactDetails) {
    const author = graph.authoring("site-v1");
    const answer = author.layer("answer");
    const viewer = author.layer("site-viewer");
    const overview = answer.node("overview", { icon: "info", title: "Launch", detail: "The launch site is ready." });
    const site = viewer.artifactNode("site", { icon: "globe", title: "Landing page", detail: "Check pricing on a phone.", artifact });
    answer.action("open-site", overview, { kind: "navigate", relation: "expand", label: "Open the site", target: viewer });
    answer.layout([[overview, 0.5, 0.5]], { edgeShape: "default", defaultNode: overview });
    return { author, answer, viewer, site };
  }

  it("writes the artifact node and its one-node artifact layer, and navigates to it", async () => {
    const fixture = wire();
    const artifact = structuredClone(SITE) as { source: { file: string } };
    const { author, answer, viewer, site } = assemble(client(), artifact as ArtifactDetails);
    const pending = author.write(answer);
    // Both are captured before the first await; late edits cannot change the request.
    artifact.source.file = "late/index.html";
    viewer.object.renderer = undefined;
    const written = await pending;
    const nodes = fixture.requests.filter((request) => request.path.endsWith("/nodes")).map((request) => request.body);
    expect(nodes.find((node) => node.title === "Launch")).not.toHaveProperty("artifact");
    expect(nodes.find((node) => node.title === "Landing page")?.artifact).toEqual(SITE);
    const siteRecord = written.nodes.find((node) => node.clientKey === site.clientKey)!;
    expect(siteRecord.artifact?.fingerprint).toBe(FINGERPRINT);
    const layers = fixture.requests.filter((request) => request.path.endsWith("/layers")).map((request) => request.body);
    const viewerLayer = layers.find((layer) => layer.renderer === "artifact")!;
    expect(viewerLayer).toMatchObject({
      nodes: [siteRecord.id],
      edges: [],
      defaultNodeId: siteRecord.id,
      layout: { placements: [{ nodeId: siteRecord.id, x: 0.5, y: 0.5 }], edgeShape: "default" },
    });
    expect(layers.filter((layer) => layer !== viewerLayer)).toEqual([expect.not.objectContaining({ renderer: expect.anything() })]);
    const viewerRecord = written.layers.find((layer) => layer.renderer === "artifact")!;
    expect(fixture.requests.find((request) => request.path.endsWith("/actions"))?.body).toMatchObject({ targetLayerId: viewerRecord.id });
  });

  it("copies scoped artifact details without running the author's code", async () => {
    const fixture = wire();
    const ran = vi.fn(() => "/pricing");
    const cases = [
      { kind: "url", source: { url: "https://example.com/" }, part: { get route() { return ran(); } } },
      { kind: "url", source: { url: "https://example.com/" }, part: { route: "/pricing", toJSON: () => ran() } },
      { kind: "url", source: new Proxy({ url: "https://example.com/" }, { get: () => ran() }) },
    ];
    for (const artifact of cases) {
      const { author, answer } = assemble(client(), artifact as never);
      await expect(author.write(answer)).rejects.toMatchObject({ issues: [expect.objectContaining({ code: "node_envelope_invalid" })] });
    }
    expect(ran).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("keeps a server-rejected artifact draft repairable with the same keys", async () => {
    let reject = true;
    const fixture = wire((body) => reject && body.title === "Landing page");
    const graph = client();
    const first = assemble(graph, { kind: "website", source: { file: "../outside/index.html", root: "../outside" } });
    const error = await first.author.write(first.answer).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphAuthoringWriteError);
    expect(error).toMatchObject({
      failures: [{ path: 'layers["site-viewer"].nodes["site"]', outcome: "rejected", cause: { status: 422, code: "artifact_path_outside_thread" } }],
    });
    reject = false;
    const repair = assemble(graph, SITE);
    expect(repair.site.clientKey).toBe(first.site.clientKey);
    const written = await repair.author.write(repair.answer);
    expect(written.layers.some((layer) => layer.renderer === "artifact")).toBe(true);
    expect(fixture.requests.at(-1)?.path).toBe("/api/graph/actions");
  });
});
