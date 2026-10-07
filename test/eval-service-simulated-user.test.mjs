import { createHash } from "node:crypto";
import { projectExecutionDossier } from "../desktop/eval-renderer/run-model.js";
import { CalibrationService } from "../desktop/eval-main/calibration-service.mjs";
import { SetupRegistry } from "../desktop/eval-main/setup-registry.mjs";
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
  mandatoryGateReceipt,
  presentationGradeFromTurns,
  resolveH3PermissionProfile,
} from "../desktop/eval-main/eval-service.mjs";

import { createSyntheticExternalCatalog } from "../packages/eval-runner/test/fixtures/external-catalog.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const directories = [];
const originalFetch = globalThis.fetch;

it("carries only the selected Eval family into product interaction requests", () => {
  const selected = {
    familyId: 7,
    providerId: "codex",
    modelId: "gpt-5.6-sol",
    harnessId: "codex-layered-personal-presentation-v1",
  };
  expect(evalModelSelectionRequest(selected)).toEqual({
    modelSelection: {
      familyId: 7,
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
  it("maps every calibration verifier gate to its emitted production checks", () => {
    const checks = [
      { name: "workspace:required-deliverables", passed: true, detail: "All required files exist." },
      { name: "workspace:behavior-or-structure", passed: true, detail: "The behavioral verifier passed." },
      { name: "workspace:delivery-commit", passed: true, detail: "One delivery commit exists." },
      { name: "workspace:delivery-clean", passed: true, detail: "The workspace is clean." },
    ];
    for (const gate of [
      { id: "required-deliverables", label: "Required deliverables" },
      { id: "behavior-or-structure", label: "Behavior or structure" },
      { id: "scoped-commit", label: "Scoped commit" },
    ]) {
      expect(mandatoryGateReceipt(gate, checks)).toMatchObject({ status: "completed", passed: true });
    }
  });

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
          families: [{ id: 7, enabled: true, position: 0, members: [{ position: 0, providerId: "openai", modelId: "test-model", roles: [{ name: "orchestrator" }] }] }],
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

  it.each([
    ["codex-basic", "openrouter-work", "openai/gpt-6-luna"],
    ["claude-basic", "anthropic-work", "claude-sonnet-4-6"],
  ])("uses the profile family for %s when its orchestrator changes between followups", async (harnessId, providerId, modelId) => {
    const { stateFile } = await testPaths();
    const product = fakeAcceptedProduct();
    globalThis.fetch = product;
    const pinned = { familyId: 17, providerId, modelId };
    const selectModel = vi.fn().mockResolvedValueOnce(pinned).mockResolvedValue({ ...pinned, modelId: "changed-orchestrator" });
    const service = await new EvalService({ stateFile, productSession: productSession(),
      configurationPaths: [join(repositoryRoot, "harnesses", `${harnessId}.yaml`)],
      selectModel, targetKey: "macos-arm64" }).open();
    const created = await service.createRun({ testCaseIds: ["empty-project.task-system.two-turn"],
      harnessConfigurationNames: [harnessId], judgeConfigurationName: "deterministic-graph-contract" });
    await waitForCompletedRun(service, created.id);
    const bodies = product.mock.calls.filter(([url, options]) => options?.method === "POST"
      && /^\/api\/threads(?:\/[^/]+\/interactions)?$/.test(new URL(url).pathname))
      .map(([, options]) => JSON.parse(options.body));
    expect(bodies.map(({ modelSelection }) => modelSelection)).toEqual([{ familyId: pinned.familyId }, { familyId: pinned.familyId }]);
    expect(selectModel.mock.calls).toEqual([[harnessId], [harnessId]]);
  });

  it("stops before a followup if profile resolution changes family", async () => {
    const { stateFile } = await testPaths();
    const product = fakeAcceptedProduct();
    globalThis.fetch = product;
    const selectModel = vi.fn()
      .mockResolvedValueOnce({ familyId: 17, providerId: "openrouter-work", modelId: "first" })
      .mockResolvedValueOnce({ familyId: 18, providerId: "openrouter-work", modelId: "second" });
    const service = await new EvalService({ stateFile, productSession: productSession(),
      configurationPaths: [join(repositoryRoot, "harnesses", "codex-basic.yaml")],
      selectModel, targetKey: "macos-arm64" }).open();
    const created = await service.createRun({ testCaseIds: ["empty-project.task-system.two-turn"],
      harnessConfigurationNames: ["codex-basic"], judgeConfigurationName: "deterministic-graph-contract" });
    const completed = await waitForCompletedRun(service, created.id);
    expect(JSON.stringify(completed)).toContain("family selection changed between product turns");
    expect(product.mock.calls.filter(([url, options]) => options?.method === "POST"
      && /^\/api\/threads\/[^/]+\/interactions$/.test(new URL(url).pathname))).toHaveLength(0);
  });

  it("retains earlier captured authoring metrics when later preparation fails and the run reopens", async () => {
    const { stateFile } = await testPaths();
    globalThis.fetch = fakeAcceptedProduct();
    const options = { stateFile, productSession: productSession(),
      configurationPaths: [join(repositoryRoot, "harnesses", "codex-basic.yaml")], targetKey: "macos-arm64",
      selectModel: vi.fn().mockResolvedValueOnce({ familyId: 17, providerId: "openrouter-work", modelId: "first" })
        .mockResolvedValueOnce({ familyId: 18, providerId: "openrouter-work", modelId: "second" }),
      candidateTraceExporter: async (_interactionId, directory) => {
        const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, interactionNodeId: 1, sequence: 1,
          method: "POST", path: "/api/graph/nodes", status: 422 })}\n`);
        await mkdir(directory, { recursive: true }); await writeFile(join(directory, "graph-operations.jsonl"), bytes);
        // The metric is independently valid; missing provider proof still leaves the trace failed.
        return { graphOperations: { format: "relayer-graph-operations-v1", ref: "graph-operations.jsonl", byteLength: bytes.length,
          sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, eventCount: 1, status: "complete", truncated: false } };
      },
    };
    const service = await new EvalService(options).open();
    const created = await service.createRun({ testCaseIds: ["empty-project.task-system.two-turn"],
      harnessConfigurationNames: ["codex-basic"], judgeConfigurationName: "deterministic-graph-contract" });
    const failed = await waitForCompletedRun(service, created.id);
    expect(failed.executions[0].status).toBe("error");
    expect(JSON.stringify(failed)).toContain("family selection changed between product turns");
    await waitForPersistedRun(stateFile, created.id);
    const reopened = await new EvalService(options).open();
    const run = reopened.listRuns().find((run) => run.id === created.id);
    const execution = run.executions[0];
    expect(execution.status).toBe("error");
    expect(execution.turns).toEqual([]);
    expect(execution.candidateTraceCaptures["interaction-1"]).toMatchObject({ status: "failed", promotable: false });
    const dossier = projectExecutionDossier(run, execution);
    expect(dossier.authoringErrors).toEqual([expect.objectContaining({ kind: "captured", interactionId: "interaction-1",
      observed: 1, total: null, coverage: "partial", byCause: { server_rejection: 1 } })]);
    expect(dossier.authoringErrors[0]).not.toHaveProperty("sourceInteractionId");
    expect(dossier.substance.score).toBeNull();
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
      targetKey: "macos-arm64",
    }).open();

    const created = await service.createRun({
      testCaseIds: ["empty-project.task-system.single-turn"],
      harnessConfigurationNames: ["claude-basic"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    await waitForCompletedRun(service, created.id);
    const threadRequest = requests.find(({ parsed, options }) => parsed.pathname === "/api/threads" && options.method === "POST");
    expect(JSON.parse(threadRequest.options.body).modelSelection).toEqual({ familyId: 7 });
  });

  it("runs after deterministic checks and reloads the immutable completed artifact", async () => {
    const { stateFile, configurationPath } = await testPaths();
    globalThis.fetch = fakeAcceptedProduct();
    const setupRegistry = await new SetupRegistry({ stateFile: join(dirname(stateFile), "setups.json"), feedbackLoader: async (ref) => ({ ...ref, feedback: { value: 2, comment: "TARGET HUMAN GRADE" } }) }).open();
    const baseline = setupRegistry.selected("judge");
    const selectedSetup = await setupRegistry.publish({ ...baseline, predecessorId: baseline.id, name: "Manual judge revision", promptVersion: "judge-manual-v1",
      settings: { model: "gpt-test-revised", modelReasoningEffort: "low" }, feedback: [{ sessionId: "source-human", gradeIndex: 0 }] });
    const calls = [];
    let nativeJudgment = false;
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
        review: nativeJudgment ? { schemaVersion: 6, contractId: "recursive-presentation-judge-v6", turn: { criterionJudgments: {
          presentation_quality: { score: 6, reason: "Meaningful visible graph", evidence: [{ screenshotId: "shot-root" }] },
          answer_quality: { score: 5, reason: "Response value", evidence: [{ screenshotId: "shot-root" }] },
        }, scoreCeiling: { maximum: 8 } } } : { turn: { ratings: { answer_quality: 4 } } },
        coverage: { complete: true, missingSubjects: [] },
        summary: "Complete screenshot-grounded review.",
      };
    };
    const service = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [configurationPath],
      simulatedUserJudgeRunner: runner, setupRegistry,
      annotationSnapshotLoader: async (threadIds) => ({ schemaVersion: 1, kind: "relayer_eval_annotation_snapshot_set", annotationsSha256: "sha256:human-labels",
        threads: threadIds.map((threadId) => ({ threadId, annotations: [] })) }),
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
    const created = await service.createRun({ ...simulatedUserSelection(), judgeSetupRevisionId: selectedSetup.id });
    expect(created.judgeSetup).toEqual(selectedSetup);
    const completed = await waitForCompletedRun(service, created.id);

    expect(completed.status).toBe("passed");
    expect(calls).toHaveLength(1);
    expect(completed.executions[0].judgeSetup).toEqual(selectedSetup);
    expect(completed.executions[0].turns[0].judgeResults[0].judgeSetup).toEqual(selectedSetup);
    expect(calls[0].judgeSetup).toMatchObject({ id: selectedSetup.id, settings: selectedSetup.settings });
    expect(JSON.stringify(calls)).not.toContain("TARGET HUMAN GRADE");
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
    const originalResult = structuredClone(turn.judgeResults[0]);
    const rerun = await service.rejudgeExecution(completed.executions[0].id, "simulated-user", null, baseline.id);
    expect(rerun.results[0].judgeSetup).toEqual(baseline);
    const rerunExecution = service.getRun(completed.id).executions[0];
    expect(rerunExecution.judgeSetup).toEqual(selectedSetup);
    expect(rerunExecution.turns[0].judgeResults[0]).toEqual(originalResult);
    expect(rerunExecution.turns[0].judgeResults).toHaveLength(2);
    const calibration = await new CalibrationService({ stateFile: join(dirname(stateFile), "calibration.json"), setups: setupRegistry, evalService: service, author: { id: "human", displayName: "Human" } }).open();
    const set = await calibration.freeze({ name: "Native graph agreement", members: [{ source: { kind: "execution", id: completed.executions[0].id }, membership: "held-out",
      labels: [{ dimension: "graph-presentation", scale: "graph-presentation-v11-1-8", subject: { kind: "turn", id: "interaction-1" }, criterion: "presentation_quality", value: 6, comment: "FROZEN HUMAN TARGET LABEL" }] }] });
    const comparison = await calibration.compare({ baselineRevisionId: baseline.id, candidateRevisionId: selectedSetup.id, calibrationSetId: set.id });
    const source = { comparisonId: comparison.comparison.id, memberId: set.members[0].id, labelId: set.members[0].labels[0].id };
    const partial = await calibration.observe({ ...source, revisionId: baseline.id, judgeResultId: rerun.results[0].id });
    expect(partial).toMatchObject({ status: "incomplete", rows: [{ baseline: { status: "incomplete", score: null, agreesWithHuman: null }, humanTarget: 6 }] });
    nativeJudgment = true;
    for (const revision of [baseline, selectedSetup]) {
      const judged = await service.rejudgeExecution(completed.executions[0].id, "simulated-user", null, revision.id);
      expect(judged.results[0].error).toBeNull();
      expect(judged.results[0]).toMatchObject({ status: "completed", rubricVersion: "graph-presentation-rubric-v11", coverage: { complete: true }, review: { turn: { criterionJudgments: { presentation_quality: { score: 6 } } } } });
      await calibration.observe({ ...source, revisionId: revision.id, judgeResultId: judged.results[0].id });
    }
    const agreed = calibration.report(comparison.comparison.id);
    expect(agreed).toMatchObject({ status: "completed", comparison: { dimension: "human-judge-agreement" }, rows: [{ baseline: { score: 6, agreesWithHuman: true }, candidate: { score: 6, agreesWithHuman: true } }] });
    expect(JSON.stringify(calls)).not.toMatch(/FROZEN HUMAN TARGET LABEL|TARGET HUMAN GRADE/);
    expect(service.getRun(completed.id).executions[0].turns[0].judgeResults[0]).toEqual(originalResult);
    const reloadedCalibration = await new CalibrationService({ stateFile: join(dirname(stateFile), "calibration.json"), setups: setupRegistry, evalService: service }).open();
    expect(reloadedCalibration.report(comparison.comparison.id)).toEqual(agreed);
    const bundle = await calibration.export();
    expect(bundle.sets[0].members[0].labels[0].value).toBe(6);
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
    await waitForPersistedRun(stateFile, created.id);
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
        }, {
          id: "execution-already-interrupted",
          testCaseId: "empty-project.task-system.single-turn",
          harnessConfigurationName: "fixture-task-system",
          status: "interrupted",
          turns: [{ judgeResults: [{ id: "judge-already-completed", status: "completed" }] }],
        }, {
          id: "execution-completed-judge-pending-grade",
          testCaseId: "empty-project.task-system.single-turn",
          harnessConfigurationName: "fixture-task-system",
          status: "running",
          presentationGrade: { status: "pending" },
          turns: [{ judgeResults: [{
            id: "judge-completed-before-restart",
            status: "completed",
            review: {
              schemaVersion: 6,
              contractId: "recursive-presentation-judge-v6",
              turn: { criterionJudgments: {} },
            },
          }] }],
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
    expect(restored.executions[1]).not.toHaveProperty("presentationGrade");
    expect(restored.executions[2].presentationGrade).toMatchObject({ status: "completed" });
    expect(restored.bundleRef).toMatch(/^runs\/.*\/bundle\.json$/);
    expect(JSON.parse(await readFile(join(dirname(stateFile), restored.bundleRef), "utf8"))).toMatchObject({
      run: { status: "interrupted" },
    });
  });

  it("preserves a persisted finalized presentation grade when historical judge aggregation differs", async () => {
    const { directory, stateFile, configurationPath } = await testPaths();
    await mkdir(join(directory, "eval-data"), { recursive: true });
    const historicalGrade = {
      schemaVersion: 1,
      kind: "graph_presentation_grade",
      status: "completed",
      score: 0.875,
      scoreScaleMaximum: 1,
      summary: "Finalized under the historical presentation contract.",
      contractId: "historical-presentation-contract-v1",
    };
    await writeFile(stateFile, `${JSON.stringify({
      schemaVersion: 1,
      runs: [{
        schemaVersion: 1,
        id: "run-historical-grade",
        createdAt: "2026-08-19T12:00:00.000Z",
        completedAt: "2026-08-19T12:01:00.000Z",
        status: "passed",
        testCaseIds: ["empty-project.task-system.single-turn"],
        harnessConfigurationNames: ["fixture-task-system"],
        judgeConfigurationName: "simulated-user",
        executions: [{
          id: "execution-historical-grade",
          testCaseId: "empty-project.task-system.single-turn",
          harnessConfigurationName: "fixture-task-system",
          status: "passed",
          presentationGrade: historicalGrade,
          turns: [{
            judgeResults: [{
              schemaVersion: 1,
              id: "judge-historical-grade",
              judge: "simulated-user",
              status: "completed",
              review: {
                schemaVersion: 6,
                contractId: "recursive-presentation-judge-v6",
                turn: { criterionJudgments: {} },
              },
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

    expect(service.getRun("run-historical-grade").executions[0].presentationGrade).toEqual(historicalGrade);
    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    expect(persisted.runs[0].executions[0].presentationGrade).toEqual(historicalGrade);
  });

  it("does not synthesize a presentation grade for a terminal legacy execution", async () => {
    const { directory, stateFile, configurationPath } = await testPaths();
    await mkdir(join(directory, "eval-data"), { recursive: true });
    await writeFile(stateFile, `${JSON.stringify({
      schemaVersion: 1,
      runs: [{
        schemaVersion: 1,
        id: "run-terminal-legacy-grade",
        createdAt: "2026-08-19T12:00:00.000Z",
        completedAt: "2026-08-19T12:01:00.000Z",
        status: "passed",
        testCaseIds: ["empty-project.task-system.single-turn"],
        harnessConfigurationNames: ["fixture-task-system"],
        judgeConfigurationName: "simulated-user",
        executions: [{
          id: "execution-terminal-legacy-grade",
          testCaseId: "empty-project.task-system.single-turn",
          harnessConfigurationName: "fixture-task-system",
          status: "passed",
          turns: [{ judgeResults: [{ id: "judge-terminal", status: "completed" }] }],
        }],
      }],
    }, null, 2)}\n`);

    const service = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [configurationPath],
    }).open();

    expect(service.getRun("run-terminal-legacy-grade").executions[0]).not.toHaveProperty("presentationGrade");
    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    expect(persisted.runs[0].executions[0]).not.toHaveProperty("presentationGrade");
  });

  it("disables Prime without a provider and pins the exact admitted model on both product turns", async () => {
    const { stateFile } = await testPaths();
    const configurationPaths = [join(repositoryRoot, "harnesses", "prime-agent-basic.yaml")];
    const selection = { testCaseIds: ["empty-project.task-system.two-turn"],
      harnessConfigurationNames: ["prime-agent-basic"], judgeConfigurationName: "deterministic-graph-contract" };
    const unavailable = await new EvalService({ stateFile, productSession: productSession(), configurationPaths, targetKey: "macos-arm64" }).open();
    expect(unavailable.catalog().harnessConfigurations[0]).toMatchObject({ available: false });
    await expect(unavailable.createRun(selection)).rejects.toThrow("requires a connected provider");
    const product = fakeAcceptedProduct();
    globalThis.fetch = product;
    const pinned = { familyId: 42, providerId: "eval-openrouter", modelId: "openai/gpt-6-luna" };
    const selectPrimeModel = vi.fn(async () => pinned);
    let routeAvailable = true;
    const service = await new EvalService({ stateFile, productSession: productSession(), configurationPaths,
      selectPrimeModel, primeModelAvailability: () => ({ available: routeAvailable, unavailableReason: routeAvailable ? null : "Runtime unavailable" }),
      targetKey: "macos-arm64" }).open();
    expect(service.catalog().harnessConfigurations[0].available).toBe(true);
    routeAvailable = false;
    expect(service.catalog().harnessConfigurations[0]).toMatchObject({ available: false, unavailableReason: "Runtime unavailable" });
    await expect(service.createRun(selection)).rejects.toThrow("requires a connected provider");
    routeAvailable = true;
    const created = await service.createRun(selection);
    await waitForCompletedRun(service, created.id);
    const bodies = product.mock.calls.filter(([url, options]) => options?.method === "POST"
      && /^\/api\/threads(?:\/[^/]+\/interactions)?$/.test(new URL(url).pathname))
      .map(([, options]) => JSON.parse(options.body));
    expect(bodies).toHaveLength(2);
    expect(bodies.map(({ modelSelection }) => modelSelection)).toEqual([{ familyId: pinned.familyId }, { familyId: pinned.familyId }]);
    expect(selectPrimeModel).toHaveBeenCalledTimes(2);
  });


  it("rejects product project consolidation outside the isolated fixture before dispatch", async () => {
    const { stateFile, configurationPath, directory } = await testPaths();
    const product = fakeExternalAcceptedProduct();
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      if (new URL(url).pathname === "/api/projects" && options.method === "POST") return jsonResponse({ id: "ancestor-project", path: directory });
      return product.fetch(url, options);
    });
    const service = await new EvalService({ stateFile, productSession: productSession(), configurationPaths: [configurationPath], platform: "darwin", externalCatalog: withExternalIdentity(createSyntheticExternalCatalog()) }).open();
    await expect(service.prepareHumanTask({ testCaseId: "fixture.external-a", harnessConfigurationName: "fixture-task-system", sessionId: "isolated-task", maxCompletions: 2, endpoint: "A result" })).rejects.toThrow("isolated fixture");
    expect(product.fetch.mock.calls.some(([url, options]) => new URL(url).pathname === "/api/threads" && options?.method === "POST")).toBe(false);
  });

  it("runs generic external cases and suites through materialize, grade, and durable catalog provenance", async () => {
    const { stateFile, configurationPath } = await testPaths();
    const product = fakeExternalAcceptedProduct();
    globalThis.fetch = product.fetch;
    const fixtureCatalog = createSyntheticExternalCatalog();
    const materialize = vi.fn(fixtureCatalog.cases[0].materialize);
    const grade = vi.fn(async () => [{ name: "arbitrary-public-check-name", passed: true, detail: "Synthetic deterministic result." }]);
    const catalog = withExternalIdentity({
      ...fixtureCatalog,
      cases: fixtureCatalog.cases.map((entry, index) => index === 0 ? { ...entry, materialize, grade } : entry),
    });
    const service = await new EvalService({ stateFile, productSession: productSession(), configurationPaths: [configurationPath], platform: "darwin", externalCatalog: catalog }).open();
    const catalogEntry = service.catalog();
    expect(catalogEntry.cases.map(({ id }) => id)).toContain("fixture.external-a");
    expect(catalogEntry.suites.map(({ suiteId }) => suiteId)).toEqual(["synthetic-external-suite"]);

    const single = await service.createRun({ testCaseIds: ["fixture.external-a"], harnessConfigurationNames: ["fixture-task-system"], judgeConfigurationName: "deterministic-graph-contract" });
    const singleResult = await waitForCompletedRun(service, single.id);
    expect(singleResult.executions[0]).toMatchObject({ status: "passed" });
    expect(singleResult.executions[0].outcomeGrade.mandatoryGates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidenceRefs: ["deterministic-check:implementation:turn-1:arbitrary-public-check-name"],
      }),
    ]));
    expect(singleResult.executions[0].checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "implementation:turn-1:arbitrary-public-check-name" }),
    ]));
    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({ caseId: "fixture.external-a", platform: "darwin" }));
    expect(grade).toHaveBeenCalledWith(expect.objectContaining({ caseId: "fixture.external-a", fixture: expect.objectContaining({ sourceRevision: expect.stringMatching(/^git-tree:/) }) }));
    expect(singleResult.catalogIdentity).toEqual(catalog.identity);
    expect(singleResult.executions[0].catalogIdentity).toEqual(catalog.identity);

    const suiteRun = await service.createRun({ suiteId: "synthetic-external-suite", harnessConfigurationNames: ["fixture-task-system"], judgeConfigurationName: "deterministic-graph-contract" });
    const suiteResult = await waitForCompletedRun(service, suiteRun.id);
    expect(suiteResult.status).toBe("passed");
    expect(suiteResult.testCaseIds).toEqual(["fixture.external-a", "fixture.external-b"]);
    expect(suiteResult.executions.map(({ testCaseId }) => testCaseId)).toEqual(["fixture.external-a", "fixture.external-b"]);
    expect(suiteResult.suiteIdentity.members.map(({ caseId }) => caseId)).toEqual(["fixture.external-a", "fixture.external-b"]);
    expect(suiteResult.catalogIdentity).toEqual(catalog.identity);
    expect(suiteResult.executions.every(({ catalogIdentity, suiteIdentity }) => catalogIdentity?.commit === catalog.identity.commit && suiteIdentity?.suiteId === "synthetic-external-suite")).toBe(true);
    expect(product.projects).toHaveLength(3);

    const reopened = await new EvalService({ stateFile, productSession: productSession(), configurationPaths: [configurationPath], platform: "darwin" }).open();
    expect(reopened.getRun(single.id)).toMatchObject({ catalogIdentity: catalog.identity, executions: [{ catalogIdentity: catalog.identity }] });
    expect(reopened.getRun(suiteRun.id)).toMatchObject({
      catalogIdentity: catalog.identity,
      suiteIdentity: { suiteId: "synthetic-external-suite", members: [{ caseId: "fixture.external-a" }, { caseId: "fixture.external-b" }] },
    });
  });

  it("binds duplicate public grader names to each exact persisted thread check", async () => {
    const { stateFile, configurationPath } = await testPaths();
    globalThis.fetch = fakeExternalAcceptedProduct().fetch;
    const fixtureCatalog = createSyntheticExternalCatalog();
    const first = fixtureCatalog.cases[0];
    const [thread] = first.definition.threads;
    const definition = {
      ...first.definition,
      threads: [
        { ...thread, id: "first", name: "First", prompts: [thread.prompts[0]] },
        { ...thread, id: "second", name: "Second", prompts: [thread.prompts[0]] },
      ],
    };
    const grade = vi.fn(async () => [{ name: "shared-public-name", passed: true, detail: "Passed." }]);
    const catalog = withExternalIdentity({
      ...fixtureCatalog,
      cases: [{ ...first, definition, grade }, fixtureCatalog.cases[1]],
    });
    const service = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [configurationPath],
      platform: "darwin",
      externalCatalog: catalog,
    }).open();

    const created = await service.createRun({
      testCaseIds: [definition.id],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    const execution = (await waitForCompletedRun(service, created.id)).executions[0];
    const expectedRefs = [
      "deterministic-check:first:turn-1:shared-public-name",
      "deterministic-check:second:turn-1:shared-public-name",
    ];
    expect(grade).toHaveBeenCalledTimes(2);
    expect(execution.outcomeGrade.mandatoryGates).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceRefs: expectedRefs }),
    ]));
    for (const reference of expectedRefs) {
      expect(execution.checks.some(({ name }) => reference === `deterministic-check:${name}`)).toBe(true);
    }
  });

  it("grades an external workspace only after native semantic children settle", async () => {
    const { stateFile, configurationPath } = await testPaths();
    const fixtureCatalog = createSyntheticExternalCatalog();
    const first = fixtureCatalog.cases[0];
    const thread = first.definition.threads[0];
    const definition = {
      ...first.definition,
      threads: [{ ...thread, mutationPolicy: "read-only", prompts: [thread.prompts[0], "Inspect the settled first result, then finish."] }],
    };
    let workspaceMarker;
    const materialize = vi.fn(async (input) => {
      const fixture = await first.materialize(input);
      workspaceMarker = join(input.workspaceDirectory, "semantic-child-marker.txt");
      await writeFile(workspaceMarker, "root-terminal\n");
      return fixture;
    });
    const observedMarkers = [];
    const grade = vi.fn(async () => {
      const marker = await readFile(workspaceMarker, "utf8");
      observedMarkers.push(marker.trim());
      return [{
        name: "settled-workspace",
        passed: marker.startsWith("child-") && marker.endsWith("-settled\n"),
        detail: marker.trim(),
      }];
    });
    const catalog = withExternalIdentity({
      ...fixtureCatalog,
      cases: [{ ...first, definition, materialize, grade }, fixtureCatalog.cases[1]],
    });
    let now = 0;
    const clock = { now: () => now, sleep: async (ms) => { now += ms; } };
    globalThis.fetch = fakeExternalChildProduct(async (phase) => {
      await writeFile(workspaceMarker, `child-${phase}-settled\n`);
    });
    const service = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [configurationPath],
      platform: "darwin",
      externalCatalog: catalog,
      semanticChildDiscoveryClock: clock,
    }).open();

    const created = await service.createRun({
      testCaseIds: [definition.id],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    const execution = (await waitForCompletedRun(service, created.id)).executions[0];

    expect(execution.error).toBeNull();
    expect(execution.semanticChildren).toEqual([
      expect.objectContaining({ interactionId: "child-1", status: "accepted" }),
      expect.objectContaining({ interactionId: "child-2", status: "accepted" }),
    ]);
    expect(grade).toHaveBeenCalledTimes(2);
    expect(observedMarkers).toEqual(["child-1-settled", "child-2-settled"]);
    expect(execution.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "implementation:turn-1:settled-workspace", passed: true, detail: "child-1-settled" }),
      expect.objectContaining({ name: "implementation:turn-2:settled-workspace", passed: true, detail: "child-2-settled" }),
    ]));
  });

  it("keeps external mandatory gates failed for missing or failing verifier checks", async () => {
    for (const mode of ["missing", "failing", "malformed-truthy", "sparse-gate"]) {
      const { stateFile, configurationPath } = await testPaths();
      globalThis.fetch = fakeExternalAcceptedProduct().fetch;
      const fixtureCatalog = createSyntheticExternalCatalog();
      const first = fixtureCatalog.cases[0];
      const grade = mode === "missing"
        ? async () => []
        : mode === "failing"
          ? async () => [{ name: "workspace:contract", passed: false, detail: "Verifier rejected the fixture result." }]
          : mode === "sparse-gate" ? first.grade
            : async () => [{ name: "workspace:contract", passed: "false", detail: "Malformed verifier result." }];
      const evaluateMandatoryGate = mode === "sparse-gate"
        ? () => ({ complete: true, passed: true, matched: new Array(1) })
        : first.evaluateMandatoryGate;
      const service = await new EvalService({
        stateFile, productSession: productSession(), configurationPaths: [configurationPath], platform: "darwin",
        externalCatalog: withExternalIdentity({ ...fixtureCatalog, cases: [{ ...first, grade, evaluateMandatoryGate }] }),
      }).open();
      const created = await service.createRun({ testCaseIds: ["fixture.external-a"], harnessConfigurationNames: ["fixture-task-system"], judgeConfigurationName: "deterministic-graph-contract" });
      const result = await waitForCompletedRun(service, created.id);
      expect(result.status).toBe(mode === "malformed-truthy" ? "error" : "failed");
      expect(result.executions[0].passed).toBe(false);
      if (mode === "missing" || mode === "sparse-gate") expect(result.executions[0].outcomeGrade.mandatoryGates.every(({ status }) => status === "failed")).toBe(true);
      else if (mode === "failing") expect(result.executions[0].outcomeGrade.mandatoryGates.every(({ status, passed }) => status === "completed" && passed === false)).toBe(true);
      else expect(result.executions[0].error).toContain("boolean passed");
    }
  });

  it("rejects unavailable suite members and case overrides before enqueueing", async () => {
    const { stateFile, configurationPath } = await testPaths();
    const fixtureCatalog = createSyntheticExternalCatalog();
    const [first, second] = fixtureCatalog.cases;
    const service = await new EvalService({
      stateFile, productSession: productSession(), configurationPaths: [configurationPath], platform: "darwin",
      externalCatalog: withExternalIdentity({ ...fixtureCatalog, cases: [first, { ...second, available: false, unavailableReason: "Fixture not provisioned." }] }),
    }).open();
    await expect(service.createRun({ suiteId: "synthetic-external-suite", harnessConfigurationNames: ["fixture-task-system"], judgeConfigurationName: "deterministic-graph-contract" })).rejects.toThrow("member is unavailable: fixture.external-b");
    await expect(service.createRun({ suiteId: "synthetic-external-suite", testCaseIds: ["fixture.external-a"], harnessConfigurationNames: ["fixture-task-system"], judgeConfigurationName: "deterministic-graph-contract" })).rejects.toThrow("cannot override its ordered member cases");
    await expect(service.createRun({ testCaseIds: ["fixture.external-b"], harnessConfigurationNames: ["fixture-task-system"], judgeConfigurationName: "deterministic-graph-contract" })).rejects.toThrow("unknown test case");
    expect(service.listRuns()).toEqual([]);
  });

  it("runs built-in cases without consulting a changed external catalog", async () => {
    const { stateFile, configurationPath } = await testPaths();
    globalThis.fetch = fakeAcceptedProduct();
    const assertUnchanged = vi.fn(async () => { throw new Error("external catalog changed"); });
    const service = await new EvalService({
      stateFile, productSession: productSession(), configurationPaths: [configurationPath], platform: "darwin",
      externalCatalog: withExternalIdentity(createSyntheticExternalCatalog(), { assertUnchanged }),
    }).open();
    const created = await service.createRun({ testCaseIds: ["empty-project.task-system.single-turn"], harnessConfigurationNames: ["fixture-task-system"], judgeConfigurationName: "deterministic-graph-contract" });
    const result = await waitForCompletedRun(service, created.id);
    expect(result.status).toBe("passed");
    expect(result.catalogIdentity).toBeNull();
    expect(assertUnchanged).not.toHaveBeenCalled();
  });

  it("checks the catalog pin before enqueue and again before materializing execution", async () => {
    const beforeQueuePaths = await testPaths();
    const fixtureCatalog = createSyntheticExternalCatalog();
    const materialize = vi.fn(fixtureCatalog.cases[0].materialize);
    const rejectImmediately = withExternalIdentity(fixtureCatalog, { assertUnchanged: vi.fn(async () => { throw new Error("catalog pin changed"); }) });
    const beforeQueue = await new EvalService({ stateFile: beforeQueuePaths.stateFile, productSession: productSession(), configurationPaths: [beforeQueuePaths.configurationPath], platform: "darwin", externalCatalog: rejectImmediately }).open();
    await expect(beforeQueue.createRun({ testCaseIds: ["fixture.external-a"], harnessConfigurationNames: ["fixture-task-system"], judgeConfigurationName: "deterministic-graph-contract" })).rejects.toThrow("catalog pin changed");
    expect(beforeQueue.listRuns()).toEqual([]);
    expect(materialize).not.toHaveBeenCalled();

    const driftPaths = await testPaths();
    globalThis.fetch = fakeExternalAcceptedProduct().fetch;
    let checks = 0;
    const driftCatalog = withExternalIdentity({ ...fixtureCatalog, cases: [{ ...fixtureCatalog.cases[0], materialize }] }, {
      assertUnchanged: vi.fn(async () => { checks += 1; if (checks > 1) throw new Error("catalog execution drift"); }),
    });
    const driftService = await new EvalService({ stateFile: driftPaths.stateFile, productSession: productSession(), configurationPaths: [driftPaths.configurationPath], platform: "darwin", externalCatalog: driftCatalog }).open();
    const created = await driftService.createRun({ testCaseIds: ["fixture.external-a"], harnessConfigurationNames: ["fixture-task-system"], judgeConfigurationName: "deterministic-graph-contract" });
    const result = await waitForCompletedRun(driftService, created.id);
    expect(result.status).toBe("error");
    expect(result.executions[0].error).toContain("catalog execution drift");
    expect(materialize).not.toHaveBeenCalled();
  });

  it.each(["materialize", "grade", "mandatory gate"])("rejects catalog drift during the external %s callback", async (callbackName) => {
    const { stateFile, configurationPath } = await testPaths();
    globalThis.fetch = fakeExternalAcceptedProduct().fetch;
    const fixtureCatalog = createSyntheticExternalCatalog();
    const first = fixtureCatalog.cases[0];
    let changed = false;
    const materialize = vi.fn(async (context) => {
      const fixture = await first.materialize(context);
      if (callbackName === "materialize") changed = true;
      return fixture;
    });
    const grade = vi.fn(async (context) => {
      const checks = await first.grade(context);
      if (callbackName === "grade") changed = true;
      return checks;
    });
    const evaluateMandatoryGate = (gate, checks) => {
      const result = first.evaluateMandatoryGate(gate, checks);
      if (callbackName === "mandatory gate") changed = true;
      return result;
    };
    const assertUnchanged = vi.fn(async () => {
      if (changed) throw new Error(`catalog drift during ${callbackName}`);
    });
    const service = await new EvalService({
      stateFile, productSession: productSession(), configurationPaths: [configurationPath], platform: "darwin",
      externalCatalog: withExternalIdentity({ ...fixtureCatalog, cases: [{ ...first, materialize, grade, evaluateMandatoryGate }] }, { assertUnchanged }),
    }).open();
    const created = await service.createRun({ testCaseIds: ["fixture.external-a"], harnessConfigurationNames: ["fixture-task-system"], judgeConfigurationName: "deterministic-graph-contract" });
    const result = await waitForCompletedRun(service, created.id);
    expect(result.status).toBe("error");
    expect(result.executions[0]).toMatchObject({ passed: false, error: `catalog drift during ${callbackName}` });
    expect(materialize).toHaveBeenCalledOnce();
    expect(grade).toHaveBeenCalledTimes(callbackName === "materialize" ? 0 : 1);
  });

  it("preserves Prime's requested bounded profile while retaining the explicit sole-Full exception", { timeout: 30_000 }, async () => {
    const { stateFile } = await testPaths();
    const product = fakeAcceptedProduct();
    globalThis.fetch = product;
    const service = await new EvalService({
      stateFile,
      productSession: productSession(),
      configurationPaths: [join(repositoryRoot, "harnesses", "prime-agent-basic.yaml")],
      selectPrimeModel: async () => ({ familyId: 7, providerId: "eval-openrouter", modelId: "openai/gpt-6-luna" }),
      platform: "darwin",
      targetKey: "macos-arm64",
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
    await waitForPersistedRun(stateFile, created.id);
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


function withExternalIdentity(catalog, overrides = {}) {
  return {
    ...catalog,
    identity: { schemaVersion: 1, repositoryUrl: "https://example.invalid/eval-catalog.git", commit: "a".repeat(40), tree: "b".repeat(40), entrypoint: "src/index.mjs", entrypointSha256: "c".repeat(64) },
    assertUnchanged: async () => {},
    ...overrides,
  };
}

function fakeExternalAcceptedProduct() {
  const base = fakeAcceptedProduct();
  const projects = [];
  let nextProject = 0;
  const output = acceptedOutput();
  const interaction = {
    id: "interaction-1", sequence: 1, graphNodeId: 1, completionStatus: "accepted",
    completionOutput: output, completionError: null, text: "Synthetic project task.",
    permissionProfileId: "auto", effectiveExecutionDigest: `sha256:${"d".repeat(64)}`,
    effectivePermissionReceipt: { permissionProfileId: "auto" },
  };
  const fetch = vi.fn(async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === "/api/projects" && options.method === "POST") {
      const body = JSON.parse(options.body);
      projects.push(body);
      return jsonResponse({ id: `external-project-${++nextProject}`, path: body.path });
    }
    const layerRoute = /^\/api\/threads\/thread-1\/interactions\/interaction-1\/layers\/(\d+)$/.exec(path);
    if (layerRoute) {
      const layer = output.rootLayer.layer;
      return jsonResponse({ layer, nodes: output.rootLayer.nodes, edges: output.rootLayer.edges, actions: output.rootLayer.actions });
    }
    if (path === "/api/threads/thread-1" && (options.method === undefined || options.method === "GET")) {
      return jsonResponse({ id: "thread-1", thread: { id: "thread-1" }, interactions: [interaction] });
    }
    return base(url, options);
  });
  return { fetch, projects, base };
}

function fakeExternalChildProduct(onChildSettled) {
  const base = fakeExternalAcceptedProduct().fetch;
  const output = acceptedOutput();
  const root = {
    id: "interaction-1", sequence: 1, graphNodeId: 1, completionStatus: "accepted",
    completionOutput: output, completionError: null, text: "Synthetic project task.",
    permissionProfileId: "auto", effectiveExecutionDigest: `sha256:${"d".repeat(64)}`,
    effectivePermissionReceipt: { permissionProfileId: "auto" },
  };
  let phase = 1;
  let phaseReads = 0;
  const mutatedPhases = new Set();
  return vi.fn(async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/state") return jsonResponse({ currentProjection: { events: [] } });
    if (/^\/api\/threads\/thread-1\/interactions\/interaction-2\/layers\/\d+$/.test(path)) {
      return jsonResponse({
        layer: output.rootLayer.layer,
        nodes: output.rootLayer.nodes,
        edges: output.rootLayer.edges,
        actions: output.rootLayer.actions,
      });
    }
    if (path === "/api/threads/thread-1/interactions" && options.method === "POST") {
      phase = 2;
      phaseReads = 0;
      return jsonResponse({ id: "interaction-2" });
    }
    if (path !== "/api/threads/thread-1" || (options.method !== undefined && options.method !== "GET")) return base(url, options);
    phaseReads += 1;
    const childAccepted = phaseReads >= 3;
    if (childAccepted && !mutatedPhases.has(phase)) {
      mutatedPhases.add(phase);
      await onChildSettled(phase);
    }
    const human = phase === 1 ? [root] : [root, {
      ...root, id: "interaction-2", sequence: 2, graphNodeId: 3,
      text: "Inspect the settled first result, then finish.",
    }];
    const child = {
      id: `child-${phase}`, sequence: phase * 2, graphNodeId: phase * 2,
      completionStatus: childAccepted ? "accepted" : "running",
      completionOutput: null, completionError: null,
    };
    return jsonResponse({
      id: "thread-1",
      interactions: [
        ...human,
        ...(phase === 2 ? [{
          id: "child-1", sequence: 2, graphNodeId: 2,
          completionStatus: "accepted", completionOutput: null, completionError: null,
        }] : []),
        child,
      ],
      actionInvocations: [
        ...(phase === 2 ? [{ sourceInteractionId: root.id, actionId: "invoke-1", resultInteractionId: "child-1" }] : []),
        { sourceInteractionId: human.at(-1).id, actionId: `invoke-${phase}`, resultInteractionId: child.id },
      ],
    });
  });
}

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
          members: [{ position: 0, providerId: "openai", modelId: "test-model", roles: [{ name: "orchestrator" }] }],
        }],
      });
    }
    if (path === "/api/threads" && options.method === "POST") {
      return jsonResponse({ id: "thread-1", rootInteractionId: interaction.id });
    }
    if (path === "/api/threads/thread-1" && (options.method === undefined || options.method === "GET")) {
      return jsonResponse({ id: "thread-1", thread: { id: "thread-1" }, interactions: [interaction] });
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
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const run = evalService.getRun(runId);
    if (!["queued", "running"].includes(run.status) && typeof run.bundleRef === "string") {
      // The terminal status is visible before its state write finishes; drain
      // it so cleanup never removes the data directory mid-write.
      await evalService.persistTail;
      return run;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Eval run did not finish in time.");
}

async function waitForPersistedRun(stateFile, runId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    const run = persisted.runs.find((candidate) => candidate.id === runId);
    if (typeof run?.bundleRef === "string") return persisted;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Completed Eval run was not persisted in time.");
}
