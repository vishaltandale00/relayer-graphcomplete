import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EvalService } from "../desktop/eval-main/eval-service.mjs";
import { restoreLayerPath } from "../desktop/renderer/src/product-workspace/model.js";

const directories = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("imported conversation production review and judging", () => {
  it("gates judging on accepted turns, persists source provenance, and navigates imported cyclic topology", async () => {
    // Phase 1: an import with no accepted turn cannot be judged.
    const unacceptedRoot = await mkdtemp(join(tmpdir(), "relayer-imported-unaccepted-"));
    directories.push(unacceptedRoot);
    const unacceptedSource = join(unacceptedRoot, "conversation.jsonl");
    await writeFile(unacceptedSource, '{"recordType":"header"}\n');
    const unacceptedReceipt = importReceipt({ turns: [{ sourceTurnId: "turn:1", interactionId: 52, graphNodeId: 62, completionStatus: "failed" }] });
    vi.stubGlobal("fetch", importedBackend(unacceptedReceipt, {
      thread: { id: 41, imported: true },
      interactions: [{ id: 52, sequence: 1, text: "Failed request", graphNodeId: 62, completionStatus: "failed", completionOutput: null }],
    }));
    const unacceptedService = new EvalService({
      stateFile: join(unacceptedRoot, "state.json"),
      productSession: { origin: "http://127.0.0.1:43123", cookie: { name: "write", value: "secret" } },
      configurationPaths: [],
      conversationImportEnabled: true,
    });
    const unacceptedImport = await unacceptedService.importConversation(unacceptedSource);
    await expect(
      unacceptedService.judgeImportedConversation(unacceptedImport.executions[0].id, "deterministic-graph-contract"),
      "imports without an accepted turn cannot be judged",
    ).rejects.toThrow("no accepted turns eligible");
    expect(unacceptedService.getRun(unacceptedImport.id).executions[0].turns[0], "ineligible turn state is explicit")
      .toMatchObject({ status: "failed", judgeEligible: false, deterministicPassed: null });

    // Phase 2: judging an accepted import stays scoped to accepted turns and persists provenance.
    const judgeRoot = await mkdtemp(join(tmpdir(), "relayer-imported-judge-"));
    directories.push(judgeRoot);
    const stateFile = join(judgeRoot, "eval-data", "test-runs.json");
    const sourceFile = join(judgeRoot, "conversation.jsonl");
    await writeFile(sourceFile, '{"recordType":"header"}\n{"recordType":"turn"}\n');

    const receipt = importReceipt();
    const detail = importedThreadDetail();
    vi.stubGlobal("fetch", importedBackend(receipt, detail));
    const judgeCalls = [];
    const service = new EvalService({
      stateFile,
      productSession: {
        origin: "http://127.0.0.1:43123",
        cookie: { name: "write", value: "secret" },
      },
      configurationPaths: [],
      conversationImportEnabled: true,
      acceptedTopologyBuilder: async ({ turnId, rootLayerId }) => ({ turnId, rootLayerId }),
      acceptedTopologyGrader: () => [{ name: "graph:accepted-reachable-closure", passed: true, detail: "closure is visible" }],
      simulatedUserJudgeRunner: async (context) => {
        judgeCalls.push(context);
        return {
          status: "completed",
          passed: true,
          rubricRef: "rubric.json",
          configurationRef: "judge.json",
          interactionTraceRef: "trace.json",
          screenshotRefs: ["screenshots/root/metadata.json"],
          reviewRef: "review.json",
          coverageRef: "coverage.json",
          review: { turn: { ratings: { answer_quality: 4 } } },
          coverage: { complete: true, missingSubjects: [] },
          summary: "Accepted imported turn judged in ProductWorkspace.",
        };
      },
    });

    const imported = await service.importConversation(sourceFile);
    const importBundleBeforeJudging = await readFile(join(dirname(stateFile), imported.bundleRef), "utf8");
    expect(imported.kind, "import runs are their own run kind").toBe("imported-conversation");
    expect(imported.executions[0], "imported executions carry external origin provenance").toMatchObject({
      kind: "imported-conversation",
      harnessConfigurationName: null,
      origin: {
        kind: "external-conversation-export",
        importId: receipt.importId,
        sourceSha256: receipt.sourceSha256,
      },
    });
    expect(service.reviewContext(imported.executions[0].id), "review context is read-only external conversation").toMatchObject({
      readOnly: true,
      origin: { kind: "external-conversation-export", importId: receipt.importId },
      cases: [{ name: receipt.title, threads: [{ name: receipt.title }] }],
    });

    const deterministic = await service.judgeImportedConversation(
      imported.executions[0].id,
      "deterministic-graph-contract",
    );
    const deterministicTurns = deterministic.executions[0].turns;
    expect(deterministicTurns.map((turn) => ({ status: turn.status, eligible: turn.judgeEligible })),
      "only accepted turns are judge-eligible").toEqual([
      { status: "accepted", eligible: true },
      { status: "failed", eligible: false },
      { status: "running", eligible: false },
    ]);
    expect(deterministicTurns[0].deterministicPassed, "accepted turn is deterministically graded").toBe(true);
    expect(deterministicTurns[1].deterministicPassed, "failed turn is not graded").toBeNull();
    expect(deterministicTurns[2].deterministicPassed, "running turn is not graded").toBeNull();
    expect(deterministicTurns[0].deterministicJudge.provenance, "deterministic judgment keeps source provenance").toEqual({
      kind: "external-conversation-export",
      importId: receipt.importId,
      sourceSha256: receipt.sourceSha256,
      sourceTurnId: "turn:1",
      producer: receipt.producer,
    });

    const simulated = await service.judgeImportedConversation(
      imported.executions[0].id,
      "simulated-user",
    );
    expect(judgeCalls, "exactly one accepted turn reaches the simulated judge").toHaveLength(1);
    expect(judgeCalls[0], "simulated judge receives provenance and accepted turn context").toMatchObject({
      provenance: {
        kind: "external-conversation-export",
        importId: receipt.importId,
        sourceSha256: receipt.sourceSha256,
        sourceTurnId: "turn:1",
      },
      thread: { id: "41" },
      turn: { id: "51", status: "accepted", rootLayerId: 10 },
      request: { text: "Accepted request" },
    });
    expect(simulated.executions[0].turns[0].judgeResults.at(-1), "simulated result persists provenance").toMatchObject({
      judge: "simulated-user",
      status: "completed",
      provenance: {
        importId: receipt.importId,
        sourceSha256: receipt.sourceSha256,
        sourceTurnId: "turn:1",
      },
    });
    expect(simulated.executions[0].turns[1].judgeResults, "failed turn receives no judge results").toEqual([]);
    expect(simulated.executions[0].turns[2].judgeResults, "running turn receives no judge results").toEqual([]);

    expect(await readFile(join(dirname(stateFile), simulated.bundleRef), "utf8"), "judging never rewrites the import bundle")
      .toBe(importBundleBeforeJudging);
    const judgeArtifact = JSON.parse(await readFile(
      join(dirname(stateFile), simulated.executions[0].latestJudgeArtifactRef),
      "utf8",
    ));
    expect(judgeArtifact, "judge artifact names its immutable source").toMatchObject({
      kind: "relayer_imported_conversation_judge",
      source: {
        importId: receipt.importId,
        sourceSha256: receipt.sourceSha256,
        importBundleRef: simulated.bundleRef,
      },
    });
    expect(judgeArtifact.execution.turns[0].judgeResults[0].provenance.sourceSha256,
      "artifact judgment retains the source digest").toBe(receipt.sourceSha256);

    // Phase 3: the accepted expansion loads shared references and survives a reference cycle.
    const topologyRoot = await mkdtemp(join(tmpdir(), "relayer-imported-topology-"));
    directories.push(topologyRoot);
    const topologySource = join(topologyRoot, "conversation.jsonl");
    await writeFile(topologySource, '{"recordType":"header"}\n{"recordType":"turn"}\n');
    const topologyReceipt = importReceipt({
      turns: [{ sourceTurnId: "turn:1", interactionId: 51, graphNodeId: 61, completionStatus: "accepted" }],
    });
    const layers = cyclicAcceptedLayers();
    const topologyDetail = {
      thread: { id: 41, title: topologyReceipt.title, imported: true },
      interactions: [{
        id: 51,
        sequence: 1,
        text: "Navigate the imported graph",
        graphNodeId: 61,
        completionStatus: "accepted",
        completionOutput: {
          nodeId: 61,
          rootAction: { id: 1, sourceNodeId: 61, sourceLayerId: null, kind: "navigate", relation: "expand", label: "Response", targetLayerId: 10, state: "accepted" },
          rootLayer: layers.get("10"),
        },
      }],
    };
    const layerLoads = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const path = new URL(url).pathname;
      const method = options.method || "GET";
      if (path === "/api/internal/conversation-imports" && method === "POST") return jsonResponse(topologyReceipt);
      if (path === "/api/internal/conversation-imports" && method === "PUT") return jsonResponse({ published: true });
      if (path === "/api/threads/41" && method === "GET") return jsonResponse(topologyDetail);
      const match = path.match(/^\/api\/threads\/41\/interactions\/51\/layers\/(\d+)$/);
      if (match && method === "GET") {
        layerLoads.push(match[1]);
        return jsonResponse(layers.get(match[1]));
      }
      return jsonResponse({ error: `Unexpected request: ${method} ${path}` }, 404);
    }));
    const topologyService = new EvalService({
      stateFile: join(topologyRoot, "state.json"),
      productSession: { origin: "http://127.0.0.1:43123", cookie: { name: "write", value: "secret" } },
      configurationPaths: [],
      conversationImportEnabled: true,
    });
    const topologyImport = await topologyService.importConversation(topologySource);
    const judged = await topologyService.judgeImportedConversation(
      topologyImport.executions[0].id,
      "deterministic-graph-contract",
    );
    expect(judged.status, "cyclic accepted topology passes deterministic judging").toBe("passed");
    expect(layerLoads, "closure loading follows shared references without skipping layers").toEqual(["10", "20", "30", "40"]);

    const restored = await restoreLayerPath(topologyDetail.interactions[0], [
      { layerId: 10, viaActionId: null },
      { layerId: 30, viaActionId: 12 },
      { layerId: 40, viaActionId: 31 },
      { layerId: 30, viaActionId: 41 },
    ], async (layerId) => layers.get(String(layerId)));
    expect(restored.layer.layer.id, "path restoration lands on the repeated shared layer").toBe(30);
    expect(restored.layerPath.map((entry) => entry.layerId), "the reference cycle stays navigable").toEqual([10, 30, 40, 30]);
  });
});

