import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  basicEvalCaseId,
  basicEvalFollowUpPrompt,
  basicEvalPrompt,
  checkNodeNavigation,
  checkBasicOutput,
  DEFAULT_SIMULATED_USER_RUBRIC,
  expandTestRun,
  gradeH3Workspace,
  H3_PROJECT_CASE_ID,
  H3_UPSTREAM_COMMIT,
  h3ProjectEvalCase,
  materializeH3ProjectFixture,
} from "@relayer/eval-runner";
import { loadHarnessConfigurations } from "@relayer/harness-host";
import {
  buildAcceptedReviewTopology,
  gradeAcceptedReviewTopology,
} from "./simulated-user-judge.mjs";

export const evalCases = Object.freeze([
  Object.freeze({
    id: basicEvalCaseId,
    name: "Task system · two turns",
    description: "Explains a queue, two-worker pool, and results store, then follows up in the same thread.",
    prompts: Object.freeze([basicEvalPrompt, basicEvalFollowUpPrompt]),
  }),
  Object.freeze({
    id: "empty-project.task-system.single-turn",
    name: "Task system · one turn",
    description: "Explains the same task system in a fresh standalone thread.",
    prompts: Object.freeze([basicEvalPrompt]),
  }),
  Object.freeze({
    id: "empty-project.hierarchical-overview.single-turn",
    name: "Hierarchical overview · one turn",
    description: "Tests whether a broad overview uses a useful child layer without forcing every node to navigate.",
    prompts: Object.freeze([
      "Create a concise map of how a transformer language model is trained, from raw text through deployment. Keep the overview readable while preserving deeper technical detail where it belongs.",
    ]),
    requiredChecks: Object.freeze(["node-navigation"]),
  }),
  h3ProjectEvalCase,
]);

export const evalJudges = Object.freeze([
  Object.freeze({ id: "deterministic-graph-contract", name: "Deterministic graph contract" }),
  Object.freeze({ id: "simulated-user", name: "Screenshot-grounded simulated user" }),
]);

const deterministicJudgeId = "deterministic-graph-contract";
const simulatedUserJudgeId = "simulated-user";

function copy(value) {
  return structuredClone(value);
}

function summarize(run) {
  const byHarness = run.harnessConfigurationNames.map((name) => {
    const executions = run.executions.filter((execution) => execution.harnessConfigurationName === name);
    const finished = executions.filter((execution) => ["passed", "failed", "error"].includes(execution.status));
    const passed = executions.filter((execution) => execution.status === "passed").length;
    return { name, passed, total: executions.length, finished: finished.length };
  });
  const passed = run.executions.filter((execution) => execution.status === "passed").length;
  return { passed, total: run.executions.length, byHarness };
}

export class EvalService {
  constructor({
    stateFile,
    productSession,
    configurationPaths,
    onChanged = () => {},
    simulatedUserJudgeRunner = null,
    projectFixtureMaterializer = materializeH3ProjectFixture,
    workspaceGrader = gradeH3Workspace,
    acceptedTopologyBuilder = buildAcceptedReviewTopology,
    acceptedTopologyGrader = gradeAcceptedReviewTopology,
    platform = process.platform,
  }) {
    this.stateFile = stateFile;
    this.productSession = productSession;
    this.configurationPaths = configurationPaths;
    this.onChanged = onChanged;
    this.simulatedUserJudgeRunner = simulatedUserJudgeRunner;
    this.projectFixtureMaterializer = projectFixtureMaterializer;
    this.workspaceGrader = workspaceGrader;
    this.acceptedTopologyBuilder = acceptedTopologyBuilder;
    this.acceptedTopologyGrader = acceptedTopologyGrader;
    this.platform = platform;
    this.runs = [];
    this.configurations = new Map();
    this.running = new Map();
    this.persistTail = Promise.resolve();
  }

  async open() {
    this.configurations = await loadHarnessConfigurations(this.configurationPaths);
    try {
      const persisted = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (persisted?.schemaVersion === 1 && Array.isArray(persisted.runs)) this.runs = persisted.runs;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const run of this.runs) {
      if (run.status === "running" || run.status === "queued") {
        run.status = "interrupted";
        for (const execution of run.executions) {
          if (execution.status === "running" || execution.status === "queued") execution.status = "interrupted";
        }
      }
      for (const execution of run.executions || []) {
        for (const turn of execution.turns || []) {
          for (const judgeResult of turn.judgeResults || []) {
            if (judgeResult.status === "running" || judgeResult.status === "queued") {
              judgeResult.status = "partial";
              judgeResult.completedAt = new Date().toISOString();
              judgeResult.error ||= "Simulated-user review was interrupted before finalization.";
            }
          }
        }
      }
      if (["passed", "failed", "error", "interrupted"].includes(run.status) && !run.bundleRef) {
        await this.#writeRunBundle(run);
      }
    }
    await this.#persist();
    return this;
  }

