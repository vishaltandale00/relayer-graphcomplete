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

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("EvalService simulated-user judging", () => {
  it("projects presentation grades, evidence packets, model selection, and permission authority through pure seams", () => {
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
    ], true), "mixed histories normalize by each review's own schema").toMatchObject({
      status: "completed",
      score: 5,
      rawScore: 5,
      comprehensionScore: 7,
      scoreCeiling: 8,
      scoreScaleMaximum: 8,
    });

    const mixedContracts = presentationGradeFromTurns([
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
    expect(mixedContracts, "v10 and v11 recursive results are non-comparable, never aggregated").toMatchObject({
      status: "partial",
      score: null,
      comparability: {
        status: "incompatible",
        contractIds: ["recursive-presentation-judge-v5", "recursive-presentation-judge-v6"],
      },
    });

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
    expect(evidence.facts, "host-authored evidence is bounded").toHaveLength(64);
    expect(evidence.facts.every((fact) => fact.length <= 2_000), "every fact stays within the bound").toBe(true);
    expect(evidence.summary, "the bound is disclosed").toContain("64 of 72");
    expect(evidence.facts.slice(0, 2), "mandatory failures and criteria lead the packet").toEqual([
      "FAIL mandatory gate Critical gate: Current mandatory failure",
      "Outcome criterion quality: Semantic review is pending",
    ]);

    expect(judgeArtifactForExecution({ fixture: {
      workspaceDirectory: "/immutable/execution/workspace",
      upstreamCommit: "upstream",
      seededCommit: "seeded-task-base",
    } }), "project judges ground in the candidate workspace and seeded task base").toEqual({
      kind: "git_workspace",
      workingDirectory: "/immutable/execution/workspace",
      baseRevision: "seeded-task-base",
    });
    expect(judgeArtifactForExecution({}), "fixture-less executions carry no workspace artifact").toBeUndefined();

    const selected = {
      familyId: 7,
      providerId: "codex",
      modelId: "gpt-5.6-sol",
      harnessId: "codex-layered-personal-presentation-v1",
    };
    expect(evalModelSelectionRequest(selected), "selected model travels with the request").toEqual({
      modelSelection: {
        familyId: 7,
        providerId: "codex",
        modelId: "gpt-5.6-sol",
      },
    });
    expect(evalModelSelectionRequest(null), "no selection sends no model payload").toEqual({});
    expect(evalModelSelectionRequest(selected, false), "disabled selection sends no model payload").toEqual({});

    expect(resolveH3PermissionProfile({ name: "legacy-full-only", permissionBindings: { full: {} } }, "ask"),
      "sole-Full harnesses record the explicit unrestricted exception").toEqual({
      requestedProfileId: "ask",
      effectiveProfileId: "full",
      overridden: true,
      reason: "Harness supports only Full access; the local Eval fixture is disposable and the unrestricted authority is recorded.",
    });
    expect(() => resolveH3PermissionProfile({
      name: "ambiguous",
      permissionBindings: { ask: {}, full: {} },
    }, "auto"), "ambiguous harnesses never override an unavailable H3 profile")
      .toThrow("evaluator-owned verifier cases require confined authority");
  });

  it("runs the simulated-user judge after deterministic checks and persists every artifact state immutably", async () => {
    const { directory, stateFile, configurationPath } = await testPaths();
    let runnerBehavior = "completed";
    const calls = [];
    const runner = async (context) => {
      calls.push(context);
      if (runnerBehavior === "throw") throw new Error("Judge process exited.");
      if (runnerBehavior === "partial") {
        return {
          status: "partial",
          rubricRef: "rubric.json",
          configurationRef: "judge.json",
          interactionTraceRef: "trace.partial.json",
          screenshotRefs: [],
          error: "Node-detail capture failed.",
        };
      }
      if (runnerBehavior === "input-roundtrip-not-exercised") {
        return {
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
        };
      }
      if (runnerBehavior === "presentation-only") {
        return {
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
        };
      }
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
    globalThis.fetch = fakeAcceptedProduct();
    const service = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [configurationPath],
      simulatedUserJudgeRunner: runner,
    }).open();

    expect(service.catalog().judges.map(({ id }) => id), "catalog offers both judge configurations").toEqual([
      "deterministic-graph-contract",
      "simulated-user",
      "simulated-user-sol-high",
    ]);
    expect(service.catalog().cases.filter(({ caseSnapshot }) => caseSnapshot).map(({ id }) => id),
      "catalog carries every snapshot case").toEqual([
      H3_AUTONOMOUS_FIX_CASE_ID,
      H3_AUTONOMOUS_INVESTIGATION_CASE_ID,
      OFETCH_RETRY_METHODS_CASE_ID,
      TRUE_MYTH_INSPECT_BOTH_CASE_ID,
      SQL_FORMATTER_ANSI_ALIAS_CASE_ID,
      HTTPX_PROXY_AUTH_REPORT_CASE_ID,
      ...calibrationAutonomousCaseIds,
    ]);

    // Completed judge lifecycle: run, persist, reload immutably.
    const created = await service.createRun(simulatedUserSelection());
    const completed = await waitForCompletedRun(service, created.id);
    expect(completed.status, "completed judge run passes").toBe("passed");
    expect(calls, "judge runs exactly once per accepted turn").toHaveLength(1);
    expect(calls[0], "judge receives the full execution context").toMatchObject({
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
    expect(calls[0].request.text, "judge sees the original prompt").toContain("incoming queue");
    expect(calls[0].artifactDirectory, "judge artifacts live under the run").toContain(join("runs", completed.id, "executions"));

    const turn = completed.executions[0].turns[0];
    expect(turn.deterministicPassed, "deterministic checks pass before judging").toBe(true);
    expect(turn.judgeResults, "completed result persists references, not inline artifacts").toEqual([
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
    expect(turn.judgeResults[0].artifactDirectory, "result names its artifact directory").toBe(calls[0].artifactDirectory);

    const persisted = await waitForPersistedRun(stateFile, completed.id);
    expect(persisted.schemaVersion, "state schema survives persistence").toBe(1);
    expect(persisted.runs[0].executions[0].turns[0].judgeResults[0].references.coverage, "coverage reference persists")
      .toBe("coverage.json");
    expect(persisted.runs[0].bundleRef, "run bundle reference persists").toMatch(/^runs\/.*\/bundle\.json$/);
    const bundleFile = join(dirname(stateFile), persisted.runs[0].bundleRef);
    const bundleBeforeReload = await readFile(bundleFile, "utf8");
    expect(JSON.parse(bundleBeforeReload), "bundle carries the completed reference result").toMatchObject({
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
    expect(restored.executions[0].turns[0].judgeResults[0], "reloading restores the exact judge result")
      .toEqual(turn.judgeResults[0]);
    expect(reloaded.catalog().judges.map(({ id }) => id), "judge catalog always keeps the deterministic judge")
      .toEqual(["deterministic-graph-contract"]);
    expect(await readFile(bundleFile, "utf8"), "reload never rewrites the immutable bundle").toBe(bundleBeforeReload);

    // Input round-trip gating.
    const inputCase = service.catalog().cases.find(
      ({ id }) => id === "empty-project.node-input-roundtrip.single-turn",
    );
    expect(inputCase.requiredJudgeConfigurationIds, "input round-trip declares its required judges").toEqual([
      "simulated-user",
      "simulated-user-sol-high",
    ]);
    await expect(service.createRun({
      testCaseIds: [inputCase.id],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "deterministic-graph-contract",
    }), "deterministic judge cannot run the input round-trip").rejects.toThrow(
      "Input round-trip cases require a compatible simulated-user judge configuration.",
    );

    // Artifact-state corpus on the same service.
    const artifactStates = [
      {
        label: "explicit partial artifact keeps deterministic evidence",
        behavior: "partial",
        selection: () => simulatedUserSelection(),
        observe: (run) => ({
          runStatus: run.status,
          passed: run.executions[0].passed,
          presentation: run.executions[0].presentationGrade,
          deterministicPassed: run.executions[0].turns[0].deterministicPassed,
          judgeResult: run.executions[0].turns[0].judgeResults[0],
          hasPassingCheck: run.executions[0].checks.some((check) => check.passed),
        }),
        expected: {
          runStatus: "failed",
          passed: false,
          presentation: { status: "partial", score: null },
          deterministicPassed: true,
          judgeResult: expect.objectContaining({
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
          }),
          hasPassingCheck: true,
        },
      },
      {
        label: "thrown judge failure persists as an explicit failed artifact",
        behavior: "throw",
        selection: () => simulatedUserSelection(),
        observe: (run) => ({ judgeResult: run.executions[0].turns[0].judgeResults[0] }),
        expected: {
          judgeResult: expect.objectContaining({
            status: "failed",
            passed: null,
            error: "Judge process exited.",
          }),
        },
      },
      {
        label: "unexercised input round-trip fails the execution gate",
        behavior: "input-roundtrip-not-exercised",
        selection: () => ({
          testCaseIds: ["empty-project.node-input-roundtrip.single-turn"],
          harnessConfigurationNames: ["fixture-task-system"],
          judgeConfigurationName: "simulated-user",
        }),
        observe: (run) => ({
          runStatus: run.status,
          execution: { status: run.executions[0].status, passed: run.executions[0].passed },
          exercisedCheck: run.executions[0].checks.find((check) => check.name === "turn-1:input-roundtrip:exercised"),
          inputRoundTrip: run.executions[0].turns[0].judgeResults[0].inputRoundTrip,
          deterministicPassed: run.executions[0].turns[0].deterministicPassed,
          qualified: run.executions[0].outcomeGrade.qualified,
        }),
        expected: {
          runStatus: "failed",
          execution: { status: "failed", passed: false },
          exercisedCheck: expect.objectContaining({ passed: false }),
          inputRoundTrip: { schemaVersion: 1, status: "not_exercised", passed: false, checks: [], detail: "The judge did not commit and Send." },
          deterministicPassed: false,
          qualified: false,
        },
      },
      {
        label: "presentation judging stays independent when an outcome gate fails",
        behavior: "presentation-only",
        selection: () => ({
          testCaseIds: ["empty-project.hierarchical-overview.single-turn"],
          harnessConfigurationNames: ["fixture-task-system"],
          judgeConfigurationName: "simulated-user",
        }),
        observe: (run) => ({
          outcome: { status: run.executions[0].outcomeGrade.status, qualified: run.executions[0].outcomeGrade.qualified },
          presentation: { status: run.executions[0].presentationGrade.status },
          deterministicPassed: run.executions[0].turns[0].deterministicPassed,
          judgeStatus: run.executions[0].turns[0].judgeResults[0].status,
        }),
        expected: {
          outcome: { status: "completed", qualified: false },
          presentation: { status: "completed" },
          deterministicPassed: false,
          judgeStatus: "completed",
        },
      },
    ];
    expect(artifactStates, "artifact-state corpus").toHaveLength(4);
    for (const artifactState of artifactStates) {
      runnerBehavior = artifactState.behavior;
      const callsBefore = calls.length;
      const run = await waitForCompletedRun(
        service,
        (await service.createRun(artifactState.selection())).id,
      );
      expect(run.executions[0].turns.flatMap(({ judgeResults = [] }) => judgeResults).length,
        `${artifactState.label}: judge ran`).toBeGreaterThan(0);
      expect(calls.length, `${artifactState.label}: exactly one new judge invocation`).toBe(callsBefore + 1);
      expect(artifactState.observe(run), artifactState.label).toMatchObject(artifactState.expected);
    }
    expect(calls.filter((call) => call.request.followUp).length, "no follow-up judging occurred").toBe(0);

    // Trace-export failure keeps the pinned presentation version.
    const tracePaths = await testPaths();
    globalThis.fetch = fakeAcceptedProduct();
    const traceService = await new EvalService({
      stateFile: tracePaths.stateFile,
      productSession: productSession(),
      configurationPaths: [tracePaths.configurationPath],
      candidateTraceRequired: true,
      candidateTraceAttributionLoader: async () => 90,
      candidateTraceExporter: async () => {
        throw new Error("Trace export failed before reaching the trace store.");
      },
    }).open();
    const traceCompleted = await waitForCompletedRun(
      traceService,
      (await traceService.createRun({
        ...simulatedUserSelection(),
        judgeConfigurationName: "deterministic-graph-contract",
      })).id,
    );
    expect(traceCompleted.executions[0].turns[0], "failed trace export keeps the pinned presentation version").toMatchObject({
      personalPresentationVersionId: 90,
      candidateTrace: {
        status: "failed",
        personalPresentationVersionId: 90,
        error: "Trace export failed before reaching the trace store.",
      },
    });

    // Restart converts an in-flight judge artifact into an explicit partial result.
    const interruptedPaths = await testPaths();
    await mkdir(join(interruptedPaths.directory, "eval-data"), { recursive: true });
    await writeFile(interruptedPaths.stateFile, `${JSON.stringify({
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
    const interruptedService = await new EvalService({
      stateFile: interruptedPaths.stateFile,
      productSession: productSession(),
      configurationPaths: [interruptedPaths.configurationPath],
    }).open();
    const restoredInterrupted = interruptedService.getRun("run-interrupted");
    expect(restoredInterrupted.status, "interrupted run is explicit").toBe("interrupted");
    expect(restoredInterrupted.executions[0].status, "interrupted execution is explicit").toBe("interrupted");
    expect(restoredInterrupted.executions[0].lifecycle, "interrupted lifecycle failed").toMatchObject({ status: "failed" });
    expect(restoredInterrupted.executions[0].turns[0].judgeResults[0], "in-flight artifact becomes an explicit partial")
      .toMatchObject({
        status: "partial",
        error: "Simulated-user review was interrupted before finalization.",
      });
    expect(restoredInterrupted.bundleRef, "interrupted runs still publish a bundle").toMatch(/^runs\/.*\/bundle\.json$/);
    expect(JSON.parse(await readFile(join(dirname(interruptedPaths.stateFile), restoredInterrupted.bundleRef), "utf8")),
      "interrupted bundle names its status").toMatchObject({
      run: { status: "interrupted" },
    });
  }, 30_000);

  it("carries model selection and permission authority into product requests according to harness ownership", async () => {
    // Configuration-owned harnesses omit product model selection on every turn.
    const ownedPaths = await testPaths();
    const ownedConfigurationPath = join(ownedPaths.directory, "configuration-owned-fixture.yaml");
    await writeFile(ownedConfigurationPath, [
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
    const ownedService = await new EvalService({
      stateFile: ownedPaths.stateFile,
      productSession: productSession(),
      configurationPaths: [ownedConfigurationPath],
    }).open();
    await waitForCompletedRun(ownedService, (await ownedService.createRun({
      testCaseIds: ["empty-project.task-system.two-turn"],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "deterministic-graph-contract",
    })).id);
    expect(productBodies, "two-turn case created two product interactions").toHaveLength(2);
    expect(productBodies[0], "first turn omits product model selection").not.toHaveProperty("modelSelection");
    expect(productBodies[1], "second turn omits product model selection").not.toHaveProperty("modelSelection");

    // Claude matrix cells pin the connected default model when creating threads.
    const claudePaths = await testPaths();
    const requests = [];
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      const parsed = new URL(url);
      requests.push({ parsed, options });
      if (parsed.pathname === "/api/model-selection/default") {
        expect(parsed.searchParams.get("harnessId"), "default model lookup names the harness").toBe("claude-basic");
        return jsonResponse({ familyId: 7, providerId: "claude-work", modelId: "sonnet" });
      }
      if (parsed.pathname === "/api/threads" && options.method === "POST") return jsonResponse({ error: "stop after model assertion" }, 500);
      return jsonResponse({ error: "unexpected" }, 404);
    });
    const claudeService = await new EvalService({
      stateFile: claudePaths.stateFile,
      productSession: productSession(),
      configurationPaths: [join(repositoryRoot, "harnesses", "claude-basic.yaml")],
    }).open();
    const claudeCreated = await claudeService.createRun({
      testCaseIds: ["empty-project.task-system.single-turn"],
      harnessConfigurationNames: ["claude-basic"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    await waitForCompletedRun(claudeService, claudeCreated.id);
    const threadRequest = requests.find(({ parsed, options }) => parsed.pathname === "/api/threads" && options.method === "POST");
    expect(JSON.parse(threadRequest.options.body).modelSelection, "thread creation pins the connected default model")
      .toEqual({ familyId: 7, providerId: "claude-work", modelId: "sonnet" });

    // Prime harnesses keep the requested bounded profile on the product request.
    const primePaths = await testPaths();
    const product = fakeAcceptedProduct();
    globalThis.fetch = product;
    const primeService = await new EvalService({
      stateFile: primePaths.stateFile,
      productSession: productSession(),
      configurationPaths: [join(repositoryRoot, "harnesses", "prime-agent-basic.yaml")],
      platform: "darwin",
    }).open();
    const primeCreated = await primeService.createRun({
      testCaseIds: ["empty-project.task-system.single-turn"],
      harnessConfigurationNames: ["prime-agent-basic"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    await waitForCompletedRun(primeService, primeCreated.id);
    await waitForPersistedRun(primePaths.stateFile, primeCreated.id);
    const createRequest = product.mock.calls.find(([url, options]) => (
      new URL(url).pathname === "/api/threads" && options?.method === "POST"
    ));
    expect(JSON.parse(createRequest[1].body).permissionProfileId, "Prime keeps its requested bounded profile").toBe("auto");
  }, 30_000);
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
