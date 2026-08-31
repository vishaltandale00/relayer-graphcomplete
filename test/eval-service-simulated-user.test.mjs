import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  H3_AUTONOMOUS_FIX_CASE_ID,
  H3_AUTONOMOUS_INVESTIGATION_CASE_ID,
  HTTPX_PROXY_AUTH_REPORT_CASE_ID,
  OFETCH_RETRY_METHODS_CASE_ID,
  SQL_FORMATTER_ANSI_ALIAS_CASE_ID,
  TRUE_MYTH_INSPECT_BOTH_CASE_ID,
  calibrationAutonomousCaseIds,
} from "@relayer/eval-runner";

import {
  EvalService,
  evalModelSelectionRequest,
  judgeArtifactEvidenceForExecution,
  judgeArtifactForExecution,
  presentationGradeFromTurns,
  resolveH3PermissionProfile,
} from "../desktop/eval-main/eval-service.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const directories = [];
const originalFetch = globalThis.fetch;

it("carries the selected Eval model into every product interaction request", () => {
  const selected = {
    familyId: 7,
    providerId: "codex",
    modelId: "gpt-5.6-sol",
    harnessId: "codex-layered-personal-presentation-v1",
  };
  expect(evalModelSelectionRequest(selected)).toEqual({
    modelSelection: {
      familyId: 7,
      providerId: "codex",
      modelId: "gpt-5.6-sol",
    },
  });
  expect(evalModelSelectionRequest(null)).toEqual({});
  expect(evalModelSelectionRequest(selected, false)).toEqual({});
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("EvalService simulated-user result persistence", () => {
  it("normalizes each selected recursive review by its own schema in a mixed-history projection", () => {
    const legacy = {
      status: "completed",
      review: {
        schemaVersion: 4,
        contractId: "recursive-presentation-judge-v4",
        turn: {
          ratings: { presentation_quality: 3, answer_quality: 4 },
          scoreCeiling: { maximum: 4 },
        },
      },
    };
    const reasoned = {
      status: "completed",
      review: {
        schemaVersion: 5,
        contractId: "recursive-presentation-judge-v5",
        turn: {
          criterionJudgments: {
            presentation_quality: { score: 4 },
            answer_quality: { score: 6 },
          },
          scoreCeiling: { maximum: 8 },
        },
      },
    };

    expect(presentationGradeFromTurns([
      { status: "accepted", judgeResults: [legacy] },
      { status: "accepted", judgeResults: [reasoned] },
    ], true)).toMatchObject({
      status: "completed",
      score: 5,
      rawScore: 5,
      comprehensionScore: 7,
      scoreCeiling: 8,
      scoreScaleMaximum: 8,
    });
  });

  it("surfaces v10 and v11 recursive results as non-comparable instead of aggregating them", () => {
    const result = presentationGradeFromTurns([
      {
        status: "accepted",
        judgeResults: [{
          status: "completed",
          review: { schemaVersion: 5, contractId: "recursive-presentation-judge-v5", turn: { criterionJudgments: {} } },
        }],
      },
      {
        status: "accepted",
        judgeResults: [{
          status: "completed",
          review: { schemaVersion: 6, contractId: "recursive-presentation-judge-v6", turn: { criterionJudgments: {} } },
        }],
      },
    ], true);

    expect(result).toMatchObject({
      status: "partial",
      score: null,
      comparability: {
        status: "incompatible",
        contractIds: ["recursive-presentation-judge-v5", "recursive-presentation-judge-v6"],
      },
    });
  });

  it("omits product model selection for every turn of a configuration-owned harness", async () => {
    const { directory, stateFile } = await testPaths();
    const configurationPath = join(directory, "configuration-owned-fixture.yaml");
    await writeFile(configurationPath, [
      "schemaVersion: 1",
      "name: fixture-task-system",
      "implementation: fixture.task-system",
      "implementationVersion: 1",
      "permissionBindings:",
      "  ask: {}",
      "  auto: {}",
      "  full: {}",
      "executionAccessContracts: [managed-runtime@1]",
      "settings:",
      "  model: fixture-owned-model",
      "",
    ].join("\n"));
    const productBodies = [];
    const interactions = [
      { id: "interaction-1", sequence: 1, graphNodeId: 1, completionStatus: "accepted", completionOutput: acceptedOutput(), completionError: null, text: "first" },
      { id: "interaction-2", sequence: 2, graphNodeId: 2, completionStatus: "accepted", completionOutput: acceptedOutput(), completionError: null, text: "second" },
    ];
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      const path = new URL(url).pathname;
      if (path === "/api/model-settings") {
        return jsonResponse({
          defaults: { harnessId: "fixture-task-system", familyId: 7 },
          harnesses: [{ id: "fixture-task-system", available: true, settings: { model: "fixture-owned-model" } }],
          providers: [{ id: "openai", adapterId: "openai-api", connected: true, models: [{ id: "test-model", visible: true, available: true }] }],
          families: [{ id: 7, enabled: true, position: 0, members: [{ position: 0, providerId: "openai", modelId: "test-model" }] }],
        });
      }
      if (path === "/api/threads" && options.method === "POST") {
        productBodies.push(JSON.parse(options.body));
        return jsonResponse({ id: "thread-1", rootInteractionId: "interaction-1" });
      }
      if (path === "/api/threads/thread-1/interactions" && options.method === "POST") {
        productBodies.push(JSON.parse(options.body));
        return jsonResponse({ id: "interaction-2" });
      }
      if (path === "/api/threads/thread-1") {
        return jsonResponse({ id: "thread-1", interactions });
      }
      return jsonResponse({ error: `Unexpected fake product request: ${options.method || "GET"} ${path}` }, 404);
    });
    const service = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [configurationPath],
    }).open();

    await waitForCompletedRun(service, (await service.createRun({
      testCaseIds: ["empty-project.task-system.two-turn"],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "deterministic-graph-contract",
    })).id);

    expect(productBodies).toHaveLength(2);
    expect(productBodies[0]).not.toHaveProperty("modelSelection");
    expect(productBodies[1]).not.toHaveProperty("modelSelection");
  });

  it("bounds the host-authored artifact evidence packet", () => {
    const evidence = judgeArtifactEvidenceForExecution({
      checks: Array.from({ length: 70 }, (_, index) => ({
        passed: true,
        name: `check-${index}`,
        detail: "x".repeat(3_000),
      })),
      outcomeGrade: {
        mandatoryGates: [{ passed: false, name: "Critical gate", detail: "Current mandatory failure" }],
        criteria: [{ criterionId: "quality", rationale: "Semantic review is pending" }],
      },
    });

    expect(evidence.facts).toHaveLength(64);
    expect(evidence.facts.every((fact) => fact.length <= 2_000)).toBe(true);
    expect(evidence.summary).toContain("64 of 72");
    expect(evidence.facts.slice(0, 2)).toEqual([
      "FAIL mandatory gate Critical gate: Current mandatory failure",
      "Outcome criterion quality: Semantic review is pending",
    ]);
  });

  it("grounds a project judge in the candidate workspace and seeded task base", () => {
    expect(judgeArtifactForExecution({ fixture: {
      workspaceDirectory: "/immutable/execution/workspace",
      upstreamCommit: "upstream",
      seededCommit: "seeded-task-base",
    } })).toEqual({
      kind: "git_workspace",
      workingDirectory: "/immutable/execution/workspace",
      baseRevision: "seeded-task-base",
    });
    expect(judgeArtifactForExecution({})).toBeUndefined();
  });

  it("pins a connected default model when a Claude matrix cell creates its thread", async () => {
    const { stateFile } = await testPaths();
    const requests = [];
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      const parsed = new URL(url);
      requests.push({ parsed, options });
      if (parsed.pathname === "/api/model-selection/default") {
        expect(parsed.searchParams.get("harnessId")).toBe("claude-basic");
        return jsonResponse({ familyId: 7, providerId: "claude-work", modelId: "sonnet" });
      }
      if (parsed.pathname === "/api/threads" && options.method === "POST") return jsonResponse({ error: "stop after model assertion" }, 500);
      return jsonResponse({ error: "unexpected" }, 404);
    });
    const service = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [join(repositoryRoot, "harnesses", "claude-basic.yaml")],
    }).open();

    const created = await service.createRun({
      testCaseIds: ["empty-project.task-system.single-turn"],
      harnessConfigurationNames: ["claude-basic"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    await waitForCompletedRun(service, created.id);
    const threadRequest = requests.find(({ parsed, options }) => parsed.pathname === "/api/threads" && options.method === "POST");
    expect(JSON.parse(threadRequest.options.body).modelSelection).toEqual({ familyId: 7, providerId: "claude-work", modelId: "sonnet" });
  });

  it("runs after deterministic checks and reloads the immutable completed artifact", async () => {
    const { stateFile, configurationPath } = await testPaths();
    globalThis.fetch = fakeAcceptedProduct();
    const calls = [];
    const runner = async (context) => {
      calls.push(context);
      return {
        status: "completed",
        passed: true,
        rubricRef: "rubric.json",
        configurationRef: "judge-configuration.json",
        interactionTraceRef: "trace.json",
        screenshotRefs: ["screenshots/shot-root.json"],
        reviewRef: "reviews.json",
        coverageRef: "coverage.json",
        review: { turn: { ratings: { answer_quality: 4 } } },
        coverage: { complete: true, missingSubjects: [] },
        summary: "Complete screenshot-grounded review.",
      };
    };
    const service = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [configurationPath],
      simulatedUserJudgeRunner: runner,
    }).open();

    expect(service.catalog().judges.map(({ id }) => id)).toEqual([
      "deterministic-graph-contract",
      "simulated-user",
      "simulated-user-sol-high",
    ]);
    expect(service.catalog().cases.filter(({ caseSnapshot }) => caseSnapshot).map(({ id }) => id)).toEqual([
      H3_AUTONOMOUS_FIX_CASE_ID,
      H3_AUTONOMOUS_INVESTIGATION_CASE_ID,
      OFETCH_RETRY_METHODS_CASE_ID,
      TRUE_MYTH_INSPECT_BOTH_CASE_ID,
      SQL_FORMATTER_ANSI_ALIAS_CASE_ID,
      HTTPX_PROXY_AUTH_REPORT_CASE_ID,
      ...calibrationAutonomousCaseIds,
    ]);
    const created = await service.createRun(simulatedUserSelection());
    const completed = await waitForCompletedRun(service, created.id);

    expect(completed.status).toBe("passed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      schemaVersion: 1,
      execution: {
        id: completed.executions[0].id,
        testRunId: completed.id,
        testCaseId: "empty-project.task-system.single-turn",
        harnessConfigurationName: "fixture-task-system",
      },
      thread: { id: "thread-1" },
      turn: {
        id: "interaction-1",
        turnIndex: 0,
        graphNodeId: 1,
        status: "accepted",
      },
      request: { followUp: false },
      rubric: { rubricVersion: "graph-presentation-rubric-v11" },
      judgeConfiguration: { name: "simulated-user" },
    });
    expect(calls[0].request.text).toContain("incoming queue");
    expect(calls[0].artifactDirectory).toContain(join("runs", completed.id, "executions"));

    const turn = completed.executions[0].turns[0];
    expect(turn.deterministicPassed).toBe(true);
    expect(turn.judgeResults).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        judge: "simulated-user",
        status: "completed",
        passed: null,
        rubricVersion: "graph-presentation-rubric-v11",
        judgeConfiguration: { name: "simulated-user" },
        artifactAuthority: "references",
        references: {
          rubric: "rubric.json",
          configuration: "judge-configuration.json",
          interactionTrace: "trace.json",
          screenshots: ["screenshots/shot-root.json"],
          reviews: "reviews.json",
          coverage: "coverage.json",
        },
        summary: "Complete screenshot-grounded review.",
        review: { turn: { ratings: { answer_quality: 4 } } },
        coverage: { complete: true, missingSubjects: [] },
        error: null,
      }),
    ]);
    expect(turn.judgeResults[0].artifactDirectory).toBe(calls[0].artifactDirectory);

    const persisted = await waitForPersistedRun(stateFile, completed.id);
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.runs[0].executions[0].turns[0].judgeResults[0].references.coverage).toBe("coverage.json");
    expect(persisted.runs[0].bundleRef).toMatch(/^runs\/.*\/bundle\.json$/);
    const bundleFile = join(dirname(stateFile), persisted.runs[0].bundleRef);
    const bundleBeforeReload = await readFile(bundleFile, "utf8");
    expect(JSON.parse(bundleBeforeReload)).toMatchObject({
      bundleSchemaVersion: 1,
      kind: "relayer_eval_run_bundle",
      testRunId: completed.id,
      run: {
        bundleRef: persisted.runs[0].bundleRef,
        executions: [{ turns: [{ judgeResults: [expect.objectContaining({
          status: "completed",
          artifactAuthority: "references",
        })] }] }],
      },
    });

    const reloaded = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [configurationPath],
    }).open();
    const restored = reloaded.getRun(completed.id);
    expect(restored.executions[0].turns[0].judgeResults[0]).toEqual(turn.judgeResults[0]);
    expect(reloaded.catalog().judges.map(({ id }) => id)).toEqual(["deterministic-graph-contract"]);
    expect(await readFile(bundleFile, "utf8")).toBe(bundleBeforeReload);

  });

  it("fails the opt-in input round-trip execution when its structural gate was not exercised", async () => {
    const { stateFile, configurationPath } = await testPaths();
    globalThis.fetch = fakeAcceptedProduct();
    const service = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [configurationPath],
      simulatedUserJudgeRunner: async () => ({
        status: "completed",
        rubricRef: "rubric.json",
        configurationRef: "judge-configuration.json",
        interactionTraceRef: "trace.json",
        screenshotRefs: ["screenshots/shot-root.json"],
        reviewRef: "reviews.json",
        coverageRef: "coverage.json",
        inputRoundTripRef: "input-roundtrip.json",
        review: { turn: { ratings: { answer_quality: 4 } } },
        coverage: { complete: true, missingSubjects: [] },
        summary: "The visible turn was reviewed.",
        inputRoundTrip: {
          schemaVersion: 1,
          status: "not_exercised",
          passed: false,
          checks: [],
          detail: "The judge did not commit and Send.",
        },
      }),
    }).open();

    const created = await service.createRun({
      testCaseIds: ["empty-project.node-input-roundtrip.single-turn"],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "simulated-user",
    });
    const completed = await waitForCompletedRun(service, created.id);

    expect(completed.status).toBe("failed");
    expect(completed.executions[0]).toMatchObject({ status: "failed", passed: false });
    expect(completed.executions[0].checks).toContainEqual(expect.objectContaining({
      name: "turn-1:input-roundtrip:exercised",
      passed: false,
    }));
    expect(completed.executions[0].turns[0].judgeResults[0].inputRoundTrip)
      .toMatchObject({ status: "not_exercised", passed: false });
    expect(completed.executions[0].turns[0].deterministicPassed).toBe(false);
    expect(completed.executions[0].outcomeGrade).toMatchObject({ qualified: false });
  });

  it("rejects an input round-trip run with the deterministic judge before execution", async () => {
    const { stateFile, configurationPath } = await testPaths();
    const service = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [configurationPath],
      simulatedUserJudgeRunner: vi.fn(),
    }).open();

    const inputCase = service.catalog().cases.find(
      ({ id }) => id === "empty-project.node-input-roundtrip.single-turn",
    );
    expect(inputCase.requiredJudgeConfigurationIds).toEqual([
      "simulated-user",
      "simulated-user-sol-high",
    ]);
    await expect(service.createRun({
      testCaseIds: [inputCase.id],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "deterministic-graph-contract",
    })).rejects.toThrow(
      "Input round-trip cases require a compatible simulated-user judge configuration.",
    );
  });

  it("persists explicit partial and thrown-failure artifacts without losing deterministic evidence", async () => {
    const partialPaths = await testPaths();
    globalThis.fetch = fakeAcceptedProduct();
    const partialService = await new EvalService({
      stateFile: partialPaths.stateFile,
      productSession: productSession(),
      configurationPaths: [partialPaths.configurationPath],
      simulatedUserJudgeRunner: async () => ({
        status: "partial",
        rubricRef: "rubric.json",
        configurationRef: "judge.json",
        interactionTraceRef: "trace.partial.json",
        screenshotRefs: [],
        error: "Node-detail capture failed.",
      }),
    }).open();
    const partial = await waitForCompletedRun(
      partialService,
      (await partialService.createRun(simulatedUserSelection())).id,
    );
    expect(partial.status).toBe("failed");
    expect(partial.executions[0]).toMatchObject({
      passed: false,
      presentationGrade: { status: "partial", score: null },
      checks: expect.arrayContaining([expect.objectContaining({ passed: true })]),
      turns: [expect.objectContaining({
        deterministicPassed: true,
        judgeResults: [expect.objectContaining({
          status: "partial",
          passed: null,
          error: "Node-detail capture failed.",
          references: {
            rubric: "rubric.json",
            configuration: "judge.json",
            interactionTrace: "trace.partial.json",
            screenshots: [],
            reviews: null,
            coverage: null,
          },
        })],
      })],
    });

    const failurePaths = await testPaths();
    globalThis.fetch = fakeAcceptedProduct();
    const failedService = await new EvalService({
      stateFile: failurePaths.stateFile,
      productSession: productSession(),
      configurationPaths: [failurePaths.configurationPath],
      simulatedUserJudgeRunner: async () => { throw new Error("Judge process exited."); },
    }).open();
    const failed = await waitForCompletedRun(
      failedService,
      (await failedService.createRun(simulatedUserSelection())).id,
    );
    expect(failed.executions[0].turns[0].judgeResults[0]).toMatchObject({
      status: "failed",
      passed: null,
      error: "Judge process exited.",
    });
  });

  it("keeps the pinned presentation version when candidate trace export throws", async () => {
    const { stateFile, configurationPath } = await testPaths();
    globalThis.fetch = fakeAcceptedProduct();
    const service = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [configurationPath],
      candidateTraceRequired: true,
      candidateTraceAttributionLoader: async () => 90,
      candidateTraceExporter: async () => {
        throw new Error("Trace export failed before reaching the trace store.");
      },
    }).open();

    const completed = await waitForCompletedRun(
      service,
      (await service.createRun({
        ...simulatedUserSelection(),
        judgeConfigurationName: "deterministic-graph-contract",
      })).id,
    );

    expect(completed.executions[0].turns[0]).toMatchObject({
      personalPresentationVersionId: 90,
      candidateTrace: {
        status: "failed",
        personalPresentationVersionId: 90,
        error: "Trace export failed before reaching the trace store.",
      },
    });
  });

  it("keeps presentation judging independent when an outcome gate fails", async () => {
    const { stateFile, configurationPath } = await testPaths();
    globalThis.fetch = fakeAcceptedProduct();
    const runner = vi.fn(async () => ({
      status: "completed",
      passed: true,
      rubricRef: "rubric.json",
      configurationRef: "judge.json",
      interactionTraceRef: "trace.json",
      screenshotRefs: ["screenshots/root.json"],
      reviewRef: "review.json",
      coverageRef: "coverage.json",
      review: { layers: [], inventory: { layers: [] } },
      coverage: { complete: true, missingSubjects: [] },
    }));
    const service = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [configurationPath],
      simulatedUserJudgeRunner: runner,
    }).open();

    const created = await service.createRun({
      testCaseIds: ["empty-project.hierarchical-overview.single-turn"],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "simulated-user",
    });
    const completed = await waitForCompletedRun(service, created.id);
    const execution = completed.executions[0];

    expect(execution.outcomeGrade).toMatchObject({ status: "completed", qualified: false });
    expect(execution.presentationGrade).toMatchObject({ status: "completed" });
    expect(runner).toHaveBeenCalledOnce();
    expect(execution.turns[0].deterministicPassed).toBe(false);
    expect(execution.turns[0].judgeResults[0].status).toBe("completed");
  });

  it("converts a persisted in-flight judge artifact to an explicit partial result on restart", async () => {
    const { directory, stateFile, configurationPath } = await testPaths();
    await mkdir(join(directory, "eval-data"), { recursive: true });
    await writeFile(stateFile, `${JSON.stringify({
      schemaVersion: 1,
      runs: [{
        schemaVersion: 1,
        id: "run-interrupted",
        createdAt: "2026-08-19T12:00:00.000Z",
        completedAt: null,
        status: "running",
        testCaseIds: ["empty-project.task-system.single-turn"],
        harnessConfigurationNames: ["fixture-task-system"],
        judgeConfigurationName: "simulated-user",
        executions: [{
          id: "execution-interrupted",
          testCaseId: "empty-project.task-system.single-turn",
          harnessConfigurationName: "fixture-task-system",
          status: "running",
          threadIds: ["thread-1"],
          checks: [],
          turns: [{
            interactionId: "interaction-1",
            judgeResults: [{
              schemaVersion: 1,
              id: "judge-result-1",
              judge: "simulated-user",
              status: "running",
              error: null,
            }],
          }],
        }],
      }],
    }, null, 2)}\n`);

    const service = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [configurationPath],
    }).open();
    const restored = service.getRun("run-interrupted");
    expect(restored.status).toBe("interrupted");
    expect(restored.executions[0].status).toBe("interrupted");
    expect(restored.executions[0].lifecycle).toMatchObject({ status: "failed" });
    expect(restored.executions[0].turns[0].judgeResults[0]).toMatchObject({
      status: "partial",
      error: "Simulated-user review was interrupted before finalization.",
    });
    expect(restored.bundleRef).toMatch(/^runs\/.*\/bundle\.json$/);
    expect(JSON.parse(await readFile(join(dirname(stateFile), restored.bundleRef), "utf8"))).toMatchObject({
      run: { status: "interrupted" },
    });
  });

  it("preserves Prime's requested bounded profile while retaining the explicit sole-Full exception", async () => {
    const { stateFile } = await testPaths();
    const product = fakeAcceptedProduct();
    globalThis.fetch = product;
    const service = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [join(repositoryRoot, "harnesses", "prime-agent-basic.yaml")],
      platform: "darwin",
    }).open();

    const soleFullConfiguration = { name: "legacy-full-only", permissionBindings: { full: {} } };
    expect(resolveH3PermissionProfile(soleFullConfiguration, "ask")).toEqual({
      requestedProfileId: "ask",
      effectiveProfileId: "full",
      overridden: true,
      reason: "Harness supports only Full access; the local Eval fixture is disposable and the unrestricted authority is recorded.",
    });

    const created = await service.createRun({
      testCaseIds: ["empty-project.task-system.single-turn"],
      harnessConfigurationNames: ["prime-agent-basic"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    await waitForCompletedRun(service, created.id);
    const createRequest = product.mock.calls.find(([url, options]) => (
      new URL(url).pathname === "/api/threads" && options?.method === "POST"
    ));
    expect(JSON.parse(createRequest[1].body).permissionProfileId).toBe("auto");
  });

  it("does not override an unavailable H3 profile for an ambiguous harness", () => {
    expect(() => resolveH3PermissionProfile({
      name: "ambiguous",
      permissionBindings: { ask: {}, full: {} },
    }, "auto")).toThrow("evaluator-owned verifier cases require confined authority");
  });
});

