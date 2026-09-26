import type { CompletionOutput } from "@relayer/graph-client";
import {
  checkGraphMemoryFirstTurn,
  checkGraphMemorySecondTurn,
  graphMemorySearchRequestMode,
  readGraphMemoryEvidence,
  type EvalCheck,
  type GraphMemoryAuditEvent,
} from "./graph-checks.js";

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
}): Promise<{ readonly turns: readonly { readonly checks: readonly EvalCheck[]; readonly evidence?: ReturnType<typeof readGraphMemoryEvidence> }[] }> {
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
  return {
    turns: [
      { checks: checkGraphMemoryFirstTurn(first, interactions[0]!.graphNodeId) },
      {
        checks: checkGraphMemorySecondTurn(second, first, evidence, interactions[1]!.graphNodeId, {
          requireDraftDecoy: deterministicFixture,
          searchRequestMode: graphMemorySearchRequestMode(implementation),
        }),
        evidence,
      },
    ],
  };
}
