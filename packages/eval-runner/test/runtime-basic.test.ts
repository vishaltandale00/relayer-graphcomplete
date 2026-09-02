import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { productHarnessImplementations, type HarnessFactory } from "@relayer/harness-host";
import type { CompletionOutput } from "@relayer/graph-client";
import {
  graphMemoryFixtureConfiguration,
  graphMemoryFixtureFactory,
  graphMemorySearchBudget,
  graphMemorySearchParameters,
  graphMemorySearchQuery,
  graphMemorySearchTitle,
} from "../src/fixtures/graph-memory.js";
import { taskSystemFixtureConfiguration, taskSystemFixtureFactory } from "../src/fixtures/task-system.js";
import { expandTestRun } from "../src/run-plan.js";
import { basicEvalCaseId, basicEvalFacts, basicEvalPrompt, basicEvalPythonPath, basicJudgePrompt, checkBasicFacts, checkBasicOutput, checkGraphMemoryFirstTurn, checkGraphMemorySecondTurn, checkNodeNavigation, checkReplayRepairOutput, executionDirectory, graphMemoryEvalCaseId, graphMemorySearchRequestMode, judgeVisibleGraph, parseReportedReplayRepairEvidence, renderArtifact, runBasicRuntimeEval, selectStandalonePermissionProfile, startGraphAuditProxy, type BasicJudgeThreadFactory, type ReplayRepairEvidence } from "../src/runtime-basic.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const implementations = productHarnessImplementations({
  "fixture.task-system": taskSystemFixtureFactory,
  "fixture.graph-memory": graphMemoryFixtureFactory,
});

function fixtureExecution() {
  return expandTestRun({
    testRunId: "fixture-run",
    testCaseIds: [basicEvalCaseId],
    harnessConfigurationNames: [taskSystemFixtureConfiguration.name],
    judgeConfiguration: { name: "none" as const },
  }, new Map([[taskSystemFixtureConfiguration.name, taskSystemFixtureConfiguration]]))[0]!;
}

