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
