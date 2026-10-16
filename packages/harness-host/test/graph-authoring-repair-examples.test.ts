import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { RelayerGraphClient, html, detailCapability } from "@relayer/graph-client";
import { AUTHORING_REPAIR_GUIDANCE_JS, AUTHORING_REPAIR_GUIDANCE_PYTHON } from "../src/implementations/graph-presentation-guidance.js";
import { PrimeVisualAuthoring } from "../src/implementations/prime-visual-authoring.js";

it("compiles the delivered JavaScript repair example while preserving Input and typed source navigation", () => {
  const graph = new RelayerGraphClient({ url: "http://graph.test", token: "fixture", nodeId: 1 });
  const layer = graph.authoring("repair-example").layer("finding");
  const finding = layer.node("finding", { icon: "info", title: "Constraint", detail: "A decision needs your answer" });
  const code = AUTHORING_REPAIR_GUIDANCE_JS.match(/```javascript\n([\s\S]*?)\n```/)?.[1];
  expect(code).toBeDefined();
  new Function("layer", "finding", "html", "detailCapability", "sourceUrl", code!)(layer, finding, html, detailCapability, "https://example.com/source");
  const compiled = finding.detailAuthoring.checkpoint();
  expect(compiled.components[0]?.html).toContain("<textarea");
  expect(compiled.mounts).toEqual(expect.arrayContaining([
    expect.objectContaining({ capability: expect.objectContaining({ kind: "input", action: expect.objectContaining({ clientKey: expect.any(String) }) }) }),
    expect.objectContaining({ capability: expect.objectContaining({ kind: "link", href: "https://example.com/source" }) }),
  ]));
});

it("executes the delivered Python repair fragment through the production host compiler without dropping its Input", async () => {
  const code = AUTHORING_REPAIR_GUIDANCE_PYTHON.match(/```python\n([\s\S]*?)\n```/)?.[1];
  expect(code).toBeDefined();
  const payload = JSON.parse(execFileSync("python3", ["-c", `
import json
from relayer_graph import GraphSession, html, action_capability
graph = GraphSession("http://graph.test", "fixture", 1)
author = graph.authoring("repair-example")
layer = author.layer("finding")
finding = layer.node("finding", icon="info", title="Constraint", detail="A decision needs your answer")
source_url = "https://example.com/source"
${code}
print(json.dumps(graph._visual_payload("checkpoint", finding)))
`], { encoding: "utf8", env: { ...process.env, PYTHONPATH: resolve("python/relayer-graph/src") } }));
  const result = await new PrimeVisualAuthoring().execute(payload, { url: "http://graph.test", token: "fixture", nodeId: 1 }, () => {}, new AbortController().signal);
  expect(result.ok).toBe(true);
  expect(result.value).toMatchObject({
    components: [expect.objectContaining({ html: expect.stringContaining("<textarea") })],
    mounts: expect.arrayContaining([
      expect.objectContaining({ capability: expect.objectContaining({ kind: "input" }) }),
      expect.objectContaining({ capability: expect.objectContaining({ kind: "link" }) }),
    ]),
  });
});
