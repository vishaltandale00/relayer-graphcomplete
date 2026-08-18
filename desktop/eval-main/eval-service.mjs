import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  basicEvalCaseId,
  basicEvalFollowUpPrompt,
  basicEvalPrompt,
  checkNodeNavigation,
  checkBasicOutput,
  expandTestRun,
} from "@relayer/eval-runner";
import { loadHarnessConfigurations } from "@relayer/harness-host";

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
]);

export const evalJudges = Object.freeze([
  Object.freeze({ id: "deterministic-graph-contract", name: "Deterministic graph contract" }),
]);

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
  constructor({ stateFile, productSession, configurationPaths, onChanged = () => {} }) {
    this.stateFile = stateFile;
    this.productSession = productSession;
    this.configurationPaths = configurationPaths;
    this.onChanged = onChanged;
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
      judges: copy(evalJudges),
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
    if (judgeConfigurationName !== evalJudges[0].id) throw new Error("Unknown judge configuration.");
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
        return {
          id: caseId,
          name: definition?.name || caseId,
          executionId: execution?.id || null,
          status: execution?.status || "missing",
          threadIds: execution?.threadIds || [],
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
    await this.#changed();
  }

  async #execute(execution) {
    execution.status = "running";
    execution.error = null;
    await this.#changed();
    const definition = evalCases.find((candidate) => candidate.id === execution.testCaseId);
    try {
      const thread = await this.#productRequest("/api/threads", {
        method: "POST",
        body: {
          title: definition.name,
          initialMessage: definition.prompts[0],
          harnessConfigurationName: execution.harnessConfigurationName,
        },
      });
      execution.threadIds = [thread.id];
      await this.#waitForInteraction(thread.id, thread.rootInteractionId);
      for (const prompt of definition.prompts.slice(1)) {
        const interaction = await this.#productRequest(`/api/threads/${thread.id}/interactions`, {
          method: "POST",
          body: { text: prompt },
        });
        await this.#waitForInteraction(thread.id, interaction.id);
      }
      const detail = await this.#productRequest(`/api/threads/${thread.id}`);
      execution.turns = detail.interactions.map((interaction) => ({
        interactionId: interaction.id,
        graphNodeId: interaction.graphNodeId,
        status: interaction.completionStatus,
        prompt: interaction.text,
      }));
      const checks = [];
      for (const interaction of detail.interactions) {
        if (interaction.completionStatus !== "accepted" || !interaction.completionOutput) {
          checks.push({
            name: `turn-${interaction.sequence}:accepted`,
            passed: false,
            detail: interaction.completionError || `Turn ended as ${interaction.completionStatus}.`,
          });
          continue;
        }
        checks.push(...checkBasicOutput(interaction.completionOutput, interaction.graphNodeId).map((check) => ({
          ...check,
          name: `turn-${interaction.sequence}:${check.name}`,
        })));
        if (definition.requiredChecks?.includes("node-navigation")) {
          checks.push(...checkNodeNavigation(interaction.completionOutput).map((check) => ({
            ...check,
            name: `turn-${interaction.sequence}:${check.name}`,
          })));
        }
      }
      execution.checks = checks;
      execution.passed = checks.length > 0 && checks.every((check) => check.passed);
      execution.status = execution.passed ? "passed" : "failed";
    } catch (error) {
      execution.status = "error";
      execution.passed = false;
      execution.error = error instanceof Error ? error.message : String(error);
    }
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
}
