import { afterEach, expect, it, vi } from "vitest";
import { LayerLayoutObject, LayerObject, NodeObject, RelayerGraphClient, detailCapability, html, type InputActionObject, type InvokeActionObject } from "../src/index.js";
import { snapshotAuthoredNodeDetailProgram } from "../src/detail.js";

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const node = new NodeObject("compass", "Vacation", "Choose", "concept", "vacation");
  const layer = new LayerObject([10, node], [], new LayerLayoutObject([], "default"), "vacations");
  layer.ref = { id: 20, nodes: [10], edges: [], state: "draft" };
  const input: InputActionObject = { kind: "input", clientKey: "destination", sourceLayer: layer, label: "Destination", control: "text", prompt: "Destination" };
  const invoke: InvokeActionObject = { kind: "invoke", clientKey: "analyze", sourceLayer: layer, label: "Analyze", interactionText: "Analyze destination", inputActions: [input] };
  const graph = new RelayerGraphClient({ url: "http://graph.test", token: "token", nodeId: 1 });
  return { node, layer, input, invoke, graph };
}

it("lowers a new Input declaration before Invoke and keeps exact retry keys", async () => {
  const { node, input, invoke, graph } = fixture();
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    if (body.kind === "input") (invoke as { interactionText: string }).interactionText = "Mutated after capture";
    return Response.json({ action: { ...body, id: body.kind === "input" ? 30 : 40, state: "draft" } });
  }));
  await graph.addAction(10, invoke);
  expect(bodies).toMatchObject([{ kind: "input", clientKey: "destination" }, { kind: "invoke", inputActionIds: [30], interactionText: "Analyze destination", reusable: false }]);
  expect(input.ref?.id).toBe(30);
  await graph.addAction(10, invoke);
  expect(bodies.map((body) => body.clientKey)).toEqual(["destination", "analyze", "destination", "analyze"]);
});

it("shares a pending Input write across two consumers without conflating Invoke identities", async () => {
  const { node, invoke, graph } = fixture();
  let resolve!: () => void;
  const gate = new Promise<void>((done) => { resolve = done; });
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    if (body.kind === "input") await gate;
    return Response.json({ action: { ...body, id: body.kind === "input" ? 30 : 40, state: "draft" } });
  }));
  const first = graph.addAction(10, invoke);
  const second = graph.addAction(10, { ...invoke, clientKey: "another-analysis", reusable: true });
  resolve(); await Promise.all([first, second]);
  expect(bodies.filter((body) => body.kind === "input")).toHaveLength(1);
  expect(bodies.filter((body) => body.kind === "invoke").map((body) => body.inputActionIds)).toEqual([[30], [30]]);
});

it.each(["duplicate", "wrong-kind", "getter", "proxy", "cross-node", "malformed-second"])("rejects %s before dependency writes", async (failure) => {
  const { node, layer, input, invoke, graph } = fixture();
  const foreign = new NodeObject("box", "Other", "", "concept", "other");
  let bad: unknown = input;
  if (failure === "wrong-kind") bad = { ...invoke, clientKey: "wrong" };
  if (failure === "getter") bad = { ...input, get prompt() { throw new Error("Getter executed"); } };
  if (failure === "proxy") bad = new Proxy(input, {});
  if (failure === "cross-node") bad = { ...input, sourceLayer: new LayerObject([foreign], [], layer.layout, "foreign") };
  if (failure === "malformed-second") bad = { ...input, clientKey: "second", prompt: "" };
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(graph.addAction(10, { ...invoke, inputActions: [input, bad] as InputActionObject[] })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("resolves visual references across components in any order and snapshots before mutation", () => {
  const { node, input, invoke } = fixture();
  node.detailAuthoring.setComponent("button", html`<button gc=${detailCapability.invoke("analyze", invoke)}>Analyze</button>`);
  node.detailAuthoring.setComponent("field", html`<input gc=${detailCapability.input("destination", input)}>`);
  const snapshot = snapshotAuthoredNodeDetailProgram(node.detailAuthoring, { object: node, clientKey: node.clientKey });
  (input as { prompt: string }).prompt = "Changed";
  expect(snapshot.components[0]?.markup.bindings[0]?.capability.capability).toMatchObject({ action: { inputActions: [{ clientKey: "destination", prompt: "Destination" }] } });
});

it.each(["unmounted", "alias", "cross-node"])("rejects %s visual Input references", (failure) => {
  const { node, input, invoke, layer } = fixture();
  if (failure !== "unmounted") node.detailAuthoring.setComponent("field", html`<input gc=${detailCapability.input("destination", failure === "alias" ? { ...input } : input)}>`);
  if (failure === "cross-node") (input as { sourceLayer: LayerObject }).sourceLayer = new LayerObject([], [], layer.layout, "foreign");
  node.detailAuthoring.setComponent("button", html`<button gc=${detailCapability.invoke("analyze", invoke)}>Analyze</button>`);
  expect(() => snapshotAuthoredNodeDetailProgram(node.detailAuthoring, { object: node, clientKey: node.clientKey })).toThrow();
});

it("preserves exact declaration references when reusing a same-node repair template", async () => {
  const { node, input, invoke, graph } = fixture();
  graph.bindNode(node);
  const controls = html`<input aria-label="Destination" gc=${detailCapability.input("destination", input)}><button gc=${detailCapability.invoke("analyze", invoke)}>Analyze</button>`;
  node.detailAuthoring.setComponent("controls", controls);
  const first = await graph.checkpointNodeDetail(node);
  const repair = new NodeObject("compass", "Vacation", "Choose", "concept", node.clientKey);
  graph.bindNode(repair);
  repair.detailAuthoring.setComponent("controls", controls);
  expect(await graph.checkpointNodeDetail(repair)).toEqual(first);
});
