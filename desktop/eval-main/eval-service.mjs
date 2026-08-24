import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

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
  selectStandalonePermissionProfile,
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
  Object.freeze({ id: "simulated-user-sol-high", name: "Screenshot-grounded simulated user · Sol high" }),
]);

const deterministicJudgeId = "deterministic-graph-contract";
const simulatedUserJudgeId = "simulated-user";
const simulatedUserJudgeIds = new Set([simulatedUserJudgeId, "simulated-user-sol-high"]);
const MAX_CONVERSATION_IMPORT_BYTES = 256 * 1024 * 1024;

function copy(value) {
  return structuredClone(value);
}

function summarize(run) {
  if (run.kind === "imported-conversation") {
    const finished = run.executions.filter((execution) => ["passed", "failed", "error"].includes(execution.status));
    const passed = run.executions.filter((execution) => execution.status === "passed").length;
    return {
      passed,
      total: run.executions.length,
      byHarness: [{ name: "External conversation", passed, total: run.executions.length, finished: finished.length }],
    };
  }
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
    candidateTraceExporter = null,
    candidateTraceRequired = false,
    conversationImportEnabled = false,
    conversationImportMaxBytes = MAX_CONVERSATION_IMPORT_BYTES,
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
    this.candidateTraceExporter = candidateTraceExporter;
    this.candidateTraceRequired = candidateTraceRequired;
    this.conversationImportEnabled = conversationImportEnabled;
    this.conversationImportMaxBytes = conversationImportMaxBytes;
    this.platform = platform;
    this.runs = [];
    this.configurations = new Map();
    this.running = new Map();
    this.persistTail = Promise.resolve();
  }

  async open() {
    this.configurations = await loadHarnessConfigurations(this.configurationPaths);
    await rm(join(dirname(this.stateFile), "import-staging"), { recursive: true, force: true });
    try {
      const persisted = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (persisted?.schemaVersion === 1 && Array.isArray(persisted.runs)) this.runs = persisted.runs;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (this.conversationImportEnabled) {
      const publishedImports = await this.#productRequest("/api/internal/conversation-imports");
      for (const receipt of publishedImports.imports || []) {
        if (!this.runs.some((run) => run.importId === receipt.importId)) {
          this.runs.unshift(importedRun(receipt, true));
        }
      }
      await this.#reconcilePendingImportDirectories(publishedImports.imports || []);
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

  async judgeImportedConversation(executionId, judgeConfigurationName) {
    const located = this.#findExecution(executionId);
    if (located.run.kind !== "imported-conversation" || located.execution.kind !== "imported-conversation") {
      throw new Error("Only imported conversation executions can use this judge action.");
    }
    if (!evalJudges.some((judge) => judge.id === judgeConfigurationName)) {
      throw new Error("Unknown judge configuration.");
    }
    if (simulatedUserJudgeIds.has(judgeConfigurationName) && this.simulatedUserJudgeRunner === null) {
      throw new Error("Simulated-user judge is not available in this EvalService.");
    }
    if (this.running.has(located.run.id)) throw new Error("This imported conversation is already being judged.");

    const operation = this.#judgeImportedExecution({
      ...located,
      judgeConfigurationName,
    }).finally(() => this.running.delete(located.run.id));
    this.running.set(located.run.id, operation);
    await operation;
    return this.getRun(located.run.id);
  }

  #findExecution(executionId) {
    for (const run of this.runs) {
      const execution = run.executions.find((candidate) => candidate.id === executionId);
      if (execution) return { run, execution };
    }
    throw new Error(`Unknown execution: ${executionId}`);
  }

  async candidateTraceContext(executionId, interactionId) {
    for (const run of this.runs) {
      const execution = run.executions.find((candidate) => candidate.id === executionId);
      if (!execution) continue;
      const turn = interactionId === undefined || interactionId === null
        ? execution.turns[0]
        : execution.turns.find((candidate) => String(candidate.interactionId) === String(interactionId));
      if (!turn) throw new Error(`Unknown Eval turn: ${interactionId}`);
      const expectedRef = [
        "executions",
        encodeURIComponent(execution.id),
        "turns",
        encodeURIComponent(String(turn.interactionId)),
        "candidate-trace",
        "manifest.json",
      ].join("/");
      if (turn.candidateTrace?.ref !== expectedRef) {
        return { execution: copy(execution), turn: copy(turn), manifest: null, events: [] };
      }
      const directory = join(dirname(this.stateFile), "runs", encodeURIComponent(run.id), ...expectedRef.split("/").slice(0, -1));
      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      const events = (await readFile(join(directory, "events.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      return {
        run: { id: run.id },
        execution: {
          id: execution.id,
          testCaseId: execution.testCaseId,
          harnessConfigurationName: execution.harnessConfigurationName,
          turns: execution.turns.map((candidate) => ({
            interactionId: candidate.interactionId,
            turnIndex: candidate.turnIndex,
            prompt: candidate.prompt,
            candidateTrace: copy(candidate.candidateTrace),
          })),
        },
        turn: copy(turn),
        manifest,
        events,
      };
    }
    throw new Error(`Unknown execution: ${executionId}`);
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
    if (simulatedUserJudgeIds.has(judgeConfigurationName) && this.simulatedUserJudgeRunner === null) {
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
    for (const plan of plans) validateEvalPermissionProfiles(plan);
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
        candidateTraceCaptures: {},
        checks: [],
        passed: null,
        promotable: true,
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

  async importConversation(sourcePath) {
    if (!this.conversationImportEnabled) throw new Error("Conversation import is not enabled.");
    if (typeof sourcePath !== "string" || !sourcePath) throw new Error("Conversation import requires a JSONL file path.");
    const stagingDirectory = join(dirname(this.stateFile), "import-staging");
    const stagedSource = join(stagingDirectory, `${randomUUID()}.jsonl`);
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    await stageBoundedSource(sourcePath, stagedSource, this.conversationImportMaxBytes);
    let receipt;
    try {
      const response = await fetch(new URL("/api/internal/conversation-imports", this.productSession.origin), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-ndjson",
          Cookie: `${this.productSession.cookie.name}=${this.productSession.cookie.value}`,
        },
        body: createReadStream(stagedSource),
        duplex: "half",
      });
      receipt = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(receipt?.error || `Conversation import failed (${response.status}).`);
    } catch (error) {
      await rm(stagedSource, { force: true });
      throw error;
    }
    const run = importedRun({
      importId: receipt.importId,
      sourceSha256: receipt.sourceSha256,
      header: { conversation: { title: receipt.title }, producer: receipt.producer },
      threadId: receipt.threadId,
      turns: receipt.turns.map((turn) => ({
        sourceTurnId: turn.sourceTurnId,
        interactionId: turn.interactionId,
        graphNodeId: turn.graphNodeId,
        completionStatus: turn.completionStatus,
      })),
    });
    const sourceRef = ["runs", encodeURIComponent(run.id), "conversation.jsonl"].join("/");
    const sourceFile = join(dirname(this.stateFile), ...sourceRef.split("/"));
    const pendingMarker = join(dirname(sourceFile), "pending-import.json");
    try {
      await mkdir(dirname(sourceFile), { recursive: true });
      await link(stagedSource, sourceFile);
      await rm(stagedSource, { force: true });
      run.sourceRef = sourceRef;
      await this.#writeRunBundle(run);
      await writeFile(pendingMarker, `${JSON.stringify({ importId: receipt.importId })}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      await this.#removeStagedImport(receipt.importId).catch(() => undefined);
      await rm(stagedSource, { force: true });
      await rm(dirname(sourceFile), { recursive: true, force: true });
      throw error;
    }
    let publish;
    try {
      publish = await fetch(new URL("/api/internal/conversation-imports", this.productSession.origin), {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: `${this.productSession.cookie.name}=${this.productSession.cookie.value}` },
        body: JSON.stringify({ importId: receipt.importId }),
      });
    } catch (error) {
      const published = await this.#findPublishedImport(receipt.importId);
      if (!published) {
        try {
          await this.#removeStagedImport(receipt.importId);
        } catch (cleanupError) {
          const publishedAfterCleanup = await this.#findPublishedImport(receipt.importId);
          if (!publishedAfterCleanup) throw cleanupError;
          publish = new Response(null, { status: 200 });
        }
        if (!publish) {
          await rm(dirname(sourceFile), { recursive: true, force: true });
          throw error;
        }
      } else {
        publish = new Response(null, { status: 200 });
      }
    }
    if (!publish.ok) {
      const detail = await publish.json().catch(() => ({}));
      await this.#removeStagedImport(receipt.importId).catch(() => undefined);
      await rm(dirname(sourceFile), { recursive: true, force: true });
      throw new Error(detail?.error || `Conversation publication failed (${publish.status}).`);
    }
    await rm(pendingMarker, { force: true });
    this.runs.unshift(run);
    await this.#changed();
    return this.getRun(run.id);
  }

  async #removeStagedImport(importId) {
    const response = await fetch(new URL("/api/internal/conversation-imports", this.productSession.origin), {
      method: "DELETE",
      headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: `${this.productSession.cookie.name}=${this.productSession.cookie.value}` },
      body: JSON.stringify({ importId }),
    });
    if (!response.ok) throw new Error(`Conversation import cleanup failed (${response.status}).`);
  }

  async #findPublishedImport(importId) {
    const value = await this.#productRequest("/api/internal/conversation-imports");
    return (value.imports || []).find((item) => item.importId === importId) || null;
  }

  async #reconcilePendingImportDirectories(publishedImports) {
    const runsDirectory = join(dirname(this.stateFile), "runs");
    let entries;
    try {
      entries = await readdir(runsDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const publishedIds = new Set(publishedImports.map((item) => item.importId));
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("import-")) continue;
      const directory = join(runsDirectory, entry.name);
      const marker = join(directory, "pending-import.json");
      let pending;
      try {
        pending = JSON.parse(await readFile(marker, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (publishedIds.has(pending.importId)) {
        await rm(marker, { force: true });
      } else {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }

  reviewContext(executionId) {
    for (const run of this.runs) {
      const selected = run.executions.find((execution) => execution.id === executionId);
      if (!selected) continue;
      const caseIds = run.kind === "imported-conversation"
        ? ["external-conversation"]
        : run.testCaseIds;
      const cases = caseIds.map((caseId) => {
        const definition = evalCases.find((candidate) => candidate.id === caseId);
        const execution = run.kind === "imported-conversation"
          ? selected
          : run.executions.find((candidate) => (
            candidate.testCaseId === caseId
            && candidate.harnessConfigurationName === selected.harnessConfigurationName
          ));
        const threadIds = execution?.threadIds || [];
        const name = run.kind === "imported-conversation"
          ? selected.title || run.title || "Imported conversation"
          : definition?.name || caseId;
        return {
          id: caseId,
          name,
          executionId: execution?.id || null,
          status: execution?.status || "missing",
          threadIds,
          threads: threadIds.map((threadId, index) => ({
            id: threadId,
            name: definition?.threads?.[index]?.name || name,
          })),
        };
      });
      return copy({
        runId: run.id,
        harnessConfigurationName: selected.harnessConfigurationName,
        selectedExecutionId: selected.id,
        selectedCaseId: run.kind === "imported-conversation" ? null : selected.testCaseId,
        readOnly: true,
        origin: copy(selected.origin || run.origin || { kind: "local-eval" }),
        cases,
      });
    }
    throw new Error(`Unknown execution: ${executionId}`);
  }

  async #judgeImportedExecution({ run, execution, judgeConfigurationName }) {
    run.status = "judging";
    run.judgeConfigurationName = judgeConfigurationName;
    execution.status = "judging";
    execution.judgeConfiguration = { name: judgeConfigurationName };
    execution.error = null;
    await this.#changed();

    try {
      const threadId = execution.threadIds?.[0];
      if (threadId == null) throw new Error("Imported execution has no product thread.");
      const detail = await this.#productRequest(`/api/threads/${encodeURIComponent(threadId)}`);
      if (detail.thread?.imported !== true) {
        throw new Error("The product thread is not server-authored imported state.");
      }
      const interactions = new Map((detail.interactions || []).map((interaction) => [String(interaction.id), interaction]));
      const accepted = [];
      const checks = [];
      for (const turn of execution.turns) {
        const interaction = interactions.get(String(turn.interactionId));
        if (!interaction) throw new Error(`Imported product turn ${turn.interactionId} is missing.`);
        turn.threadId = detail.thread.id;
        turn.prompt = interaction.text;
        turn.rootLayerId = interaction.completionOutput?.rootLayer?.layer?.id ?? null;
        turn.status = interaction.completionStatus;
        turn.graphNodeId = interaction.graphNodeId;
        turn.judgeEligible = interaction.completionStatus === "accepted" && Boolean(interaction.completionOutput);
        turn.deterministicChecks = [];
        turn.deterministicPassed = null;
        turn.deterministicJudge = null;
        if (!turn.judgeEligible) continue;

        const prefix = `turn-${interaction.sequence}`;
        const turnChecks = checkBasicOutput(
          interaction.completionOutput,
          interaction.graphNodeId,
          { allowLegacyLayout: true },
        ).map((check) => ({
          ...check,
          name: `${prefix}:${check.name}`,
        }));
        try {
          const topology = await this.acceptedTopologyBuilder({
            turnId: interaction.id,
            rootLayerId: interaction.completionOutput.rootLayer.layer.id,
            loadLayer: (layerId) => this.#productRequest(
              `/api/threads/${encodeURIComponent(detail.thread.id)}`
                + `/interactions/${encodeURIComponent(interaction.id)}`
                + `/layers/${encodeURIComponent(layerId)}`,
            ),
          });
          turnChecks.push(...this.acceptedTopologyGrader(topology).map((check) => ({
            ...check,
            name: `${prefix}:${check.name}`,
          })));
        } catch (error) {
          turnChecks.push({
            name: `${prefix}:graph:accepted-reachable-closure`,
            passed: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        turn.deterministicChecks = turnChecks;
        turn.deterministicPassed = turnChecks.length > 0 && turnChecks.every((check) => check.passed);
        const provenance = importedJudgeProvenance(run, turn);
        turn.deterministicJudge = {
          schemaVersion: 1,
          judge: deterministicJudgeId,
          status: "completed",
          passed: turn.deterministicPassed,
          completedAt: new Date().toISOString(),
          provenance,
          checks: copy(turnChecks),
        };
        checks.push(...turnChecks);
        accepted.push({ thread: detail.thread, interaction, turn, provenance });
      }
      if (accepted.length === 0) throw new Error("This imported conversation has no accepted turns eligible for result judging.");

      execution.checks = checks;
      let passed = accepted.every(({ turn }) => turn.deterministicPassed);
      if (simulatedUserJudgeIds.has(judgeConfigurationName)) {
        const eligible = accepted.filter(({ turn }) => turn.deterministicPassed);
        for (const [index, candidate] of eligible.entries()) {
          const result = await this.#judgeAcceptedTurn({
            execution,
            ...candidate,
            reviewSequence: { index, count: eligible.length },
          });
          if (result.status !== "completed" || result.passed === false) passed = false;
        }
        if (eligible.length === 0) passed = false;
      }
      execution.passed = passed;
      execution.status = passed ? "passed" : "failed";
      run.status = execution.status;
      run.completedAt = new Date().toISOString();
      await this.#writeImportedJudgeArtifact(run, execution);
      await this.#changed();
    } catch (error) {
      execution.status = "error";
      execution.passed = false;
      execution.error = error instanceof Error ? error.message : String(error);
      run.status = "error";
      run.completedAt = new Date().toISOString();
      await this.#writeImportedJudgeArtifact(run, execution);
      await this.#changed();
      throw error;
    }
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
      const interactions = executedThreads.flatMap(({ thread, threadDefinition, permissionResolution, detail, workspaceChecks }) => (
        detail.interactions.map((interaction, threadTurnIndex) => ({
          thread,
          threadDefinition,
          permissionResolution,
          interaction,
          threadTurnIndex,
          workspaceChecks: workspaceChecks.get(String(interaction.id)) || [],
        }))
      ));
      execution.turns = interactions.map(({ thread, threadDefinition, permissionResolution, interaction, threadTurnIndex }, turnIndex) => ({
        threadId: thread.id,
        threadDefinitionId: threadDefinition?.id || null,
        interactionId: interaction.id,
        graphNodeId: interaction.graphNodeId,
        rootLayerId: interaction.completionOutput?.rootLayer?.layer?.id ?? null,
        permissionProfileId: interaction.permissionProfileId,
        requestedPermissionProfileId: permissionResolution?.requestedProfileId ?? interaction.permissionProfileId,
        permissionProfileOverride: permissionResolution?.overridden
          ? copy(permissionResolution)
          : null,
        effectiveExecutionDigest: interaction.effectiveExecutionDigest,
        effectivePermissionReceipt: copy(interaction.effectivePermissionReceipt),
        status: interaction.completionStatus,
        prompt: interaction.text,
        turnIndex,
        threadTurnIndex,
        deterministicChecks: [],
        deterministicPassed: false,
        judgeResults: [],
        candidateTrace: copy(execution.candidateTraceCaptures?.[String(interaction.id)] || disabledCandidateTrace()),
      }));
      delete execution.candidateTraceCaptures;
      execution.promotable = execution.turns.every((turn) => !this.candidateTraceRequired || turn.candidateTrace.status === "complete");
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
              turnChecks.push(...this.acceptedTopologyGrader(topology).map((check) => ({
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
            }
          }
        }
        if (definition.id === H3_PROJECT_CASE_ID) {
          const permissionResolution = executedTurn.permissionResolution;
          const expectedProfileId = permissionResolution.effectiveProfileId;
          turnChecks.push({
            name: `${checkPrefix}:permission-profile`,
            passed: interaction.permissionProfileId === expectedProfileId,
            detail: permissionResolution.overridden
              ? `The case requested ${permissionResolution.requestedProfileId}; ${execution.harnessConfigurationName} explicitly used ${expectedProfileId}. Product recorded ${interaction.permissionProfileId || "none"}.`
              : `Expected ${expectedProfileId}; product recorded ${interaction.permissionProfileId || "none"}.`,
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
      if (simulatedUserJudgeIds.has(execution.judgeConfiguration.name)) {
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
      permissionProfileId: selectStandalonePermissionProfile(execution.harnessConfiguration),
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
    execution.permissionProfileResolutions = definition.threads.map((threadDefinition) => ({
      threadDefinitionId: threadDefinition.id,
      ...resolveH3PermissionProfile(execution.harnessConfiguration, threadDefinition.permissionProfileId),
    }));
    const executedThreads = [];
    for (const [threadIndex, threadDefinition] of definition.threads.entries()) {
      const workspaceChecks = new Map();
      const permissionResolution = execution.permissionProfileResolutions[threadIndex];
      const thread = await this.#createAndRunThread({
        execution,
        title: `${definition.name} · ${threadDefinition.name}`,
        prompts: threadDefinition.prompts,
        projectId: project.id,
        permissionProfileId: permissionResolution.effectiveProfileId,
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
      executedThreads.push({ thread, threadDefinition, permissionResolution, detail, workspaceChecks });
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
    const rootInteraction = await this.#waitForInteraction(thread.id, thread.rootInteractionId);
    await this.#captureCandidateTrace(execution, rootInteraction);
    await afterTurn(thread.rootInteractionId, 0);
    for (const [offset, prompt] of prompts.slice(1).entries()) {
      const interaction = await this.#productRequest(`/api/threads/${thread.id}/interactions`, {
        method: "POST",
        body: { text: prompt },
      });
      const completedInteraction = await this.#waitForInteraction(thread.id, interaction.id);
      await this.#captureCandidateTrace(execution, completedInteraction);
      await afterTurn(interaction.id, offset + 1);
    }
    return thread;
  }

  async #judgeAcceptedTurn({ execution, thread, interaction, turn, reviewSequence, provenance = null }) {
    const judgeConfigurationId = execution.judgeConfiguration.name;
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
      judgeConfigurationId,
    );
    await mkdir(artifactDirectory, { recursive: true });
    const judgeResult = {
      schemaVersion: 1,
      id: randomUUID(),
      judge: judgeConfigurationId,
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
      ...(provenance === null ? {} : { provenance: copy(provenance) }),
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
        ...(provenance === null ? {} : { provenance: copy(provenance) }),
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

  async #captureCandidateTrace(execution, interaction) {
    if (this.candidateTraceExporter === null) {
      execution.candidateTraceCaptures ||= {};
      execution.candidateTraceCaptures[String(interaction.id)] = disabledCandidateTrace();
      await this.#changed();
      return;
    }
    const ref = [
      "executions",
      encodeURIComponent(execution.id),
      "turns",
      encodeURIComponent(String(interaction.id)),
      "candidate-trace",
      "manifest.json",
    ].join("/");
    const targetDirectory = join(
      dirname(this.stateFile),
      "runs",
      encodeURIComponent(execution.testRunId),
      ...ref.split("/").slice(0, -1),
    );
    try {
      const descriptor = await this.candidateTraceExporter(interaction.id, targetDirectory, {
        runId: execution.testRunId,
        executionId: execution.id,
        interactionId: String(interaction.id),
        harnessConfigurationName: execution.harnessConfigurationName,
        model: candidateModel(execution.harnessConfiguration),
      });
      execution.candidateTraceCaptures ||= {};
      execution.candidateTraceCaptures[String(interaction.id)] = {
        ...copy(descriptor),
        ref,
        promotable: descriptor.status === "complete",
      };
    } catch (error) {
      execution.candidateTraceCaptures ||= {};
      execution.candidateTraceCaptures[String(interaction.id)] = {
        status: "failed",
        format: "relayer-harness-trace-v1",
        coverage: emptyTraceCoverage(),
        error: error instanceof Error ? error.message : String(error),
        ref: null,
        promotable: false,
      };
    }
    await this.#changed();
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

  async #writeImportedJudgeArtifact(run, execution) {
    const artifactId = `judge-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const artifactRef = [
      "runs",
      encodeURIComponent(run.id),
      "judges",
      `${artifactId}.json`,
    ].join("/");
    const artifactFile = join(dirname(this.stateFile), ...artifactRef.split("/"));
    const temporary = `${artifactFile}.${process.pid}.${randomUUID()}.tmp`;
    const artifact = {
      schemaVersion: 1,
      kind: "relayer_imported_conversation_judge",
      id: artifactId,
      createdAt: new Date().toISOString(),
      runId: run.id,
      executionId: execution.id,
      judgeConfigurationName: run.judgeConfigurationName,
      source: {
        kind: "external-conversation-export",
        importId: run.importId,
        sourceSha256: run.sourceSha256,
        producer: copy(run.producer || {}),
        sourceRef: run.sourceRef,
        importBundleRef: run.bundleRef,
      },
      execution: copy(execution),
    };
    await mkdir(dirname(artifactFile), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, artifactFile);
    } finally {
      await rm(temporary, { force: true });
    }
    run.judgeArtifacts ||= [];
    run.judgeArtifacts.push({
      id: artifactId,
      ref: artifactRef,
      judgeConfigurationName: run.judgeConfigurationName,
      createdAt: artifact.createdAt,
    });
    execution.latestJudgeArtifactRef = artifactRef;
  }
}

export async function stageBoundedSource(sourcePath, targetPath, limit, { afterOpen } = {}) {
  const source = await open(sourcePath, "r");
  let total = 0;
  try {
    const metadata = await source.stat();
    if (!metadata.isFile() || metadata.size > limit) {
      throw new Error("Conversation export exceeds the 256 MiB import limit.");
    }
    await afterOpen?.(source);
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        total += chunk.length;
        if (total > limit) {
          callback(new Error("Conversation export exceeds the 256 MiB import limit."));
        } else {
          callback(null, chunk);
        }
      },
    });
    await pipeline(
      source.createReadStream({ autoClose: false }),
      limiter,
      createWriteStream(targetPath, { flags: "wx", mode: 0o600 }),
    );
    return total;
  } catch (error) {
    await rm(targetPath, { force: true });
    throw error;
  } finally {
    await source.close();
  }
}

