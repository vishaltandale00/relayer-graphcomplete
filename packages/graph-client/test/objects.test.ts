import { afterEach, describe, expect, it, vi } from "vitest";
import { EdgeObject, LayerObject, NodeObject, RelayerGraphClient, type ActionObject } from "../src/index.js";
import { edgeId, layerId, nodeId } from "../src/objects.js";

describe("agent-facing graph objects", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not require the model to invent durable IDs", () => {
    const node = new NodeObject("queue", "Queue", "Waiting work", "concept", "queue");
    const edge = new EdgeObject([node, 9], "queue-worker");
    const layer = new LayerObject([node, 9], [edge], "root");
    expect(() => nodeId(node)).toThrow("must be submitted");
    expect(() => edgeId(edge)).toThrow("must be created");
    expect(() => layerId(layer)).toThrow("must be submitted");
    node.ref = { id: 10, kind: "concept", icon: "queue", title: "Queue", detail: "Waiting work", state: "draft" };
    edge.ref = { id: 20, endpoints: [9, 10], state: "draft" };
    layer.ref = { id: 30, nodes: [10, 9], edges: [20], state: "draft" };
    expect([nodeId(node), edgeId(edge), layerId(layer)]).toEqual([10, 20, 30]);
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

    await expect(graph.submitLayer(new LayerObject([1], []))).rejects.toMatchObject({
      code: "layer_node_count",
      issues: [
        { code: "layer_node_count" },
        { code: "duplicate_layer_node" },
      ],
    });
  });
});