async function testPaths() {
  const directory = await mkdtemp(join(tmpdir(), "relayer-eval-simulated-user-"));
  directories.push(directory);
  return {
    directory,
    stateFile: join(directory, "eval-data", "test-runs.json"),
    configurationPath: join(repositoryRoot, "harnesses", "fixture-task-system.yaml"),
  };
}

function productSession() {
  return {
    origin: "http://127.0.0.1:43123",
    cookie: { name: "relayer", value: "test" },
  };
}

function simulatedUserSelection() {
  return {
    testCaseIds: ["empty-project.task-system.single-turn"],
    harnessConfigurationNames: ["fixture-task-system"],
    judgeConfigurationName: "simulated-user",
  };
}

function fakeAcceptedProduct() {
  const interaction = {
    id: "interaction-1",
    sequence: 1,
    graphNodeId: 1,
    completionStatus: "accepted",
    completionOutput: acceptedOutput(),
    completionError: null,
    text: "A task system has an incoming queue.",
  };
  return vi.fn(async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/model-settings" && (options.method === undefined || options.method === "GET")) {
      return jsonResponse({
        defaults: { harnessId: "fixture-task-system", familyId: 1 },
        harnesses: [
          {
            id: "fixture-task-system",
            available: true,
            modelCompatibility: [{ providerId: "codex" }],
          },
          {
            id: "prime-agent-basic",
            available: true,
            modelRules: { allow: [{ adapterId: "openai-api", modelIdRegex: ".*" }], deny: [] },
          },
        ],
        providers: [{
          id: "openai",
          adapterId: "openai-api",
          connected: true,
          models: [{ id: "test-model", visible: true, available: true }],
        }],
        families: [{
          id: 1,
          enabled: true,
          position: 0,
          members: [{ position: 0, providerId: "openai", modelId: "test-model" }],
        }],
      });
    }
    if (path === "/api/threads" && options.method === "POST") {
      return jsonResponse({ id: "thread-1", rootInteractionId: interaction.id });
    }
    if (path === "/api/threads/thread-1" && (options.method === undefined || options.method === "GET")) {
      return jsonResponse({ id: "thread-1", interactions: [interaction] });
    }
    return jsonResponse({ error: `Unexpected fake product request: ${options.method || "GET"} ${path}` }, 404);
  });
}

function acceptedOutput() {
  const node = { id: 2, kind: "concept", icon: "queue", title: "Queue", detail: "Tasks wait here.", state: "accepted" };
  const layer = {
    id: 10,
    nodes: [node.id],
    edges: [],
    layout: { version: 1, placements: [{ nodeId: node.id, x: 0.5, y: 0.5 }] },
    state: "accepted",
  };
  return {
    nodeId: 1,
    rootAction: {
      id: 11,
      sourceNodeId: 1,
      sourceLayerId: null,
      kind: "navigate",
      relation: "expand",
      label: "Response",
      targetLayerId: layer.id,
      state: "accepted",
    },
    rootLayer: { layer, nodes: [node], edges: [], actions: [] },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function waitForCompletedRun(evalService, runId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = evalService.getRun(runId);
    if (!["queued", "running"].includes(run.status) && typeof run.bundleRef === "string") return run;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Eval run did not finish in time.");
}

async function waitForPersistedRun(stateFile, runId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    const run = persisted.runs.find((candidate) => candidate.id === runId);
    if (typeof run?.bundleRef === "string") return persisted;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Completed Eval run was not persisted in time.");
}