function importedRun(receipt, recovered = false) {
  const id = `import-${receipt.importId}`;
  const executionId = `execution-${receipt.importId}`;
  const title = receipt.header?.conversation?.title || "Imported conversation";
  const turns = (receipt.turns || []).map((turn, index) => ({
    threadId: receipt.threadId,
    interactionId: turn.interactionId,
    sourceTurnId: turn.sourceTurnId,
    turnIndex: index,
    prompt: null,
    status: turn.completionStatus,
    graphNodeId: turn.graphNodeId,
    rootLayerId: null,
    deterministicPassed: null,
    deterministicJudge: null,
    judgeEligible: turn.completionStatus === "accepted",
    judgeResults: [],
    candidateTrace: null,
  }));
  return {
    schemaVersion: 1,
    kind: "imported-conversation",
    importId: receipt.importId,
    sourceSha256: receipt.sourceSha256,
    producer: copy(receipt.header?.producer || {}),
    origin: {
      kind: "external-conversation-export",
      importId: receipt.importId,
      sourceSha256: receipt.sourceSha256,
    },
    id,
    title,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    bundleRef: recovered ? ["runs", encodeURIComponent(id), "bundle.json"].join("/") : null,
    sourceRef: recovered ? ["runs", encodeURIComponent(id), "conversation.jsonl"].join("/") : null,
    status: "imported",
    testCaseIds: [],
    harnessConfigurationNames: [],
    judgeConfigurationName: null,
    executions: [{
      kind: "imported-conversation",
      id: executionId,
      testRunId: id,
      testCaseId: "external-conversation",
      harnessConfigurationName: null,
      harnessConfiguration: null,
      harnessConfigurationDigest: null,
      judgeConfiguration: null,
      origin: {
        kind: "external-conversation-export",
        importId: receipt.importId,
        sourceSha256: receipt.sourceSha256,
      },
      status: "imported",
      threadIds: [receipt.threadId],
      turns,
      checks: [],
      passed: null,
      promotable: false,
      error: null,
      title,
    }],
  };
}

