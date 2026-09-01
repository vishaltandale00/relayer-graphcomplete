import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  LIVE_RUN_AUTH,
  RECURSIVE_LIVE_RUN_TASK,
  compareRuns,
  liveRunProfileNames,
  normalizedTemporalFeatures,
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
  requestedTemporalFeatures: {
    schemaRead: true, rootCurrentWrite: true, projectionUi: true, invokeResolution: true, providerRecursion: true,
  },
  actualTemporalFeatures: {
    configVersion: 1,
    schemaRead: true, rootCurrentWrite: true, projectionUi: true, invokeResolution: true, providerRecursion: true,
  },
  expectedAttachmentProvider: "codex",
  rootCompletionId: 101,
  startedAtMs: 1_000,
  settledAtMs: 61_000,
  completionStatus: "accepted",
  events: [
    revision(1, 0, { currentLayerId: null }),
    revision(2, 1),
    revision(3, 2),
    revision(4, 3, { lifecycle: "succeeded" }),
    revision(5, 0, { completionId: 202, currentLayerId: null }),
    revision(6, 1, { completionId: 202, lifecycle: "succeeded", currentLayerId: 702 }),
  ],
  observations: [
    { observedAtMs: 1_200, pollSequence: 1, source: "live", rootStatus: "running", sequence: 1, completionId: 101, revision: 0, lifecycle: "active", currentLayerId: null },
    { observedAtMs: 4_500, pollSequence: 2, source: "live", rootStatus: "running", sequence: 2, completionId: 101, revision: 1, lifecycle: "active", currentLayerId: 501 },
    { observedAtMs: 9_000, pollSequence: 3, source: "live", rootStatus: "running", sequence: 3, completionId: 101, revision: 2, lifecycle: "active", currentLayerId: 502 },
  ],
  completionMetadata: [
    { nodeId: 202, invocation: { sourceInteractionNodeId: 101, sourceActionId: 41 } },
  ],
  completionExecutions: [{
    completionId: 202,
    sourceCompletionId: 101,
    sourceActionId: 41,
    phase: "settled",
    attachment: { present: true, provider: "codex", schemaVersion: 1 },
    settlement: { present: true, valid: true, completionStatus: "accepted" },
  }],
  traces: [
    { productInteractionId: 1, completionId: 101, status: "complete", coverageComplete: true, completionBrokerAvailable: true },
    { productInteractionId: 2, completionId: 202, status: "complete", coverageComplete: true, completionBrokerAvailable: true },
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
    expect(revisionFindings(
      101,
      orderedRevisions(coherentRun.events).filter((event) => event.completionId === 101),
    )).toEqual([]);
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
    const summary = summarizeRun({ ...coherentRun, completionMetadata: [], completionExecutions: [], traces: coherentRun.traces.slice(0, 1) });

    expect(summary.passed).toBe(false);
    expect(summary.findings).toContain("no semantic child was created by the agent's own decision");
  });

  it("fails a recursion run whose pointer never advanced observably", () => {
    const summary = summarizeRun({
      ...coherentRun,
      observations: coherentRun.observations.slice(0, 1),
      events: [
        revision(1, 0, { currentLayerId: null }),
        revision(2, 1, { lifecycle: "succeeded" }),
        revision(3, 0, { completionId: 202, currentLayerId: null }),
        revision(4, 1, { completionId: 202, lifecycle: "succeeded", currentLayerId: 702 }),
      ],
    });

    expect(summary.findings).toContain(
      "the root current pointer did not advance observably while work proceeded",
    );
  });

  it("does not count post-settlement backfill or two revisions first seen in one poll as live progress", () => {
    const afterSettlement = summarizeRun({
      ...coherentRun,
      observations: coherentRun.observations.map((observation) => ({
        ...observation,
        source: "backfill",
        rootStatus: "accepted",
      })),
    });
    const onePoll = summarizeRun({
      ...coherentRun,
      observations: coherentRun.observations.map((observation) => ({ ...observation, pollSequence: 1 })),
    });

    expect(afterSettlement.findings).toContain(
      "the root current pointer did not advance observably while work proceeded",
    );
    expect(onePoll.findings).toContain(
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
      completionExecutions: [],
      traces: [{ ...coherentRun.traces[0], completionBrokerAvailable: false }],
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
      completionExecutions: [],
      traces: [{ ...coherentRun.traces[0], completionBrokerAvailable: false }],
    });

    expect(compareRuns(enabled, disabled)).toEqual({
      interpretation: "diagnostic-only; an order-balanced repeated portfolio is required for a performance claim",
      timeToFirstObservableGraphMs: { enabled: 3_500, disabled: 39_000 },
      totalTaskMs: { enabled: 60_000, disabled: 45_000, overheadMs: 15_000 },
    });
  });

  it("fails closed when a prepared child never attached or settled", () => {
    const summary = summarizeRun({
      ...coherentRun,
      completionExecutions: [{
        completionId: 202,
        sourceCompletionId: 101,
        sourceActionId: 41,
        phase: "prepared",
        attachment: { present: false },
        settlement: { present: false, valid: false, completionStatus: "running" },
      }],
    });

    expect(summary.passed).toBe(false);
    expect(summary.findings).toContain("child completion 202 was not durably attached and settled accepted");
  });

  it("requires the exact attachment provider, schema, and a valid object settlement", () => {
    for (const execution of [
      { ...coherentRun.completionExecutions[0], attachment: { present: true, provider: "claude", schemaVersion: 1 } },
      { ...coherentRun.completionExecutions[0], attachment: { present: true, provider: "codex", schemaVersion: 2 } },
      { ...coherentRun.completionExecutions[0], settlement: { present: true, valid: false, completionStatus: "accepted" } },
    ]) {
      const summary = summarizeRun({ ...coherentRun, completionExecutions: [execution] });
      expect(summary.findings).toContain("child completion 202 was not durably attached and settled accepted");
    }
  });

  it("requires graph invocation action identity to match the durable execution binding", () => {
    const summary = summarizeRun({
      ...coherentRun,
      completionExecutions: [{ ...coherentRun.completionExecutions[0], sourceActionId: 99 }],
    });

    expect(summary.findings).toContain(
      "child completion 202 invocation action did not match durable execution",
    );
  });

  it("requires the child to advance and publish a terminal layer", () => {
    const summary = summarizeRun({
      ...coherentRun,
      events: coherentRun.events.filter((event) => event.completionId !== 202).concat([
        revision(5, 0, { completionId: 202, lifecycle: "succeeded", currentLayerId: null }),
      ]),
    });

    expect(summary.findings).toContain("child completion 202 did not advance past revision 0");
    expect(summary.findings).toContain("child completion 202 did not publish a succeeded terminal layer");
  });

  it("requires complete traces and the exact broker scope for both arms", () => {
    const missingChildTrace = summarizeRun({ ...coherentRun, traces: coherentRun.traces.slice(0, 1) });
    const childWithoutBroker = summarizeRun({
      ...coherentRun,
      traces: [coherentRun.traces[0], { ...coherentRun.traces[1], completionBrokerAvailable: false }],
    });
    const disabledWithBroker = summarizeRun({
      ...coherentRun,
      recursionEnabled: false,
      completionMetadata: [],
      completionExecutions: [],
      traces: coherentRun.traces.slice(0, 1),
    });

    expect(missingChildTrace.findings).toContain("completion 202 has no complete untruncated full-coverage candidate trace");
    expect(childWithoutBroker.findings).toContain(
      "completion 202 trace reported completion broker unavailable while recursion was enabled",
    );
    expect(disabledWithBroker.findings).toContain(
      "root trace reported completion broker available while recursion was disabled",
    );
  });

  it("normalizes and verifies the graph runtime's effective temporal feature set", () => {
    expect(normalizedTemporalFeatures({ providerRecursion: true })).toEqual({
      configVersion: 1,
      schemaRead: false,
      rootCurrentWrite: false,
      projectionUi: false,
      invokeResolution: false,
      providerRecursion: true,
    });
    const summary = summarizeRun({
      ...coherentRun,
      requestedTemporalFeatures: { providerRecursion: true },
      actualTemporalFeatures: {
        configVersion: 1,
        schemaRead: false,
        rootCurrentWrite: false,
        projectionUi: false,
        invokeResolution: false,
        providerRecursion: false,
      },
    });
    expect(summary.findings).toContain(
      "the graph runtime temporal features did not match the requested feature set",
    );
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

  it("resolves the checked-in live-run template users copy", () => {
    // The README tells users to copy live-run.example.json; the model tests
    // above exercise an inline duplicate, so this checkpoint pins the real
    // template's shape against the same resolver.
    const template = JSON.parse(
      readFileSync(new URL("../live-run.example.json", import.meta.url), "utf8"),
    );
    const profiles = Object.entries(template.runs);
    expect(profiles.length).toBeGreaterThan(0);
    for (const [name, profile] of profiles) {
      const implementation =
        profile.harness === "codex-basic" ? "codex.basic" : "prime-agent.basic";
      const resolved = resolveRunProfile(template, name, { implementation });
      expect(typeof resolved.adapterId, name).toBe("string");
      expect(typeof profile.harness, name).toBe("string");
      expect(typeof profile.modelId, name).toBe("string");
    }
  });

  it("keeps the paid live-run entry point parseable without executing it", () => {
    // The entry point awaits its paid main() at top level, so CI must never
    // import it; a module parse catches syntax and import regressions.
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--check"],
      {
        input: readFileSync(
          new URL("../scripts/run-recursive-live-run.mjs", import.meta.url),
        ),
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
  });
});
