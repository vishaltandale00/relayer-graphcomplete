import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CompletionOutput } from "@relayer/graph-client";
import { nodeDetailEvalCase } from "../src/fixtures/node-detail.js";
import { canonicalJson } from "../src/cases/catalog.js";

function acceptedFixture(): CompletionOutput {
  const clientKey = "fixture-node-detail.accepted";
  const layerKey = "fixture-node-detail.root";
  const kinds = ["expand", "reference", "invoke", "input"] as const;
  const actions = kinds.map((kind, index) => ({
    id: index + 10, clientKey: `fixture-node-detail.${kind}`, sourceNodeId: 2,
    sourceLayerId: 3, sourceLayerClientKey: layerKey,
    kind: kind === "expand" || kind === "reference" ? "navigate" as const : kind,
    relation: kind === "expand" || kind === "reference" ? kind : null,
    targetLayerId: kind === "expand" || kind === "reference" ? index + 20 : null,
    label: kind, variant: "pill" as const, state: "accepted" as const,
  }));
  const content = {
    version: 1 as const,
    components: [{ id: "main", order: 0, html: '<img data-asset-mount="image"><button data-gc-mount="expand"></button><button data-gc-mount="reference"></button><button data-gc-mount="invoke"></button><input data-gc-mount="input"><a data-gc-mount="link"></a>', css: "" }],
    assets: [{ id: "asset-1", digestSha256: "a".repeat(64), mediaType: "image/svg+xml", representation: "image" as const }],
    mounts: [
      { id: "image", componentId: "main", kind: "asset" as const, host: "img", assetId: "asset-1" },
      ...kinds.map((kind) => ({ id: kind, componentId: "main", kind: "capability" as const, host: kind === "input" ? "input" : "button", capability: { kind, action: { clientKey: `fixture-node-detail.${kind}`, sourceNode: { clientKey }, sourceLayer: { clientKey: layerKey } } } })),
      { id: "link", componentId: "main", kind: "capability" as const, host: "a", capability: { kind: "link" as const, href: "https://example.com/relayer-node-detail" } },
    ],
  };
  return {
    nodeId: 1,
    rootAction: { id: 30, sourceNodeId: 1, kind: "navigate", relation: "expand", label: "Response", variant: "pill", targetLayerId: 3, state: "accepted" },
    rootLayer: {
      layer: { id: 3, clientKey: layerKey, nodes: [2], edges: [], state: "accepted", layout: { version: 1, placements: [{ nodeId: 2, x: 0.5, y: 0.5 }] } },
      nodes: [{ id: 2, clientKey, kind: "concept", icon: "N", title: "Fixture", detail: "Details", state: "accepted", authoredDetail: { ...content, integritySha256: createHash("sha256").update(canonicalJson(content)).digest("hex") } }],
      edges: [], actions,
    },
  };
}

function grade(output: CompletionOutput) {
  return nodeDetailEvalCase.gradeExecution({ interactions: [{ interaction: { graphNodeId: 1, completionOutput: output } }] }).turns[0]!.checks;
}

describe("visual fixture's registered execution grader", () => {
  it("requires visual evidence without any presentation-version setting", () => {
    expect(grade(acceptedFixture()).every((check) => check.passed)).toBe(true);
  });
  it.each(["plain", "integrity", "image", "media", "host", "capability", "action"])("fails accepted output with missing %s evidence", (boundary) => {
    const output = structuredClone(acceptedFixture());
    const node = output.rootLayer.nodes[0]!;
    const detail = node.authoredDetail!;
    if (boundary === "plain") Reflect.deleteProperty(node, "authoredDetail");
    if (boundary === "integrity") Reflect.set(detail, "integritySha256", "0".repeat(64));
    if (boundary === "image") Reflect.set(detail, "assets", []);
    if (boundary === "host") Reflect.set(detail.components[0]!, "html", detail.components[0]!.html.replace('<input data-gc-mount="input">', '<div data-gc-mount="input"></div>'));
    if (boundary === "media") Reflect.set(detail.assets[0]!, "mediaType", "image/webp");
    if (boundary === "capability") Reflect.set(detail, "mounts", detail.mounts.filter((mount) => mount.id !== "input"));
    if (boundary === "action") Reflect.set(output.rootLayer, "actions", output.rootLayer.actions.filter((action) => action.kind !== "input"));
    // Keep altered packages internally consistent: semantic evidence must fail too.
    if (boundary === "image" || boundary === "media" || boundary === "host" || boundary === "capability") {
      const { integritySha256: _, ...content } = detail;
      Reflect.set(detail, "integritySha256", createHash("sha256").update(canonicalJson(content)).digest("hex"));
    }
    expect(grade(output).some((check) => !check.passed)).toBe(true);
  });
});
