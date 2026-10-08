import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrimeVisualAuthoring, submitPrimeLayer } from "../src/implementations/prime-visual-authoring.js";

const capability = { url: "http://graph.test", token: "run-one", nodeId: 1 };
const request = () => ({ version: 1, objectId: "object-one", token: "run-one", nodeId: 1, operation: "submit",
  node: { clientKey: "answer", icon: "box", title: "Answer", detail: "Fallback", kind: "concept" },
  detail: { clear: false, components: [{ id: "main", markup: { strings: ["<h2>Answer</h2>"], values: [] }, styles: '[data-relayer-theme="light"] h2 { color: #182c34; } [data-relayer-theme="dark"] h2 { color: #edf2f3; }' }] },
});
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
function graphTransport() {
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    return Response.json({ node: { id: 2, state: "draft", ...body } });
  });
  vi.stubGlobal("fetch", fetch);
  return { bodies, fetch };
}
describe("Prime declarative visual authoring", () => {
  it("lowers Python declaration references across components and rejects missing/wrong-kind references before transport", async () => {
    const payload = JSON.parse(execFileSync("python3", ["-c", `
import json
from relayer_graph import GraphSession, NodeObject, LayerObject, LayerLayoutObject, ActionObject, html, action_capability
graph = GraphSession("http://graph.test", "run-one", 1)
node = NodeObject("compass", "Vacation", "Choose", client_key="answer")
layer = LayerObject([node], [], LayerLayoutObject([], "default"), client_key="source")
field = ActionObject("input", "Destination", layer, "destination", control="text", prompt="Destination")
invoke = ActionObject("invoke", "Analyze", layer, "analyze", interaction_text="Analyze destination", input_actions=(field,))
node.detail_authoring.set_component("button", html(["<button gc=", ">Analyze</button>"], action_capability("analyze", invoke)))
node.detail_authoring.set_component("field", html(['<input aria-label="Destination" gc=', ">"], action_capability("destination", field)))
print(json.dumps(graph._visual_payload("submit", node)))
`], { encoding: "utf8", env: { ...process.env, PYTHONPATH: resolve("python/relayer-graph/src") } }));
    expect(payload.detail.components[0].markup.values[0].action.inputActions).toEqual([{ inputActionClientKey: "destination" }]);
    const { fetch, bodies } = graphTransport();
    const result = await new PrimeVisualAuthoring().execute(payload, capability, () => {}, signal());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((bodies[0]!.authoredDetail as { mounts: unknown[] }).mounts).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const reference of ["missing", "analyze"]) {
      const invalid = structuredClone(payload);
      invalid.detail.components[0].markup.values[0].action.inputActions = [{ inputActionClientKey: reference }];
      expect(await new PrimeVisualAuthoring().execute(invalid, capability, () => {}, signal())).toMatchObject({ ok: false });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([{ reusable: "true" }, { reusable: 1 }, { reusable: null }, { inputActions: [0] }, { inputActions: ["21"] }, { inputActions: [1.5] }])("rejects malformed Invoke declarations before graph writes (%j)", async (invalidFields) => {
    const { fetch } = graphTransport();
    const payload = { ...request(), detail: { clear: false, components: [{ id: "main", styles: "", markup: { strings: ["<button gc=", ">Run</button>"], values: [{ kind: "action", key: "run", action: { kind: "invoke", label: "Run", clientKey: "run", sourceLayer: { clientKey: "source", nodes: ["answer"] }, interactionText: "Run", ...invalidFields } }] } }] } };
    expect(await new PrimeVisualAuthoring().execute(payload, capability, () => {}, signal())).toMatchObject({ ok: false, frozen: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ reusable: false }, { inputActions: [21] }])("keeps Invoke policy and bindings off Input declarations (%j)", async (invokeFields) => {
    const { fetch } = graphTransport();
    const payload = { ...request(), detail: { clear: false, components: [{ id: "main", styles: "", markup: { strings: ["<input gc=", ">"], values: [{ kind: "action", key: "input", action: { kind: "input", label: "Destination", clientKey: "input", sourceLayer: { clientKey: "source", nodes: ["answer"] }, control: "text", prompt: "Destination", ...invokeFields } }] } }] } };
    expect(await new PrimeVisualAuthoring().execute(payload, capability, () => {}, signal())).toMatchObject({ ok: false, frozen: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("compiles canonically, shares concurrent submissions, and preserves frozen retries", async () => {
    const { bodies, fetch } = graphTransport();
    const bridge = new PrimeVisualAuthoring();
    const results = await Promise.all([bridge.execute(request(), capability, () => {}, signal()), bridge.execute(request(), capability, () => {}, signal())]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].ok).toBe(true);
    const checkpoint = await bridge.execute({ ...request(), operation: "checkpoint" }, capability, () => {}, signal());
    expect(checkpoint.value).toEqual(bodies[0]!.authoredDetail);
    expect(JSON.stringify(checkpoint.value)).toContain("data-relayer-theme");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toMatchObject({ authoredDetail: { version: 1, components: [{ id: "main", html: "<h2>Answer</h2>" }] } });
    const edited = request(); edited.node.title = "Changed";
    await expect(bridge.execute(edited, capability, () => {}, signal())).rejects.toThrow("detail_finalized");
  });
  it.each([false, true])("compiles Python Invoke policy and bindings through checkpoint and submit (reuse %s)", async (reusable) => {
    const payloads = JSON.parse(execFileSync("python3", ["-c", `
import json
from relayer_graph import GraphSession, NodeObject, LayerObject, LayerLayoutObject, ActionObject, html, action_capability
graph = GraphSession("http://graph.test", "run-one", 1)
original = graph.bind_node(NodeObject("box", "Answer", "Fallback", client_key="answer"))
replacement = graph.bind_node(NodeObject("box", "Answer", "Fallback", client_key="answer"))
layer = LayerObject([original], [], LayerLayoutObject([], "default"), client_key="source")
action = ActionObject("invoke", "Continue", layer, "continue", interaction_text="Continue", reusable=${reusable ? "True" : "False"}, input_actions=(21, 22))
page = html(["<button gc=", ">Continue</button>"], action_capability("continue", action))
original.detail_authoring.set_component("main", page)
replacement.detail_authoring.set_component("main", page)
print(json.dumps([graph._visual_payload("checkpoint", original), graph._visual_payload("checkpoint", replacement), graph._visual_payload("submit", replacement)]))
`], { encoding: "utf8", env: { ...process.env, PYTHONPATH: resolve("python/relayer-graph/src") } }));
    for (const payload of payloads) expect(payload.detail.components[0].markup.values[0].action).toMatchObject({ reusable, inputActions: [21, 22] });
    const { bodies, fetch } = graphTransport();
    const bridge = new PrimeVisualAuthoring();
    const original = await bridge.execute(payloads[0], capability, () => {}, signal());
    const repaired = await bridge.execute(payloads[1], capability, () => {}, signal());
    expect(original.ok).toBe(true);
    expect(repaired).toMatchObject({ ok: true, value: original.value });
    expect(repaired.value).toMatchObject({ mounts: [{ kind: "capability", capability: {
      kind: "invoke", action: { clientKey: "continue", sourceNode: { clientKey: "answer" }, sourceLayer: { clientKey: "source" } },
    } }] });
    expect(await bridge.execute(payloads[2], capability, () => {}, signal())).toMatchObject({ ok: true, frozen: true });
    expect(bodies[0]!.authoredDetail).toEqual(repaired.value);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("compiles Python attached-node replacements with retained and node-owned controls", async () => {
    const payload = JSON.parse(execFileSync("python3", ["-c", `
import asyncio, json, sys, types
from relayer_graph import GraphSession, NodeObject, LayerObject, LayerLayoutObject, ActionObject, html, action_capability
async def run():
    graph = GraphSession("http://graph.test", "run-one", 1)
    replacement = NodeObject("box", "Meaning", "Unchanged", client_key="persistent")
    layer = LayerObject([replacement], [], LayerLayoutObject([], "default"), client_key="old-source")
    old = ActionObject("invoke", "Continue", layer, "old", interaction_text="Continue")
    new = ActionObject("navigate", "Response", None, "response", relation="reference", target=3)
    replacement.detail_authoring.set_component("main", html(["<button gc=", ">Old</button><button gc=", ">Response</button>"], action_capability("old", old), action_capability("response", new)))
    async def host_request(method, payload):
        print(json.dumps(payload))
        return {"ok": True, "value": {"compiled": True}}
    async def request(method, path, body=None):
        raise AssertionError("Replacement transport belongs to the host")
    graph._request = request
    sys.modules["rlm"] = types.SimpleNamespace(host_request=host_request)
    await graph.replace_node_presentation(2, 7, replacement)
asyncio.run(run())
`], { encoding: "utf8", env: { ...process.env, PYTHONPATH: resolve("python/relayer-graph/src") } }));
    const { fetch, bodies } = graphTransport();
    const result = await new PrimeVisualAuthoring().execute(payload, capability, () => {}, signal());
    expect(result).toMatchObject({ ok: true, frozen: false, value: null });
    expect(payload).toMatchObject({ operation: "replace", replacement: { nodeId: 2, expectedRevision: 7 } });
    expect(fetch.mock.calls[0]![0]).toBe("http://graph.test/api/graph/nodes/2/presentation");
    expect(bodies[0]).toMatchObject({ expectedRevision: 7, authoredDetail: { mounts: [
      { capability: { kind: "invoke", action: { clientKey: "old", sourceNode: { clientKey: "persistent" }, sourceLayer: { clientKey: "old-source" } } } },
      { capability: { kind: "reference", action: { clientKey: "response", sourceNode: { clientKey: "persistent" } } } },
    ] } });
    const mounts = (bodies[0]!.authoredDetail as { mounts: { capability: { action: object } }[] }).mounts;
    expect(mounts[1]!.capability.action).not.toHaveProperty("sourceLayer");
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const operation of ["checkpoint", "submit"]) {
      const ordinary = { ...payload, operation };
      delete ordinary.replacement;
      expect(await new PrimeVisualAuthoring().execute(ordinary, capability, () => {}, signal())).toMatchObject({ ok: false });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    const malformed = structuredClone(payload);
    delete malformed.detail.components[0].markup.values[0].action.sourceLayer;
    expect(await new PrimeVisualAuthoring().execute(malformed, capability, () => {}, signal())).toMatchObject({ ok: false });
  });
  it("rejects another run, unknown authority fields and oversized programs before transport", async () => {
    const { fetch } = graphTransport(); const bridge = new PrimeVisualAuthoring();
    await expect(bridge.execute({ ...request(), token: "old" }, capability, () => {}, signal())).rejects.toThrow("another run");
    expect(await bridge.execute({ ...request(), authoredDetail: {} }, capability, () => {}, signal())).toMatchObject({ ok: false, frozen: false });
    const huge = request(); huge.node.detail = "x".repeat(1024 * 1024);
    expect(await bridge.execute(huge, capability, () => {}, signal())).toMatchObject({ ok: false, frozen: false, message: "Visual authoring request exceeds 1 MiB" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await bridge.execute(request(), capability, () => {}, signal())).toMatchObject({ ok: true });
  });
  it("retains, explicitly clears, or replaces a draft using fresh authored objects", async () => {
    const { bodies } = graphTransport(); const bridge = new PrimeVisualAuthoring();
    for (const clear of [false, true]) {
      const input = request(); input.objectId = String(clear); input.detail = { clear, components: [] };
      await bridge.execute(input, capability, () => {}, signal());
    }
    await bridge.execute(request(), capability, () => {}, signal());
    expect(Object.hasOwn(bodies[0]!, "authoredDetail")).toBe(false);
    expect(bodies[1]!.authoredDetail).toBe(null);
    expect(bodies[2]!.authoredDetail).toHaveProperty("integritySha256");
  });
  it("repairs compiler failure without freezing and rejects forged source membership", async () => {
    const { fetch } = graphTransport(); const bridge = new PrimeVisualAuthoring();
    const input = request(); input.detail.components[0]!.markup.strings = ["<script>alert(1)</script>"];
    expect(await bridge.execute(input, capability, () => {}, signal())).toMatchObject({ ok: false, frozen: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(await bridge.execute(request(), capability, () => {}, signal())).toMatchObject({ ok: true });
    const invalid = { ...request(), objectId: "wrong-owner", detail: { clear: false, components: [{ id: "main", styles: "", markup: { strings: ["<button gc=", ">Go</button>"], values: [{ kind: "action", key: "go", action: { kind: "invoke", label: "Go", interactionText: "Continue", clientKey: "go", sourceLayer: { clientKey: "root", nodes: ["other"] } } }] } }] } };
    expect(await bridge.execute(invalid, capability, () => {}, signal())).toMatchObject({ ok: false, frozen: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps a compiled package across transport failure and rejects edits", async () => {
    const { fetch, bodies } = graphTransport(); const bridge = new PrimeVisualAuthoring();
    fetch.mockRejectedValueOnce(new Error("lost response"));
    const first = new AbortController();
    expect(await bridge.execute(request(), capability, () => first.signal.throwIfAborted(), first.signal)).toMatchObject({ ok: false, frozen: true });
    first.abort("host request settled");
    expect(await bridge.execute(request(), capability, () => {}, signal())).toMatchObject({ ok: true, frozen: true });
    expect(fetch.mock.calls[1]![1].signal?.aborted).toBe(false);
    expect(bodies).toHaveLength(1);
  });
  it("preserves server rejection status and cause across the Python bridge", async () => {
    const { fetch } = graphTransport();
    fetch.mockResolvedValueOnce(Response.json({error:{code:"unsupported_icon",path:"icon",message:"Unsupported icon",issues:[]}}, {status:422}));
    expect(await new PrimeVisualAuthoring().execute(request(),capability,()=>{},signal())).toMatchObject({ok:false,frozen:true,httpStatus:422,error:{code:"unsupported_icon",path:"icon",message:expect.stringContaining('Unsupported icon Rejected node.icon = "box"')}});
  });
  it("fences authority again after asynchronous asset resolution and before node write", async () => {
    let active = true;
    vi.stubGlobal("fetch", vi.fn(async () => { active = false; return Response.json({ assets: [] }); }));
    const input = { ...request(), detail: { clear: false, components: [{ id: "main", styles: "", markup: { strings: ['<img asset=', ' alt="Proof">'], values: [{ kind: "asset", logicalId: "asset-one" }] } }] } };
    const result = await new PrimeVisualAuthoring().execute(input, capability, () => { if (!active) throw new Error("revoked"); }, signal());
    expect(result).toMatchObject({ ok: false, frozen: false, message: "revoked" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Prime layer submission", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x07]);
  // The exact payload GraphSession.submit_layer sends to the host.
  const pythonLayerRequest = () => JSON.parse(execFileSync("python3", ["-c", `
import asyncio, json, sys, types
from relayer_graph import GraphSession, NodeObject, EdgeObject, EdgeRouteObject, EdgeEndObject, LayerObject, LayerLayoutObject, NodePlacementObject
from relayer_graph.authoring import GraphEdge, GraphNode
async def run():
    first, second = NodeObject("box", "First", "One", client_key="first"), NodeObject("box", "Second", "Two", client_key="second")
    first.ref, second.ref = GraphNode(5, "concept", "box", "First", "One", "draft"), GraphNode(6, "concept", "box", "Second", "Two", "draft")
    edge = EdgeObject((first, second), client_key="edge")
    edge.ref = GraphEdge(9, (5, 6), "draft")
    layer = LayerObject([first, second], [edge], LayerLayoutObject(
        [NodePlacementObject(first, 0.25, 0.5), NodePlacementObject(second, 0.75, 0.5)], "elbow-horizontal",
        (EdgeRouteObject(edge, ends=(EdgeEndObject(first, "top"), EdgeEndObject(second, "top")), waypoints=((0.5, 0.1),)),)),
        client_key="root", default_node=second)
    async def host_request(method, payload):
        print(json.dumps({"method": method, "payload": payload}))
        return {"ok": True, "value": {"id": 30, "nodes": [5, 6], "edges": [9], "state": "draft"}}
    sys.modules["rlm"] = types.SimpleNamespace(host_request=host_request)
    await GraphSession("http://graph.test", "run-one", 1).submit_layer(layer, size_justification="private")
asyncio.run(run())
`], { encoding: "utf8", env: { ...process.env, PYTHONPATH: resolve("python/relayer-graph/src") } }));

  function layerTransport(reply: (body: Record<string, unknown>) => Response) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetch = vi.fn(async (url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push({ url: String(url), body });
      return reply(body);
    });
    vi.stubGlobal("fetch", fetch);
    return calls;
  }

  it("forwards Python's exact layer and writes its preview into the host folder", async () => {
    const { method, payload } = pythonLayerRequest();
    expect(method).toBe("relayer.graph.submit-layer");
    const folder = await mkdtemp(join(tmpdir(), "prime-layer-preview-"));
    try {
      const calls = layerTransport((body) => Response.json({
        layer: { id: 30, nodes: body.nodes, edges: body.edges, layout: body.layout, defaultNodeId: body.defaultNodeId, state: "draft" },
        preview: { status: "rendered", fingerprint: `sha256:${"ab".repeat(32)}`, width: 1176, height: 812, pngBase64: PNG.toString("base64") },
      }));
      const result = await submitPrimeLayer(payload, { ...capability, previewDirectory: folder }, () => {}, signal());
      expect(calls).toEqual([{ url: "http://graph.test/api/graph/layers", body: payload.layer }]);
      const path = join(folder, "layer-30-abababababababab.png");
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ id: 30, preview: { status: "rendered", path, width: 1176, height: 812 } }) });
      expect(await readFile(path)).toEqual(PNG);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("returns graph rejections for repair and fences authority before transport", async () => {
    const { payload } = pythonLayerRequest();
    const issues = [{ code: "overlap", path: "layout", message: "Spread the nodes out" }];
    const calls = layerTransport(() => Response.json({ error: { code: "validation_failed", message: "Layer is invalid", issues } }, { status: 422 }));
    expect(await submitPrimeLayer(payload, capability, () => {}, signal())).toEqual({
      ok: false, httpStatus: 422, error: { code: "validation_failed", message: "Layer is invalid", issues },
    });
    await expect(submitPrimeLayer({ ...payload, token: "old" }, capability, () => {}, signal())).rejects.toThrow("another run");
    expect(await submitPrimeLayer({ ...payload, layer: { ...payload.layer, extra: true } }, capability, () => {}, signal()))
      .toMatchObject({ ok: false, httpStatus: 400, error: { code: "invalid_request" } });
    await expect(submitPrimeLayer(payload, capability, () => { throw new Error("revoked"); }, signal())).rejects.toThrow("revoked");
    expect(calls).toHaveLength(1);
  });
});