  catalog() {
    return {
      cases: copy(evalCases),
      harnessConfigurations: [...this.configurations.values()].map((configuration) => ({
        name: configuration.name,
        implementation: configuration.implementation,
        settings: copy(configuration.settings),
      })),
      judges: copy(evalJudges.filter((judge) => (
        judge.id === deterministicJudgeId || this.simulatedUserJudgeRunner !== null
      ))),
    };
  }

  listRuns() {
    return copy(this.runs.map((run) => ({ ...run, summary: summarize(run) })));
  }

  getRun(runId) {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`Unknown test run: ${runId}`);
    return copy({ ...run, summary: summarize(run) });
  }

  async createRun(selection) {
    const testCaseIds = selection?.testCaseIds;
    const harnessConfigurationNames = selection?.harnessConfigurationNames;
    const judgeConfigurationName = selection?.judgeConfigurationName;
    if (!Array.isArray(testCaseIds) || testCaseIds.some((id) => !evalCases.some((item) => item.id === id))) {
      throw new Error("Test run contains an unknown test case.");
    }
    if (testCaseIds.includes(H3_PROJECT_CASE_ID) && this.platform !== "darwin") {
      throw new Error("The pinned h3 project case is local Mac only.");
    }
    if (judgeConfigurationName === simulatedUserJudgeId && this.simulatedUserJudgeRunner === null) {
      throw new Error("Simulated-user judge is not available in this EvalService.");
    }
    if (!evalJudges.some((judge) => judge.id === judgeConfigurationName)) {
      throw new Error("Unknown judge configuration.");
    }
    const id = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const plans = expandTestRun({
      testRunId: id,
      testCaseIds,
      harnessConfigurationNames,
      judgeConfiguration: { name: judgeConfigurationName },
    }, this.configurations);
    const run = {
      schemaVersion: 1,
      id,
      createdAt: new Date().toISOString(),
      completedAt: null,
      bundleRef: null,
      status: "queued",
      testCaseIds: [...testCaseIds],
      harnessConfigurationNames: [...harnessConfigurationNames],
      judgeConfigurationName,
      executions: plans.map((plan) => ({
        id: randomUUID(),
        testRunId: id,
        testCaseId: plan.testCaseId,
        harnessConfigurationName: plan.harnessConfigurationName,
        harnessConfiguration: plan.harnessConfiguration,
        harnessConfigurationDigest: plan.harnessConfigurationDigest,
        judgeConfiguration: plan.judgeConfiguration,
        status: "queued",
        threadIds: [],
        turns: [],
        checks: [],
        passed: null,
        error: null,
      })),
    };
    this.runs.unshift(run);
    await this.#changed();
    const operation = this.#run(run).catch(async (error) => {
      run.status = "error";
      run.completedAt = new Date().toISOString();
      run.error = error instanceof Error ? error.message : String(error);
      await this.#changed();
    }).finally(() => this.running.delete(id));
    this.running.set(id, operation);
    return this.getRun(id);
  }

  reviewContext(executionId) {
    for (const run of this.runs) {
      const selected = run.executions.find((execution) => execution.id === executionId);
      if (!selected) continue;
      const cases = run.testCaseIds.map((caseId) => {
        const definition = evalCases.find((candidate) => candidate.id === caseId);
        const execution = run.executions.find((candidate) => (
          candidate.testCaseId === caseId
          && candidate.harnessConfigurationName === selected.harnessConfigurationName
        ));
        const threadIds = execution?.threadIds || [];
        return {
          id: caseId,
          name: definition?.name || caseId,
          executionId: execution?.id || null,
          status: execution?.status || "missing",
          threadIds,
          threads: threadIds.map((threadId, index) => ({
            id: threadId,
            name: definition?.threads?.[index]?.name || definition?.name || caseId,
          })),
        };
      });
      return copy({
        runId: run.id,
        harnessConfigurationName: selected.harnessConfigurationName,
        selectedExecutionId: selected.id,
        selectedCaseId: selected.testCaseId,
        readOnly: true,
        cases,
      });
    }
    throw new Error(`Unknown execution: ${executionId}`);
  }

  async #run(run) {
    run.status = "running";
    await this.#changed();
    for (const execution of run.executions) {
      await this.#execute(execution);
      await this.#changed();
    }
    run.status = run.executions.some((execution) => execution.status === "error")
      ? "error"
      : run.executions.every((execution) => execution.status === "passed") ? "passed" : "failed";
    run.completedAt = new Date().toISOString();
    await this.#writeRunBundle(run);
    await this.#changed();
  }

  async #execute(execution) {
    execution.status = "running";
    execution.error = null;
    await this.#changed();
    const definition = evalCases.find((candidate) => candidate.id === execution.testCaseId);
    try {
      if (!definition) throw new Error(`Unknown test case: ${execution.testCaseId}`);
      const executedThreads = definition.id === H3_PROJECT_CASE_ID
        ? await this.#executeH3ProjectCase(execution, definition)
        : [await this.#executeStandaloneCase(execution, definition)];
      execution.threadIds = executedThreads.map(({ thread }) => thread.id);
      const interactions = executedThreads.flatMap(({ thread, threadDefinition, detail, workspaceChecks }) => (
        detail.interactions.map((interaction, threadTurnIndex) => ({
          thread,
          threadDefinition,
          interaction,
          threadTurnIndex,
          workspaceChecks: workspaceChecks.get(String(interaction.id)) || [],
        }))
      ));
      execution.turns = interactions.map(({ thread, threadDefinition, interaction, threadTurnIndex }, turnIndex) => ({
        threadId: thread.id,
        threadDefinitionId: threadDefinition?.id || null,
        interactionId: interaction.id,
        graphNodeId: interaction.graphNodeId,
        rootLayerId: interaction.completionOutput?.rootLayer?.layer?.id ?? null,
        permissionProfileId: interaction.permissionProfileId,
        effectiveExecutionDigest: interaction.effectiveExecutionDigest,
        effectivePermissionReceipt: copy(interaction.effectivePermissionReceipt),
        status: interaction.completionStatus,
        prompt: interaction.text,
        turnIndex,
        threadTurnIndex,
        deterministicChecks: [],
        deterministicPassed: false,
        judgeResults: [],
      }));
      const checks = [];
      for (const [turnIndex, executedTurn] of interactions.entries()) {
        const { interaction, threadDefinition, workspaceChecks } = executedTurn;
        const turn = execution.turns[turnIndex];
        const turnChecks = [];
        const checkPrefix = threadDefinition
          ? `${threadDefinition.id}:turn-${interaction.sequence}`
          : `turn-${interaction.sequence}`;
        if (interaction.completionStatus !== "accepted" || !interaction.completionOutput) {
          turnChecks.push({
            name: `${checkPrefix}:accepted`,
            passed: false,
            detail: interaction.completionError || `Turn ended as ${interaction.completionStatus}.`,
          });
        } else {
          turnChecks.push(...checkBasicOutput(interaction.completionOutput, interaction.graphNodeId).map((check) => ({
            ...check,
            name: `${checkPrefix}:${check.name}`,
          })));
          if (definition.requiredChecks?.includes("node-navigation")) {
            turnChecks.push(...checkNodeNavigation(interaction.completionOutput).map((check) => ({
              ...check,
              name: `${checkPrefix}:${check.name}`,
            })));
          }
          if (definition.id === H3_PROJECT_CASE_ID) {
            const requireGrandchild = threadDefinition?.id === "architecture";
            try {
              const topology = await this.acceptedTopologyBuilder({
                turnId: interaction.id,
                rootLayerId: interaction.completionOutput.rootLayer.layer.id,
                loadLayer: (layerId) => this.#productRequest(
                  `/api/threads/${encodeURIComponent(executedTurn.thread.id)}`
                    + `/interactions/${encodeURIComponent(interaction.id)}`
                    + `/layers/${encodeURIComponent(layerId)}`,
                ),
              });
              turnChecks.push(...this.acceptedTopologyGrader(topology, { requireGrandchild }).map((check) => ({
                ...check,
                name: `${checkPrefix}:${check.name}`,
              })));
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              turnChecks.push({
                name: `${checkPrefix}:graph:accepted-reachable-closure`,
                passed: false,
                detail,
              });
              if (requireGrandchild) {
                turnChecks.push({
                  name: `${checkPrefix}:graph:root-child-grandchild`,
                  passed: false,
                  detail,
                });
              }
            }
          }
        }
        if (definition.id === H3_PROJECT_CASE_ID) {
          const expectedProfileId = threadDefinition.permissionProfileId;
          turnChecks.push({
            name: `${checkPrefix}:permission-profile`,
            passed: interaction.permissionProfileId === expectedProfileId,
            detail: `Expected ${expectedProfileId}; product recorded ${interaction.permissionProfileId || "none"}.`,
          });
          turnChecks.push({
            name: `${checkPrefix}:effective-execution-receipt`,
            passed: typeof interaction.effectiveExecutionDigest === "string"
              && interaction.effectiveExecutionDigest.startsWith("sha256:")
              && interaction.effectivePermissionReceipt?.permissionProfileId === expectedProfileId,
            detail: interaction.effectiveExecutionDigest
              ? "The accepted turn records its effective execution identity and normalized permission receipt."
              : "The accepted turn is missing its effective execution identity.",
          });
          if (expectedProfileId === "full") {
            turnChecks.push({
              name: `${checkPrefix}:full-access-disclosure`,
              passed: interaction.effectivePermissionReceipt?.unconfinedHostAccess === true
                && typeof interaction.effectivePermissionReceipt?.disclosure === "string",
              detail: interaction.effectivePermissionReceipt?.disclosure || "Full access lacks the required host-confinement disclosure.",
            });
          }
        }
        turnChecks.push(...workspaceChecks.map((check) => ({
          ...check,
          name: `${checkPrefix}:${check.name}`,
        })));
        turn.deterministicChecks = turnChecks;
        turn.deterministicPassed = turnChecks.length > 0 && turnChecks.every((check) => check.passed);
        checks.push(...turnChecks);
      }
      execution.checks = checks;
      const deterministicPassed = checks.length > 0 && checks.every((check) => check.passed);
      let simulatedUserPassed = true;
      if (execution.judgeConfiguration.name === simulatedUserJudgeId) {
        const eligibleTurns = interactions
          .map(({ thread, interaction }, turnIndex) => ({ thread, interaction, turn: execution.turns[turnIndex] }))
          .filter(({ interaction, turn }) => (
            interaction.completionStatus === "accepted"
            && interaction.completionOutput
            && turn.deterministicPassed
          ));
        for (const [index, { thread, interaction, turn }] of eligibleTurns.entries()) {
          const result = await this.#judgeAcceptedTurn({
            execution,
            thread,
            interaction,
            turn,
            reviewSequence: { index, count: eligibleTurns.length },
          });
          if (result.status !== "completed" || result.passed === false) simulatedUserPassed = false;
        }
        if (eligibleTurns.length === 0) simulatedUserPassed = false;
      }
      execution.passed = deterministicPassed && simulatedUserPassed;
      execution.status = execution.passed ? "passed" : "failed";
    } catch (error) {
      execution.status = "error";
      execution.passed = false;
      execution.error = error instanceof Error ? error.message : String(error);
    }
  }

  async #executeStandaloneCase(execution, definition) {
    const thread = await this.#createAndRunThread({
      execution,
      title: definition.name,
      prompts: definition.prompts,
    });
    const detail = await this.#productRequest(`/api/threads/${thread.id}`);
    return { thread, threadDefinition: null, detail, workspaceChecks: new Map() };
  }

  async #executeH3ProjectCase(execution, definition) {
    const executionDirectory = join(
      dirname(this.stateFile),
      "runs",
      encodeURIComponent(execution.testRunId),
      "executions",
      encodeURIComponent(execution.id),
    );
    const workspaceDirectory = join(executionDirectory, "workspace");
    const fixture = await this.projectFixtureMaterializer({
      cacheDirectory: join(dirname(this.stateFile), "fixtures", `h3-${H3_UPSTREAM_COMMIT}`),
      workspaceDirectory,
      platform: this.platform,
    });
    const project = await this.#productRequest("/api/projects", {
      method: "POST",
      body: {
        name: `h3 eval · ${execution.id.slice(0, 8)}`,
        path: workspaceDirectory,
      },
    });
    execution.projectId = project.id;
    execution.fixture = copy(fixture);
    const executedThreads = [];
    for (const threadDefinition of definition.threads) {
      const workspaceChecks = new Map();
      const thread = await this.#createAndRunThread({
        execution,
        title: `${definition.name} · ${threadDefinition.name}`,
        prompts: threadDefinition.prompts,
        projectId: project.id,
        permissionProfileId: threadDefinition.permissionProfileId,
        afterTurn: async (interactionId, promptIndex) => {
          if (threadDefinition.mutationPolicy === "read-only" || promptIndex === threadDefinition.prompts.length - 1) {
            workspaceChecks.set(String(interactionId), await this.workspaceGrader({
              workspaceDirectory,
              grade: threadDefinition.workspaceGrade,
            }));
          }
        },
      });
      const detail = await this.#productRequest(`/api/threads/${thread.id}`);
      executedThreads.push({ thread, threadDefinition, detail, workspaceChecks });
    }
    return executedThreads;
  }

  async #createAndRunThread({ execution, title, prompts, projectId = null, permissionProfileId = "auto", afterTurn = async () => {} }) {
    if (!Array.isArray(prompts) || prompts.length === 0) throw new Error(`Eval thread ${title} has no prompts.`);
    const thread = await this.#productRequest("/api/threads", {
      method: "POST",
      body: {
        title,
        initialMessage: prompts[0],
        harnessConfigurationName: execution.harnessConfigurationName,
        permissionProfileId,
        ...(projectId === null ? {} : { projectId }),
      },
    });
    execution.threadIds.push(thread.id);
    await this.#waitForInteraction(thread.id, thread.rootInteractionId);
    await afterTurn(thread.rootInteractionId, 0);
    for (const [offset, prompt] of prompts.slice(1).entries()) {
      const interaction = await this.#productRequest(`/api/threads/${thread.id}/interactions`, {
        method: "POST",
        body: { text: prompt },
      });
      await this.#waitForInteraction(thread.id, interaction.id);
      await afterTurn(interaction.id, offset + 1);
    }
    return thread;
  }

  async #judgeAcceptedTurn({ execution, thread, interaction, turn, reviewSequence }) {
    const previousTurnIds = execution.turns
      .filter((candidate) => (
        String(candidate.threadId) === String(turn.threadId)
        && candidate.turnIndex < turn.turnIndex
      ))
      .map((candidate) => String(candidate.interactionId));
    const artifactDirectory = join(
      dirname(this.stateFile),
      "runs",
      encodeURIComponent(execution.testRunId),
      "executions",
      encodeURIComponent(execution.id),
      "turns",
      encodeURIComponent(String(interaction.id)),
      simulatedUserJudgeId,
    );
    await mkdir(artifactDirectory, { recursive: true });
    const judgeResult = {
      schemaVersion: 1,
      id: randomUUID(),
      judge: simulatedUserJudgeId,
      status: "running",
      passed: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      artifactDirectory,
      artifactAuthority: "references",
      rubricVersion: DEFAULT_SIMULATED_USER_RUBRIC.rubricVersion,
      judgeConfiguration: copy(execution.judgeConfiguration),
      references: emptyJudgeReferences(),
      review: null,
      coverage: null,
      summary: null,
      error: null,
    };
    turn.judgeResults.push(judgeResult);
    await this.#changed();

    try {
      const context = {
        schemaVersion: 1,
        artifactDirectory,
        execution: {
          id: execution.id,
          testRunId: execution.testRunId,
          testCaseId: execution.testCaseId,
          harnessConfigurationName: execution.harnessConfigurationName,
          harnessConfigurationDigest: execution.harnessConfigurationDigest,
        },
        thread: { id: String(thread.id) },
        turn: {
          id: String(interaction.id),
          turnIndex: turn.turnIndex,
          sequence: interaction.sequence,
          graphNodeId: interaction.graphNodeId,
          rootLayerId: interaction.completionOutput?.rootLayer?.layer?.id ?? null,
          status: interaction.completionStatus,
        },
        reviewSequence: copy(reviewSequence),
        request: {
          text: interaction.text,
          followUp: previousTurnIds.length > 0,
          previousTurnIds,
          comparisonTurnIds: previousTurnIds.slice(-1),
        },
        rubric: copy(DEFAULT_SIMULATED_USER_RUBRIC),
        judgeConfiguration: copy(execution.judgeConfiguration),
      };
      const output = await invokeSimulatedUserJudge(this.simulatedUserJudgeRunner, context);
      Object.assign(judgeResult, normalizeJudgeOutput(output, judgeResult));
    } catch (error) {
      judgeResult.status = "failed";
      judgeResult.passed = false;
      judgeResult.error = error instanceof Error ? error.message : String(error);
    }
    judgeResult.completedAt = new Date().toISOString();
    await this.#changed();
    return judgeResult;
  }

  async #waitForInteraction(threadId, interactionId) {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const detail = await this.#productRequest(`/api/threads/${threadId}`);
      const interaction = detail.interactions.find((candidate) => candidate.id === interactionId);
      if (!interaction) throw new Error(`Product interaction ${interactionId} disappeared.`);
      if (!["not_started", "running", "submitted"].includes(interaction.completionStatus)) return interaction;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    throw new Error(`Product interaction ${interactionId} did not finish within 10 minutes.`);
  }

  async #productRequest(path, options = {}) {
    const response = await fetch(new URL(path, this.productSession.origin), {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        Cookie: `${this.productSession.cookie.name}=${this.productSession.cookie.value}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value?.error || `Product request failed (${response.status}).`);
    return value;
  }

  async #changed() {
    await this.#persist();
    this.onChanged(this.listRuns());
  }

  #persist() {
    const serialized = `${JSON.stringify({ schemaVersion: 1, runs: this.runs }, null, 2)}\n`;
    const operation = this.persistTail.then(() => this.#writeState(serialized));
    this.persistTail = operation.catch(() => undefined);
    return operation;
  }

  async #writeState(serialized) {
    await mkdir(dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.stateFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #writeRunBundle(run) {
    if (run.bundleRef) return;
    const bundleRef = ["runs", encodeURIComponent(run.id), "bundle.json"].join("/");
    const bundleFile = join(dirname(this.stateFile), ...bundleRef.split("/"));
    const bundle = {
      bundleSchemaVersion: 1,
      kind: "relayer_eval_run_bundle",
      testRunId: run.id,
      run: { ...copy(run), bundleRef },
    };
    await mkdir(dirname(bundleFile), { recursive: true });
    try {
      await writeFile(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(bundleFile, "utf8"));
      if (existing?.kind !== "relayer_eval_run_bundle" || existing?.testRunId !== run.id) {
        throw new Error(`Immutable Eval bundle conflicts with test run ${run.id}.`);
      }
    }
    run.bundleRef = bundleRef;
  }
}

async function invokeSimulatedUserJudge(runner, context) {
  if (typeof runner === "function") return runner(copy(context));
  if (runner && typeof runner.run === "function") return runner.run(copy(context));
  throw new Error("Simulated-user judge runner must be a function or expose run(context).");
}

function normalizeJudgeOutput(output, initial) {
  if (!output || !["completed", "partial", "failed"].includes(output.status)) {
    return {
      status: "failed",
      passed: false,
      error: "Simulated-user judge returned an invalid status.",
    };
  }
  const references = {
    rubric: optionalReference(output.rubricRef),
    configuration: optionalReference(output.configurationRef),
    interactionTrace: optionalReference(output.interactionTraceRef),
    screenshots: Array.isArray(output.screenshotRefs)
      ? output.screenshotRefs.filter((reference) => typeof reference === "string" && reference.length > 0)
      : [],
    reviews: optionalReference(output.reviewRef),
    coverage: optionalReference(output.coverageRef),
  };
  const requiredReferences = [
    references.rubric,
    references.configuration,
    references.interactionTrace,
    references.reviews,
    references.coverage,
  ];
  const completeReferences = requiredReferences.every((reference) => reference !== null)
    && references.screenshots.length > 0;
  const requestedStatus = output.status;
  const status = requestedStatus === "completed" && !completeReferences ? "partial" : requestedStatus;
  const missingReferenceError = requestedStatus === "completed" && !completeReferences
    ? "Completed simulated-user review omitted one or more immutable artifact references."
    : null;
  return {
    status,
    passed: status === "completed" ? output.passed !== false : false,
    rubricVersion: initial.rubricVersion,
    judgeConfiguration: copy(initial.judgeConfiguration),
    references,
    review: output.review && typeof output.review === "object" ? copy(output.review) : null,
    coverage: output.coverage && typeof output.coverage === "object" ? copy(output.coverage) : null,
    summary: typeof output.summary === "string" ? output.summary : null,
    error: missingReferenceError
      ?? (typeof output.error === "string" && output.error.length > 0
        ? output.error
        : status === "partial" ? "Simulated-user review ended without finalization."
          : status === "failed" ? "Simulated-user judge reported failure."
            : null),
  };
}

function optionalReference(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function emptyJudgeReferences() {
  return {
    rubric: null,
    configuration: null,
    interactionTrace: null,
    screenshots: [],
    reviews: null,
    coverage: null,
  };
}