function importReceipt(overrides = {}) {
  const producer = { desktopVersion: "0.2.0", buildCommit: "abc", platform: "darwin", architecture: "arm64" };
  return {
    importId: "portable-judge-1",
    sourceSha256: "sha256:source-export",
    threadId: 41,
    title: "Imported debugging run",
    producer,
    turns: [
      { sourceTurnId: "turn:1", interactionId: 51, graphNodeId: 61, completionStatus: "accepted" },
      { sourceTurnId: "turn:2", interactionId: 52, graphNodeId: 62, completionStatus: "failed" },
      { sourceTurnId: "turn:3", interactionId: 53, graphNodeId: 63, completionStatus: "running" },
    ],
    ...overrides,
  };
}

function importedThreadDetail() {
  return {
    thread: { id: 41, title: "Imported debugging run", imported: true },
    interactions: [
      { id: 51, sequence: 1, text: "Accepted request", graphNodeId: 61, completionStatus: "accepted", completionOutput: acceptedOutput() },
      { id: 52, sequence: 2, text: "Failed request", graphNodeId: 62, completionStatus: "failed", completionOutput: null },
      { id: 53, sequence: 3, text: "Running request", graphNodeId: 63, completionStatus: "running", completionOutput: null },
    ],
  };
}

function acceptedOutput() {
  const node = { id: 2, kind: "concept", icon: "queue", title: "Queue", detail: "Tasks wait here.", state: "accepted" };
  const layer = { id: 10, nodes: [2], edges: [], state: "accepted" };
  return {
    nodeId: 61,
    rootAction: { id: 11, sourceNodeId: 61, sourceLayerId: null, kind: "navigate", relation: "expand", label: "Response", targetLayerId: 10, state: "accepted" },
    rootLayer: { layer, nodes: [node], edges: [], actions: [] },
  };
}

