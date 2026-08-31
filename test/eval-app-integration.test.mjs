import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  H3_PACKAGE_MANAGER,
  H3_AUTONOMOUS_FIX_CASE_ID,
  H3_AUTONOMOUS_INVESTIGATION_CASE_ID,
  H3_PROJECT_CASE_ID,
  H3_REPOSITORY_URL,
  H3_SEEDED_COMMIT,
  H3_SEEDED_TREE,
  H3_UPSTREAM_COMMIT,
  H3_UPSTREAM_TREE,
  graphMemoryAnchor,
  graphMemoryEvalCaseId,
  graphMemoryEvalPrompts,
  graphMemoryFixtureFactory,
  graphMemorySearchBudget,
  graphMemorySearchParameters,
  graphMemorySearchQuery,
  taskSystemFixtureFactory,
} from "@relayer/eval-runner";
import { afterEach, describe, expect, it } from "vitest";

import { EvalService, evalCases, resolveEvalCasePrompts } from "../desktop/eval-main/eval-service.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const services = [];
const directories = [];

afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Relayer Eval application service", () => {
  it("catalogs graph memory as a harness-neutral run-unique two-turn case", () => {
    const definition = evalCases.find((candidate) => candidate.id === graphMemoryEvalCaseId);
    const firstRun = resolveEvalCasePrompts(definition, "run-alpha");
    const secondRun = resolveEvalCasePrompts(definition, "run-beta");

    expect(definition).toMatchObject({
      name: "Graph memory · prior accepted reference",
      description: expect.stringContaining("prior accepted layer"),
    });
    expect(firstRun).toEqual(graphMemoryEvalPrompts("run-alpha"));
    expect(firstRun).toHaveLength(2);
    expect(firstRun.join("\n")).toContain(graphMemoryAnchor("run-alpha"));
    expect(secondRun.join("\n")).toContain(graphMemoryAnchor("run-beta"));
    expect(firstRun).not.toEqual(secondRun);
    expect(JSON.stringify(definition)).not.toContain("fixture.graph-memory");
    expect(JSON.stringify(definition)).not.toContain("codex.basic");
  });

  it("retains graph-memory search and reference evidence in one product thread", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-graph-memory-app-test-"));
    directories.push(dataDirectory);
    const configurationPath = join(repositoryRoot, "harnesses", "fixture-graph-memory.yaml");
    const runtime = new GraphCompleteRuntimeService({
      userDataDirectory: dataDirectory,
      graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
      configurationPaths: [configurationPath],
      additionalImplementations: { "fixture.graph-memory": graphMemoryFixtureFactory },
      candidateTrace: {
        directory: join(dataDirectory, "eval-data", "candidate-trace-spool"),
        policy: {
          mode: "required",
          requiredFeatures: { prompt: "full", messages: "full" },
          includeNativeArtifacts: false,
          maxBytesPerTurn: 1_000_000,
          maxEventsPerTurn: 1_000,
        },
      },
    });
    services.push(runtime);
    const runtimeSession = await runtime.start();
    const product = new RelayerAppServerService({
      userDataDirectory: dataDirectory,
      binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
      webDirectory: join(repositoryRoot, "desktop", "renderer"),
      permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
      runtimeSession,
      defaultHarnessConfiguration: "fixture-graph-memory",
      allowHarnessOverride: true,
    });
    services.push(product);
    const productSession = await product.start();
    const evalService = await new EvalService({
      stateFile: join(dataDirectory, "eval-data", "test-runs.json"),
      productSession,
      configurationPaths: [configurationPath],
      platform: "darwin",
      candidateTraceExporter: (interactionId, targetDirectory, correlation) => runtime.exportCandidateTrace(interactionId, targetDirectory, correlation),
      candidateTraceRequired: true,
    }).open();

    expect(evalService.catalog()).toMatchObject({
      cases: expect.arrayContaining([expect.objectContaining({ id: graphMemoryEvalCaseId })]),
      harnessConfigurations: expect.arrayContaining([expect.objectContaining({
        name: "fixture-graph-memory",
        implementation: "fixture.graph-memory",
      })]),
    });
    const created = await evalService.createRun({
      testCaseIds: [graphMemoryEvalCaseId],
      harnessConfigurationNames: ["fixture-graph-memory"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    const completed = await waitForCompletedRun(evalService, created.id, 20_000);
    const execution = completed.executions[0];

    expect(completed.status).toBe("passed");
    expect(execution.threadIds).toHaveLength(1);
    expect(execution.turns).toHaveLength(2);
    expect(execution.turns[0].prompt).toContain(graphMemoryAnchor(completed.id));
    expect(execution.turns[1].deterministicChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: expect.stringContaining("search-returned-prior-root"), passed: true }),
      expect.objectContaining({ name: expect.stringContaining("typed-reference-target"), passed: true }),
      expect.objectContaining({ name: expect.stringContaining("ack-search-submit-order"), passed: true }),
    ]));
    expect(execution.turns[1].caseEvidence).toMatchObject({
      anchor: graphMemoryAnchor(completed.id),
      searchedLayerIds: [execution.turns[0].rootLayerId],
      referenceActionId: expect.any(Number),
    });
    const secondTrace = await evalService.candidateTraceContext(
      execution.id,
      execution.turns[1].interactionId,
    );
    expect(secondTrace.graphOperationsEvidence).toMatchObject({
      status: "complete",
      error: null,
      descriptor: {
        format: "relayer-graph-operations-v1",
        truncated: false,
      },
    });
    expect(secondTrace.graphOperations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "/api/graph/search",
        queryContractVersion: 1,
        query: graphMemorySearchQuery,
        parameters: graphMemorySearchParameters,
        budget: graphMemorySearchBudget,
        status: 200,
        searchLayerIds: [execution.turns[0].rootLayerId],
        sequence: expect.any(Number),
      }),
    ]));
    const firstRoot = execution.turns[0].rootLayerId;
    const secondRoot = execution.turns[1].rootLayerId;
    const detail = await productRequest(productSession, `/api/threads/${execution.threadIds[0]}`);
    expect(detail.interactions).toHaveLength(2);
    expect(detail.interactions.every((interaction) => interaction.completionStatus === "accepted")).toBe(true);
    const secondLayer = await productRequest(
      productSession,
      `/api/threads/${execution.threadIds[0]}/interactions/${detail.interactions[1].id}/layers/${secondRoot}`,
    );
    expect(secondLayer.actions).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "navigate",
      relation: "reference",
      sourceLayerId: secondRoot,
      targetLayerId: firstRoot,
      state: "accepted",
    })]));
    expect(evalService.reviewContext(execution.id).cases).toEqual([expect.objectContaining({
      id: graphMemoryEvalCaseId,
      threads: [{ id: execution.threadIds[0], name: "Graph memory · prior accepted reference" }],
    })]);

    let launderedTurns = 0;
    const launderedEvalService = await new EvalService({
      stateFile: join(dataDirectory, "eval-data", "laundered-test-runs.json"),
      productSession,
      configurationPaths: [configurationPath],
      platform: "darwin",
      candidateTraceExporter: async (interactionId, targetDirectory, correlation) => {
        const descriptor = await runtime.exportCandidateTrace(interactionId, targetDirectory, correlation);
        launderedTurns += 1;
        if (launderedTurns !== 2) return descriptor;
        const rewritten = await rewriteGraphOperations(targetDirectory, (operations) => {
          const search = operations.find((event) => event.path === "/api/graph/search");
          search.query = "MATCH (l:Layer) RETURN l AS layer ORDER BY layer ASC";
        });
        return {
          ...descriptor,
          graphOperations: { ...descriptor.graphOperations, ...rewritten.descriptor },
        };
      },
      candidateTraceRequired: true,
    }).open();
    const launderedRun = await launderedEvalService.createRun({
      testCaseIds: [graphMemoryEvalCaseId],
      harnessConfigurationNames: ["fixture-graph-memory"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    const launderedCompleted = await waitForCompletedRun(launderedEvalService, launderedRun.id, 20_000);
    expect(launderedCompleted.status).toBe("failed");
    expect(launderedCompleted.executions[0].turns[1].deterministicChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: expect.stringContaining("search-request-contract"),
        passed: false,
      }),
    ]));

    let exportedTurns = 0;
    let tamperedGraphOperationsPath;
    const corruptedEvalService = await new EvalService({
      stateFile: join(dataDirectory, "eval-data", "corrupted-test-runs.json"),
      productSession,
      configurationPaths: [configurationPath],
      platform: "darwin",
      candidateTraceExporter: async (interactionId, targetDirectory, correlation) => {
        const descriptor = await runtime.exportCandidateTrace(interactionId, targetDirectory, correlation);
        exportedTurns += 1;
        if (exportedTurns !== 2) return descriptor;
        const rewritten = await rewriteGraphOperations(targetDirectory, (operations) => {
          operations[0].interactionNodeId += 10_000;
        });
        tamperedGraphOperationsPath = rewritten.path;
        return {
          ...descriptor,
          graphOperations: {
            ...descriptor.graphOperations,
            ...rewritten.descriptor,
          },
        };
      },
      candidateTraceRequired: true,
    }).open();
    const corruptedRun = await corruptedEvalService.createRun({
      testCaseIds: [graphMemoryEvalCaseId],
      harnessConfigurationNames: ["fixture-graph-memory"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    const corruptedCompleted = await waitForCompletedRun(corruptedEvalService, corruptedRun.id, 20_000);
    const corruptedExecution = corruptedCompleted.executions[0];
    expect(corruptedCompleted.status).toBe("failed");
    expect(corruptedExecution.promotable).toBe(false);
    expect(corruptedExecution.turns.flatMap((turn) => turn.deterministicChecks)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: expect.stringContaining("case-evidence"),
        passed: false,
        detail: "Candidate trace graph-operation ledger contains an invalid receipt.",
      }),
    ]));
    const corruptedTrace = await corruptedEvalService.candidateTraceContext(
      corruptedExecution.id,
      corruptedExecution.turns[1].interactionId,
    );
    expect(corruptedTrace.graphOperations).toEqual([]);
    expect(corruptedTrace.graphOperationsEvidence).toMatchObject({
      status: "invalid",
      error: "Candidate trace graph-operation ledger contains an invalid receipt.",
    });

    await writeFile(tamperedGraphOperationsPath, Buffer.concat([
      await readFile(tamperedGraphOperationsPath),
      Buffer.from("tampered\n"),
    ]));
    const digestCorruptedTrace = await corruptedEvalService.candidateTraceContext(
      corruptedExecution.id,
      corruptedExecution.turns[1].interactionId,
    );
    expect(digestCorruptedTrace.graphOperations).toEqual([]);
    expect(digestCorruptedTrace.graphOperationsEvidence).toMatchObject({
      status: "invalid",
      error: "Candidate trace graph-operation ledger failed digest validation.",
    });
  }, 30_000);

  it("runs case × harness executions through the product server and preserves reviewable threads", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-app-test-"));
    directories.push(dataDirectory);
    const configurationPath = join(repositoryRoot, "harnesses", "fixture-task-system.yaml");
    const runtime = new GraphCompleteRuntimeService({
      userDataDirectory: dataDirectory,
      graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
      configurationPaths: [configurationPath],
      additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory },
      candidateTrace: {
        directory: join(dataDirectory, "eval-data", "candidate-trace-spool"),
        policy: {
          mode: "required",
          requiredFeatures: { prompt: "full", messages: "full" },
          includeNativeArtifacts: false,
          maxBytesPerTurn: 1_000_000,
          maxEventsPerTurn: 1_000,
        },
      },
    });
    services.push(runtime);
    const runtimeSession = await runtime.start();
    const product = new RelayerAppServerService({
      userDataDirectory: dataDirectory,
      binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
      webDirectory: join(repositoryRoot, "desktop", "renderer"),
      permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
      runtimeSession,
      defaultHarnessConfiguration: "fixture-task-system",
      allowHarnessOverride: true,
      allowConversationImport: true,
    });
    services.push(product);
    const productSession = await product.start();
    const workspaceGrades = [];
    const acceptedTopologyGrades = [];
    const evalService = await new EvalService({
      stateFile: join(dataDirectory, "eval-data", "test-runs.json"),
      productSession,
      configurationPaths: [configurationPath],
      candidateTraceExporter: (interactionId, targetDirectory, correlation) => runtime.exportCandidateTrace(interactionId, targetDirectory, correlation),
      candidateTraceRequired: true,
      conversationImportEnabled: true,
      projectFixtureMaterializer: async ({ workspaceDirectory }) => {
        await mkdir(workspaceDirectory, { recursive: true });
        return {
          schemaVersion: 1,
          fixtureId: H3_PROJECT_CASE_ID,
          workspaceDirectory,
          repositoryUrl: H3_REPOSITORY_URL,
          upstreamCommit: H3_UPSTREAM_COMMIT,
          upstreamTree: H3_UPSTREAM_TREE,
          seededCommit: H3_SEEDED_COMMIT,
          seededTree: H3_SEEDED_TREE,
          packageManager: H3_PACKAGE_MANAGER,
          installedWithFrozenLockfile: true,
        };
      },
      workspaceGrader: async ({ grade }) => {
        workspaceGrades.push(grade);
        if (grade === "autonomous-implementation") {
          return [
            "implementation-build",
            "implementation-typecheck",
            "implementation-focused-tests",
            "behavior-lower-boundary",
            "behavior-upper-boundary",
            "behavior-decimal-number",
            "behavior-integer-numeric-string",
            "behavior-decimal-numeric-string",
            "behavior-custom-fallback",
            "implementation-focused-files",
            "implementation-meaningful-commit",
            "implementation-clean",
          ].map((name) => ({ name: `workspace:${name}`, passed: true, detail: `${name} passed.` }));
        }
        if (grade === "diagnosis") {
          return ["diagnosis-baseline-head", "diagnosis-zero-diff", "diagnosis-reproduces-seeded-failure"]
            .map((name) => ({ name: `workspace:${name}`, passed: true, detail: `${name} passed.` }));
        }
        return [{ name: `workspace:${grade}`, passed: true, detail: `${grade} policy passed.` }];
      },
      acceptedTopologyGrader: (topology, { requireGrandchild = false } = {}) => {
        acceptedTopologyGrades.push({
          turnId: topology.turnId,
          layerCount: topology.layers.length,
          requireGrandchild,
        });
        return [
          { name: "graph:accepted-reachable-closure", passed: true, detail: "Accepted topology loaded." },
          ...(requireGrandchild
            ? [{ name: "graph:root-child-grandchild", passed: true, detail: "Test topology policy passed." }]
            : []),
        ];
      },
      platform: "darwin",
    }).open();

    const productModelRequired = await fetch(new URL("/api/threads", productSession.origin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${productSession.cookie.name}=${productSession.cookie.value}`,
      },
      body: JSON.stringify({
        initialMessage: "Product selection must not inherit Eval's raw harness exemption.",
        harnessId: "fixture-task-system",
      }),
    });
    expect(productModelRequired.status).toBe(422);
    expect((await productModelRequired.json()).code).toBe("model_selection_required");

    const created = await evalService.createRun({
      testCaseIds: ["empty-project.task-system.two-turn", "empty-project.task-system.single-turn", "empty-project.hierarchical-overview.single-turn"],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    const completed = await waitForCompletedRun(evalService, created.id);
    expect(completed.status).toBe("passed");
    expect(completed.summary).toMatchObject({ passed: 3, total: 3 });
    expect(completed.executions).toHaveLength(3);
    expect(completed.executions.every((execution) => execution.threadIds.length === 1)).toBe(true);
    expect(completed.executions.find((execution) => execution.testCaseId.endsWith("two-turn")).turns).toHaveLength(2);
    expect(completed.executions.every((execution) => execution.promotable)).toBe(true);
    expect(completed.executions.flatMap((execution) => execution.turns).every((turn) => (
      turn.candidateTrace.status === "complete"
      && Number.isSafeInteger(turn.candidateTrace.personalPresentationVersionId)
      && turn.candidateTrace.ref.endsWith("candidate-trace/manifest.json")
      && turn.candidateTrace.sha256.startsWith("sha256:")
    ))).toBe(true);

    const selected = completed.executions[0];
    const selectedTrace = await evalService.candidateTraceContext(selected.id, selected.turns[0].interactionId);
    expect(selectedTrace.manifest).toMatchObject({
      format: "relayer-harness-trace-v1",
      personalPresentationVersionId: selected.turns[0].candidateTrace.personalPresentationVersionId,
      correlation: { runId: completed.id, executionId: selected.id },
    });
    expect(JSON.stringify(selectedTrace.manifest)).not.toContain("Decision-useful center");
    expect(selectedTrace.events.map((event) => event.type)).toEqual(expect.arrayContaining(["prompt", "message", "run.completed"]));
    const bundle = JSON.parse(await readFile(join(dataDirectory, "eval-data", completed.bundleRef), "utf8"));
    expect(bundle.run.executions[0].turns[0].candidateTrace).toMatchObject({
      status: "complete",
      format: "relayer-harness-trace-v1",
      personalPresentationVersionId: selected.turns[0].candidateTrace.personalPresentationVersionId,
      ref: selected.turns[0].candidateTrace.ref,
    });
    const context = evalService.reviewContext(selected.id);
    expect(context).toMatchObject({
      runId: completed.id,
      harnessConfigurationName: "fixture-task-system",
      selectedExecutionId: selected.id,
      readOnly: true,
    });
    expect(context.cases).toHaveLength(3);
    expect(context.cases.every((testCase) => testCase.threadIds.length === 1)).toBe(true);
    expect(context.cases.map((testCase) => testCase.threads)).toEqual([
      [{ id: completed.executions[0].threadIds[0], name: "Task system · two turns" }],
      [{ id: completed.executions[1].threadIds[0], name: "Task system · one turn" }],
      [{ id: completed.executions[2].threadIds[0], name: "Hierarchical overview · one turn" }],
    ]);

    const detail = await productRequest(productSession, `/api/threads/${selected.threadIds[0]}`);
    expect(detail.interactions[0].completionStatus).toBe("accepted");
    const output = detail.interactions[0].completionOutput;
    const layer = await productRequest(
      productSession,
      `/api/threads/${selected.threadIds[0]}/interactions/${detail.interactions[0].id}/layers/${output.rootLayer.layer.id}`,
    );
    expect(layer.nodes.map((node) => node.title)).toEqual([
      "Incoming queue",
      "Two-worker pool",
      "Results store",
    ]);
    expect(layer.actions).toEqual([
      expect.objectContaining({
        sourceNodeId: layer.nodes[0].id,
        sourceLayerId: layer.layer.id,
        kind: "navigate",
        relation: "expand",
        label: "See queue behavior",
      }),
      expect.objectContaining({
        sourceNodeId: layer.nodes[2].id,
        sourceLayerId: layer.layer.id,
        kind: "invoke",
        targetLayerId: null,
        label: "Plan the next improvement",
      }),
    ]);
    const childLayer = await productRequest(
      productSession,
      `/api/threads/${selected.threadIds[0]}/interactions/${detail.interactions[0].id}/layers/${layer.actions[0].targetLayerId}`,
    );
    expect(childLayer.nodes.map((node) => node.title)).toEqual(["Waiting tasks", "Next claim"]);

    const h3Created = await evalService.createRun({
      testCaseIds: [H3_PROJECT_CASE_ID],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    const h3Completed = await waitForCompletedRun(evalService, h3Created.id);
    expect(h3Completed.executions[0].error).toBeNull();
    expect(h3Completed.status).toBe("passed");
    expect(h3Completed.executions).toHaveLength(1);
    const h3Execution = h3Completed.executions[0];
    expect(h3Execution.threadIds).toHaveLength(3);
    expect(h3Execution.turns.map((turn) => [turn.threadDefinitionId, turn.threadTurnIndex])).toEqual([
      ["architecture", 0],
      ["architecture", 1],
      ["diagnosis", 0],
      ["diagnosis", 1],
      ["implementation", 0],
      ["implementation", 1],
    ]);
    expect(h3Execution.turns).toHaveLength(6);
    expect(h3Execution.turns.map((turn) => turn.permissionProfileId)).toEqual([
      "auto", "auto", "auto", "auto", "auto", "auto",
    ]);
    expect(h3Execution.turns.every((turn) => turn.effectiveExecutionDigest.startsWith("sha256:"))).toBe(true);
    expect(h3Execution.turns.every((turn) => (
      turn.effectivePermissionReceipt.permissionProfileId === "auto"
      && turn.effectivePermissionReceipt.unconfinedHostAccess === false
    ))).toBe(true);
    expect(evalService.reviewContext(h3Execution.id).cases.find((testCase) => (
      testCase.id === H3_PROJECT_CASE_ID
    )).threads).toEqual([
      { id: h3Execution.threadIds[0], name: "Architecture question" },
      { id: h3Execution.threadIds[1], name: "Read-only bug diagnosis" },
      { id: h3Execution.threadIds[2], name: "Implement and commit the repair" },
    ]);
    expect(workspaceGrades).toEqual(["question", "question", "diagnosis", "diagnosis", "implementation"]);
    expect(acceptedTopologyGrades).toHaveLength(6);
    expect(acceptedTopologyGrades.filter((grade) => grade.requireGrandchild)).toHaveLength(0);
    expect(acceptedTopologyGrades.every((grade) => grade.layerCount === 2)).toBe(true);
    const h3Threads = await Promise.all(h3Execution.threadIds.map((threadId) => (
      productRequest(productSession, `/api/threads/${threadId}`)
    )));
    expect(new Set(h3Threads.map((threadDetail) => threadDetail.thread.projectId)).size).toBe(1);
    expect(h3Threads.every((threadDetail) => threadDetail.interactions.length === 2)).toBe(true);
    expect(h3Threads.map((threadDetail) => threadDetail.thread.permissionProfileId)).toEqual(["auto", "auto", "auto"]);

    const autonomousCreated = await evalService.createRun({
      testCaseIds: [H3_AUTONOMOUS_FIX_CASE_ID, H3_AUTONOMOUS_INVESTIGATION_CASE_ID],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    const autonomousCompleted = await waitForCompletedRun(evalService, autonomousCreated.id);
    expect(autonomousCompleted.executions).toHaveLength(2);
    expect(autonomousCompleted.executions.every((execution) => execution.lifecycle.status === "complete")).toBe(true);
    expect(autonomousCompleted.executions.every((execution) => execution.turns.length === 1)).toBe(true);
    expect(autonomousCompleted.executions.every((execution) => execution.caseSnapshotDigest.startsWith("sha256:"))).toBe(true);
    expect(autonomousCompleted.executions.every((execution) => execution.caseSnapshot.artifacts.reference.sealedPath === undefined)).toBe(true);
    expect(autonomousCompleted.executions.every((execution) => execution.outcomeGrade.status === "partial")).toBe(true);
    expect(autonomousCompleted.executions.map((execution) => execution.outcomeGrade.qualified)).toEqual([null, null]);
    expect(autonomousCompleted.executions.every((execution) => execution.outcomeGrade.score === null)).toBe(true);
    expect(autonomousCompleted.executions.map((execution) => execution.outcomeGrade.mandatoryGates.map((gate) => gate.gateId))).toEqual([
      ["functional-behavior", "regression-safety", "scoped-clean-commit"],
      ["read-only-workspace", "independent-reproduction"],
    ]);
    expect(autonomousCompleted.executions.every((execution) => execution.presentationGrade.status === "unjudged")).toBe(true);
  }, 20_000);
});

async function waitForCompletedRun(evalService, runId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = evalService.getRun(runId);
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Eval run did not finish in time: ${JSON.stringify(evalService.getRun(runId))}`);
}

async function productRequest(session, path) {
  const response = await fetch(new URL(path, session.origin), {
    headers: { Cookie: `${session.cookie.name}=${session.cookie.value}` },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}

async function rewriteGraphOperations(targetDirectory, mutate) {
  const path = join(targetDirectory, "graph-operations.jsonl");
  const operations = (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  mutate(operations);
  const bytes = Buffer.from(`${operations.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeFile(path, bytes);
  return {
    path,
    descriptor: {
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      byteLength: bytes.byteLength,
    },
  };
}
