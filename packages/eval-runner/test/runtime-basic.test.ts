import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { productHarnessImplementations } from "@relayer/harness-host";
import type { CompletionOutput } from "@relayer/graph-client";
import { taskSystemFixtureConfiguration, taskSystemFixtureFactory } from "../src/fixtures/task-system.js";
import { expandTestRun } from "../src/run-plan.js";
import { basicEvalCaseId, basicEvalFacts, basicEvalPrompt, basicEvalPythonPath, basicJudgePrompt, checkBasicFacts, checkBasicOutput, checkNodeNavigation, checkReplayRepairOutput, executionDirectory, judgeVisibleGraph, parseReportedReplayRepairEvidence, renderArtifact, runBasicRuntimeEval, selectStandalonePermissionProfile, startGraphAuditProxy, type ReplayRepairEvidence } from "../src/runtime-basic.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const implementations = productHarnessImplementations({ "fixture.task-system": taskSystemFixtureFactory });

function fixtureExecution() {
  return expandTestRun({
    testRunId: "fixture-run",
    testCaseIds: [basicEvalCaseId],
    harnessConfigurationNames: [taskSystemFixtureConfiguration.name],
    judgeConfiguration: { name: "none" as const },
  }, new Map([[taskSystemFixtureConfiguration.name, taskSystemFixtureConfiguration]]))[0]!;
}

function navigationOutput(actions: CompletionOutput["rootLayer"]["actions"] = []): CompletionOutput {
  return {
    nodeId: 1,
    rootAction: { id: 1, sourceNodeId: 1, sourceLayerId: null, kind: "navigate" as const, relation: "expand" as const, label: "Response", variant: "pill", targetLayerId: 3, state: "accepted" as const },
    rootLayer: {
      layer: { id: 3, nodes: [2], edges: [], state: "accepted" as const },
      nodes: [{ id: 2, kind: "concept", icon: "N", title: "Overview", detail: "Details", state: "accepted" as const }],
      edges: [],
      actions,
    },
  };
}

