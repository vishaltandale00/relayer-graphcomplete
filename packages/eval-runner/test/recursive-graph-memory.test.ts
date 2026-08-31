import { describe, expect, it } from "vitest";

import {
  RECURSIVE_GRAPH_MEMORY_CASE_ID,
  RECURSIVE_GRAPH_MEMORY_HARNESS_QUARTET,
  recursiveGraphMemoryEvalCase,
} from "../src/cases/recursive-graph-memory.js";

describe("recursive graph-memory Eval case", () => {
  it("uses three natural turns whose follow-ups progressively invalidate earlier assumptions", () => {
    expect(RECURSIVE_GRAPH_MEMORY_CASE_ID).toBe("empty-project.recursive-graph-memory.launch-readiness");
    expect(recursiveGraphMemoryEvalCase.prompts).toHaveLength(3);
    expect(recursiveGraphMemoryEvalCase.requiredHarnessConfigurationNames).toEqual(
      RECURSIVE_GRAPH_MEMORY_HARNESS_QUARTET,
    );
    expect(RECURSIVE_GRAPH_MEMORY_HARNESS_QUARTET).toEqual([
      "codex-eval-lantern-search-disabled-recursion-disabled",
      "codex-eval-lantern-search-query-v1-recursion-disabled",
      "codex-eval-lantern-search-disabled-recursion-enabled",
      "codex-eval-lantern-search-query-v1-recursion-enabled",
    ]);
    expect(recursiveGraphMemoryEvalCase.requiredChecks).toEqual([
      "agent-authored-complete",
      "follow-up-graph-search",
    ]);

    const prompts = recursiveGraphMemoryEvalCase.prompts.join("\n").toLowerCase();
    expect(prompts).toContain("lantern");
    expect(prompts).toContain("earlier work");
    expect(prompts).toContain("go/no-go");
    expect(prompts).not.toMatch(/graph search|query-v1|ladybug|complete\(|subagent|delegate/);
  });
});
