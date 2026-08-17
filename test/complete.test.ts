import { describe, expect, it, vi } from "vitest";
import { complete } from "../src/index.js";
import type { CompletionPolicy, CompletionResult, GraphCompleteRuntime, InputGraph } from "../src/index.js";

const graph: InputGraph = {
  version: 1,
  rootNodeId: "workspace",
  nodes: [
    {
      id: "workspace",
      kind: "workspace",
      title: "Workspace",
      content: "Complete this workspace graph.",
      status: "draft",
    },
  ],
  edges: [],
};

const policy: CompletionPolicy = {
  models: {
    orchestrator: { model: "openai-codex/gpt-5.6-luna" },
    contentOwner: { model: "openai-codex/gpt-5.6-luna" },
    reviewer: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
    reviser: { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
  },
  minChildren: 3,
  maxChildren: 8,
};

describe("complete", () => {
  it("passes the canonical graph and policy to the selected runtime", async () => {
    const result: CompletionResult = {
      graph,
      reason: "accepted",
      accepted: true,
      diagnostics: [],
    };
    const run = vi.fn(async () => result);
    const runtime: GraphCompleteRuntime = { run };

    await expect(complete(graph, { runtime, policy })).resolves.toBe(result);
    expect(run).toHaveBeenCalledWith({ inputGraph: graph, policy });
  });

  it("rejects an input whose root node is missing", async () => {
    const runtime: GraphCompleteRuntime = { run: vi.fn() };
    const invalidGraph: InputGraph = { ...graph, rootNodeId: "missing" };

    await expect(complete(invalidGraph, { runtime, policy })).rejects.toThrow(
      "Graph root node does not exist: missing",
    );
  });
});
