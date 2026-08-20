import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  H3_PACKAGE_MANAGER,
  H3_PROJECT_CASE_ID,
  H3_REPOSITORY_URL,
  H3_SEEDED_COMMIT,
  H3_SEEDED_TREE,
  H3_UPSTREAM_COMMIT,
  H3_UPSTREAM_TREE,
  taskSystemFixtureFactory,
} from "@relayer/eval-runner";
import { afterEach, describe, expect, it } from "vitest";

import { EvalService } from "../desktop/eval-main/eval-service.mjs";
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
  it("runs case × harness executions through the product server and preserves reviewable threads", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-app-test-"));
    directories.push(dataDirectory);
    const configurationPath = join(repositoryRoot, "harnesses", "fixture-task-system.yaml");
    const runtime = new GraphCompleteRuntimeService({
      userDataDirectory: dataDirectory,
      graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
      configurationPaths: [configurationPath],
      additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory },
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
    });
    services.push(product);
    const productSession = await product.start();
    const workspaceGrades = [];
    const acceptedTopologyGrades = [];
    const evalService = await new EvalService({
      stateFile: join(dataDirectory, "eval-data", "test-runs.json"),
      productSession,
      configurationPaths: [configurationPath],
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
        return [{ name: `workspace:${grade}`, passed: true, detail: `${grade} policy passed.` }];
      },
      acceptedTopologyGrader: (topology, { requireGrandchild }) => {
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

    const selected = completed.executions[0];
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
        kind: "navigate",
        label: "See queue behavior",
        response: false,
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
      "ask", "ask", "auto", "auto", "full", "full",
    ]);
    expect(h3Execution.turns.every((turn) => turn.effectiveExecutionDigest.startsWith("sha256:"))).toBe(true);
    expect(h3Execution.turns.slice(4).every((turn) => (
      turn.effectivePermissionReceipt.unconfinedHostAccess === true
      && turn.effectivePermissionReceipt.disclosure.includes("not hard-confined")
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
    expect(acceptedTopologyGrades.filter((grade) => grade.requireGrandchild)).toHaveLength(2);
    expect(acceptedTopologyGrades.every((grade) => grade.layerCount === 2)).toBe(true);
    const h3Threads = await Promise.all(h3Execution.threadIds.map((threadId) => (
      productRequest(productSession, `/api/threads/${threadId}`)
    )));
    expect(new Set(h3Threads.map((threadDetail) => threadDetail.thread.projectId)).size).toBe(1);
    expect(h3Threads.every((threadDetail) => threadDetail.interactions.length === 2)).toBe(true);
    expect(h3Threads.map((threadDetail) => threadDetail.thread.permissionProfileId)).toEqual(["ask", "auto", "full"]);
  }, 20_000);
});

async function waitForCompletedRun(evalService, runId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = evalService.getRun(runId);
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("Eval run did not finish in time.");
}

async function productRequest(session, path) {
  const response = await fetch(new URL(path, session.origin), {
    headers: { Cookie: `${session.cookie.name}=${session.cookie.value}` },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}
