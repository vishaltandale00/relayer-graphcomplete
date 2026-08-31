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
  graphMemoryEvalCaseId,
  graphMemoryEvalPrompts,
  graphMemoryFixtureFactory,
  graphMemorySearchBudget,
  graphMemorySearchParameters,
  graphMemorySearchQuery,
  taskSystemFixtureFactory,
} from "@relayer/eval-runner";
import { afterEach, describe, expect, it } from "vitest";

import {
  EvalService,
  evalCases,
  resolveEvalCasePrompts,
  recursiveCompleteChecks,
  validateCandidateTrace,
} from "../desktop/eval-main/eval-service.mjs";
import {
  GraphCompleteRuntimeService,
  RECURSIVE_TEMPORAL_FEATURES,
} from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { recursiveCompleteFixtureFactory } from "./support/recursive-complete-fixture.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const services = [];
const directories = [];

function recursiveComparisonConfiguration(name, agentAuthored, personalPresentationVersion) {
  return [
    "schemaVersion: 1",
    `name: ${name}`,
    "implementation: fixture.task-system",
    "implementationVersion: 1",
    "complete:",
    `  agentAuthored: ${agentAuthored}`,
    "permissionBindings:",
    "  ask: {}",
    "  auto: {}",
    "  full: {}",
    "modelCompatibility:",
    "  - providerId: codex",
    "executionAccessContracts: [managed-runtime@1]",
    "settings:",
    `  personalPresentationVersion: ${personalPresentationVersion}`,
    "",
  ].join("\n");
}

afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Relayer Eval application service", () => {
  it("rejects discontinuous child projections and duplicate trace scope markers", async () => {
    const checks = recursiveCompleteChecks({
      harnessConfiguration: { implementation: "fixture.task-system", complete: { agentAuthored: true } },
      harnessConfigurationDigest: "sha256:config",
      turns: [{ candidateTrace: { completionBrokerAvailable: true } }],
      semanticChildren: [{
        sourceInteractionId: 1,
        sourceActionId: 2,
        interactionId: 3,
        graphNodeId: 4,
        rootLayerId: 77,
        status: "accepted",
        resultCompletionStatus: "accepted",
        projectionObservations: [
          { sequence: 1, revision: 0, previousRevision: null, lifecycle: "active", currentLayerId: null },
          { sequence: 2, revision: 2, previousRevision: 0, lifecycle: "active", currentLayerId: 77 },
          { sequence: 3, revision: 3, previousRevision: 2, lifecycle: "succeeded", currentLayerId: 77 },
        ],
        execution: {},
        candidateTrace: { status: "complete", completionBrokerAvailable: true },
      }],
    });
    expect(checks.find(({ name }) => name.endsWith(":child-terminal"))?.passed).toBe(false);

    const directory = await mkdtemp(join(tmpdir(), "relayer-eval-trace-scope-test-"));
    directories.push(directory);
    const eventsBytes = Buffer.from([
      JSON.stringify({ type: "execution.scope", data: { completionBrokerAvailable: true } }),
      JSON.stringify({ type: "execution.scope", data: { completionBrokerAvailable: true } }),
      "",
    ].join("\n"));
    await writeFile(join(directory, "events.jsonl"), eventsBytes);
    const digest = `sha256:${createHash("sha256").update(eventsBytes).digest("hex")}`;
    const descriptor = {
      status: "complete",
      truncated: false,
      sha256: digest,
      byteLength: eventsBytes.byteLength,
      eventCount: 2,
      format: "relayer-harness-trace-v1",
      traceId: "trace-1",
    };
    await writeFile(join(directory, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      format: descriptor.format,
      status: descriptor.status,
      traceId: descriptor.traceId,
      productInteractionId: 3,
      interactionNodeId: 4,
      correlation: { runId: "run-1" },
      declaredCoverage: {},
      achievedCoverage: {},
      artifacts: { events: { ref: "events.jsonl", sha256: digest, byteLength: eventsBytes.byteLength, eventCount: 2 } },
    }));
    await expect(validateCandidateTrace(
      directory,
      descriptor,
      { id: 3, graphNodeId: 4 },
      { runId: "run-1" },
      { requireComplete: true },
    )).rejects.toThrow("exactly one valid broker-scope marker");
  });

  it("requires explicit root and recursive-child authorization before queuing the live Codex pair", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-live-authorization-test-"));
    directories.push(dataDirectory);
    const evalService = await new EvalService({
      stateFile: join(dataDirectory, "test-runs.json"),
      productSession: {
        origin: "http://127.0.0.1:1",
        cookie: { name: "unused", value: "unused" },
      },
      configurationPaths: [
        join(repositoryRoot, "harnesses", "codex-eval-complete-disabled.yaml"),
        join(repositoryRoot, "harnesses", "codex-eval-complete-enabled.yaml"),
      ],
    }).open();

    await expect(evalService.createRun({
      testCaseIds: ["empty-project.recursive-complete.comparison"],
      harnessConfigurationNames: [
        "codex-eval-complete-disabled",
        "codex-eval-complete-enabled",
      ],
      judgeConfigurationName: "deterministic-graph-contract",
    })).rejects.toThrow("requires explicit confirmation");
    expect(evalService.listRuns()).toEqual([]);
  });

  it("rejects a recursive comparison whose exact off cell grants Complete authority", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-recursive-authority-drift-test-"));
    directories.push(dataDirectory);
    const disabledPath = join(dataDirectory, "codex-eval-complete-disabled.yaml");
    const enabledPath = join(dataDirectory, "codex-eval-complete-enabled.yaml");
    await writeFile(disabledPath, recursiveComparisonConfiguration(
      "codex-eval-complete-disabled",
      true,
      "personal-presentation-v1",
    ));
    await writeFile(enabledPath, recursiveComparisonConfiguration(
      "codex-eval-complete-enabled",
      true,
      "personal-presentation-v2",
    ));
    const evalService = await new EvalService({
      stateFile: join(dataDirectory, "test-runs.json"),
      productSession: {
        origin: "http://127.0.0.1:1",
        cookie: { name: "unused", value: "unused" },
      },
      configurationPaths: [disabledPath, enabledPath],
    }).open();

    await expect(evalService.createRun({
      testCaseIds: ["empty-project.recursive-complete.comparison"],
      harnessConfigurationNames: [
        "codex-eval-complete-disabled",
        "codex-eval-complete-enabled",
      ],
      judgeConfigurationName: "deterministic-graph-contract",
    })).rejects.toThrow("approved V1/off and V2/on experience pair");
  });

  it("runs an authority-isolated agent-authored Complete pair and preserves child evidence outside human turns", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-recursive-test-"));
    directories.push(dataDirectory);
    const disabledPath = join(dataDirectory, "codex-eval-complete-disabled.yaml");
    const enabledPath = join(dataDirectory, "codex-eval-complete-enabled.yaml");
    await writeFile(disabledPath, recursiveComparisonConfiguration(
      "codex-eval-complete-disabled",
      false,
      "personal-presentation-v1",
    ));
    await writeFile(enabledPath, recursiveComparisonConfiguration(
      "codex-eval-complete-enabled",
      true,
      "personal-presentation-v2",
    ));
    const observed = { fireAndForget: true, childDelayMs: 100 };
    const recursiveFactory = recursiveCompleteFixtureFactory(observed);
    const runtime = new GraphCompleteRuntimeService({
      userDataDirectory: dataDirectory,
      graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
      configurationPaths: [disabledPath, enabledPath],
      temporalFeatures: RECURSIVE_TEMPORAL_FEATURES,
      additionalImplementations: {
        "fixture.task-system": (context) => (
          context.configuration.complete?.agentAuthored
            ? recursiveFactory(context)
            : taskSystemFixtureFactory(context)
        ),
      },
      acquireProviderExecution: async (providerId) => ({
        definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
        descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
        runtime: { async executionAccess() { return { kind: "managed-runtime", environment: {} }; } },
        async release() {},
      }),
      candidateTrace: {
        directory: join(dataDirectory, "eval-data", "candidate-trace-spool"),
        policy: {
          mode: "required",
          requiredFeatures: {},
          includeNativeArtifacts: false,
          maxBytesPerTurn: 1_000_000,
          maxEventsPerTurn: 1_000,
        },
      },
    });
    services.push(runtime);
    const product = new RelayerAppServerService({
      userDataDirectory: dataDirectory,
      binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
      webDirectory: join(repositoryRoot, "desktop", "renderer"),
      permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
      runtimeSession: await runtime.start(),
      defaultHarnessConfiguration: "codex-eval-complete-disabled",
      allowHarnessOverride: true,
    });
    services.push(product);
    const productSession = await product.start();
    await product.publishProviderCatalog({
      providerId: "codex",
      label: "Fixture provider",
      connected: true,
      models: [{
        id: "fixture-model",
        label: "Fixture model",
        order: 0,
        visible: true,
        available: true,
        providerDefault: true,
        metadata: {},
      }],
      systemFamily: { key: "codex", name: "Codex", modelIds: ["fixture-model"] },
    });
    await productRequest(productSession, "/api/model-families", {
      method: "POST",
      body: JSON.stringify({
        name: "Fixture models",
        enabled: true,
        members: [{ providerId: "codex", modelId: "fixture-model" }],
      }),
    });
    const evalService = await new EvalService({
      stateFile: join(dataDirectory, "eval-data", "test-runs.json"),
      productSession,
      configurationPaths: [disabledPath, enabledPath],
      candidateTraceExporter: (interactionId, targetDirectory, correlation) => (
        runtime.exportCandidateTrace(interactionId, targetDirectory, correlation)
      ),
      candidateTraceRequired: true,
    }).open();

    await expect(evalService.createRun({
      testCaseIds: ["empty-project.recursive-complete.comparison"],
      harnessConfigurationNames: [
        "codex-eval-complete-enabled",
        "codex-eval-complete-disabled",
      ],
      judgeConfigurationName: "deterministic-graph-contract",
    })).rejects.toThrow("exact ordered Codex pair");

    const created = await evalService.createRun({
      testCaseIds: ["empty-project.recursive-complete.comparison"],
      harnessConfigurationNames: [
        "codex-eval-complete-disabled",
        "codex-eval-complete-enabled",
      ],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    const completed = await waitForCompletedRun(evalService, created.id);
    expect(completed.status, JSON.stringify({
      observed,
      executions: completed.executions.map((execution) => ({
        harnessConfigurationName: execution.harnessConfigurationName,
        status: execution.status,
        error: execution.error,
        checks: execution.checks,
        turns: execution.turns.map(({ interactionId, graphNodeId, candidateTrace }) => ({
          interactionId,
          graphNodeId,
          candidateTrace,
        })),
        semanticChildren: execution.semanticChildren,
      })),
    }, null, 2)).toBe("passed");
    const control = completed.executions.find((execution) => execution.harnessConfigurationName.endsWith("disabled"));
    const treatment = completed.executions.find((execution) => execution.harnessConfigurationName.endsWith("enabled"));
    expect(completed.comparison).toMatchObject({
      kind: "agent-authored-complete-pair",
      passed: true,
      check: { name: "agent-authored-complete:controlled-pair", passed: true },
    });
    expect(treatment.modelResolution).toEqual(control.modelResolution);
    expect(control.turns).toHaveLength(1);
    expect(control.turns[0].candidateTrace).toMatchObject({
      status: "complete",
      completionBrokerAvailable: false,
    });
    expect(control.semanticChildren).toEqual([]);
    expect(treatment.turns).toHaveLength(1);
    expect(treatment.turns[0].candidateTrace).toMatchObject({
      status: "complete",
      completionBrokerAvailable: true,
    });
    expect(treatment.semanticChildren).toHaveLength(1);
    expect(observed.fireAndForgetStarted).toBe(true);
    expect(treatment.semanticChildren[0]).toMatchObject({
      status: "accepted",
      candidateTrace: { status: "complete", completionBrokerAvailable: true },
      execution: {
        phase: "settled",
        attached: true,
        attachmentSchemaVersion: 1,
        attachmentProvider: "fixture",
        settled: true,
        safeReason: null,
      },
    });
    expect(treatment.semanticChildren[0].projectionObservations.map(({ lifecycle }) => lifecycle))
      .toEqual(expect.arrayContaining(["active", "succeeded"]));
    const childTrace = await evalService.candidateTraceContext(
      treatment.id,
      treatment.semanticChildren[0].interactionId,
    );
    expect(childTrace.manifest).toMatchObject({
      format: "relayer-harness-trace-v1",
      correlation: { executionId: treatment.id },
    });
    expect(childTrace.events.map(({ type }) => type)).toContain("execution.scope");
  }, 20_000);

  it("catalogs graph memory as a harness-neutral natural two-turn case", () => {
    const definition = evalCases.find((candidate) => candidate.id === graphMemoryEvalCaseId);
    const firstRun = resolveEvalCasePrompts(definition, "run-alpha");
    const secondRun = resolveEvalCasePrompts(definition, "run-beta");

    expect(definition).toMatchObject({
      name: "Graph memory · prior accepted reference",
      description: expect.stringContaining("prior accepted layer"),
      defaultSelected: false,
    });
    expect(firstRun).toEqual(graphMemoryEvalPrompts("run-alpha"));
    expect(firstRun).toHaveLength(2);
    expect(firstRun.join("\n")).not.toContain("GRAPH_MEMORY_ANCHOR:");
    expect(firstRun[1]).toBe("Find your earlier Freshness acknowledged explanation and link the original as supporting context in a concise follow-up. Do not recreate or paraphrase it.");
    expect(firstRun[1]).not.toMatch(/graph search|graph\.search|query|parameter|budget|layer|accepted|hard-code|\bID\b/i);
    expect(secondRun).toEqual(firstRun);
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
      targetKey: "macos-arm64",
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
    expect(execution.turns.every((turn) => !turn.prompt.includes("GRAPH_MEMORY_ANCHOR:"))).toBe(true);
    expect(execution.turns[1].deterministicChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: expect.stringContaining("search-returned-prior-root"), passed: true }),
      expect.objectContaining({ name: expect.stringContaining("draft-decoy-hidden"), passed: true }),
      expect.objectContaining({ name: expect.stringContaining("typed-reference-target"), passed: true }),
      expect.objectContaining({ name: expect.stringContaining("ack-search-submit-order"), passed: true }),
    ]));
    expect(execution.turns[1].caseEvidence).toMatchObject({
      searchedLayerIds: [execution.turns[0].rootLayerId],
      referenceActionId: expect.any(Number),
    });
    expect(execution.turns[1].caseEvidence).not.toHaveProperty("anchor");
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
        resultTruncated: false,
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

    const secondCreated = await evalService.createRun({
      testCaseIds: [graphMemoryEvalCaseId],
      harnessConfigurationNames: ["fixture-graph-memory"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    const secondCompleted = await waitForCompletedRun(evalService, secondCreated.id, 20_000);
    const secondExecution = secondCompleted.executions[0];
    expect(secondCompleted.status).toBe("passed");
    expect(secondExecution.threadIds).toHaveLength(1);
    expect(secondExecution.threadIds[0]).not.toBe(execution.threadIds[0]);
    expect(secondExecution.turns[0].rootLayerId).not.toBe(firstRoot);
    expect(secondExecution.turns[1].caseEvidence).toMatchObject({
      searchedLayerIds: [secondExecution.turns[0].rootLayerId],
      referenceActionId: expect.any(Number),
    });
    expect(secondExecution.turns[1].caseEvidence.searchedLayerIds).not.toContain(firstRoot);

    let launderedTurns = 0;
    const launderedEvalService = await new EvalService({
      stateFile: join(dataDirectory, "eval-data", "laundered-test-runs.json"),
      productSession,
      configurationPaths: [configurationPath],
      platform: "darwin",
      targetKey: "macos-arm64",
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
      targetKey: "macos-arm64",
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
  throw new Error("Eval run did not finish in time.");
}

async function productRequest(session, path, init = {}) {
  const response = await fetch(new URL(path, session.origin), {
    ...init,
    headers: {
      Cookie: `${session.cookie.name}=${session.cookie.value}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
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
