import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digestHarnessConfiguration } from "../packages/harness-host/src/configuration.ts";
import { instructionGraphControlName, instructionGraphHarnessPair, validateInstructionGraphComparison, finalizeInstructionGraphComparison, preflightInstructionGraphComparison } from "../desktop/eval-main/instruction-graph-comparison.mjs";
import { instructionMetricsFromTrace, aggregateInstructionMetrics } from "../desktop/eval-main/instruction-graph-metrics.mjs";
import { authorizeInstructionGraphSelection, projectExecutionDossier } from "../desktop/eval-renderer/run-model.js";

const caseId = "empty-project.task-system.two-turn";
const cases = [{ id: caseId, prompts: ["First", "Second"] }];
const authorization = { confirmed: true, credentialReference: "connected-product-provider", rootProviderExecutions: 4, agentAuthoredChildren: true, declaredCostCapUsd: 10 };
const directories = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const usageEvent = (inputTokens, outputTokens, threadId = "main") => ({ type: "provider.event", data: { method: "thread/tokenUsage/updated", params: { threadId, tokenUsage: { total: { inputTokens, outputTokens, cachedInputTokens: 2 } } } } });

async function serviceFixture() {
  const { EvalService } = await import("../desktop/eval-main/eval-service.mjs");
  const directory = await mkdtemp(join(tmpdir(), "instruction-graph-eval-")); directories.push(directory);
  const service = await new EvalService({ validateLiveCredential: vi.fn(async (configuration) => ({ selectedModel: { harnessId: configuration.name, familyId: 1, providerId: "work", modelId: "first" }, productModelSelection: true, providerAdapterId: "codex-subscription" })), stateFile: join(directory, "runs.json"), productSession: { origin: "http://product.invalid", cookie: { name: "control", value: "test" } }, configurationPaths: [resolve("harnesses/codex-full-prompt-control.yaml"), resolve("harnesses/codex-basic.yaml")], targetKey: "macos-arm64" }).open();
  const treatment = structuredClone(service.configurations.get(instructionGraphControlName));
  treatment.name = instructionGraphHarnessPair[1];
  Object.assign(treatment.settings, { promptProfile: "instruction-graph-v1", instructionGraphVersionKey: "codex-instruction-graph-v1", instructionGraphDigest: "a".repeat(64) });
  service.configurations.set(treatment.name, treatment);
  return service;
}

