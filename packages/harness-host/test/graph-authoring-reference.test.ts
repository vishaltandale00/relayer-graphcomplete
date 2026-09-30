import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as client from "@relayer/graph-client";
import { PrimeVisualAuthoring } from "../src/implementations/prime-visual-authoring.js";
import { JS_DETAIL_EXAMPLE, JS_NAVIGATION_EXAMPLE, JS_QUESTION_EXAMPLE, PYTHON_DETAIL_EXAMPLE, PYTHON_NAVIGATION_EXAMPLE, PYTHON_QUESTION_EXAMPLE } from "../src/implementations/graph-authoring-reference.js";

describe("delivered authoring examples", () => {
  it("executes the JavaScript visual, navigation, and question examples through the owning compiler", async () => {
    const run = new Function("api", `const { NodeObject, LayerObject, LayerLayoutObject, NodePlacementObject, html, css, detailCapability } = api;
${JS_DETAIL_EXAMPLE}
const layer = new LayerObject([node], [], new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)]), "example-layer");
${JS_QUESTION_EXAMPLE}
const target = new NodeObject("info", "Evidence", "Supporting evidence.", "concept", "evidence");
const targetLayer = new LayerObject([target], [], new LayerLayoutObject([new NodePlacementObject(target, 0.5, 0.5)]), "evidence-layer");
${JS_NAVIGATION_EXAMPLE}
return node;`);
    const node = run(client) as client.NodeObject;
    const graph = new client.RelayerGraphClient({ url: "http://graph.test", token: "test", nodeId: 1 });
    const compiled = await graph.checkpointNodeDetail(node);
    expect(compiled.components).toHaveLength(3);
    expect(compiled.mounts).toMatchObject([{ capability: { kind: "input", action: {
      clientKey: "constraint-question", sourceNode: { clientKey: "comparison" }, sourceLayer: { clientKey: "example-layer" },
    } } }, { capability: { kind: "expand", action: {
      clientKey: "open-evidence", sourceNode: { clientKey: "comparison" }, sourceLayer: { clientKey: "example-layer" },
    } } }]);
    // The exact recipe must continue to avoid the live run's rejected CSS.
    node.detailAuthoring.setComponent("invalid", client.html`<p>Probe</p>`, client.css`p { border-collapse: collapse; }`);
    await expect(graph.checkpointNodeDetail(node)).rejects.toThrow();
  });

  it("executes the Python examples and compiles their real bridge payload", async () => {
    const payload = JSON.parse(execFileSync(process.platform === "win32" ? "python" : "python3", ["-c", `
import json
from relayer_graph import GraphSession, LayerObject, LayerLayoutObject, NodePlacementObject
${PYTHON_DETAIL_EXAMPLE}
layer = LayerObject([node], [], LayerLayoutObject([NodePlacementObject(node, 0.5, 0.5)]), client_key="example-layer")
${PYTHON_QUESTION_EXAMPLE}
target = NodeObject("info", "Evidence", "Supporting evidence.", client_key="evidence")
target_layer = LayerObject([target], [], LayerLayoutObject([NodePlacementObject(target, 0.5, 0.5)]), client_key="evidence-layer")
${PYTHON_NAVIGATION_EXAMPLE}
graph = GraphSession("http://graph.test", "test", 1)
print(json.dumps(graph._visual_payload("checkpoint", node)))
`], { encoding: "utf8", env: { ...process.env, PYTHONPATH: resolve("python/relayer-graph/src") } }));
    const compiled = await new PrimeVisualAuthoring().execute(payload, { url: "http://graph.test", token: "test", nodeId: 1 }, () => {}, new AbortController().signal);
    expect(compiled).toMatchObject({ ok: true, value: { components: [{ id: "main" }, { id: "question" }, { id: "navigation" }], mounts: [{ capability: { kind: "input", action: {
      clientKey: "constraint-question", sourceNode: { clientKey: "comparison" }, sourceLayer: { clientKey: "example-layer" },
    } } }, { capability: { kind: "expand", action: {
      clientKey: "open-evidence", sourceNode: { clientKey: "comparison" }, sourceLayer: { clientKey: "example-layer" },
    } } }] } });
  });
});
