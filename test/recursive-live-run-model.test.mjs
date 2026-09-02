import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LIVE_RUN_AUTH,
  RECURSIVE_LIVE_RUN_TASK,
  compareRuns,
  liveRunProfileNames,
  resolveRunProfile,
  summarizeRun,
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

/** Swaps completion 101's event stream while keeping the child arm intact. */
function withRootEvents(rootEvents) {
  return coherentRun.events.filter((event) => event.completionId !== 101).concat(rootEvents);
}

describe("recursive live run analysis", () => {
  it("accepts a coherent recursive run and records its observable facts", () => {
    const summary = summarizeRun(coherentRun);

    expect(summary.passed, "a coherent run passes").toBe(true);
    expect(summary.findings, "a coherent run is finding-free").toEqual([]);
    expect(summary.semanticChildren, "the invocation-named child").toEqual([202]);
    expect(summary.timings, "first observable graph and total task time").toEqual({
      timeToFirstObservableGraphMs: 3_500,
      totalTaskMs: 60_000,
    });
    expect(summary.judge.verdict, "the deterministic gate never grades semantics").toBe("not-run");

    // The runner pages the projection feed, so repeats and out-of-order pages must
    // collapse back into one durable sequence per completion.
    const paged = summarizeRun({
      ...coherentRun,
      events: [
        revision(3, 2),
        revision(1, 0, { currentLayerId: null }),
        revision(2, 1),
        revision(2, 1),
        ...coherentRun.events.filter((event) => event.completionId === 202),
      ],
    });
    expect(
      paged.revisions.find((entry) => entry.completionId === 101).revisions.map((event) => event.sequence),
      "paged repeats drop and durable sequence order is restored",
    ).toEqual([1, 2, 3]);
    expect(paged.findings, "reordered pages introduce no findings").toEqual([]);

    const filtered = summarizeRun({
      ...coherentRun,
      completionMetadata: [
        ...coherentRun.completionMetadata,
        { nodeId: 303, invocation: { sourceInteractionNodeId: 202, sourceActionId: 7 } },
        { nodeId: 404, invocation: null },
      ],
    });
    expect(filtered.semanticChildren, "grandchildren and uninvoked completions are not children").toEqual([202]);
    expect(filtered.passed, "extra invocations introduce no findings").toBe(true);

    const disabled = summarizeRun({
      ...coherentRun,
      recursionEnabled: false,
      completionMetadata: [],
      completionExecutions: [],
      traces: [{ ...coherentRun.traces[0], completionBrokerAvailable: false }],
    });
    expect(disabled.passed, "recursion disabled expects no child and no broker").toBe(true);

    const sparse = summarizeRun({
      ...coherentRun,
      requestedTemporalFeatures: { providerRecursion: true },
      actualTemporalFeatures: {
        configVersion: 1,
        schemaRead: false, rootCurrentWrite: false, projectionUi: false, invokeResolution: false, providerRecursion: true,
      },
    });
    expect(sparse.requestedTemporalFeatures, "omitted temporal features normalize to false").toEqual({
      configVersion: 1,
      schemaRead: false, rootCurrentWrite: false, projectionUi: false, invokeResolution: false, providerRecursion: true,
    });
    expect(sparse.passed, "normalized request and explicit actual features agree").toBe(true);
  });

  it("names every broken recursive-run promise by name", () => {
    const settledExecution = coherentRun.completionExecutions[0];
    const cases = [
      ["an agent that created no semantic child",
        (run) => ({ ...run, completionMetadata: [], completionExecutions: [], traces: run.traces.slice(0, 1) }),
        ["no semantic child was created by the agent's own decision"]],
      ["a root pointer that never advanced observably",
        (run) => ({
          ...run,
          observations: run.observations.slice(0, 1),
          events: withRootEvents([
            revision(1, 0, { currentLayerId: null }),
            revision(2, 1, { lifecycle: "succeeded" }),
          ]),
        }),
        ["the root current pointer did not advance observably while work proceeded"]],
      ["post-settlement backfill posed as live observations",
        (run) => ({
          ...run,
          observations: run.observations.map((observation) => ({
            ...observation,
            source: "backfill",
            rootStatus: "accepted",
          })),
        }),
        ["the root current pointer did not advance observably while work proceeded"]],
      ["two revisions first seen in one poll",
        (run) => ({
          ...run,
          observations: run.observations.map((observation) => ({ ...observation, pollSequence: 1 })),
        }),
        ["the root current pointer did not advance observably while work proceeded"]],
      ["a root that settled failed",
        (run) => ({ ...run, completionStatus: "failed" }),
        ["the root completion settled failed rather than accepted"]],
      ["a revision unreachable from its predecessor",
        (run) => ({
          ...run,
          events: withRootEvents([
            revision(1, 0, { currentLayerId: null }),
            revision(2, 2, { previousRevision: 1 }),
          ]),
        }),
        ["completion 101 revision 2 is not reachable from 0"]],
      ["an advance that published no layer",
        (run) => ({
          ...run,
          events: withRootEvents([
            revision(1, 0, { currentLayerId: null }),
            revision(2, 1, { currentLayerId: null }),
          ]),
        }),
        ["completion 101 revision 1 advanced without publishing a layer"]],
      ["a revision published after settling stopped",
        (run) => ({
          ...run,
          events: withRootEvents([
            revision(1, 0, { currentLayerId: null }),
            revision(2, 1, { lifecycle: "stopped" }),
            revision(3, 2),
          ]),
        }),
        ["completion 101 published revision 2 after settling stopped"]],
      ["a prepared child that never attached or settled",
        (run) => ({
          ...run,
          completionExecutions: [{
            ...settledExecution,
            phase: "prepared",
            attachment: { present: false },
            settlement: { present: false, valid: false, completionStatus: "running" },
          }],
        }),
        ["child completion 202 was not durably attached and settled accepted"]],
      ["the wrong attachment provider",
        (run) => ({
          ...run,
          completionExecutions: [{
            ...settledExecution,
            attachment: { present: true, provider: "claude", schemaVersion: 1 },
          }],
        }),
        ["child completion 202 was not durably attached and settled accepted"]],
      ["an unsupported attachment schema",
        (run) => ({
          ...run,
          completionExecutions: [{
            ...settledExecution,
            attachment: { present: true, provider: "codex", schemaVersion: 2 },
          }],
        }),
        ["child completion 202 was not durably attached and settled accepted"]],
      ["an invalid settlement object",
        (run) => ({
          ...run,
          completionExecutions: [{
            ...settledExecution,
            settlement: { present: true, valid: false, completionStatus: "accepted" },
          }],
        }),
        ["child completion 202 was not durably attached and settled accepted"]],
      ["an invocation action that mismatches the durable execution",
        (run) => ({
          ...run,
          completionExecutions: [{ ...settledExecution, sourceActionId: 99 }],
        }),
        ["child completion 202 invocation action did not match durable execution"]],
      ["a child that never advanced or published a terminal layer",
        (run) => ({
          ...run,
          events: run.events.filter((event) => event.completionId !== 202).concat([
            revision(5, 0, { completionId: 202, lifecycle: "succeeded", currentLayerId: null }),
          ]),
        }),
        ["child completion 202 did not advance past revision 0",
          "child completion 202 did not publish a succeeded terminal layer"]],
      ["a missing child trace",
        (run) => ({ ...run, traces: run.traces.slice(0, 1) }),
        ["completion 202 has no complete untruncated full-coverage candidate trace"]],
      ["a child trace without broker authority while recursion was enabled",
        (run) => ({
          ...run,
          traces: [run.traces[0], { ...run.traces[1], completionBrokerAvailable: false }],
        }),
        ["completion 202 trace reported completion broker unavailable while recursion was enabled"]],
      ["a root trace with broker authority while recursion was disabled",
        (run) => ({
          ...run,
          recursionEnabled: false,
          completionMetadata: [],
          completionExecutions: [],
          traces: run.traces.slice(0, 1),
        }),
        ["root trace reported completion broker available while recursion was disabled"]],
      ["a runtime feature set that drifted from the request",
        (run) => ({
          ...run,
          requestedTemporalFeatures: { providerRecursion: true },
          actualTemporalFeatures: {
            configVersion: 1,
            schemaRead: false, rootCurrentWrite: false, projectionUi: false, invokeResolution: false,
            providerRecursion: false,
          },
        }),
        ["the graph runtime temporal features did not match the requested feature set"]],
    ];
    expect(cases, "broken-promise inventory").toHaveLength(18);
    for (const [label, mutate, expectedFindings] of cases) {
      const summary = summarizeRun(mutate(coherentRun));
      expect(summary.passed, `${label}: the run fails`).toBe(false);
      for (const finding of expectedFindings) {
        expect(summary.findings, label).toContain(finding);
      }
    }

    expect(summarizeRun({
      ...coherentRun,
      observations: [{ observedAtMs: 2_000, currentLayerId: null }],
    }).timings.timeToFirstObservableGraphMs, "no published layer means no observable graph yet").toBeNull();
  });

  it("reports recursion's time cost as diagnostic-only", () => {
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

    expect(compareRuns(enabled, disabled), "one ordered pair never proves a performance effect").toEqual({
      interpretation: "diagnostic-only; an order-balanced repeated portfolio is required for a performance claim",
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
  const withRun = (run) => ({ runs: { only: { ...document.runs["codex-openai"], ...run } } });

  it("resolves run profiles onto adapter contracts and names every mistake without leaking the key", () => {
    const resolved = resolveRunProfile(document, "prime-openrouter", prime);
    expect(resolved, "an OpenRouter key lands on the secret contract").toEqual({
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
    expect(resolved, "a key harness carries no Codex runtime").not.toHaveProperty("codexExecutable");

    expect(resolveRunProfile(document, "codex-openai", codex), "an OpenAI key binds the isolated Codex runtime")
      .toMatchObject({
        adapterId: "openai-api",
        contract: "secret@1",
        endpoint: "https://api.openai.com/v1",
        codexExecutable: "/managed/codex",
        codexHome: "/isolated/codex-home",
        modelId: "gpt-5-codex",
      });

    const overridden = {
      runs: {
        gateway: {
          ...document.runs["prime-openrouter"],
          auth: { ...document.runs["prime-openrouter"].auth, endpoint: "https://gateway.internal/v1" },
        },
      },
    };
    expect(resolveRunProfile(overridden, "gateway", prime).endpoint, "an endpoint override wins")
      .toBe("https://gateway.internal/v1");
    expect(resolveRunProfile(document, "prime-openrouter", prime).endpoint, "otherwise the provider default")
      .toBe("https://openrouter.ai/api/v1");

    expect(liveRunProfileNames(document), "the document's profile names").toEqual(["prime-openrouter", "codex-openai"]);
    expect(liveRunProfileNames({}), "an empty document defines nothing").toEqual([]);

    const cases = [
      ["an unknown auth kind", withRun({ auth: { kind: "nope", apiKey: "test-key" } }), "only", codex,
        /auth.kind set to one of/],
      ["a secret adapter missing its key", withRun({ auth: { kind: "openrouter" } }), "only", codex,
        /needs auth.apiKey for openrouter/],
      ["a subscription login carrying a key", withRun({ auth: { kind: "codex-subscription", apiKey: "test-key" } }),
        "only", codex, /leave auth.apiKey null/],
      ["a subscription login on a key harness",
        { runs: { sub: { harness: "prime-agent-basic", modelId: "m", auth: { kind: "codex-subscription" } } } },
        "sub", prime, /accepts a key rather than a codex-subscription login/],
      ["a missing modelId", withRun({ modelId: "" }), "only", codex, /needs modelId/],
      ["a blank harness", withRun({ harness: "  " }), "only", codex, /needs harness/],
      ["a codex harness missing its executable and home",
        withRun({ codexExecutable: null, codexHome: null }), "only", codex, /needs codexExecutable/],
      ["an unknown profile name", document, "typo", prime, /It defines: prime-openrouter, codex-openai/],
    ];
    expect(cases, "credential mistake inventory").toHaveLength(8);
    for (const [label, candidate, name, implementation, expected] of cases) {
      let error;
      try {
        resolveRunProfile(candidate, name, implementation);
      } catch (caught) {
        error = caught;
      }
      expect(error, `${label}: rejects`).toBeDefined();
      expect(error.message, label).toMatch(expected);
      expect(error.message, `${label}: never quotes the key`).not.toContain("test-key");
    }

    expect(
      resolveRunProfile(withRun({ codexExecutable: null, codexHome: null }), "only", prime).modelId,
      "the executable and home bind only a Codex harness",
    ).toBe("gpt-5-codex");

    for (const kind of Object.keys(LIVE_RUN_AUTH)) {
      const apiKey = LIVE_RUN_AUTH[kind].contract === "secret@1" ? "test-key" : null;
      const candidate = { runs: { only: { ...document.runs["codex-openai"], auth: { kind, apiKey } } } };
      expect(resolveRunProfile(candidate, "only", codex).adapterId, `auth kind ${kind} resolves`)
        .toBe(LIVE_RUN_AUTH[kind].adapterId);
    }
  });

  it("keeps the checked-in live-run artifacts usable", async () => {
    expect(RECURSIVE_LIVE_RUN_TASK, "the task never instructs delegation").not.toMatch(/delegat|sub-?agent|child|complete\(/i);
    expect(RECURSIVE_LIVE_RUN_TASK.length, "the task is demanding enough to need delegation").toBeGreaterThan(200);

    // The README tells users to copy live-run.example.json; pin the real template's shape
    // against the resolver, loading each harness yaml exactly like the paid entry point, so
    // an unknown or typo'd harness id fails here instead of when a user spends a run.
    const { loadHarnessConfigurations } = await import("@relayer/harness-host");
    const template = JSON.parse(
      readFileSync(new URL("../live-run.example.json", import.meta.url), "utf8"),
    );
    const profiles = Object.entries(template.runs);
    expect(profiles.length, "the template defines at least one run").toBeGreaterThan(0);
    for (const [name, profile] of profiles) {
      const configurationPath = fileURLToPath(
        new URL(`../harnesses/${profile.harness}.yaml`, import.meta.url),
      );
      const configurations = await loadHarnessConfigurations([configurationPath]);
      const implementation = configurations.get(profile.harness)?.implementation;
      expect(typeof implementation, `${name}: harness ${profile.harness}`).toBe("string");
      const resolved = resolveRunProfile(template, name, { implementation });
      expect(typeof resolved.adapterId, name).toBe("string");
      expect(typeof profile.harness, name).toBe("string");
      expect(typeof profile.modelId, name).toBe("string");
    }

    // The entry point awaits its paid main() at top level, so CI must never import it; a
    // module parse catches syntax and import regressions.
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
  }, 20_000);
});