function cyclicAcceptedLayers() {
  const node = (id, title) => ({ id, kind: "concept", icon: "circle", title, detail: `${title} detail`, state: "accepted" });
  const action = (id, sourceNodeId, sourceLayerId, relation, targetLayerId) => ({
    id,
    sourceNodeId,
    sourceLayerId,
    kind: "navigate",
    relation,
    label: `${relation} ${targetLayerId}`,
    targetLayerId,
    state: "accepted",
  });
  const resolved = (id, authoredNode, actions) => ({
    layer: { id, nodes: [authoredNode.id], edges: [], state: "accepted" },
    nodes: [authoredNode],
    edges: [],
    actions,
  });
  return new Map([
    ["10", resolved(10, node(2, "Root"), [
      action(11, 2, 10, "expand", 20),
      action(12, 2, 10, "reference", 30),
    ])],
    ["20", resolved(20, node(3, "Expanded"), [action(21, 3, 20, "reference", 30)])],
    ["30", resolved(30, node(4, "Shared reference"), [action(31, 4, 30, "reference", 40)])],
    ["40", resolved(40, node(5, "Cycle return"), [action(41, 5, 40, "reference", 30)])],
  ]);
}

function importedBackend(receipt, detail) {
  return vi.fn(async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method || "GET";
    if (path === "/api/internal/conversation-imports" && method === "POST") return jsonResponse(receipt);
    if (path === "/api/internal/conversation-imports" && method === "PUT") return jsonResponse({ published: true });
    if (path === `/api/threads/${receipt.threadId}` && method === "GET") return jsonResponse(detail);
    return jsonResponse({ error: `Unexpected request: ${method} ${path}` }, 404);
  });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
