import { describe, expect, it } from "vitest";

import {
  LIVE_RUN_AUTH,
  RECURSIVE_LIVE_RUN_TASK,
  compareRuns,
  liveRunProfileNames,
  resolveRunProfile,
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
  const document = {
    runs: {
      "prime-openrouter": {
        harness: "prime-agent-basic",
        modelId: "openai/gpt-5",
        auth: { kind: "openrouter", apiKey: "test-key" },
      },
      "codex-openai": {
        harness: "codex-basic",
        modelId: "gpt-5-codex",
        codexExecutable: "/managed/codex",
        codexHome: "/isolated/codex-home",
        auth: { kind: "openai-api", apiKey: "test-key" },
      },
    },
  };
  const prime = { implementation: "prime.agent" };
  const codex = { implementation: "codex.basic" };

  it("resolves an OpenRouter key for Prime onto the secret contract, with no Codex runtime", () => {
    const resolved = resolveRunProfile(document, "prime-openrouter", prime);

    expect(resolved).toEqual({
      name: "prime-openrouter",
      harness: "prime-agent-basic",
      implementation: "prime.agent",
      adapterId: "openrouter",
      contract: "secret@1",
      endpoint: "https://openrouter.ai/api/v1",
      providerId: "codex",
      modelId: "openai/gpt-5",
      apiKey: "test-key",
    });
    expect(resolved).not.toHaveProperty("codexExecutable");
  });

  it("resolves an OpenAI key for Codex with its isolated executable and home", () => {
    expect(resolveRunProfile(document, "codex-openai", codex)).toMatchObject({
      adapterId: "openai-api",
      contract: "secret@1",
      endpoint: "https://api.openai.com/v1",
      codexExecutable: "/managed/codex",
      codexHome: "/isolated/codex-home",
      modelId: "gpt-5-codex",
    });
  });

  it("requires the Codex executable and home only for a Codex harness", () => {
    const withoutCodex = {
      runs: { plain: { ...document.runs["codex-openai"], codexExecutable: null, codexHome: null } },
    };

    expect(() => resolveRunProfile(withoutCodex, "plain", codex)).toThrow(/needs codexExecutable/);
    expect(resolveRunProfile(withoutCodex, "plain", prime).modelId).toBe("gpt-5-codex");
  });

  it("refuses a subscription login for a harness that takes a key", () => {
    const subscription = {
      runs: { sub: { harness: "prime-agent-basic", modelId: "m", auth: { kind: "codex-subscription" } } },
    };

    expect(() => resolveRunProfile(subscription, "sub", prime))
      .toThrow(/accepts a key rather than a codex-subscription login/);
  });

  it("honours an endpoint override and falls back to the provider default", () => {
    const overridden = {
      runs: {
        gateway: {
          ...document.runs["prime-openrouter"],
          auth: { ...document.runs["prime-openrouter"].auth, endpoint: "https://gateway.internal/v1" },
        },
      },
    };

    expect(resolveRunProfile(overridden, "gateway", prime).endpoint).toBe("https://gateway.internal/v1");
    expect(resolveRunProfile(document, "prime-openrouter", prime).endpoint)
      .toBe("https://openrouter.ai/api/v1");
  });

  it("lists the profiles a document defines so an unknown name is actionable", () => {
    expect(liveRunProfileNames(document)).toEqual(["prime-openrouter", "codex-openai"]);
    expect(liveRunProfileNames({})).toEqual([]);
    expect(() => resolveRunProfile(document, "typo", prime))
      .toThrow(/It defines: prime-openrouter, codex-openai/);
  });

  it("names the missing field without ever quoting the key", () => {
    const withRun = (run) => ({ runs: { only: { ...document.runs["codex-openai"], ...run } } });
    const cases = [
      [withRun({ auth: { kind: "nope", apiKey: "test-key" } }), /auth.kind set to one of/],
      [withRun({ auth: { kind: "openrouter" } }), /needs auth.apiKey for openrouter/],
      [withRun({ auth: { kind: "codex-subscription", apiKey: "test-key" } }), /leave auth.apiKey null/],
      [withRun({ modelId: "" }), /needs modelId/],
      [withRun({ harness: "  " }), /needs harness/],
    ];
    for (const [candidate, expected] of cases) {
      expect(() => resolveRunProfile(candidate, "only", codex)).toThrow(expected);
      try {
        resolveRunProfile(candidate, "only", codex);
      } catch (error) {
        expect(error.message).not.toContain("test-key");
      }
    }
  });

  it("covers every auth kind the file offers", () => {
    for (const kind of Object.keys(LIVE_RUN_AUTH)) {
      const apiKey = LIVE_RUN_AUTH[kind].contract === "secret@1" ? "test-key" : null;
      const candidate = { runs: { only: { ...document.runs["codex-openai"], auth: { kind, apiKey } } } };
      expect(resolveRunProfile(candidate, "only", codex).adapterId).toBe(LIVE_RUN_AUTH[kind].adapterId);
    }
  });
});