describe("Instruction graph Eval comparison", () => {
  it("admits only the exact matched V6 pair and enforces live consent at the real run boundary", async () => {
    const service = await serviceFixture();
    const selection = { testCaseIds: [caseId], harnessConfigurationNames: [...instructionGraphHarnessPair], judgeConfigurationName: "deterministic-graph-contract" };
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(service.createRun(selection)).rejects.toThrow("4 live roots");
    expect(fetch).not.toHaveBeenCalled();
    const validate = (extra = {}) => validateInstructionGraphComparison({ names: [...instructionGraphHarnessPair], configurations: service.configurations, cases, targetKey: "macos-arm64", authorization, ...extra });
    expect(validate()).toMatchObject({ kind: "instruction-graph-pair", qualityEquivalence: "unproven", tokenUsage: { totalInputTokens: null } });
    expect(service.catalog().ablations).toEqual([expect.objectContaining({ harnessPairs: [{ control: instructionGraphControlName, treatment: instructionGraphHarnessPair[1] }] })]);
    expect(() => validate({ names: ["codex-basic", instructionGraphHarnessPair[1]] })).toThrow("exact ordered pair");
    await expect(service.createRun({ ...selection, harnessConfigurationNames: ["codex-basic", instructionGraphHarnessPair[1]], liveAuthorization: authorization })).rejects.toThrow("exact ordered pair");
    expect(() => authorizeInstructionGraphSelection({ ...selection, harnessConfigurationNames: ["codex-basic", instructionGraphHarnessPair[1]] }, { cases }, () => true, () => 10)).toThrow("frozen full-prompt control");
    expect(() => validate({ names: [...instructionGraphHarnessPair].reverse() })).toThrow("exact ordered pair");
    expect(() => validate({ targetKey: "linux-x64" })).toThrow("qualified");
    expect(() => validate({ authorization: { ...authorization, rootProviderExecutions: 2 } })).toThrow("4 live roots");
    service.configurations.get(instructionGraphHarnessPair[1]).settings.modelReasoningEffort = "high";
    await expect(service.createRun({ ...selection, liveAuthorization: authorization })).rejects.toThrow("must match");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("pins the treatment to the first resolved route and durably preserves an unsuccessful comparison", async () => {
    const service = await serviceFixture();
    service.selectModel = vi.fn(async () => ({ familyId: 1, providerId: "work", modelId: "first" }));
    const dispatches = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      if (new URL(url).pathname === "/api/model-settings") return Response.json({ harnesses: [{ id: instructionGraphControlName, modelRules: { allow: [], deny: [] } }], providers: [], families: [] });
      if (new URL(url).pathname === "/api/threads") { dispatches.push(JSON.parse(options.body)); throw new Error("Injected dispatch loss"); }
      throw new Error(`Unexpected ${url}`);
    }));
    const run = await service.createRun({ testCaseIds: [caseId], harnessConfigurationNames: [...instructionGraphHarnessPair], judgeConfigurationName: "deterministic-graph-contract", liveAuthorization: authorization });
    await Promise.all(service.running.values());
    const finished = service.getRun(run.id);
    expect(service.selectModel).not.toHaveBeenCalled();
    expect(service.validateLiveCredential).toHaveBeenCalledTimes(2);
    expect(service.validateLiveCredential.mock.calls.map(([config, reference, selection]) => [config.name, reference, selection])).toEqual([
      [instructionGraphControlName, "connected-product-provider", {}], ["codex-instruction-graph-v1", "connected-product-provider", { familyId: 1 }],
    ]);
    expect(dispatches.map(({ harnessConfigurationName, modelSelection }) => ({ harnessConfigurationName, modelSelection }))).toEqual(instructionGraphHarnessPair.map((harnessConfigurationName) => ({ harnessConfigurationName, modelSelection: { familyId: 1 } })));
    expect(finished).toMatchObject({ status: "error", liveAuthorization: authorization, comparison: { passed: false, qualityEquivalence: "unproven" } });
    expect(finished.executions.map(({ modelResolution }) => modelResolution.selectedModel)).toEqual(instructionGraphHarnessPair.map((harnessId) => ({ harnessId, familyId: 1, providerId: "work", modelId: "first" })));
    const reopened = await serviceFixture();
    reopened.stateFile = service.stateFile;
    await reopened.open();
    expect(reopened.getRun(run.id).comparison).toEqual(finished.comparison);
  });

  it.each(["unavailable", "mismatched-model"])("refuses %s treatment preflight before any baseline dispatch", async (failure) => {
    const service = await serviceFixture();
    const original = service.validateLiveCredential;
    service.validateLiveCredential = vi.fn(async (configuration, reference, selection) => {
      const route = await original(configuration, reference, selection);
      if (configuration.name.endsWith("v1")) {
        if (failure === "unavailable") throw new Error("Treatment readiness pending");
        route.selectedModel.modelId = "different";
      }
      return route;
    });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(service.createRun({ testCaseIds: [caseId], harnessConfigurationNames: [...instructionGraphHarnessPair], judgeConfigurationName: "deterministic-graph-contract", liveAuthorization: authorization })).rejects.toThrow(failure === "unavailable" ? "readiness" : "differ");
    expect(fetch).not.toHaveBeenCalled();
    expect(service.listRuns()).toEqual([]);
  });

  it("admits v2 as a separate pinned experiment while preserving the v1 pair", async () => {
    const service = await serviceFixture();
    const v2 = structuredClone(service.configurations.get(instructionGraphHarnessPair[1]));
    v2.name = "codex-instruction-graph-v2";
    Object.assign(v2.settings, { promptProfile: "instruction-graph-v2", instructionGraphVersionKey: v2.name, instructionGraphDigest: "b".repeat(64) });
    service.configurations.set(v2.name, v2);
    const validate = (names) => validateInstructionGraphComparison({ names, configurations: service.configurations, cases, targetKey: "macos-arm64", authorization });
    expect(validate([instructionGraphControlName, v2.name])).toMatchObject({ schemaVersion: 2, harnessPair: [instructionGraphControlName, v2.name], treatment: { readProtocol: 2, digest: "b".repeat(64) } });
    expect(validate([...instructionGraphHarnessPair])).toMatchObject({ treatment: { readProtocol: 1 } });
    expect(() => validate([instructionGraphControlName, ...[instructionGraphHarnessPair[1], v2.name]])).toThrow("exact ordered pair");
    expect(authorizeInstructionGraphSelection({ testCaseIds: [caseId], harnessConfigurationNames: [instructionGraphControlName, v2.name] }, { cases }, () => true, () => 10).liveAuthorization).toEqual(authorization);
  });

  it("reopens historical v1 comparison evidence without assigning a new treatment or regrading", async () => {
    const service = await serviceFixture();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Injected dispatch loss"); }));
    const run = await service.createRun({ testCaseIds: [caseId], harnessConfigurationNames: [...instructionGraphHarnessPair], judgeConfigurationName: "deterministic-graph-contract", liveAuthorization: authorization });
    await Promise.all(service.running.values());
    const state = JSON.parse(await readFile(service.stateFile, "utf8"));
    const stored = state.runs[0];
    stored.harnessConfigurationNames[0] = "codex-basic";
    stored.executions[0].harnessConfigurationName = "codex-basic";
    Object.assign(stored.executions[0].harnessConfiguration, { name: "codex-basic", revision: 18 });
    stored.executions[0].harnessConfigurationDigest = digestHarnessConfiguration(stored.executions[0].harnessConfiguration);
    const legacyConfiguration = structuredClone(stored.executions[0].harnessConfiguration);
    const legacyDigest = stored.executions[0].harnessConfigurationDigest;
    for (const field of ["schemaVersion", "treatment", "harnessPair", "preflight"]) delete state.runs[0].comparison[field];
    const legacy = structuredClone(state.runs[0].comparison);
    await writeFile(service.stateFile, JSON.stringify(state));
    await service.open();
    expect(service.configurations.get("codex-basic")).toMatchObject({ revision: 19, settings: { promptProfile: "instruction-graph-v2" } });
    expect(service.getRun(run.id).comparison).toEqual(legacy);
    expect(service.getRun(run.id).comparison.treatment).toBeUndefined();
    expect(service.getRun(run.id).executions[0].harnessConfiguration).toMatchObject({ name: "codex-basic", revision: 18, settings: { promptProfile: "layered-navigation-multi-agent-v1" } });
    expect(service.getRun(run.id).executions[0].harnessConfiguration).toEqual(legacyConfiguration);
    expect(service.getRun(run.id).executions[0].harnessConfigurationDigest).toBe(legacyDigest);
  });

  it("keeps dashboard consent bound to the actual root count and additional child work", () => {
    const selection = { testCaseIds: [caseId], harnessConfigurationNames: [...instructionGraphHarnessPair] };
    expect(authorizeInstructionGraphSelection(selection, { cases }, () => false, () => 10)).toBeNull();
    expect(authorizeInstructionGraphSelection(selection, { cases }, (message) => {
      expect(message).toContain(`against ${instructionGraphControlName}`);
      expect(message).toContain("4 paid/live Codex root turns"); expect(message).toContain("additional model-controlled"); return true;
    }, () => 10).liveAuthorization).toEqual(authorization);
  });

  it.each([["v1", "codex-basic"], ["v2", "codex-basic"], ["v1", instructionGraphControlName], ["v2", instructionGraphControlName]])("requires accepted matched evidence for %s with saved control %s", (version, controlName) => {
    const treatmentName = `codex-instruction-graph-${version}`;
    const comparison = version === "v1" && controlName === "codex-basic" ? undefined : { treatment: { name: treatmentName, versionKey: treatmentName, digest: "a".repeat(64), readProtocol: version === "v2" ? 2 : 1 }, harnessPair: [controlName, treatmentName], preflight: Object.fromEntries([controlName, treatmentName].map((name) => [name, { selectedModel: { familyId: 1, providerId: "work", modelId: "model" } }])) };
    const control = { testCaseId: caseId, harnessConfigurationName: controlName, modelResolution: { selectedModel: { familyId: 1, modelId: "model" } }, turns: [{ status: "accepted", prompt: "Same", modelSelection: { familyId: 1, providerId: "work", modelId: "model" }, permissionProfileId: "auto", effectivePermissionReceipt: { mode: "auto" }, personalPresentationVersionKey: "personal-presentation-v6", personalPresentationVersionId: 9, candidateTrace: { status: "complete", completionBrokerAvailable: true } }] };
    const treatment = { ...structuredClone(control), harnessConfigurationName: treatmentName, harnessConfiguration: { settings: { instructionGraphVersionKey: treatmentName, instructionGraphDigest: "a".repeat(64) } } };
    treatment.turns[0].instructionMetrics = { instructionDelivery: { versionKey: treatmentName, digest: "a".repeat(64) }, instructionRetrieval: { status: "recorded", successfulReads: 1, readProtocol: version === "v2" ? 2 : 1, reasonCoverage: version === "v2" ? "complete" : "unknown" } };
    expect(finalizeInstructionGraphComparison([control, treatment], [caseId], { [caseId]: 1 }, comparison)).toMatchObject({ passed: true, qualityEquivalence: "unproven" });
    expect(finalizeInstructionGraphComparison([control, treatment], [caseId], { [caseId]: 2 }, comparison).passed).toBe(false);
    treatment.turns[0].instructionMetrics.instructionRetrieval.successfulReads = 0;
    expect(finalizeInstructionGraphComparison([control, treatment], [caseId], { [caseId]: 1 }, comparison).checks.find(({ name }) => name.includes(":retrieval:")).passed).toBe(false);
    treatment.turns[0].instructionMetrics.instructionRetrieval.successfulReads = 1;
    treatment.turns[0].modelSelection.modelId = "changed";
    expect(finalizeInstructionGraphComparison([control, treatment], [caseId], { [caseId]: 1 }, comparison).passed).toBe(false);
    expect(finalizeInstructionGraphComparison([control], [caseId], { [caseId]: 1 }, comparison).passed).toBe(false);
  });

  it("observes instruction body reads separately from metadata discovery and optional search", () => {
    const events = [{ type: "prompt", data: { instructionGraphVersionKey: "codex-instruction-graph-v1", instructionGraphDigest: "a".repeat(64) } }];
    const ledger = [
      { method: "GET", path: "/api/graph/instruction-graph", status: 200 },
      { method: "GET", path: "/api/graph/instruction-graph/nodes/7", status: 200 },
      { method: "GET", path: "/api/graph/instruction-graph/layers/8", status: 403 },
    ];
    expect(instructionMetricsFromTrace(events, { complete: true, ledgerComplete: true, graphOperations: ledger })).toMatchObject({ instructionDelivery: { versionKey: "codex-instruction-graph-v1" }, instructionRetrieval: { status: "recorded", successfulReads: 1, successfulSearches: 0 } });
    expect(instructionMetricsFromTrace(events, { complete: true }).instructionRetrieval).toMatchObject({ status: "unknown", successfulReads: null });
    expect(instructionMetricsFromTrace([usageEvent(5, 1, null)], { complete: true }).providerSessionUsage.status).toBe("unknown");
  });

  it("counts physical v2 body delivery, replays and duplicate metadata separately with reason receipts", () => {
    const reason = { purpose: "authoring", detail: "Need the node submission signature." };
    const operation = (requestKey, delivery, replayed = false, bodyCharacters = 20) => ({ method: "POST", path: "/api/graph/instruction-graph/retrieve", status: 200,
      instructionRetrieval: { requestKey, replayed, reason, entries: [{ nodeId: 7, key: "nodes", delivery, bodyCharacters, bodyBytes: bodyCharacters }] } });
    const events = [{ type: "prompt", data: { instructionGraphVersionKey: "codex-instruction-graph-v2", instructionGraphDigest: "b".repeat(64) } }];
    const graphOperations = [operation("first", "body"), operation("first", "body", true), operation("duplicate", "already-returned", false, 0), {
      ...operation("reread", "reread"), instructionRetrieval: { ...operation("reread", "reread").instructionRetrieval, rereadReason: "Earlier output was truncated." },
    }];
    const metric = instructionMetricsFromTrace(events, { complete: true, ledgerComplete: true, graphOperations });
    expect(metric.instructionRetrieval).toMatchObject({ readProtocol: 2, reasonCoverage: "complete", successfulReads: 3, uniqueModulesRead: 1, uniqueReadRequests: 3, replayBodyResponses: 1, duplicateMetadataResponses: 1, returnedBodyCharacters: 60, returnedBodyBytes: 60 });
    expect(metric.instructionRetrieval.readReasons).toHaveLength(4);
    const dossier = projectExecutionDossier({}, { id: "reasoned", turns: [{ interactionId: 9, graphNodeId: 11, instructionMetrics: metric }] });
    expect(dossier.instructionRetrieval).toMatchObject([{ interactionId: 9, graphNodeId: 11, reasonCoverage: "complete", readReasons: metric.instructionRetrieval.readReasons }]);
    const search = { method: "POST", path: "/api/graph/instruction-graph/search", status: 200, instructionSearchReceipt: { reason: { purpose: "search", detail: "Find the specific repair rule." } } };
    expect(instructionMetricsFromTrace(events, { complete: true, ledgerComplete: true, graphOperations: [...graphOperations, search] }).instructionRetrieval.searchReasons).toHaveLength(1);
    delete search.instructionSearchReceipt;
    expect(instructionMetricsFromTrace(events, { complete: true, ledgerComplete: true, graphOperations: [...graphOperations, search] }).instructionRetrieval.reasonCoverage).toBe("unknown");
    const missing = structuredClone(graphOperations); delete missing[0].instructionRetrieval.reason;
    expect(instructionMetricsFromTrace(events, { complete: true, ledgerComplete: true, graphOperations: missing }).instructionRetrieval).toMatchObject({ reasonCoverage: "unknown", successfulReads: null, returnedBodyCharacters: null });
    expect(instructionMetricsFromTrace(events, { complete: true, graphOperations }).instructionRetrieval.reasonCoverage).toBe("unknown");
  });

  it("records actual prompt size and final cumulative usage once, preserving unknown task coverage", () => {
    const events = [{ type: "prompt", data: { text: "redacted", actualPromptCharacters: 100, actualPromptUtf8Bytes: 120 } }, usageEvent(10, 2), usageEvent(30, 8)];
    const metric = instructionMetricsFromTrace(events, { complete: true });
    expect(metric).toMatchObject({ actualPromptCharacters: 100, providerSessionUsage: { status: "recorded", counters: { inputTokens: 30, outputTokens: 8 }, nativeChildCoverage: "unknown" } });
    const aggregate = aggregateInstructionMetrics({ turns: [{ instructionMetrics: metric }], semanticChildren: [{ instructionMetrics: metric }], lifecycle: { durationMs: 500 } });
    expect(aggregate).toMatchObject({ actualPromptCharacters: 200, observedInputTokens: 60, recordedSessions: 2, totalInputTokens: null, coverage: "unknown", latencyMs: 500, graphWriteRejections: null });
    expect(instructionMetricsFromTrace(events).providerSessionUsage.status).toBe("unknown");
    expect(instructionMetricsFromTrace([usageEvent(30, 8), usageEvent(10, 2)], { complete: true }).providerSessionUsage.status).toBe("unknown");
    expect(instructionMetricsFromTrace([usageEvent(10, 2), usageEvent(20, 4, "native-child")], { complete: true }).providerSessionUsage.status).toBe("unknown");
    expect(aggregateInstructionMetrics({ turns: [{}] })).toMatchObject({ observedInputTokens: null, actualPromptCharacters: null });
  });
});