function importedJudgeProvenance(run, turn) {
  return {
    kind: "external-conversation-export",
    importId: run.importId,
    sourceSha256: run.sourceSha256,
    sourceTurnId: turn.sourceTurnId,
    producer: copy(run.producer || {}),
  };
}

function emptyTraceCoverage() {
  return {
    prompt: "none",
    messages: "none",
    reasoningSummaries: "none",
    modelCalls: "none",
    toolCalls: "none",
    usage: "none",
    childStreams: "none",
    nativeArtifacts: "none",
  };
}

function disabledCandidateTrace() {
  return {
    status: "disabled",
    format: "relayer-harness-trace-v1",
    coverage: emptyTraceCoverage(),
    ref: null,
    promotable: true,
  };
}

function candidateModel(configuration) {
  const model = configuration?.settings?.model;
  if (typeof model === "string") return model;
  if (model && typeof model.provider === "string" && typeof model.id === "string") return `${model.provider}/${model.id}`;
  return undefined;
}

function validateEvalPermissionProfiles(execution) {
  if (execution.testCaseId !== H3_PROJECT_CASE_ID) {
    selectStandalonePermissionProfile(execution.harnessConfiguration);
    return;
  }
  for (const thread of h3ProjectEvalCase.threads) {
    resolveH3PermissionProfile(execution.harnessConfiguration, thread.permissionProfileId);
  }
}

export function resolveH3PermissionProfile(configuration, requestedProfileId) {
  const profiles = Object.keys(configuration.permissionBindings);
  if (profiles.includes(requestedProfileId)) {
    return {
      requestedProfileId,
      effectiveProfileId: requestedProfileId,
      overridden: false,
      reason: null,
    };
  }
  if (profiles.length === 1 && profiles[0] === "full") {
    return {
      requestedProfileId,
      effectiveProfileId: "full",
      overridden: true,
      reason: "Harness supports only Full access; the local Eval fixture is disposable and the unrestricted authority is recorded.",
    };
  }
  throw new Error(
    `Eval case ${H3_PROJECT_CASE_ID} requests permission profile ${requestedProfileId}, which is not supported by ${configuration.name}. Only an explicit sole Full access binding may override an H3 case profile.`,
  );
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
