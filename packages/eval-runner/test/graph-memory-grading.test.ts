import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CompletionOutput } from "@relayer/graph-client";
import { gradeGraphMemoryExecution } from "../src/cases/graph-memory.js";
import { checkGraphMemoryFirstTurn, type GraphMemoryAuditEvent } from "../src/cases/graph-checks.js";
import { canonicalJson } from "../src/cases/catalog.js";

const heading = "Freshness acknowledged";

function output(nodeId: number, title: string, fragments: readonly string[] = []): CompletionOutput {
  const layerId = 100 + nodeId;
  const contentId = 1000 + nodeId;
  const content = {
    version: 1 as const,
    components: fragments.map((html, order) => ({ id: `section-${order}`, order, html, css: "" })),
    assets: [], mounts: [],
  };
  return {
    nodeId,
    rootAction: { id: 200 + nodeId, sourceNodeId: nodeId, sourceLayerId: null, kind: "navigate", relation: "expand", label: "Response", variant: "pill", targetLayerId: layerId, state: "accepted" },
    rootLayer: {
      layer: { id: layerId, nodes: [contentId], edges: [], state: "accepted", layout: { version: 1, placements: [{ nodeId: contentId, x: 0.5, y: 0.5 }] } },
      nodes: [{ id: contentId, kind: "concept", icon: "info", title, detail: "Accepted explanation of publication and retrieval.", state: "accepted", ...(fragments.length ? { authoredDetail: { ...content, integritySha256: createHash("sha256").update(canonicalJson(content)).digest("hex") } } : {}) }],
      edges: [], actions: [],
    },
  };
}

function acknowledgement(nodeId: number, sequence: number, temporal = true): GraphMemoryAuditEvent {
  return {
    method: "POST", path: temporal ? "/api/graph/current/transitions" : "/api/graph/submit", status: 200, sequence,
    completionNodeId: nodeId, completionRootLayerId: 100 + nodeId,
    ...(temporal ? { transitionKind: "return", completionLifecycle: "succeeded" } : {}),
  };
}

function scenario(temporalFirst = true, temporalSecond = true) {
  const first = output(1, "When saved content is available", [`<article><h2>${heading}</h2><p>Accepted work is retrievable.</p></article>`]);
  const second = output(2, "Original explanation");
  Reflect.set(second.rootLayer, "actions", [{ id: 300, sourceNodeId: 1002, sourceLayerId: 102, kind: "navigate", relation: "reference", label: "Read original", variant: "pill", targetLayerId: 101, state: "accepted" }]);
  const firstEvents = [acknowledgement(1, 10, temporalFirst)];
  const secondEvents: GraphMemoryAuditEvent[] = [
    { method: "POST", path: "/api/graph/search", status: 200, sequence: 20, queryContractVersion: 1, query: "MATCH (l:Layer)-[:CONTAINS]->(n:Content) WHERE n.title = $topic RETURN l AS layer", parameters: { topic: { type: "string", value: first.rootLayer.nodes[0]!.title } }, searchLayerIds: [101], resultTruncated: false },
    { method: "POST", path: "/api/graph/actions", status: 200, sequence: 30, recordId: 300, actionKind: "navigate", actionRelation: "reference", actionSourceNodeId: 1002, actionSourceLayerId: 102, actionTargetLayerId: 101 },
    acknowledgement(2, 40, temporalSecond),
  ];
  const grade = () => gradeGraphMemoryExecution({
    execution: { harnessConfiguration: { implementation: "codex.basic" }, turns: [{ graphOperations: firstEvents }, { graphOperations: secondEvents }] },
    interactions: [{ graphNodeId: 1, completionOutput: first }, { graphNodeId: 2, completionOutput: second }],
  });
  return { first, firstEvents, secondEvents, grade };
}

