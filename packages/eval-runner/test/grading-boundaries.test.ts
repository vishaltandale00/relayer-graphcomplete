import { describe, expect, it } from "vitest";
import type { CompletionOutput } from "@relayer/graph-client";
import { gradeGraphMemoryExecution } from "../src/cases/graph-memory.js";
import { gradeRecursiveGraphMemoryExecution } from "../src/cases/recursive-graph-memory-grading.js";

function completedOutput(nodeId: number): CompletionOutput {
  const layerId = nodeId + 100;
  return {
    nodeId,
    rootAction: {
      id: nodeId + 200,
      sourceNodeId: nodeId,
      sourceLayerId: null,
      kind: "navigate",
      relation: "expand",
      label: "Response",
      variant: "pill",
      targetLayerId: layerId,
      state: "accepted",
    },
    rootLayer: {
      layer: { id: layerId, nodes: [nodeId + 300], edges: [], state: "accepted" },
      nodes: [{ id: nodeId + 300, kind: "concept", icon: "N", title: "Overview", detail: "Details", state: "accepted" }],
      edges: [],
      actions: [],
    },
  };
}

describe("exported Eval grading boundaries", () => {
  it.each([
    { count: 1, expected: "exactly two product turns" },
    { count: 3, expected: "exactly two product turns" },
  ])("rejects $count product turns in two-turn graph-memory grading", async ({ count, expected }) => {
    await expect(gradeGraphMemoryExecution({
      execution: { turns: [] },
      interactions: Array.from({ length: count }, (_, index) => ({ graphNodeId: index + 1 })),
    })).rejects.toThrow(expected);
  });

  it.each([0, 1])("rejects a missing completion output at two-turn position %i", async (missingIndex) => {
    const interactions = [0, 1].map((index) => ({
      graphNodeId: index + 1,
      ...(index === missingIndex ? {} : { completionOutput: completedOutput(index + 1) }),
    }));
    await expect(gradeGraphMemoryExecution({ execution: { turns: [] }, interactions }))
      .rejects.toThrow("requires two completed graph outputs");
  });

  it.each([
    { count: 2, expected: "exactly three product turns" },
    { count: 4, expected: "exactly three product turns" },
  ])("rejects $count product turns in recursive graph-memory grading", async ({ count, expected }) => {
    await expect(gradeRecursiveGraphMemoryExecution({
      execution: { turns: [] },
      interactions: Array.from({ length: count }, (_, index) => ({ id: index + 1, graphNodeId: index + 1 })),
      graphOperationsByTurn: [],
    })).rejects.toThrow(expected);
  });

  it.each([0, 1, 2])("rejects a missing completion output at recursive position %i", async (missingIndex) => {
    const interactions = [0, 1, 2].map((index) => ({
      id: index + 1,
      graphNodeId: index + 1,
      ...(index === missingIndex ? {} : { completionOutput: completedOutput(index + 1) }),
    }));
    await expect(gradeRecursiveGraphMemoryExecution({
      execution: { turns: [] },
      interactions,
      graphOperationsByTurn: [],
    })).rejects.toThrow("requires three completed graph outputs");
  });
});
