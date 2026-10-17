import type { CompletionOutput } from "@relayer/graph-client";
import {
  checkGraphMemoryFirstTurn,
  checkGraphMemoryRetrieval,
  checkGraphMemorySecondTurn,
  graphMemorySearchRequestMode,
  readGraphMemoryEvidence,
  type EvalCheck,
  type EvalCapabilityCoverage,
  type GraphMemoryAuditEvent,
} from "./graph-checks.js";

export const GRAPH_MEMORY_GRADING_VERSION = "graph-memory-retrieval-v2";

export interface GraphMemoryGradingInteraction {
  readonly graphNodeId: number;
  readonly completionOutput?: CompletionOutput;
}

export interface GraphMemoryGradingTurn {
  readonly graphOperations: readonly GraphMemoryAuditEvent[];
}

export interface GraphMemoryGradingExecution {
  readonly harnessConfiguration?: { readonly implementation?: string };
  readonly turns: readonly GraphMemoryGradingTurn[];
}

export async function gradeGraphMemoryExecution(input: {
  readonly execution: GraphMemoryGradingExecution;
  readonly interactions: readonly GraphMemoryGradingInteraction[];
}): Promise<{ readonly version: string; readonly turns: readonly {
  readonly checks: readonly EvalCheck[];
  readonly capabilityCoverage?: readonly EvalCapabilityCoverage[];
  readonly evidence?: ReturnType<typeof readGraphMemoryEvidence>;
}[] }> {
  const { execution, interactions } = input;
  if (interactions.length !== 2) throw new Error("Graph-memory grading requires exactly two product turns.");
  const [first, second] = interactions.map(({ completionOutput }) => completionOutput);
  if (!first || !second) throw new Error("Graph-memory grading requires two completed graph outputs.");
  const firstEvents = execution.turns[0]?.graphOperations ?? [];
  const secondEvents = execution.turns[1]?.graphOperations ?? [];
  const auditEvents = [...firstEvents, ...secondEvents].sort((left, right) => left.sequence - right.sequence);
  const secondTurnStartSequence = firstEvents.reduce((maximum, event) => Math.max(maximum, event.sequence), 0);
  const evidence = readGraphMemoryEvidence(first, second, auditEvents, secondTurnStartSequence);
  const implementation = execution.harnessConfiguration?.implementation ?? "";
  const deterministicFixture = implementation === "fixture.graph-memory";
  const searchChecks = checkGraphMemorySecondTurn(second, first, evidence, interactions[1]!.graphNodeId, {
    requireDraftDecoy: deterministicFixture,
    searchRequestMode: graphMemorySearchRequestMode(implementation),
  }).filter(check => ["search-returned-prior-root", "search-request-contract", "draft-decoy-hidden", "typed-reference-target", "ack-search-submit-order"].includes(check.name));
  const searchAttempts = secondEvents.filter(event => event.method === "POST" && event.path === "/api/graph/search");
  searchChecks.push({
    name: "search-attempts-succeeded",
    passed: searchAttempts.length > 0 && searchAttempts.every(event => event.status >= 200 && event.status < 300),
    detail: "Every recorded follow-up search attempt succeeded; failed requests remain visible after recovery.",
  });
  const searchCoverage: EvalCapabilityCoverage = {
    capability: "graph-search",
    status: secondEvents.length === 0 ? "unknown" : searchAttempts.length === 0 ? "not_exercised"
      : searchChecks.every(check => check.passed) ? "passed" : "failed",
    attempts: secondEvents.length === 0 ? null : searchAttempts.length,
    checks: searchChecks,
  };
  return {
    version: GRAPH_MEMORY_GRADING_VERSION,
    turns: [
      { checks: checkGraphMemoryFirstTurn(first, interactions[0]!.graphNodeId) },
      {
        checks: checkGraphMemoryRetrieval(second, first, evidence, interactions[1]!.graphNodeId),
        capabilityCoverage: [searchCoverage],
        evidence,
      },
    ],
  };
}