describe("graph-memory grading through the exported production seam", () => {
  it.each([[true, true], [false, false], [true, false], [false, true]])("accepts exact HTML target and successful search with temporal acknowledgements %s/%s", async (first, second) => {
    const result = await scenario(first, second).grade();
    expect(result.turns.flatMap(turn => turn.checks).filter(check => !check.passed)).toEqual([]);
  });

  it.each([
    { name: "Advance", patch: { transitionKind: "advance", completionLifecycle: "active" } },
    { name: "Stop", patch: { transitionKind: "stop", completionLifecycle: "stopped" } },
    { name: "misleading succeeded Advance", patch: { transitionKind: "advance", completionLifecycle: "succeeded" } },
    { name: "failed Return", patch: { status: 422 } },
    { name: "wrong completion", patch: { completionNodeId: 99 } },
    { name: "wrong final layer", patch: { completionRootLayerId: 99 } },
    { name: "wrong lifecycle", patch: { completionLifecycle: "active" } },
  ])("rejects $name as a first or final Return", async ({ patch }) => {
    for (const position of ["first", "second"]) {
      const s = scenario();
      const event = position === "first" ? s.firstEvents[0]! : s.secondEvents[2]!;
      Object.assign(event, patch);
      const result = await s.grade();
      expect(result.turns[1]!.checks.find(check => check.name === "ack-search-submit-order")?.passed).toBe(false);
    }
  });

  it.each(["empty", "truncated", "wrong-title", "unrelated-title", "early-return", "wrong-reference"])("preserves the %s failure boundary", async boundary => {
    const s = scenario();
    const search = s.secondEvents[0]!;
    if (boundary === "empty") Object.assign(search, { searchLayerIds: [] });
    if (boundary === "truncated") Object.assign(search, { resultTruncated: true });
    if (boundary === "wrong-title") Object.assign(search, { parameters: { topic: { type: "string", value: "Another explanation" } } });
    if (boundary === "unrelated-title") {
      Reflect.set(s.first.rootLayer, "nodes", [...s.first.rootLayer.nodes, { id: 1003, kind: "concept", icon: "info", title: "Unrelated", detail: "Not the requested section", state: "accepted" }]);
      Reflect.set(s.first.rootLayer.layer, "nodes", [1001, 1003]);
      Reflect.set(s.first.rootLayer.layer.layout!, "placements", [...s.first.rootLayer.layer.layout!.placements, { nodeId: 1003, x: 0.75, y: 0.5 }]);
      Reflect.set(s.first.rootLayer, "edges", [{ id: 400, endpoints: [1001, 1003], state: "accepted" }]);
      Reflect.set(s.first.rootLayer.layer, "edges", [400]);
      Object.assign(search, { parameters: { topic: { type: "string", value: "Unrelated" } } });
    }
    if (boundary === "early-return") Object.assign(s.secondEvents[2]!, { sequence: 25 });
    if (boundary === "wrong-reference") Object.assign(s.secondEvents[1]!, { actionTargetLayerId: 999 });
    const result = await s.grade();
    const checkpoint = boundary === "empty" || boundary === "truncated" ? "search-returned-prior-root"
      : boundary === "wrong-title" || boundary === "unrelated-title" ? "search-request-contract"
      : boundary === "wrong-reference" ? "typed-reference-target" : "ack-search-submit-order";
    expect(result.turns[1]!.checks.find(check => check.name === checkpoint)?.passed).toBe(false);
  });
});

describe("graph-memory section recognition", () => {
  it.each([
    { title: heading, fragments: [], accepted: true, name: "legacy Node title" },
    { title: heading, fragments: [`<h2>${heading}</h2>`], accepted: true, name: "title and its own section" },
    { title: "Overview", fragments: ["<h3>Freshness&nbsp; <em>acknowledged</em></h3>"], accepted: true, name: "entities and inline text" },
    { title: "Overview", fragments: ["<h2>Freshness<br>acknowledged</h2>"], accepted: true, name: "heading line break" },
    { title: "Overview", fragments: [`<p>${heading}</p>`], accepted: false, name: "ordinary prose" },
    { title: "Overview", fragments: [`<p title="${heading}">Other</p>`], accepted: false, name: "attribute text" },
    { title: "Overview", fragments: [`&lt;h2&gt;${heading}&lt;/h2&gt;`], accepted: false, name: "escaped markup" },
    { title: "Overview", fragments: [`<!-- <h2>${heading}</h2> -->`], accepted: false, name: "comment" },
    { title: "Overview", fragments: [`<template><h2>${heading}</h2></template>`], accepted: false, name: "inert template" },
    { title: "Overview", fragments: [`<h2 hidden>${heading}</h2>`], accepted: false, name: "hidden heading" },
    { title: "Overview", fragments: [`<div aria-hidden="true"><h2>${heading}</h2></div>`], accepted: false, name: "hidden ancestor" },
    { title: "Overview", fragments: [`<h2>${heading}</h2>`, `<h3>${heading}</h3>`], accepted: false, name: "duplicate sections across components" },
    { title: "Overview", fragments: [`<h2>${heading}</h2><p>GRAPH_MEMORY_ANCHOR:forbidden</p>`], accepted: false, name: "visible HTML machine marker" },
  ])("recognizes $name", ({ title, fragments, accepted }) => {
    expect(checkGraphMemoryFirstTurn(output(1, title, fragments)).find(check => check.name === "natural-memory-search-target")?.passed).toBe(accepted);
  });
});
