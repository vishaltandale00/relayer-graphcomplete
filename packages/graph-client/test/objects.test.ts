import { afterEach, describe, expect, it, vi } from "vitest";
import { EdgeObject, LayerLayoutObject, LayerObject, NodeObject, NodePlacementObject, RelayerGraphClient, type ActionObject } from "../src/index.js";
import { edgeId, layerId, nodeId } from "../src/objects.js";

describe("agent-facing graph objects", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not require the model to invent durable IDs", () => {
    const node = new NodeObject("queue", "Queue", "Waiting work", "concept", "queue");
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
    node.ref = { id: 10, kind: "concept", icon: "queue", title: "Queue", detail: "Waiting work", state: "draft" };
    edge.ref = { id: 20, endpoints: [9, 10], state: "draft" };
    layer.ref = { id: 30, nodes: [10, 9], edges: [20], state: "draft" };
    expect([nodeId(node), edgeId(edge), layerId(layer)]).toEqual([10, 20, 30]);
  });

  it("serializes a versioned authored layout from node references", async () => {
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      request = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        layer: { id: 30, nodes: [10, 11], edges: [], layout: request?.layout, state: "draft" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const left = new NodeObject("box", "Left", "Left detail", "concept", "left");
    const right = new NodeObject("box", "Right", "Right detail", "concept", "right");
    left.ref = { id: 10, kind: "concept", icon: "box", title: "Left", detail: "Left detail", state: "draft" };
    right.ref = { id: 11, kind: "concept", icon: "box", title: "Right", detail: "Right detail", state: "draft" };
    const layer = new LayerObject(
      [left, right],
      [],
      new LayerLayoutObject([new NodePlacementObject(left, 0.2, 0.5), new NodePlacementObject(right, 0.8, 0.5)]),
      "comparison",
    );

    await new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 }).submitLayer(layer);

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
