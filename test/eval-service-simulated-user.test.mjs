import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EvalService } from "../desktop/eval-main/eval-service.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const directories = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("EvalService simulated-user result persistence", () => {
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
      rubric: { rubricVersion: "simulated-user-rubric-v1" },
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
        passed: true,
        rubricVersion: "simulated-user-rubric-v1",
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

    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
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
      checks: expect.arrayContaining([expect.objectContaining({ passed: true })]),
      turns: [expect.objectContaining({
        deterministicPassed: true,
        judgeResults: [expect.objectContaining({
          status: "partial",
          passed: false,
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
      passed: false,
      error: "Judge process exited.",
    });
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
    expect(restored.executions[0].turns[0].judgeResults[0]).toMatchObject({
      status: "partial",
      error: "Simulated-user review was interrupted before finalization.",
    });
    expect(restored.bundleRef).toMatch(/^runs\/.*\/bundle\.json$/);
    expect(JSON.parse(await readFile(join(dirname(stateFile), restored.bundleRef), "utf8"))).toMatchObject({
      run: { status: "interrupted" },
    });
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
  const layer = { id: 10, nodes: [node.id], edges: [], state: "accepted" };
  return {
    nodeId: 1,
    rootAction: {
      id: 11,
      sourceNodeId: 1,
      kind: "navigate",
      label: "Response",
      targetLayerId: layer.id,
      response: true,
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
