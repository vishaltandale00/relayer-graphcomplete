import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";
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
      runtimeSession,
      defaultHarnessConfiguration: "fixture-task-system",
      allowHarnessOverride: true,
    });
    services.push(product);
    const productSession = await product.start();
    const evalService = await new EvalService({
      stateFile: join(dataDirectory, "eval-data", "test-runs.json"),
      productSession,
      configurationPaths: [configurationPath],
    }).open();

    const created = await evalService.createRun({
      testCaseIds: ["empty-project.task-system.two-turn", "empty-project.task-system.single-turn"],
      harnessConfigurationNames: ["fixture-task-system"],
      judgeConfigurationName: "deterministic-graph-contract",
    });
    const completed = await waitForCompletedRun(evalService, created.id);

    expect(completed.status).toBe("passed");
    expect(completed.summary).toMatchObject({ passed: 2, total: 2 });
    expect(completed.executions).toHaveLength(2);
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
    expect(context.cases).toHaveLength(2);
    expect(context.cases.every((testCase) => testCase.threadIds.length === 1)).toBe(true);

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
