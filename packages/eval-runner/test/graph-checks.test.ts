import { describe, expect, it } from "vitest";
import type { CompletionOutput } from "@relayer/graph-client";
import { taskSystemFixtureConfiguration } from "../src/fixtures/task-system.js";
import { checkBasicOutput, checkNodeNavigation, selectEvalPermissionProfile } from "../src/cases/graph-checks.js";

function navigationOutput(actions: CompletionOutput["rootLayer"]["actions"] = []): CompletionOutput {
  return {
    nodeId: 1,
    rootAction: { id: 1, sourceNodeId: 1, sourceLayerId: null, kind: "navigate" as const, relation: "expand" as const, label: "Response", variant: "pill", targetLayerId: 3, state: "accepted" as const },
    rootLayer: {
      layer: { id: 3, nodes: [2], edges: [], state: "accepted" as const },
      nodes: [{ id: 2, kind: "concept", icon: "N", title: "Overview", detail: "Details", state: "accepted" as const }],
      edges: [],
      actions,
    },
  };
}

describe("desktop Eval graph checks", () => {
  it("selects an Eval permission profile supported by the harness", () => {
    expect(selectEvalPermissionProfile(taskSystemFixtureConfiguration)).toBe("auto");
    expect(selectEvalPermissionProfile({
      ...taskSystemFixtureConfiguration,
      name: "prime-agent-basic",
      permissionBindings: { full: {} },
    })).toBe("full");
    expect(() => selectEvalPermissionProfile({
      ...taskSystemFixtureConfiguration,
      permissionBindings: { ask: {}, full: {} },
    })).toThrow("need Auto or one unambiguous permission profile");
  });

  it("rejects inconsistent resolved membership and draft output", () => {
    const mismatched = {
      nodeId: 1,
      rootAction: { id: 1, sourceNodeId: 1, sourceLayerId: null, kind: "navigate" as const, relation: "expand" as const, label: "Response", variant: "pill" as const, targetLayerId: 3, state: "accepted" as const },
      rootLayer: {
        layer: { id: 3, nodes: [2], edges: [], state: "accepted" as const },
        nodes: [{ id: 6, kind: "concept", icon: "R", title: "Results", detail: "Stored", state: "draft" as const }],
        edges: [],
        actions: [],
      },
    };
    const checks = checkBasicOutput(mismatched);
    expect(checks.find((check) => check.name === "resolved-membership")?.passed).toBe(false);
    expect(checks.find((check) => check.name === "accepted-closure")?.passed).toBe(false);
    expect(checks.some((check) => check.name.startsWith("fact:"))).toBe(false);
  });

  it("distinguishes a node-level child-layer action from the required response action", () => {
    const output = navigationOutput();
    expect(checkNodeNavigation(output)).toEqual([
      expect.objectContaining({ name: "node-navigation", passed: false }),
    ]);
    const withNavigation = navigationOutput([{
      id: 9,
      sourceNodeId: output.rootLayer.nodes[0]!.id,
      sourceLayerId: output.rootLayer.layer.id,
      kind: "navigate",
      relation: "expand",
      label: "Open details",
      variant: "pill",
      targetLayerId: 10,
      state: "accepted" as const,
    }]);
    expect(checkNodeNavigation(withNavigation)).toEqual([
      expect.objectContaining({ name: "node-navigation", passed: true }),
    ]);
  });
});
