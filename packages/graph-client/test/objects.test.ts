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
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { clientKey: string };
      keys.push(body.clientKey);
      return new Response(JSON.stringify({
        action: { id: 40, sourceNodeId: 1, kind: "invoke", label: "Ask", interactionText: "Continue", response: false, state: "draft" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const graph = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 });
    const action: ActionObject = { kind: "invoke", label: "Ask", interactionText: "Continue" };

    await graph.addAction(1, action);
    await graph.addAction(1, action);

    expect(action.clientKey).toBeTypeOf("string");
    expect(keys).toEqual([action.clientKey, action.clientKey]);
  });
});