function graphMemoryExecution() {
  return expandTestRun({
    testRunId: "fixture-memory-run",
    testCaseIds: [graphMemoryEvalCaseId],
    harnessConfigurationNames: [graphMemoryFixtureConfiguration.name],
    judgeConfiguration: { name: "none" as const },
  }, new Map([[graphMemoryFixtureConfiguration.name, graphMemoryFixtureConfiguration]]))[0]!;
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
  it("exposes a deterministic fixture evaluation contract", () => {
    // Checkpoint: kernels launched from temporary directories get an absolute Python client path.
    const paths = basicEvalPythonPath("existing-python-path").split(delimiter);
    expect(isAbsolute(paths[0]!)).toBe(true);
    expect(paths[0]).toMatch(/python[/\\]relayer-graph[/\\]src$/);
    expect(paths[1]).toBe("existing-python-path");

    // Checkpoint: the standalone permission profile must be unambiguous for the harness.
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

    // Checkpoint: equivalent concurrency language is recognized and the judge sees endpoint-resolvable ids.
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

    // Checkpoint: node-level child-layer actions stay distinct from the required response action.
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

  it("isolates audit-proxy targets and bounds proxy shutdown", async () => {
    // Checkpoint: hostile absolute and scheme-relative targets are rejected without touching either server.
    {
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
    }

    // Checkpoint: shutdown stays bounded while an active upstream request never responds.
    {
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
    }
  }, 10_000);

  it("enforces runtime state authority across shutdown outcomes", async () => {
    // Checkpoint: forced shutdown removes state once settled, even when graceful disposal stalls.
    {
      const outputDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-stalled-dispose-"));
      temporary.push(outputDirectory);
      let runtimeDirectory: string | undefined;
      let releaseDispose!: () => void;
      let markDisposeStarted!: () => void;
      let markDisposeFinished!: () => void;
      const disposeGate = new Promise<void>((resolveDispose) => { releaseDispose = resolveDispose; });
      const disposeStarted = new Promise<void>((resolveStarted) => { markDisposeStarted = resolveStarted; });
      const disposeFinished = new Promise<void>((resolveFinished) => { markDisposeFinished = resolveFinished; });
      const stalledFactory: HarnessFactory = async (context) => {
        runtimeDirectory = context.workingDirectory;
        const fixture = await taskSystemFixtureFactory(context);
        return {
          complete: (runContext, signal) => fixture.complete(runContext, signal),
          state: () => fixture.state(),
          async dispose() {
            markDisposeStarted();
            await disposeGate;
            markDisposeFinished();
          },
        };
      };

      const evaluation = runBasicRuntimeEval({
        outputDirectory,
        execution: fixtureExecution(),
        implementations: { "fixture.task-system": stalledFactory },
        harnessCloseGraceMs: 25,
      });
      await disposeStarted;
      const shutdownStartedAt = Date.now();

      try {
        await expect(evaluation).rejects.toThrow("Harness host did not close within 25ms and was forcibly disconnected");

        expect(Date.now() - shutdownStartedAt).toBeLessThan(1_000);
        expect(runtimeDirectory).toBeDefined();
        await expect.poll(async () => stat(runtimeDirectory!).then(() => false, () => true)).toBe(true);
      } finally {
        releaseDispose();
        await disposeFinished;
      }
    }

    // Checkpoint: failed forced disconnection retains the runtime state.
    {
      const outputDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-failed-force-close-"));
      temporary.push(outputDirectory);
      let runtimeDirectory: string | undefined;
      let releaseDispose!: () => void;
      let markDisposeFinished!: () => void;
      const disposeGate = new Promise<void>((resolveDispose) => { releaseDispose = resolveDispose; });
      const disposeFinished = new Promise<void>((resolveFinished) => { markDisposeFinished = resolveFinished; });
      const failedForceFactory: HarnessFactory = async (context) => {
        runtimeDirectory = context.workingDirectory;
        const fixture = await taskSystemFixtureFactory(context);
        return {
          complete: (runContext, signal) => fixture.complete(runContext, signal),
          state: () => fixture.state(),
          forceShutdown() { throw new Error("forced provider interruption failed"); },
          async dispose() {
            await disposeGate;
            markDisposeFinished();
          },
        };
      };

      const evaluation = runBasicRuntimeEval({
        outputDirectory,
        execution: fixtureExecution(),
        implementations: { "fixture.task-system": failedForceFactory },
        harnessCloseGraceMs: 25,
      });
      try {
        await expect(evaluation).rejects.toThrow("Harness host did not force-close cleanly");
        expect(runtimeDirectory).toBeDefined();
        await expect(stat(runtimeDirectory!)).resolves.toBeDefined();
      } finally {
        releaseDispose();
        await disposeFinished;
        if (runtimeDirectory !== undefined) {
          await expect.poll(async () => stat(runtimeDirectory!).then(() => false, () => true)).toBe(true);
        }
      }
    }

    // Checkpoint: a slow successful disposal still completes inside the configured grace.
    {
      const outputDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-slow-dispose-"));
      temporary.push(outputDirectory);
      let disposed = false;
      const slowFactory: HarnessFactory = async (context) => {
        const fixture = await taskSystemFixtureFactory(context);
        return {
          complete: (runContext, signal) => fixture.complete(runContext, signal),
          state: () => fixture.state(),
          async dispose() {
            await new Promise((resolveDispose) => setTimeout(resolveDispose, 40));
            disposed = true;
          },
        };
      };

      const artifact = await runBasicRuntimeEval({
        outputDirectory,
        execution: fixtureExecution(),
        implementations: { "fixture.task-system": slowFactory },
        harnessCloseGraceMs: 250,
      });

      expect(artifact.passed).toBe(true);
      expect(disposed).toBe(true);
    }
  }, 20_000);

  it("runs the fixture session end-to-end and pins the managed judge executable", async () => {
    // Checkpoint: two interactions flow through one live harness object and both graphs persist.
    {
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
    }

    // Checkpoint: every structured judge turn starts with the explicit managed Codex executable.
    {
      const outputDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-managed-judge-")); temporary.push(outputDirectory);
      const execution = {
        ...fixtureExecution(),
        judgeConfiguration: { name: "codex-structured" as const },
      };
      const starts: { codexPathOverride: string | undefined; workingDirectory: string | undefined }[] = [];
      const judgeThreadFactory: BasicJudgeThreadFactory = {
        start(codexOptions, threadOptions) {
          starts.push({
            codexPathOverride: codexOptions.codexPathOverride,
            workingDirectory: threadOptions.workingDirectory,
          });
          return {
            async run() {
              return {
                finalResponse: JSON.stringify({
                  factIds: basicEvalFacts.map(({ id }) => id),
                  graphUseful: true,
                  detailsUseful: true,
                  problems: [],
                  verdict: "pass",
                }),
              };
            },
          };
        },
      };

      const artifact = await runBasicRuntimeEval({
        outputDirectory,
        execution,
        implementations,
        judgeCodexPathOverride: "/managed/codex/bin/codex",
        judgeThreadFactory,
      });

      expect(artifact.passed).toBe(true);
      expect(starts).toHaveLength(2);
      expect(starts.every(({ codexPathOverride }) => codexPathOverride === "/managed/codex/bin/codex")).toBe(true);
      expect(starts.every(({ workingDirectory }) => typeof workingDirectory === "string")).toBe(true);
    }
  }, 30_000);

  it("proves prior accepted graph search and typed reference reuse across two capabilities in one session", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-graph-memory-"));
    temporary.push(outputDirectory);
    const execution = graphMemoryExecution();
    const artifact = await runBasicRuntimeEval({ outputDirectory, execution, implementations });

    expect(artifact.passed).toBe(true);
    expect(artifact.turns).toHaveLength(2);
    const searchTarget = artifact.turns[0]!.output.rootLayer.nodes.filter((node) => (
      node.title === graphMemorySearchTitle
    ));
    expect(searchTarget).toHaveLength(1);
    expect(artifact.turns[0]!.output.rootLayer.nodes.every((node) => (
      !node.title.includes("GRAPH_MEMORY_ANCHOR:")
      && !node.detail.includes("GRAPH_MEMORY_ANCHOR:")
    ))).toBe(true);
    expect(artifact.turns[1]!.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "search-returned-prior-root", passed: true }),
      expect.objectContaining({ name: "search-request-contract", passed: true }),
      expect.objectContaining({ name: "draft-decoy-hidden", passed: true }),
      expect.objectContaining({ name: "typed-reference-target", passed: true }),
      expect.objectContaining({ name: "ack-search-submit-order", passed: true }),
    ]));
    expect(artifact.sessionChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "single-harness-object", passed: true }),
      expect.objectContaining({ name: "distinct-interaction-capabilities", passed: true }),
      expect.objectContaining({ name: "revoked-interaction-capabilities", passed: true }),
      expect.objectContaining({ name: "same-provider-session", passed: true }),
    ]));
    const evidence = artifact.turns[1]!.graphMemoryEvidence!;
    expect(evidence.searchRequest).toEqual({
      queryContractVersion: 1,
      target: undefined,
      query: graphMemorySearchQuery,
      parameters: graphMemorySearchParameters,
      budget: graphMemorySearchBudget,
    });
    const firstLayerId = artifact.turns[0]!.output.rootLayer.layer.id;
    expect(evidence.searchedLayerIds).toEqual([firstLayerId]);
    const acceptedReference = artifact.turns[1]!.output.rootLayer.actions.find((action) => (
      action.id === evidence.referenceActionId
    ));
    expect(acceptedReference).toMatchObject({
      kind: "navigate",
      relation: "reference",
      state: "accepted",
      targetLayerId: firstLayerId,
      sourceLayerId: artifact.turns[1]!.output.rootLayer.layer.id,
    });
    const submits = evidence.auditEvents.filter((event) => event.path === "/api/graph/submit" && event.status === 200);
    const search = evidence.auditEvents.find((event) => (
      event.path === "/api/graph/search"
      && event.status === 200
      && event.sequence > evidence.secondTurnStartSequence
    ))!;
    const reference = evidence.auditEvents.find((event) => event.recordId === evidence.referenceActionId && event.recordKind === "action")!;
    expect(submits).toHaveLength(2);
    expect(submits[0]!.sequence).toBeLessThan(search.sequence);
    expect(search.sequence).toBeLessThan(reference.sequence);
    expect(reference.sequence).toBeLessThan(submits[1]!.sequence);
    const launderedChecks = checkGraphMemorySecondTurn(
      artifact.turns[1]!.output,
      artifact.turns[0]!.output,
      {
        ...evidence,
        searchRequest: {
          ...evidence.searchRequest!,
          query: "MATCH (l:Layer) RETURN l AS layer ORDER BY layer ASC",
        },
      },
      artifact.turns[1]!.interactionNodeId,
      { requireDraftDecoy: true, searchRequestMode: "exact" },
    );
    expect(launderedChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "search-returned-prior-root", passed: true }),
      expect.objectContaining({ name: "search-request-contract", passed: false }),
    ]));
    const machineMarkerAsParameterChecks = checkGraphMemorySecondTurn(
      artifact.turns[1]!.output,
      artifact.turns[0]!.output,
      {
        ...evidence,
        searchRequest: {
          ...evidence.searchRequest!,
          parameters: {
            topic: { type: "string", value: "GRAPH_MEMORY_ANCHOR:forbidden" },
          },
        },
      },
      artifact.turns[1]!.interactionNodeId,
      { requireDraftDecoy: true, searchRequestMode: "exact" },
    );
    expect(machineMarkerAsParameterChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "search-returned-prior-root", passed: true }),
      expect.objectContaining({ name: "search-request-contract", passed: false }),
    ]));
    const selectedTargetChecks = checkGraphMemorySecondTurn(
      artifact.turns[1]!.output,
      artifact.turns[0]!.output,
      {
        ...evidence,
        searchRequest: {
          ...evidence.searchRequest!,
          target: { scope: "project", id: 41 },
        },
      },
      artifact.turns[1]!.interactionNodeId,
      { requireDraftDecoy: true, searchRequestMode: "exact" },
    );
    expect(selectedTargetChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "search-request-contract", passed: false }),
    ]));
    const naturallyFormulatedChecks = checkGraphMemorySecondTurn(
      artifact.turns[1]!.output,
      artifact.turns[0]!.output,
      {
        ...evidence,
        searchRequest: {
          queryContractVersion: 1,
          query: "MATCH (content:Content)<-[:CONTAINS]-(layer:Layer) WHERE content.title = $title RETURN layer AS layer LIMIT 1",
          parameters: { title: { type: "string", value: graphMemorySearchTitle } },
          budget: graphMemorySearchBudget,
        },
      },
      artifact.turns[1]!.interactionNodeId,
      { requireDraftDecoy: true, searchRequestMode: "natural" },
    );
    expect(naturallyFormulatedChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "search-returned-prior-root", passed: true }),
      expect.objectContaining({ name: "search-request-contract", passed: true }),
    ]));
    const admittedNaturalVariants = [
      {
        query: "MATCH (layer:Layer)-[membership:CONTAINS]->(content:Content) WHERE content.title = $title RETURN DISTINCT layer LIMIT 1",
        budget: graphMemorySearchBudget,
      },
      {
        query: "MATCH path = (layer:Layer)-[:CONTAINS { order: 0 }]->(content:Content) WHERE $title = content.title RETURN layer ORDER BY content.title ASC LIMIT 1",
        budget: graphMemorySearchBudget,
      },
      {
        query: "MATCH (layer:Layer)-[:CONTAINS]->(content:Content) WHERE content.title = $title RETURN layer ORDER BY layer ASC",
        budget: {},
      },
      {
        query: "MATCH (layer:Layer)-[:CONTAINS]->(content:Content) WHERE content.title = $title RETURN layer ORDER BY layer ASC",
        budget: undefined,
      },
      {
        query: "MATCH (layer:Layer)-[:CONTAINS]->(content:Content) WHERE content.title = $title RETURN layer LIMIT 1;  ",
        budget: graphMemorySearchBudget,
      },
    ];
    for (const { query, budget } of admittedNaturalVariants) {
      expect(checkGraphMemorySecondTurn(
        artifact.turns[1]!.output,
        artifact.turns[0]!.output,
        {
          ...evidence,
          searchRequest: {
            queryContractVersion: 1,
            query,
            parameters: { title: { type: "string", value: graphMemorySearchTitle } },
            budget,
          },
        },
        artifact.turns[1]!.interactionNodeId,
        { requireDraftDecoy: true, searchRequestMode: "natural" },
      )).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "search-request-contract", passed: true }),
      ]));
    }
    expect(graphMemorySearchRequestMode("fixture.graph-memory")).toBe("exact");
    expect(graphMemorySearchRequestMode("codex.basic")).toBe("natural");
    expect(graphMemorySearchRequestMode("claude.basic")).toBe("natural");
    expect(graphMemorySearchRequestMode("prime.agent")).toBe("natural");
    const nonFinalSemicolonChecks = checkGraphMemorySecondTurn(
      artifact.turns[1]!.output,
      artifact.turns[0]!.output,
      {
        ...evidence,
        searchRequest: {
          queryContractVersion: 1,
          query: "MATCH (layer:Layer)-[:CONTAINS]->(content:Content) WHERE content.title = $title RETURN layer; LIMIT 1",
          parameters: { title: { type: "string", value: graphMemorySearchTitle } },
          budget: graphMemorySearchBudget,
        },
      },
      artifact.turns[1]!.interactionNodeId,
      { requireDraftDecoy: true, searchRequestMode: "natural" },
    );
    expect(nonFinalSemicolonChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "search-request-contract", passed: false }),
    ]));
    const tautologicalQueryChecks = checkGraphMemorySecondTurn(
      artifact.turns[1]!.output,
      artifact.turns[0]!.output,
      {
        ...evidence,
        searchRequest: {
          queryContractVersion: 1,
          query: "MATCH (layer:Layer) WHERE $title = $title RETURN layer AS layer LIMIT 1",
          parameters: { title: { type: "string", value: graphMemorySearchTitle } },
          budget: graphMemorySearchBudget,
        },
      },
      artifact.turns[1]!.interactionNodeId,
      { requireDraftDecoy: true, searchRequestMode: "natural" },
    );
    expect(tautologicalQueryChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "search-returned-prior-root", passed: true }),
      expect.objectContaining({ name: "search-request-contract", passed: false }),
    ]));
    const truncatedEvidence = {
      ...evidence,
      auditEvents: evidence.auditEvents.map((event) => (
        event.path === "/api/graph/search" && event.sequence > evidence.secondTurnStartSequence
          ? { ...event, resultTruncated: true }
          : event
      )),
    };
    expect(checkGraphMemorySecondTurn(
      artifact.turns[1]!.output,
      artifact.turns[0]!.output,
      truncatedEvidence,
      artifact.turns[1]!.interactionNodeId,
      { requireDraftDecoy: true, searchRequestMode: "exact" },
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "search-returned-prior-root", passed: false }),
      expect.objectContaining({ name: "draft-decoy-hidden", passed: false }),
    ]));

    const firstOutput = artifact.turns[0]!.output;
    const searchTargetId = searchTarget[0]!.id;
    const duplicateNaturalTarget = {
      ...firstOutput,
      rootLayer: {
        ...firstOutput.rootLayer,
        nodes: firstOutput.rootLayer.nodes.map((node) => node.id === searchTargetId
          ? node
          : { ...node, title: graphMemorySearchTitle }),
      },
    };
    const machineMarkerTitle = {
      ...firstOutput,
      rootLayer: {
        ...firstOutput.rootLayer,
        nodes: firstOutput.rootLayer.nodes.map((node) => node.id === searchTargetId
          ? node
          : { ...node, title: "GRAPH_MEMORY_ANCHOR:forbidden" }),
      },
    };
    const machineMarkerDetail = {
      ...firstOutput,
      rootLayer: {
        ...firstOutput.rootLayer,
        nodes: firstOutput.rootLayer.nodes.map((node) => node.id === searchTargetId
          ? node
          : { ...node, detail: `${node.detail}\n\nGRAPH_MEMORY_ANCHOR:forbidden` }),
      },
    };
    for (const invalidOutput of [duplicateNaturalTarget, machineMarkerTitle, machineMarkerDetail]) {
      expect(checkGraphMemoryFirstTurn(
        invalidOutput,
        invalidOutput.nodeId,
      )).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "natural-memory-search-target", passed: false }),
      ]));
    }
  }, 30_000);
  it("fails closed for unusable graph servers", async () => {
    const recipes = [
      {
        label: "unexecutable binary reports a controlled startup failure",
        file: "not-executable",
        content: "not a binary",
        mode: 0o644,
        options: {},
        error: "Graph server could not start",
      },
      {
        label: "a server that never becomes ready is terminated at the deadline",
        file: "stalled-server",
        content: "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 30_000);\n",
        mode: 0o755,
        options: { serverReadyTimeoutMs: 300 },
        error: "did not become ready",
      },
      {
        label: "invalid readiness output terminates the process",
        file: "invalid-server",
        content: "#!/usr/bin/env node\nprocess.stdout.write('not-json\\n');\nsetInterval(() => {}, 30_000);\n",
        mode: 0o755,
        options: {},
        error: "Unexpected token",
      },
    ];
    expect(recipes, "fail-closed corpus").toHaveLength(3);
    for (const recipe of recipes) {
      const directory = await mkdtemp(join(tmpdir(), "relayer-eval-server-failure-"));
      temporary.push(directory);
      const serverBinary = join(directory, recipe.file);
      await writeFile(serverBinary, recipe.content, "utf8");
      await chmod(serverBinary, recipe.mode);
      await expect(
        runBasicRuntimeEval({
          outputDirectory: join(directory, "output"),
          execution: fixtureExecution(),
          implementations,
          serverBinary,
          ...recipe.options,
        }),
        recipe.label,
      ).rejects.toThrow(recipe.error);
    }
  }, 30_000);
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
