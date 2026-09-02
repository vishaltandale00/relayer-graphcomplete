import { afterEach, describe, expect, it, vi } from "vitest";
import { EdgeObject, LayerLayoutObject, LayerObject, NodeObject, NodePlacementObject, RelayerGraphClient, type ActionObject } from "../src/index.js";
import { edgeId, layerId, nodeId } from "../src/objects.js";

function graphClient(token = "token"): RelayerGraphClient {
  return new RelayerGraphClient({ url: "http://127.0.0.1:1", token, nodeId: 1 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("agent-facing graph objects", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("spares the model from inventing durable IDs", () => {
    const node = new NodeObject("queue", "Queue", "Waiting work", "concept", "queue");
    const edge = new EdgeObject([node, 9], "queue-worker");
    const layer = new LayerObject(
      [node, 9],
      [edge],
      new LayerLayoutObject([new NodePlacementObject(node, 0.25, 0.5), new NodePlacementObject(9, 0.75, 0.5)]),
      "root",
    );
    expect(() => nodeId(node), "node id before submission").toThrow("must be submitted");
    expect(() => edgeId(edge), "edge id before creation").toThrow("must be created");
    expect(() => layerId(layer), "layer id before submission").toThrow("must be submitted");
    node.ref = { id: 10, kind: "concept", icon: "queue", title: "Queue", detail: "Waiting work", state: "draft" };
    edge.ref = { id: 20, endpoints: [9, 10], state: "draft" };
    layer.ref = { id: 30, nodes: [10, 9], edges: [20], state: "draft" };
    expect([nodeId(node), edgeId(edge), layerId(layer)], "ids after server refs attach").toEqual([10, 20, 30]);
  });

  it("submits authored layers with versioned layouts, fail-closed placements, and actionable rejections", async () => {
    // Checkpoint: unresolved placement references fail closed before any request.
    const neverCalled = vi.fn();
    vi.stubGlobal("fetch", neverCalled);
    const pendingNode = new NodeObject("box", "Pending", "Not submitted");
    const pendingLayer = new LayerObject([1], [], new LayerLayoutObject([new NodePlacementObject(pendingNode, 0.5, 0.5)]));
    await expect(graphClient().submitLayer(pendingLayer), "unresolved placement rejects")
      .rejects.toThrow("must be submitted");
    expect(neverCalled, "no request leaves the client").not.toHaveBeenCalled();

    // Checkpoint: the submitted layout is versioned, serialized from node refs, and retained on the layer.
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      request = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({
        layer: { id: 30, nodes: [10, 11], edges: [], layout: request?.layout, state: "draft" },
      });
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
    await graphClient().submitLayer(layer);
    expect(request, "versioned layout from node references").toMatchObject({
      clientKey: "comparison",
      layout: { version: 1, placements: [{ nodeId: 10, x: 0.2, y: 0.5 }, { nodeId: 11, x: 0.8, y: 0.5 }] },
    });
    expect(layer.ref?.layout, "layout retained on the object").toEqual(request?.layout);

    // Checkpoint: a rejected submission surfaces every actionable validation issue.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      error: {
        code: "layer_node_count",
        path: "nodes",
        message: "Repair both layer problems.",
        issues: [
          { code: "layer_node_count", path: "nodes", message: "Split the layer." },
          { code: "duplicate_layer_node", path: "nodes", message: "Remove the duplicate node." },
        ],
      },
    }, 422)));
    await expect(
      graphClient().submitLayer(new LayerObject([1], [], new LayerLayoutObject([new NodePlacementObject(1, 0.5, 0.5)]))),
      "every validation issue survives",
    ).rejects.toMatchObject({
      code: "layer_node_count",
      issues: [
        { code: "layer_node_count" },
        { code: "duplicate_layer_node" },
      ],
    });
  });

  it("authors actions with stable retry keys and canonical presentation", async () => {
    // Checkpoint: retrying the same action object reuses one generated client key.
    const keys: string[] = [];
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { clientKey: string } & Record<string, unknown>;
      keys.push(body.clientKey);
      requests.push(body);
      return jsonResponse({
        action: { id: 40, sourceNodeId: 1, sourceLayerId: 2, kind: "invoke", label: "Ask", variant: "pill", icon: null, description: null, interactionText: "Continue", state: "draft" },
      });
    }));
    const graph = graphClient();
    const action: ActionObject = { kind: "invoke", label: "Ask", interactionText: "Continue", sourceLayer: 2 };
    await graph.addAction(1, action);
    await graph.addAction(1, action);
    expect(action.clientKey, "generated key retained on the object").toBeTypeOf("string");
    expect(keys, "retry reuses the same key").toEqual([action.clientKey, action.clientKey]);
    expect(requests[0], "canonical invoke defaults").toMatchObject({ variant: "pill", icon: null, description: null });

    // Checkpoint: structured input actions serialize fully without a provider side channel.
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      request = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ action: { id: 42, ...request, state: "draft" } });
    }));
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
    expect(request, "multi_select input shape").toEqual({
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
    expect(request, "text input omits options").not.toHaveProperty("options");

    // Checkpoint: card presentation serializes as canonical action data.
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      request = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({
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
      });
    }));
    const card = await graph.addAction(1, {
      kind: "navigate",
      relation: "reference",
      label: "Compare approaches",
      target: 9,
      sourceLayer: 3,
      variant: "card",
      icon: "git-compare",
      description: "Lay out the tradeoffs before choosing.",
    });
    expect(request, "card navigate shape").toMatchObject({
      kind: "navigate",
      relation: "reference",
      label: "Compare approaches",
      sourceLayerId: 3,
      targetLayerId: 9,
      variant: "card",
      icon: "git-compare",
      description: "Lay out the tradeoffs before choosing.",
    });
    expect(card.variant, "card variant retained").toBe("card");
  });

  it("reads normalized interaction state without leaking authority", async () => {
    // Checkpoint: node reads expose nullable lease identity.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      nodes: [{
        id: 10,
        leasedActionId: 42,
        kind: "user-interaction",
        icon: "user",
        title: "Result",
        detail: "Result",
        state: "accepted",
      }],
    })));
    const [source] = await new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 10 }).getNeighbors(10);
    expect(source?.leasedActionId, "leased action identity").toBe(42);

    // Checkpoint: interaction context is normalized with no authority provenance.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      interaction: { id: 10, kind: "user-interaction", icon: "user", title: "Compare", detail: "Compare", state: "accepted" },
      contexts: [{
        type: "interaction.context",
        targetNode: { id: 7, kind: "concept", icon: "box", title: "Boundary", detail: "Evidence", state: "accepted" },
        annotations: ["First", "Second"],
      }],
    })));
    const reader = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 10 });
    const input = await reader.getInteractionInput();
    expect(input.contexts[0], "normalized context").toMatchObject({
      type: "interaction.context",
      targetNode: { id: 7, title: "Boundary" },
      annotations: ["First", "Second"],
    });
    expect(input.contexts[0], "no context id provenance").not.toHaveProperty("id");
    expect(input.contexts[0], "no source node provenance").not.toHaveProperty("sourceNodeId");
    expect(fetch, "authenticated input read").toHaveBeenCalledWith(
      "http://127.0.0.1:1/api/graph/input",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer token" }) }),
    );

    // Checkpoint: submitted input snapshots carry no child or occurrence authority.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      interaction: { id: 10, kind: "user-interaction", icon: "user", title: "", detail: "", state: "accepted" },
      contexts: [],
      submittedInputs: [{
        action: { control: "single_select", prompt: "Choose evidence", options: [{ key: "logs", label: "Logs" }] },
        value: { selected: [{ key: "logs", label: "Logs" }] },
      }],
    })));
    const snapshot = await reader.getInteractionInput();
    expect(snapshot.submittedInputs?.[0], "submitted snapshot body").toEqual({
      action: { control: "single_select", prompt: "Choose evidence", options: [{ key: "logs", label: "Logs" }] },
      value: { selected: [{ key: "logs", label: "Logs" }] },
    });
    expect(snapshot.submittedInputs?.[0], "no action id authority").not.toHaveProperty("actionId");
    expect(snapshot.submittedInputs?.[0], "no occurrence authority").not.toHaveProperty("occurrence");

    // Checkpoint: the hidden personal presentation graph only loads through its dedicated boundary.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
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
    })));
    const presentation = await reader.getPersonalPresentation();
    expect(presentation.attachment.versionInteractionNodeId, "versioned attachment").toBe(90);
    expect(presentation.graph.layers[0]?.nodes[0]?.kind, "preference node kind").toBe("presentation-preference");
    expect(fetch, "dedicated presentation boundary").toHaveBeenCalledWith(
      "http://127.0.0.1:1/api/graph/personal-presentation",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer token" }) }),
    );
  });

  it("mutates persisted objects through canonical endpoints", async () => {
    // Checkpoint: one persisted invoke action prepares a canonical child pointer.
    let observed: { url: string; body: unknown; authorization: string | null } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      observed = {
        url,
        body: JSON.parse(String(init.body)),
        authorization: new Headers(init.headers).get("authorization"),
      };
      return jsonResponse({ interactionNode: 91 });
    }));
    const parent = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "parent", nodeId: 1 });
    const invoke: ActionObject = {
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
    await expect(parent.prepareComplete(invoke), "child pointer").resolves.toEqual({ interactionNode: 91 });
    expect(observed, "prepare request shape").toEqual({
      url: "http://127.0.0.1:1/api/graph/completions/prepare",
      body: { actionId: 44 },
      authorization: "Bearer parent",
    });

    // Checkpoint: discarding a submitted layer stops it and refreshes the object reference.
    let request: { url: string; method?: string } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      request = { url, ...(init.method === undefined ? {} : { method: init.method }) };
      return jsonResponse({ layer: { id: 30, nodes: [10], edges: [], state: "stopped" } });
    }));
    const layer = new LayerObject(
      [10],
      [],
      new LayerLayoutObject([new NodePlacementObject(10, 0.5, 0.5)]),
      "abandoned",
    );
    layer.ref = { id: 30, nodes: [10], edges: [], state: "draft" };
    const stopped = await graphClient().discardLayer(layer);
    expect(request, "discard endpoint").toEqual({
      url: "http://127.0.0.1:1/api/graph/layers/30/discard",
      method: "POST",
    });
    expect(stopped.state, "stopped state").toBe("stopped");
    expect(layer.ref, "object reference refreshed").toEqual(stopped);
  });
});
