import { describe, expect, it } from "vitest";

import {
  LIVE_RUN_AUTH,
  RECURSIVE_LIVE_RUN_TASK,
  compareRuns,
  resolveCredentials,
  orderedRevisions,
  revisionFindings,
  semanticChildren,
  summarizeRun,
  timeToFirstObservableGraph,
} from "../scripts/recursive-live-run-model.mjs";

function revision(sequence, number, overrides = {}) {
  return {
    sequence,
    completionId: 101,
    revision: number,
    previousRevision: number === 0 ? null : number - 1,
    lifecycle: "active",
    currentLayerId: 500 + number,
    ...overrides,
  };
}

const coherentRun = {
  recursionEnabled: true,
  rootCompletionId: 101,
  startedAtMs: 1_000,
  settledAtMs: 61_000,
  completionStatus: "accepted",
  events: [
    revision(1, 0, { currentLayerId: null }),
    revision(2, 1),
    revision(3, 2),
    revision(4, 3, { lifecycle: "succeeded" }),
  ],
  observations: [
    { observedAtMs: 1_200, currentLayerId: null },
    { observedAtMs: 4_500, currentLayerId: 501 },
    { observedAtMs: 9_000, currentLayerId: 502 },
  ],
  completionMetadata: [
    { nodeId: 202, invocation: { sourceInteractionNodeId: 101, sourceActionId: 41 } },
  ],
};