describe("first runtime evaluation", () => {
  it("configures an absolute Python client path for kernels launched from temporary directories", () => {
    const paths = basicEvalPythonPath("existing-python-path").split(delimiter);
    expect(isAbsolute(paths[0]!)).toBe(true);
    expect(paths[0]).toMatch(/python[/\\]relayer-graph[/\\]src$/);
    expect(paths[1]).toBe("existing-python-path");
  });

  it("selects a standalone permission profile supported by the harness", () => {
    expect(selectStandalonePermissionProfile(taskSystemFixtureConfiguration)).toBe("auto");
    expect(selectStandalonePermissionProfile({
      ...taskSystemFixtureConfiguration,
      name: "prime-agent-basic",
      permissionBindings: { full: {} },
    })).toBe("full");
    expect(() => selectStandalonePermissionProfile({
      ...taskSystemFixtureConfiguration,
      permissionBindings: { ask: {}, full: {} },
    })).toThrow("need Auto or one unambiguous permission profile");
  });

  it("recognizes equivalent concurrency language and gives the judge endpoint-resolvable node IDs", () => {
    const concurrency = basicEvalFacts.find((fact) => fact.id === "two-active-limit")!;
    expect(concurrency.patterns.some((pattern) => pattern.test("allowing up to two tasks to run at the same time"))).toBe(true);
    expect(concurrency.patterns.some((pattern) => pattern.test("While both workers are busy: no new task starts."))).toBe(true);
    const visible = judgeVisibleGraph({
      nodeId: 1,
      rootAction: { id: 1, sourceNodeId: 1, sourceLayerId: null, kind: "navigate", relation: "expand", label: "Response", variant: "pill", targetLayerId: 3, state: "accepted" },
      rootLayer: {
        layer: { id: 3, nodes: [2, 6], edges: [4], state: "accepted" },
        nodes: [
          { id: 2, kind: "concept", icon: "Q", title: "Queue", detail: "Wait", state: "accepted" },
          { id: 6, kind: "concept", icon: "R", title: "Results", detail: "Stored", state: "accepted" },
        ],
        edges: [{ id: 4, endpoints: [2, 6], state: "accepted" }],
        actions: [],
      },
    });
    expect(visible.nodes.map((node) => node.id)).toEqual([2, 6]);
    expect(visible.edges).toEqual([[2, 6]]);
    const judgePrompt = basicJudgePrompt({
      nodeId: 1,
      rootAction: { id: 1, sourceNodeId: 1, sourceLayerId: null, kind: "navigate", relation: "expand", label: "Response", variant: "pill", targetLayerId: 3, state: "accepted" },
      rootLayer: {
        layer: { id: 3, nodes: [2, 6], edges: [4], state: "accepted" },
        nodes: visible.nodes.map((node) => ({ ...node, kind: "concept" as const, state: "accepted" as const })),
        edges: [{ id: 4, endpoints: [6, 2], state: "accepted" }],
        actions: [],
      },
    }, basicEvalPrompt);
    expect(judgePrompt).toContain("[a,b] means the same thing as [b,a]");
    expect(judgePrompt).toContain("exactly two worker nodes shown busy while additional work remains queued clearly establishes the two-active-task limit");

    const mismatched = {
      nodeId: 1,
      rootAction: { id: 1, sourceNodeId: 1, sourceLayerId: null, kind: "navigate" as const, relation: "expand" as const, label: "Response", variant: "pill" as const, targetLayerId: 3, state: "accepted" as const },
      rootLayer: {
        layer: { id: 3, nodes: [2], edges: [], state: "accepted" as const },
        nodes: [{ id: 6, kind: "concept", icon: "R", title: "Results", detail: "Stored", state: "draft" as const }],
        edges: [],
        actions: [],
      },
    };
    const checks = checkBasicOutput(mismatched);
    expect(checks.find((check) => check.name === "resolved-membership")?.passed).toBe(false);
    expect(checks.find((check) => check.name === "accepted-closure")?.passed).toBe(false);
    expect(checks.some((check) => check.name.startsWith("fact:"))).toBe(false);
    expect(checkBasicFacts(mismatched).some((check) => check.name.startsWith("fact:"))).toBe(true);
  });

  it("distinguishes a node-level child-layer action from the required response action", () => {
    const output = navigationOutput();
    expect(checkNodeNavigation(output)).toEqual([
      expect.objectContaining({ name: "node-navigation", passed: false }),
    ]);
    const withNavigation = navigationOutput([{
      id: 9,
      sourceNodeId: output.rootLayer.nodes[0]!.id,
      sourceLayerId: output.rootLayer.layer.id,
      kind: "navigate",
      relation: "expand",
      label: "Open details",
      variant: "pill",
      targetLayerId: 10,
      state: "accepted" as const,
    }]);
    expect(checkNodeNavigation(withNavigation)).toEqual([
      expect.objectContaining({ name: "node-navigation", passed: true }),
    ]);
  });

  it("grades durable replay, singleton-root, and stopped-orphan evidence without inference", () => {
    const pass = { primaryNodeId: 2, secondaryNodeId: 3, edgeId: 4, rootLayerId: 5, rootActionId: 6, orphanNodeId: 7, orphanLayerId: 8 };
    const output: CompletionOutput = {
      nodeId: 1,
      rootAction: { id: 6, sourceNodeId: 1, sourceLayerId: null, kind: "navigate", relation: "expand", label: "Response", variant: "pill", targetLayerId: 5, state: "accepted" },
      rootLayer: {
        layer: {
          id: 5,
          nodes: [2, 3],
          edges: [4],
          layout: { version: 1, placements: [{ nodeId: 2, x: 0.25, y: 0.5 }, { nodeId: 3, x: 0.75, y: 0.5 }] },
          state: "accepted",
        },
        nodes: [
          { id: 2, kind: "concept", icon: "key", title: "Stable client keys", detail: `Retry after partial persistence reuses the draft.\nGRAPH_REPAIR_EVIDENCE=${JSON.stringify({ passes: [pass, pass], orphanSubmitErrorCode: "orphan_draft_layers", discardedLayerIds: [8, 8] })}`, state: "accepted" },
          { id: 3, kind: "concept", icon: "refresh-cw", title: "Idempotent replay", detail: "Rerun safely without duplicate roots.", state: "accepted" },
        ],
        edges: [{ id: 4, endpoints: [2, 3], state: "accepted" }],
        actions: [],
      },
    };
    const reported = parseReportedReplayRepairEvidence(output);
    expect(reported).toEqual({ passes: [pass, pass], orphanSubmitErrorCode: "orphan_draft_layers", discardedLayerIds: [8, 8] });
    let sequence = 0;
    const write = (recordKind: "node" | "edge" | "layer" | "action", recordId: number) => ({
      sequence: ++sequence,
      method: "POST",
      path: `/api/graph/${recordKind === "edge" ? "edges" : `${recordKind}s`}`,
      status: 200,
      recordKind,
      recordId,
      recordState: "draft",
    });
    const replayWrites = ([
      ["node", 2], ["node", 3], ["edge", 4], ["layer", 5], ["action", 6], ["node", 7], ["layer", 8],
    ] as const).flatMap(([kind, id]) => [write(kind, id), write(kind, id)]);
    const failedSubmit = { sequence: ++sequence, method: "POST", path: "/api/graph/submit", status: 422, errorCodes: ["orphan_draft_layers"] };
    const firstDiscard = { sequence: ++sequence, method: "POST", path: "/api/graph/layers/8/discard", status: 200, recordKind: "layer" as const, recordId: 8, recordState: "stopped" };
    const secondDiscard = { ...firstDiscard, sequence: ++sequence };
    const finalSubmit = { sequence: ++sequence, method: "POST", path: "/api/graph/submit", status: 200 };
    const evidence: ReplayRepairEvidence = {
      reported: reported!,
      stoppedLayer: {
        layer: { id: 8, nodes: [7], edges: [], state: "stopped" },
        nodes: [{ id: 7, kind: "concept", icon: "archive", title: "Abandoned", detail: "Preserved", state: "draft" }],
        edges: [],
        actions: [],
      },
      stoppedLayerOwnerNodeId: 1,
      auditEvents: [...replayWrites, failedSubmit, firstDiscard, secondDiscard, finalSubmit],
    };

    expect(checkReplayRepairOutput(output, evidence).every((check) => check.passed)).toBe(true);
    expect(checkReplayRepairOutput(output, { ...evidence, stoppedLayerOwnerNodeId: 99 }).find((check) => check.name === "explicit-stopped-orphan")?.passed).toBe(false);
    const fabricatedTextOnly = checkReplayRepairOutput(output, { ...evidence, auditEvents: [] });
    expect(fabricatedTextOnly.find((check) => check.name === "stable-object-replay")?.passed).toBe(false);
    expect(fabricatedTextOnly.find((check) => check.name === "orphan-validation-observed")?.passed).toBe(false);
    expect(fabricatedTextOnly.find((check) => check.name === "idempotent-discard")?.passed).toBe(false);
    const onePassOneDiscard = checkReplayRepairOutput(output, {
      ...evidence,
      auditEvents: [
        ...replayWrites.filter((_, index) => index % 2 === 0),
        failedSubmit,
        firstDiscard,
        finalSubmit,
      ],
    });
    expect(onePassOneDiscard.find((check) => check.name === "stable-object-replay")?.passed).toBe(false);
    expect(onePassOneDiscard.find((check) => check.name === "idempotent-discard")?.passed).toBe(false);
    expect(parseReportedReplayRepairEvidence({
      ...output,
      rootLayer: { ...output.rootLayer, nodes: output.rootLayer.nodes.map((node) => ({ ...node, detail: "No evidence" })) },
    })).toBeUndefined();
  });

  it("rejects hostile audit-proxy targets without contacting either upstream or the requested origin", async () => {
    let upstreamRequests = 0;
    let hostileRequests = 0;
    const upstream = await listenServer(() => { upstreamRequests += 1; });
    const hostile = await listenServer(() => { hostileRequests += 1; });
    const proxy = await startGraphAuditProxy(upstream.url);
    try {
      const absoluteStatus = await rawHttpRequest(proxy.url, `${hostile.url}/api/graph/nodes`);
      const schemeRelativeStatus = await rawHttpRequest(proxy.url, `//127.0.0.1:${new URL(hostile.url).port}/api/graph/nodes`);
      expect(absoluteStatus).toBe(400);
      expect(schemeRelativeStatus).toBe(400);
      expect(upstreamRequests).toBe(0);
      expect(hostileRequests).toBe(0);
      expect(proxy.events()).toEqual([]);
    } finally {
      await proxy.close();
      await upstream.close();
      await hostile.close();
    }
  });

  it("bounds audit-proxy shutdown while an active upstream request never responds", async () => {
    let markUpstreamReached!: () => void;
    const upstreamReached = new Promise<void>((resolveReached) => { markUpstreamReached = resolveReached; });
    const upstream = await listenServer(() => {
      markUpstreamReached();
      return false;
    });
    const proxy = await startGraphAuditProxy(upstream.url, 25);
    const pendingResponse = rawHttpRequest(proxy.url, "/api/graph/nodes").catch(() => 0);
    await upstreamReached;
    const startedAt = Date.now();
    try {
      await proxy.close();
      expect(Date.now() - startedAt).toBeLessThan(500);
      await pendingResponse;
    } finally {
      await upstream.close();
    }
  });

  it("runs two interactions through one live harness object and saves both fixture graphs", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-test-")); temporary.push(outputDirectory);
    const execution = fixtureExecution();
    const artifact = await runBasicRuntimeEval({ outputDirectory, execution, implementations });
    expect(artifact.passed).toBe(true);
    expect(artifact.execution).toEqual(execution);
    expect(artifact.turns).toHaveLength(2);
    expect(artifact.turns.map((turn) => turn.output.nodeId)).toEqual(artifact.turns.map((turn) => turn.interactionNodeId));
    expect(artifact.turns.every((turn) => turn.output.rootLayer.nodes.length === 3)).toBe(true);
    expect(artifact.turns.every((turn) => turn.output.rootLayer.edges.length === 2)).toBe(true);
    expect(artifact.turns.every((turn) => turn.output.rootLayer.layer.layout?.version === 1)).toBe(true);
    expect(artifact.turns.every((turn) => turn.output.rootLayer.layer.layout?.placements.length === 3)).toBe(true);
    expect(artifact.turns.every((turn) => turn.checks.every((check) => check.passed))).toBe(true);
    expect(artifact.turns.every((turn) => checkBasicFacts(turn.output).every((check) => check.passed))).toBe(true);
    expect(artifact.sessionChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "single-harness-object", passed: true }),
      expect.objectContaining({ name: "distinct-interaction-capabilities", passed: true }),
      expect.objectContaining({ name: "revoked-interaction-capabilities", passed: true }),
    ]));
    const directory = executionDirectory(outputDirectory, execution);
    expect(JSON.parse(await readFile(join(directory, "result.json"), "utf8"))).toMatchObject({
      schemaVersion: 3,
      execution: {
        testRunId: "fixture-run",
        testCaseId: basicEvalCaseId,
        harnessConfigurationName: "fixture-task-system",
        harnessConfiguration: taskSystemFixtureConfiguration,
        harnessConfigurationDigest: execution.harnessConfigurationDigest,
      },
      passed: true,
      turns: [{ passed: true }, { passed: true }],
    });
    expect(await readFile(join(directory, "index.html"), "utf8")).toContain("Incoming queue");
    const unsafe = {
      ...artifact,
      turns: artifact.turns.map((turn, turnIndex) => turnIndex === 0 ? {
        ...turn,
        prompt: '<img src=x onerror="alert(1)">',
        output: {
          ...turn.output,
          rootLayer: {
            ...turn.output.rootLayer,
            nodes: turn.output.rootLayer.nodes.map((node, nodeIndex) => nodeIndex === 0 ? { ...node, title: '<img src=x onerror="alert(2)">' } : node),
          },
        },
      } : turn),
    };
    const html = renderArtifact(unsafe);
    expect(html).not.toContain('<img src=x onerror="alert');
    expect(html).toContain("title.textContent=node.title");
    expect(html).toContain("110+placement.x*740");
  }, 15_000);

  it("reports a controlled failure when the graph server cannot be executed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-eval-spawn-error-")); temporary.push(directory);
    const executable = join(directory, "not-executable");
    await writeFile(executable, "not a binary", "utf8");
    await chmod(executable, 0o644);

    await expect(runBasicRuntimeEval({
      outputDirectory: join(directory, "output"),
      execution: fixtureExecution(),
      implementations,
      serverBinary: executable,
    })).rejects.toThrow("Graph server could not start");
  });

  it("times out and terminates a graph process that never becomes ready", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-eval-timeout-")); temporary.push(directory);
    const executable = join(directory, "stalled-server");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 30_000);\n", "utf8");
    await chmod(executable, 0o755);

    await expect(runBasicRuntimeEval({
      outputDirectory: join(directory, "output"),
      execution: fixtureExecution(),
      implementations,
      serverBinary: executable,
      serverReadyTimeoutMs: 300,
    })).rejects.toThrow("did not become ready");
  });

  it("terminates a graph process that emits invalid readiness output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-eval-invalid-ready-")); temporary.push(directory);
    const executable = join(directory, "invalid-server");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdout.write('not-json\\n');\nsetInterval(() => {}, 30_000);\n", "utf8");
    await chmod(executable, 0o755);

    await expect(runBasicRuntimeEval({
      outputDirectory: join(directory, "output"),
      execution: fixtureExecution(),
      implementations,
      serverBinary: executable,
    })).rejects.toThrow("Unexpected token");
  });
});

async function listenServer(onRequest: () => boolean | void): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    if (onRequest() === false) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP test server address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error === undefined ? resolveClose() : reject(error));
      server.closeAllConnections();
    }),
  };
}

async function rawHttpRequest(proxyUrl: string, target: string): Promise<number> {
  const proxy = new URL(proxyUrl);
  return new Promise<number>((resolveResponse, reject) => {
    const outgoing = request({
      hostname: proxy.hostname,
      port: proxy.port,
      method: "POST",
      path: target,
      headers: { authorization: "Bearer must-not-leave-proxy" },
    }, (response) => {
      response.resume();
      response.once("end", () => resolveResponse(response.statusCode ?? 0));
      response.once("aborted", () => resolveResponse(0));
      response.once("error", reject);
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}
