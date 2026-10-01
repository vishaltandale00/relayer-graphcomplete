import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { bindAutonomousCaseSnapshot, createAutonomousCaseSnapshot } from "../packages/eval-runner/src/index.ts";
import { EvalService } from "../desktop/eval-main/eval-service.mjs";
import { createSyntheticExternalCatalog } from "../packages/eval-runner/test/fixtures/external-catalog.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const directories = [];
const externalCaseIds = ["fixture.external-a", "fixture.external-b"];
const externalSuiteId = "synthetic-external-suite";
const providerReference = "connected-product-provider";
const originalFetch = globalThis.fetch;
const directoriesForFixture = () => [
  join(repositoryRoot, "harnesses", "fixture-task-system.yaml"),
  join(repositoryRoot, "harnesses", "codex-basic.yaml"),
  join(repositoryRoot, "harnesses", "codex-layered-navigation-luna.yaml"),
];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("EvalService live external authorization", () => {
  it("rejects external human tasks before preparation without bound authorization", async () => {
    const { service, validateLiveCredential, product } = await openService();
    const callsBefore = product.mock.calls.length;
    await expect(service.prepareHumanTask({ testCaseId: externalCaseIds[0], harnessConfigurationName: "codex-basic", sessionId: "human-external" }))
      .rejects.toThrow("External interactive tasks require confirmation");
    expect(validateLiveCredential).not.toHaveBeenCalled();
    expect(product.mock.calls).toHaveLength(callsBefore);
  });
  it("keeps interactive cases out of unattended matrix runs", async () => {
    const { service, validateLiveCredential } = await openService({ interactive: true });
    await expect(service.createRun(liveSelection({ testCaseIds: [externalCaseIds[0]] })))
      .rejects.toThrow("Interactive cases require a participant");
    expect(service.listRuns()).toEqual([]);
    expect(validateLiveCredential).not.toHaveBeenCalled();
    expect(service.catalog().suites[0]).toMatchObject({ available: false });
    expect(service.catalog().cases.find(({ id }) => id === externalCaseIds[0])).toBeDefined();
  });

  it("pins an external human subscription route, dispatches ordinary input, and grades with the external callback", async () => {
    const route = { selectedModel: { harnessId: "codex-basic", providerId: "codex", modelId: "gpt-5.6-sol" }, productModelSelection: true, providerAdapterId: "codex-subscription" };
    const { service, product } = await openService({ interactive: true, validateLiveCredential: vi.fn(async () => route) });
    const selection = { testCaseId: externalCaseIds[0], harnessConfigurationName: "codex-basic", sessionId: "human-external", maxCompletions: 3, endpoint: "A verified change", mode: "human" };
    const prepared = await service.prepareHumanTask({ ...selection, liveAuthorization: { ...selection, confirmed: true, billingMode: "subscription-only" } });
    expect(prepared.humanBrief).toBe("PRIVATE_PARTICIPANT");
    expect(prepared.humanRubric).toContain("PRIVATE_REVIEW_CRITERION");
    expect(JSON.stringify(service.catalog())).not.toMatch(/PRIVATE_PARTICIPANT|PRIVATE_REVIEW_CRITERION/);
    expect(prepared.execution.catalogIdentity.commit).toBe("a".repeat(40));
    expect(prepared.execution.pinnedModelResolution).toEqual(route);
    await service.createHumanTaskThread(prepared, 0);
    expect(product.mock.calls.some(([url]) => new URL(url).pathname === "/api/threads")).toBe(true);
    expect(JSON.stringify(product.mock.calls)).not.toMatch(/PRIVATE_PARTICIPANT|PRIVATE_REVIEW_CRITERION/);
    const grade = await service.gradeHumanTaskStep(prepared, 0);
    expect(grade.result).toEqual([{ name: "workspace:contract", passed: true, detail: "Synthetic deterministic result." }]);
    service.externalCatalog.assertUnchanged = async () => { throw new Error("catalog drift"); };
    await expect(service.createHumanTaskThread(prepared, 0)).rejects.toThrow("catalog drift");
    await expect(service.gradeHumanTaskStep(prepared, 0)).rejects.toThrow("catalog drift");
  });

  it.each(["catalog", "credential", "materialize", "thread", "grade"])("cancels external %s work without late product dispatch", async (phase) => {
    const route = { selectedModel: { providerId: "codex", modelId: "gpt-5.6-sol" }, productModelSelection: true, providerAdapterId: "codex-subscription" };
    const { service, product } = await openService({ interactive: true, validateLiveCredential: vi.fn(async () => route) });
    const selection = { testCaseId: externalCaseIds[0], harnessConfigurationName: "codex-basic", sessionId: "cancel-external", maxCompletions: 3, endpoint: "A verified change", mode: "human" };
    selection.liveAuthorization = { ...selection, confirmed: true, billingMode: "subscription-only" };
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const stall = value => { entered(); return new Promise(resolve => { release = () => resolve(value); }); };
    let prepared;
    if (["thread", "grade"].includes(phase)) prepared = await service.prepareHumanTask(selection);
    if (["catalog", "thread"].includes(phase)) service.externalCatalog.assertUnchanged = () => stall();
    if (phase === "credential") service.validateLiveCredential = () => stall(route);
    const external = service.externalCases.get(externalCaseIds[0]);
    if (phase === "materialize") {
      const materialize = external.materialize;
      external.materialize = async input => stall(await materialize(input));
    }
    if (phase === "grade") external.grade = () => stall([]);
    const before = product.mock.calls.length;
    const controller = new AbortController();
    const operation = phase === "thread" ? service.createHumanTaskThread(prepared, 0, { signal: controller.signal })
      : phase === "grade" ? service.gradeHumanTaskStep(prepared, 0, { signal: controller.signal })
      : service.prepareHumanTask(selection, { signal: controller.signal });
    const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
    await started; controller.abort(); await rejected;
    release(); await new Promise(resolve => setImmediate(resolve));
    expect(product.mock.calls.slice(before).filter(([, options]) => options?.method === "POST")).toEqual([]);
  });

  it("rejects a subscription without an exact model before preparation", async () => {
    const { service } = await openService({ validateLiveCredential: vi.fn(async () => ({ providerAdapterId: "codex-subscription" })) });
    const selection = { testCaseId: externalCaseIds[0], harnessConfigurationName: "codex-basic", sessionId: "invalid-route", maxCompletions: 3, endpoint: "A verified change", mode: "human" };
    await expect(service.prepareHumanTask({ ...selection, liveAuthorization: { ...selection, confirmed: true, billingMode: "subscription-only" } }))
      .rejects.toThrow("exact provider model route");
  });

  it("refuses API routes and altered authorization before external human preparation", async () => {
    const { service, product } = await openService({ validateLiveCredential: vi.fn(async () => ({ providerAdapterId: "openai-api-key" })) });
    const selection = { testCaseId: externalCaseIds[0], harnessConfigurationName: "codex-basic", sessionId: "human-external", maxCompletions: 3, endpoint: "A verified change", mode: "human" };
    const liveAuthorization = { ...selection, confirmed: true, billingMode: "subscription-only" };
    const before = product.mock.calls.length;
    await expect(service.prepareHumanTask({ ...selection, maxCompletions: 4, liveAuthorization })).rejects.toThrow("confirmation bound");
    await expect(service.prepareHumanTask({ ...selection, liveAuthorization })).rejects.toThrow("API spending is not authorized");
    expect(product.mock.calls).toHaveLength(before);
  });

  it.each([
    ["individual", { testCaseIds: [externalCaseIds[0]] }],
    ["suite", { suiteId: externalSuiteId }],
  ])("rejects an external live %s before queueing without exact authorization", async (_kind, caseSelection) => {
    const { service, validateLiveCredential } = await openService();
    const selection = liveSelection({ ...caseSelection, includeAuthorization: false });

    await expect(service.createRun(selection)).rejects.toThrow("External live Eval requires confirmation");
    expect(service.listRuns()).toEqual([]);
    expect(validateLiveCredential).not.toHaveBeenCalled();
  });

  it("rejects a suite whose authorization binds a different resolved member order", async () => {
    const { service, validateLiveCredential } = await openService();
    const selection = liveSelection({ suiteId: externalSuiteId });
    selection.liveAuthorization = authorization({
      testCaseIds: [...externalCaseIds].reverse(),
    });

    await expect(service.createRun(selection)).rejects.toThrow("bound to the resolved cases");
    expect(service.listRuns()).toEqual([]);
    expect(validateLiveCredential).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, Number.NaN])("requires a positive declared cap before live admission (%s)", async (declaredCostCapUsd) => {
    const { service, validateLiveCredential } = await openService();
    const selection = liveSelection({ testCaseIds: [externalCaseIds[0]] });
    selection.liveAuthorization = authorization();
    if (declaredCostCapUsd === undefined) delete selection.liveAuthorization.declaredCostCapUsd;
    else selection.liveAuthorization.declaredCostCapUsd = declaredCostCapUsd;

    await expect(service.createRun(selection)).rejects.toThrow("declared positive USD cost cap");
    expect(service.listRuns()).toEqual([]);
    expect(validateLiveCredential).not.toHaveBeenCalled();
  });

  it.each(["missing validator", "disconnected credential"])("fails closed before queueing when the trusted credential check is %s", async (mode) => {
    const validateLiveCredential = mode === "missing validator"
      ? undefined
      : vi.fn(async () => { throw new Error("credential disconnected"); });
    const { service } = await openService({ validateLiveCredential });

    await expect(service.createRun(liveSelection({ testCaseIds: [externalCaseIds[0]] })))
      .rejects.toThrow(mode === "missing validator" ? "no trusted credential validator" : "credential disconnected");
    expect(service.listRuns()).toEqual([]);
  });

  it("persists the exact suite authorization and validates Codex for a paid judge over a deterministic fixture", async () => {
    const validateLiveCredential = vi.fn(async () => {});
    const { service } = await openService({
      validateLiveCredential,
      simulatedUserJudgeRunner: async () => ({ status: "failed", error: "Synthetic judge fixture." }),
    });
    const selection = liveSelection({
      suiteId: externalSuiteId,
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "simulated-user",
    });
    const created = await service.createRun(selection);
    const completed = await waitForTerminal(service, created.id);
    expect(completed.executions[0].turns).not.toHaveLength(0);

    expect(validateLiveCredential).toHaveBeenCalledOnce();
    expect(validateLiveCredential).toHaveBeenCalledWith(
      { name: "simulated-user", implementation: "codex.basic" },
      providerReference,
    );
    expect(completed.testCaseIds).toEqual(externalCaseIds);
    expect(completed.liveAuthorization).toEqual(authorization({
      testCaseIds: externalCaseIds,
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "simulated-user",
    }));
    const stored = JSON.parse(await readFile(service.stateFile, "utf8"));
    expect(stored.runs[0].liveAuthorization).toEqual(completed.liveAuthorization);
  });

  it("pins the credential-validated provider route into every matching external execution", async () => {
    const pinnedModelResolution = {
      selectedModel: {
        harnessId: "codex-basic",
        familyId: 7,
        providerId: "codex",
        modelId: "gpt-6-sol",
      },
      productModelSelection: true,
    };
    const validateLiveCredential = vi.fn(async () => pinnedModelResolution);
    const { service, product } = await openService({ validateLiveCredential });

    const created = await service.createRun(liveSelection({ testCaseIds: [externalCaseIds[0]] }));
    const completed = await waitForTerminal(service, created.id);

    expect(validateLiveCredential).toHaveBeenCalledWith(
      expect.objectContaining({ name: "codex-basic", implementation: "codex.basic" }),
      providerReference,
    );
    expect(completed.executions[0]).toMatchObject({
      pinnedModelResolution,
      modelResolution: pinnedModelResolution,
    });
    const threadRequest = product.mock.calls.find(([url, options]) => (
      new URL(url).pathname === "/api/threads" && options?.method === "POST"
    ));
    expect(JSON.parse(threadRequest[1].body)).toMatchObject({
      harnessConfigurationName: "codex-basic",
      modelSelection: {
        familyId: 7,
        providerId: "codex",
        modelId: "gpt-6-sol",
      },
    });
  });

  it("preserves the admitted configuration-owned Codex model across follow-ups without reselecting", async () => {
    const pinnedModelResolution = {
      selectedModel: null,
      productModelSelection: false,
      configurationModel: "gpt-5.6-luna",
    };
    const validateLiveCredential = vi.fn(async () => pinnedModelResolution);
    const selectModel = vi.fn(async () => { throw new Error("Configuration-owned execution must not reselect a product model."); });
    const { service, product } = await openService({ validateLiveCredential, selectModel, followUpPrompt: "Check the implementation once more." });

    const created = await service.createRun(liveSelection({
      testCaseIds: [externalCaseIds[0]],
      harnessConfigurationNames: ["codex-layered-navigation-luna"],
    }));
    const completed = await waitForTerminal(service, created.id);

    expect(validateLiveCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "codex-layered-navigation-luna",
        implementation: "codex.basic",
        settings: { model: "gpt-5.6-luna", modelReasoningEffort: "medium", promptProfile: "layered-navigation-v1", skipGitRepoCheck: true },
      }),
      providerReference,
    );
    expect(completed.executions[0]).toMatchObject({
      pinnedModelResolution,
      modelResolution: pinnedModelResolution,
    });
    const threadRequest = product.mock.calls.find(([url, options]) => (
      new URL(url).pathname === "/api/threads" && options?.method === "POST"
    ));
    const threadBody = JSON.parse(threadRequest[1].body);
    expect(threadBody.harnessConfigurationName).toBe("codex-layered-navigation-luna");
    expect(threadBody).not.toHaveProperty("modelSelection");
    expect(completed.status).toBe("passed");
    expect(selectModel).not.toHaveBeenCalled();
    const followUps = product.mock.calls.filter(([url, options]) => new URL(url).pathname === "/api/threads/thread-1/interactions" && options?.method === "POST");
    expect(followUps).toHaveLength(1);
    expect(JSON.parse(followUps[0][1].body)).toEqual({ text: "Check the implementation once more." });
  });

  it("rejects a credential route that would omit its selected model before queueing", async () => {
    const validateLiveCredential = vi.fn(async () => ({
      selectedModel: {
        harnessId: "codex-basic",
        providerId: "codex",
        modelId: "gpt-6-sol",
      },
      productModelSelection: false,
    }));
    const { service, product } = await openService({ validateLiveCredential });

    await expect(service.createRun(liveSelection({ testCaseIds: [externalCaseIds[0]] })))
      .rejects.toThrow("did not resolve an exact provider model route");
    expect(service.listRuns()).toEqual([]);
    expect(product.mock.calls.some(([url]) => new URL(url).pathname === "/api/threads")).toBe(false);
  });

  it("keeps an external deterministic fixture run exempt from live authorization", async () => {
    const validateLiveCredential = vi.fn(async () => {});
    const { service } = await openService({ validateLiveCredential });
    const created = await service.createRun({
      testCaseIds: [externalCaseIds[0]],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    const completed = await waitForTerminal(service, created.id);

    expect(completed.liveAuthorization).toBeNull();
    expect(validateLiveCredential).not.toHaveBeenCalled();
  });

  it("requires fresh auth for an external live rejudge even after the catalog is absent", async () => {
    const validateLiveCredential = vi.fn(async () => {});
    const simulatedUserJudgeRunner = vi.fn(async () => ({ status: "failed", error: "Synthetic judge fixture." }));
    const { service, stateFile, product } = await openService({ validateLiveCredential });
    const created = await service.createRun({
      testCaseIds: [externalCaseIds[0]],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    const completed = await waitForTerminal(service, created.id);
    expect(completed.executions[0].turns).not.toHaveLength(0);
    const executionId = completed.executions[0].id;
    const persistedCatalogFree = await new EvalService({
      stateFile,
      productSession: { origin: "http://127.0.0.1:43123", cookie: { name: "relayer", value: "test" } },
      configurationPaths: directoriesForFixture(),
      platform: "darwin",
      validateLiveCredential,
      simulatedUserJudgeRunner,
    }).open();
    const requestsBeforeUnauthorizedAttempt = product.mock.calls.length;

    await expect(persistedCatalogFree.rejudgeExecution(executionId, "simulated-user"))
      .rejects.toThrow("External live Eval requires confirmation");
    expect(product.mock.calls).toHaveLength(requestsBeforeUnauthorizedAttempt);
    expect(simulatedUserJudgeRunner).not.toHaveBeenCalled();

    product.emptyAcceptedThread = true;
    const requestsBeforeAuthorizedAttempt = product.mock.calls.length;
    await expect(persistedCatalogFree.rejudgeExecution(executionId, "simulated-user", authorization({
      testCaseIds: [externalCaseIds[0]],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "simulated-user",
    }))).rejects.toThrow("no accepted turns eligible for rejudging");
    expect(validateLiveCredential).toHaveBeenCalledWith(
      { name: "simulated-user", implementation: "codex.basic" },
      providerReference,
    );
    expect(product.mock.calls).toHaveLength(requestsBeforeAuthorizedAttempt + 1);
    expect(simulatedUserJudgeRunner).not.toHaveBeenCalled();
    expect(persistedCatalogFree.getRun(created.id).executions[0].liveJudgeAuthorizations).toMatchObject([{
      confirmed: true,
      credentialReference: providerReference,
      declaredCostCapUsd: 5,
      testCaseIds: [externalCaseIds[0]],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "simulated-user",
    }]);
  });
});

async function openService(options = {}) {
  const validateLiveCredential = Object.hasOwn(options, "validateLiveCredential")
    ? options.validateLiveCredential
    : vi.fn(async () => {});
  const simulatedUserJudgeRunner = options.simulatedUserJudgeRunner ?? null;
  const directory = await mkdtemp(join(tmpdir(), "eval-live-auth-"));
  directories.push(directory);
  const stateFile = join(directory, "eval-data", "test-runs.json");
  const product = fakeExternalProduct();
  globalThis.fetch = product;
  const catalog = createSyntheticExternalCatalog();
  if (options.interactive) catalog.cases = catalog.cases.map((entry) => {
    const boundCase = bindAutonomousCaseSnapshot(entry.boundCase.definition, createAutonomousCaseSnapshot({ ...entry.boundCase.snapshot,
      interactive: { schemaVersion: 1, participantBrief: "PRIVATE_PARTICIPANT", reviewerRubric: { version: "v1", criteria: ["PRIVATE_REVIEW_CRITERION"] }, endpoint: "A verified change", maxCompletions: 3, research: "case-defined" } }));
    return { ...entry, boundCase, definition: { ...entry.definition, caseSnapshot: boundCase.catalogSnapshot, caseSnapshotDigest: boundCase.snapshotDigest } };
  });
  if (options.followUpPrompt) catalog.cases = catalog.cases.map((entry) => ({ ...entry, definition: {
    ...entry.definition, threads: entry.definition.threads.map((thread) => ({ ...thread, prompts: [...thread.prompts, options.followUpPrompt] })),
  } }));
  const service = await new EvalService({
    stateFile,
    productSession: { origin: "http://127.0.0.1:43123", cookie: { name: "relayer", value: "test" } },
    configurationPaths: directoriesForFixture(),
    platform: "darwin",
    externalCatalog: withExternalIdentity(catalog),
    selectModel: options.selectModel ?? null,
    validateLiveCredential,
    simulatedUserJudgeRunner,
    targetKey: "macos-arm64",
  }).open();
  return { service, validateLiveCredential, product, stateFile };
}

function liveSelection({
  suiteId,
  testCaseIds = [],
  harnessConfigurationNames = ["codex-basic"],
  judgeConfigurationName = "deterministic-graph-contract",
  includeAuthorization = true,
} = {}) {
  const selection = {
    ...(suiteId ? { suiteId } : {}),
    testCaseIds,
    harnessConfigurationNames,
    judgeConfigurationName,
  };
  if (includeAuthorization) selection.liveAuthorization = authorization({
    testCaseIds: suiteId ? externalCaseIds : testCaseIds,
    harnessConfigurationNames,
    judgeConfigurationName,
  });
  return selection;
}

function authorization({
  confirmed = true,
  credentialReference = providerReference,
  declaredCostCapUsd = 5,
  testCaseIds = [externalCaseIds[0]],
  harnessConfigurationNames = ["codex-basic"],
  judgeConfigurationName = "deterministic-graph-contract",
} = {}) {
  return { confirmed, credentialReference, declaredCostCapUsd, testCaseIds, harnessConfigurationNames, judgeConfigurationName };
}

function withExternalIdentity(catalog) {
  return {
    ...catalog,
    identity: { schemaVersion: 1, repositoryUrl: "https://example.invalid/eval-catalog.git", commit: "a".repeat(40), tree: "b".repeat(40), entrypoint: "src/index.mjs", entrypointSha256: "c".repeat(64) },
    assertUnchanged: async () => {},
  };
}

function fakeExternalProduct() {
  const output = {
    nodeId: 1,
    rootAction: { id: 11, sourceNodeId: 1, sourceLayerId: null, kind: "navigate", relation: "expand", label: "Response", targetLayerId: 10, state: "accepted" },
    rootLayer: {
      layer: { id: 10, nodes: [2], edges: [], layout: { version: 1, placements: [{ nodeId: 2, x: 0.5, y: 0.5 }] }, state: "accepted" },
      nodes: [{ id: 2, kind: "concept", icon: "queue", title: "Queue", detail: "Tasks wait here.", state: "accepted" }],
      edges: [], actions: [],
    },
  };
  const interaction = { id: "interaction-1", sequence: 1, graphNodeId: 1, completionStatus: "accepted", completionOutput: output, completionError: null, text: "Synthetic project task.", permissionProfileId: "auto", effectiveExecutionDigest: `sha256:${"d".repeat(64)}`, effectivePermissionReceipt: { permissionProfileId: "auto" } };
  const interactions = [interaction];
  let projectId = 0;
  const fetch = vi.fn(async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/model-settings" && (!options.method || options.method === "GET")) return jsonResponse({
      defaults: { harnessId: "fixture-task-system", familyId: 1 },
      harnesses: [
        { id: "fixture-task-system", available: true, modelCompatibility: [{ providerId: "codex" }] },
        { id: "codex-layered-navigation-luna", available: true, modelCompatibility: [], compatibleProviderIds: [] },
      ],
      providers: [{ id: "openai", adapterId: "openai-api", connected: true, models: [{ id: "test-model", visible: true, available: true }] }],
      families: [{ id: 1, enabled: true, position: 0, members: [{ position: 0, providerId: "openai", modelId: "test-model" }] }],
    });
    if (path === "/api/projects" && options.method === "POST") return jsonResponse({ id: `project-${++projectId}`, path: JSON.parse(options.body).path });
    if (path === "/api/threads" && options.method === "POST") return jsonResponse({ id: "thread-1", rootInteractionId: interaction.id });
    if (path === "/api/threads/thread-1" && (!options.method || options.method === "GET")) return jsonResponse({ id: "thread-1", interactions: fetch.emptyAcceptedThread ? [] : interactions });
    if (path === "/api/threads/thread-1/interactions" && options.method === "POST") {
      const next = { ...interaction, id: `interaction-${interactions.length + 1}`, sequence: interactions.length + 1, text: JSON.parse(options.body).text };
      interactions.push(next);
      return jsonResponse(next);
    }
    const layerRoute = /^\/api\/threads\/thread-1\/interactions\/interaction-\d+\/layers\/(\d+)$/.exec(path);
    if (layerRoute) return jsonResponse({ layer: output.rootLayer.layer, nodes: output.rootLayer.nodes, edges: [], actions: [] });
    return jsonResponse({ error: `Unexpected test request ${options.method || "GET"} ${path}` }, 404);
  });
  return fetch;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

async function waitForTerminal(service, runId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const run = service.getRun(runId);
    if (!["queued", "running"].includes(run.status) && typeof run.bundleRef === "string") {
      await service.persistTail;
      return run;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Eval authorization fixture did not finish in time.");
}