describe("recursive live run analysis", () => {
  it("names a demanding task without instructing the agent to delegate", () => {
    expect(RECURSIVE_LIVE_RUN_TASK).not.toMatch(/delegat|sub-?agent|child|complete\(/i);
    expect(RECURSIVE_LIVE_RUN_TASK.length).toBeGreaterThan(200);
  });

  it("orders paged projection events by durable sequence and drops repeats", () => {
    const paged = [revision(3, 2), revision(1, 0), revision(2, 1), revision(2, 1)];

    expect(orderedRevisions(paged).map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("accepts a sequence where every revision follows its predecessor", () => {
    expect(revisionFindings(101, orderedRevisions(coherentRun.events))).toEqual([]);
  });

  it("reports a revision that is not reachable from the one before it", () => {
    const gapped = [revision(1, 0, { currentLayerId: null }), revision(2, 2, { previousRevision: 1 })];

    expect(revisionFindings(101, gapped)).toContain(
      "completion 101 revision 2 is not reachable from 0",
    );
  });

  it("reports an advance that published no layer", () => {
    const silent = [revision(1, 0, { currentLayerId: null }), revision(2, 1, { currentLayerId: null })];

    expect(revisionFindings(101, silent)).toContain(
      "completion 101 revision 1 advanced without publishing a layer",
    );
  });

  it("reports a revision published after the completion settled", () => {
    const late = [
      revision(1, 0, { currentLayerId: null }),
      revision(2, 1, { lifecycle: "stopped" }),
      revision(3, 2),
    ];

    expect(revisionFindings(101, late)).toContain(
      "completion 101 published revision 2 after settling stopped",
    );
  });

  it("counts a completion as a child only when its invocation names the root", () => {
    const metadata = [
      { nodeId: 202, invocation: { sourceInteractionNodeId: 101, sourceActionId: 41 } },
      { nodeId: 303, invocation: { sourceInteractionNodeId: 202, sourceActionId: 7 } },
      { nodeId: 404, invocation: null },
    ];

    expect(semanticChildren(101, metadata)).toEqual([202]);
  });

  it("measures the first observable graph from the first published layer", () => {
    expect(timeToFirstObservableGraph(1_000, coherentRun.observations)).toBe(3_500);
    expect(timeToFirstObservableGraph(1_000, [{ observedAtMs: 2_000, currentLayerId: null }])).toBeNull();
  });

  it("passes a run whose child, pointer sequence, and settlement all hold", () => {
    const summary = summarizeRun(coherentRun);

    expect(summary.passed).toBe(true);
    expect(summary.findings).toEqual([]);
    expect(summary.semanticChildren).toEqual([202]);
    expect(summary.timings).toEqual({ timeToFirstObservableGraphMs: 3_500, totalTaskMs: 60_000 });
    expect(summary.judge.verdict).toBe("not-run");
  });

  it("fails a recursion run where the agent created no semantic child", () => {
    const summary = summarizeRun({ ...coherentRun, completionMetadata: [] });

    expect(summary.passed).toBe(false);
    expect(summary.findings).toContain("no semantic child was created by the agent's own decision");
  });

  it("fails a recursion run whose pointer never advanced observably", () => {
    const summary = summarizeRun({
      ...coherentRun,
      events: [revision(1, 0, { currentLayerId: null }), revision(2, 1, { lifecycle: "succeeded" })],
    });

    expect(summary.findings).toContain(
      "the root current pointer did not advance observably while work proceeded",
    );
  });

  it("fails a run whose root did not settle accepted", () => {
    const summary = summarizeRun({ ...coherentRun, completionStatus: "failed" });

    expect(summary.findings).toContain("the root completion settled failed rather than accepted");
  });

  it("expects no child when recursion is disabled for the timing comparison", () => {
    const summary = summarizeRun({
      ...coherentRun,
      recursionEnabled: false,
      completionMetadata: [],
    });

    expect(summary.passed).toBe(true);
  });

  it("reports the total-time cost of publishing intermediate accepted states", () => {
    const enabled = summarizeRun(coherentRun);
    const disabled = summarizeRun({
      ...coherentRun,
      recursionEnabled: false,
      settledAtMs: 46_000,
      observations: [{ observedAtMs: 40_000, currentLayerId: 900 }],
      completionMetadata: [],
    });

    expect(compareRuns(enabled, disabled)).toEqual({
      timeToFirstObservableGraphMs: { enabled: 3_500, disabled: 39_000 },
      totalTaskMs: { enabled: 60_000, disabled: 45_000, overheadMs: 15_000 },
    });
  });
});

describe("live run credentials", () => {
  const openRouter = {
    codexExecutable: "/managed/codex",
    codexHome: "/isolated/codex-home",
    modelId: "openai/gpt-5",
    auth: { kind: "openrouter", apiKey: "test-key" },
  };

  it("resolves an OpenRouter key onto the secret execution contract", () => {
    expect(resolveCredentials(openRouter)).toEqual({
      adapterId: "openrouter",
      contract: "secret@1",
      endpoint: "https://openrouter.ai/api/v1",
      providerId: "codex",
      codexExecutable: "/managed/codex",
      codexHome: "/isolated/codex-home",
      modelId: "openai/gpt-5",
      apiKey: "test-key",
    });
  });

  it("keeps the harness-compatible provider id while the adapter varies", () => {
    for (const kind of Object.keys(LIVE_RUN_AUTH)) {
      const apiKey = LIVE_RUN_AUTH[kind].contract === "secret@1" ? "test-key" : null;
      const resolved = resolveCredentials({ ...openRouter, auth: { kind, apiKey } });
      expect(resolved.providerId).toBe("codex");
      expect(resolved.adapterId).toBe(LIVE_RUN_AUTH[kind].adapterId);
    }
  });

  it("honours an endpoint override and falls back to the provider default", () => {
    expect(resolveCredentials({
      ...openRouter,
      auth: { ...openRouter.auth, endpoint: "https://gateway.internal/v1" },
    }).endpoint).toBe("https://gateway.internal/v1");
    expect(resolveCredentials({ ...openRouter, auth: { ...openRouter.auth, endpoint: null } }).endpoint)
      .toBe("https://openrouter.ai/api/v1");
  });

  it("carries no key for a subscription, whose login lives in its provider home", () => {
    const resolved = resolveCredentials({
      ...openRouter,
      auth: { kind: "codex-subscription", apiKey: null },
    });

    expect(resolved).not.toHaveProperty("apiKey");
    expect(resolved.contract).toBe("managed-runtime@1");
  });

  it("names the missing field without ever quoting the key", () => {
    const cases = [
      [{ ...openRouter, auth: { kind: "nope" } }, /auth.kind set to one of/],
      [{ ...openRouter, auth: { kind: "openrouter" } }, /needs auth.apiKey for openrouter/],
      [{ ...openRouter, auth: { kind: "codex-subscription", apiKey: "test-key" } }, /leave auth.apiKey null/],
      [{ ...openRouter, codexExecutable: "  " }, /needs codexExecutable/],
      [{ ...openRouter, codexHome: null }, /needs codexHome/],
      [{ ...openRouter, modelId: "" }, /needs modelId/],
    ];
    for (const [document, expected] of cases) {
      expect(() => resolveCredentials(document)).toThrow(expected);
      try {
        resolveCredentials(document);
      } catch (error) {
        expect(error.message).not.toContain("test-key");
      }
    }
  });
});
