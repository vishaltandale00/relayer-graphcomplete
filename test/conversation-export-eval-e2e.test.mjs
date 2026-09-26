import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  EdgeObject,
  LayerLayoutObject,
  LayerObject,
  NodeObject,
  NodePlacementObject,
  RelayerGraphClient,
  assetRef,
  html,
} from "@relayer/graph-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EvalService } from "../desktop/eval-main/eval-service.mjs";
import { createConversationExportService } from "../desktop/main/services/conversation-export.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { restoreLayerPath } from "../desktop/renderer/src/product-workspace/model.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const services = [];
const directories = [];
const PORTABLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#2563eb"/></svg>`;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0).reverse()) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("conversation export to Eval end to end", () => {
  it("exports real ordinary bytes, imports immutable review state, judges accepted turns, and survives restart", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-conversation-e2e-"));
    directories.push(dataDirectory);
    const projectDirectory = join(dataDirectory, "private-project-path");
    await mkdir(projectDirectory);
    const canonicalProjectPath = await realpath(projectDirectory);
    const configurationPath = join(dataDirectory, "conversation-e2e.yaml");
    await writeFile(configurationPath, [
      "schemaVersion: 1",
      "name: fixture-conversation-e2e",
      "implementation: fixture.task-system",
      "implementationVersion: 1",
      "permissionBindings:",
      "  ask: {}",
      "  auto: {}",
      "  full: {}",
      "modelCompatibility:",
      "  - providerId: codex",
      "executionAccessContracts: [managed-runtime@1]",
      "settings: {}",
      "",
    ].join("\n"));

    const runtime = new GraphCompleteRuntimeService({
      userDataDirectory: dataDirectory,
      graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
      configurationPaths: [configurationPath],
      additionalImplementations: { "fixture.task-system": complexConversationFactory(canonicalProjectPath) },
      acquireProviderExecution: async (providerId) => ({
        definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
        descriptor: {
          adapterId: "codex-subscription",
          accessContract: "managed-runtime@1",
          implementationVersion: "1",
        },
        runtime: { async executionAccess() { return { kind: "managed-runtime", environment: {} }; } },
        async release() {},
      }),
    });
    services.push(runtime);
    const runtimeSession = await runtime.start();
    const product = new RelayerAppServerService({
      userDataDirectory: dataDirectory,
      binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
      webDirectory: join(repositoryRoot, "desktop", "renderer"),
      permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
      runtimeSession,
      defaultHarnessConfiguration: "fixture-conversation-e2e",
      allowHarnessOverride: true,
      allowConversationImport: true,
      enableReadOnlySession: true,
      exportProducer: {
        desktopVersion: "e2e-fixture",
        buildCommit: "0000000000000000000000000000000000000000",
        platform: "darwin",
        architecture: "arm64",
      },
    });
    services.push(product);
    let productSession = await product.start();
    await product.publishProviderCatalog(fixtureCatalog());

    const project = await productRequest(productSession, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ path: projectDirectory }),
    });
    const fixtureFamily = await productRequest(productSession, "/api/model-families", {
      method: "POST",
      body: JSON.stringify({
        name: "Fixture models",
        enabled: true,
        members: [{ providerId: "codex", modelId: "fixture-model" }],
      }),
    });
    const selection = {
      familyId: fixtureFamily.id,
      providerId: "codex",
      modelId: "fixture-model",
    };
    const thread = await productRequest(productSession, "/api/threads", {
      method: "POST",
      body: JSON.stringify({
        title: `Debug ${canonicalProjectPath}`,
        initialMessage: `Map the fixture without disclosing ${canonicalProjectPath}`,
        projectId: project.id,
        permissionProfileId: "auto",
        harnessId: "fixture-conversation-e2e",
        modelSelection: selection,
      }),
    });
    let detail = await waitForStatus(productSession, thread.id, 0, "accepted");
    const first = detail.interactions[0];
    const invoke = first.completionOutput.rootLayer.actions.find((action) => action.kind === "invoke");
    expect(invoke).toBeTruthy();

    const invoked = await productRequest(
      productSession,
      `/api/threads/${thread.id}/interactions/${first.id}/actions/${invoke.id}/invoke`,
      { method: "POST" },
    );
    expect(invoked).toMatchObject({ created: true, invocation: { sourceInteractionId: first.id, actionId: invoke.id } });
    detail = await waitForStatus(productSession, thread.id, 1, "accepted");

    await productRequest(productSession, `/api/threads/${thread.id}/interactions`, {
      method: "POST",
      body: JSON.stringify({ text: "FAIL_FIXTURE", modelSelection: selection }),
    });
    detail = await waitForStatus(productSession, thread.id, 2, "failed");
    await productRequest(productSession, `/api/threads/${thread.id}/interactions`, {
      method: "POST",
      body: JSON.stringify({ text: "RUNNING_FIXTURE", modelSelection: selection }),
    });
    detail = await waitForStatus(productSession, thread.id, 3, "running");
    expect(detail.interactions.map((turn) => turn.completionStatus)).toEqual([
      "accepted", "accepted", "failed", "running",
    ]);

    const exportPath = join(dataDirectory, "owner-selected-export.jsonl");
    const dialog = { showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: exportPath })) };
    const desktopExport = createConversationExportService({
      dialog,
      getWindow: () => ({ id: "ordinary-product-window" }),
      exportConversation: (threadId) => product.exportConversation(threadId),
      createTemporaryId: () => "deterministic-e2e",
    });
    await expect(desktopExport.save(thread.id)).resolves.toEqual({ status: "saved" });
    expect(dialog.showSaveDialog).toHaveBeenCalledOnce();
    const exactExportBytes = await readFile(exportPath);
    const records = exactExportBytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);
    const contentRecords = records.filter(({ recordType }) => recordType === "visualAssetContent");
    const turnRecords = records.filter(({ recordType }) => recordType === "turn");
    expect(records.map(({ recordType }) => recordType)).toEqual(["header", "visualAssetContent", "turn", "turn", "turn", "turn"]);
    expect(records[0].turns).toEqual(turnRecords.map(({ id, sequence }) => ({ id, sequence })));
    expect(turnRecords.map((turn) => turn.completion.status)).toEqual([
      "accepted", "accepted", "failed", "running",
    ]);
    expect(turnRecords[0].acceptedView.layers.map((layer) => layer.layer.id)).toHaveLength(5);
    expect(turnRecords[0].acceptedView.layers.flatMap((layer) => layer.actions).filter((action) => action.relation === "reference")).toHaveLength(4);
    const exportedRoot = turnRecords[0].acceptedView.layers.find(
      (layer) => layer.layer.id === turnRecords[0].acceptedView.rootLayerId,
    );
    expect(contentRecords).toHaveLength(1);
    const exportedAssetNode = exportedRoot.nodes.find((node) => node.clientKey === "root");
    expect(exportedAssetNode.authoredDetailAssets).toHaveLength(1);
    expect(exportedAssetNode.authoredDetailAssets[0]).toMatchObject({
      digestSha256: contentRecords[0].digestSha256,
      mediaType: "image/svg+xml",
      byteLength: Buffer.from(contentRecords[0].contentBase64, "base64").length,
    });
    expect(exportedRoot.layer.layout).toMatchObject({ version: 1 });
    expect(exportedRoot.layer.layout.placements.map(({ x, y }) => [x, y])).toEqual([
      [0.2, 0.35],
      [0.8, 0.65],
    ]);
    const exportedText = exactExportBytes.toString("utf8");
    expect(exportedText).not.toContain(canonicalProjectPath);
    expect(exportedText).not.toMatch(/relayer_control|graphControlToken|harnessControlToken|privateRationale|draft/i);

    const judgeCalls = [];
    const stateFile = join(dataDirectory, "eval-data", "test-runs.json");
    let evalService = await new EvalService({
      stateFile,
      productSession,
      configurationPaths: [],
      conversationImportEnabled: true,
      simulatedUserJudgeRunner: async (context) => {
        judgeCalls.push(context);
        return simulatedJudgeResult(context.turn.id);
      },
    }).open();
    const imported = await evalService.importConversation(exportPath);
    const importedExecution = imported.executions[0];
    expect(importedExecution.turns.map((turn) => turn.status)).toEqual(["accepted", "accepted", "failed", "running"]);
    expect(await readFile(join(dataDirectory, "eval-data", imported.sourceRef))).toEqual(exactExportBytes);

    const legacyRecords = structuredClone(records).filter(({ recordType }) => recordType !== "visualAssetContent");
    for (const node of legacyRecords.slice(1).flatMap((turn) => turn.acceptedView?.layers ?? []).flatMap((layer) => layer.nodes)) {
      delete node.authoredDetailAssets;
    }
    const legacyPath = join(dataDirectory, "legacy-metadata-only-export.jsonl");
    await writeFile(legacyPath, `${legacyRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const legacyImport = await evalService.importConversation(legacyPath);
    const legacyReexportBytes = await product.exportConversation(legacyImport.executions[0].threadIds[0]);
    const legacyReexport = Buffer.from(legacyReexportBytes).toString("utf8").trimEnd().split("\n").map(JSON.parse);
    expect(legacyReexport.some(({ recordType }) => recordType === "visualAssetContent")).toBe(false);
    expect(legacyReexport.slice(1).flatMap((turn) => turn.acceptedView?.layers ?? []).flatMap((layer) => layer.nodes)
      .every((node) => node.authoredDetailAssets === undefined)).toBe(true);

    const importedDetail = await productRequest(productSession, `/api/threads/${importedExecution.threadIds[0]}`);
    expect(importedDetail.thread).toMatchObject({ imported: true });
    expect(importedDetail.interactions.map((turn) => turn.completionStatus)).toEqual([
      "accepted", "accepted", "failed", "running",
    ]);
    expect(importedDetail.interactions[0].id).not.toBe(first.id);
    const importedFirst = importedDetail.interactions[0];
    expect(importedDetail.interactions.every((turn) => Number.isSafeInteger(turn.id))).toBe(true);
    expect(importedDetail.interactions.filter((turn) => turn.completionStatus === "accepted").every((turn) => Number.isSafeInteger(turn.graphNodeId))).toBe(true);
    expect(turnRecords.every((turn) => /^turn:\d+$/.test(turn.id))).toBe(true);
    expect(records.filter((record) => record.recordType === "turn" && record.acceptedView).every((turn) => (
      /^node:\d+$/.test(turn.acceptedView.interactionNodeId)
      && /^action:\d+$/.test(turn.acceptedView.rootAction.id)
      && turn.acceptedView.layers.every((layer) => (
        /^layer:\d+$/.test(layer.layer.id)
        && layer.nodes.every((node) => /^node:\d+$/.test(node.id))
        && layer.actions.every((action) => /^action:\d+$/.test(action.id))
      ))
    ))).toBe(true);
    const rootLayer = importedFirst.completionOutput.rootLayer;
    const importedAssetNode = rootLayer.nodes.find((node) => node.clientKey === "root");
    const importedAsset = importedAssetNode.authoredDetail.assets[0];
    const importedAssetResponse = await productRequest(
      productSession,
      `/api/threads/${importedDetail.thread.id}/interactions/${importedFirst.id}/nodes/${importedAssetNode.id}/detail-assets/${importedAsset.id}?layerId=${rootLayer.layer.id}`,
    );
    expect(importedAssetResponse).toMatchObject({
      digestSha256: contentRecords[0].digestSha256,
      contentBase64: contentRecords[0].contentBase64,
    });
    expect(rootLayer.layer.layout).toMatchObject({ version: 1 });
    expect(rootLayer.layer.layout.placements.map(({ x, y }) => [x, y])).toEqual([
      [0.2, 0.35],
      [0.8, 0.65],
    ]);
    const rootExpand = rootLayer.actions.find((action) => action.relation === "expand");
    const rootReference = rootLayer.actions.find((action) => action.relation === "reference");
    const expanded = await loadLayer(productSession, importedDetail.thread.id, importedFirst.id, rootExpand.targetLayerId);
    const nestedExpand = expanded.actions.find((action) => action.relation === "expand");
    const nested = await loadLayer(productSession, importedDetail.thread.id, importedFirst.id, nestedExpand.targetLayerId);
    expect(nested.nodes[0].title).toBe("Nested expansion");
    const restored = await restoreLayerPath(importedFirst, [
      { layerId: rootLayer.layer.id, viaActionId: null },
      { layerId: rootReference.targetLayerId, viaActionId: rootReference.id },
    ], (layerId) => loadLayer(productSession, importedDetail.thread.id, importedFirst.id, layerId));
    const cycleAction = restored.layer.actions.find((action) => action.relation === "reference");
    const cycleLayer = await loadLayer(productSession, importedDetail.thread.id, importedFirst.id, cycleAction.targetLayerId);
    expect(cycleLayer.actions.some((action) => String(action.targetLayerId) === String(restored.layer.layer.id))).toBe(true);

    const deterministic = await evalService.judgeImportedConversation(
      importedExecution.id,
      "deterministic-graph-contract",
    );
    expect(deterministic.executions[0].turns.map((turn) => turn.judgeEligible)).toEqual([true, true, false, false]);
    const simulated = await evalService.judgeImportedConversation(importedExecution.id, "simulated-user");
    expect(judgeCalls).toHaveLength(2);
    expect(simulated.executions[0].turns.slice(2).every((turn) => turn.judgeResults.length === 0)).toBe(true);

    const readOnly = { ...productSession, cookie: productSession.readOnlyCookie };
    await expect(productRequest(readOnly, `/api/threads/${importedDetail.thread.id}/interactions`, {
      method: "POST",
      body: JSON.stringify({ text: "mutate imported review", modelSelection: selection }),
    })).rejects.toMatchObject({ status: 403, code: "read_only_session" });
    await expect(productRequest(productSession, `/api/threads/${importedDetail.thread.id}/interactions`, {
      method: "POST",
      body: JSON.stringify({ text: "mutate imported review", modelSelection: selection }),
    })).rejects.toMatchObject({
      status: 422,
      code: "invalid_input",
      message: "imported conversations are immutable",
    });
    const importedInvoke = importedFirst.completionOutput.rootLayer.actions.find((action) => action.kind === "invoke");
    await expect(productRequest(
      productSession,
      `/api/threads/${importedDetail.thread.id}/interactions/${importedFirst.id}/actions/${importedInvoke.id}/invoke`,
      { method: "POST" },
    )).rejects.toMatchObject({
      status: 422,
      code: "invalid_input",
      message: "imported conversation actions cannot execute",
    });

    await product.close();
    await runtime.close();
    const restartedRuntime = new GraphCompleteRuntimeService({
      userDataDirectory: dataDirectory,
      graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
      configurationPaths: [configurationPath],
      additionalImplementations: { "fixture.task-system": complexConversationFactory(canonicalProjectPath) },
    });
    services.push(restartedRuntime);
    const restartedRuntimeSession = await restartedRuntime.start();
    const restartedProduct = new RelayerAppServerService({
      userDataDirectory: dataDirectory,
      binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
      webDirectory: join(repositoryRoot, "desktop", "renderer"),
      permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
      runtimeSession: restartedRuntimeSession,
      defaultHarnessConfiguration: "fixture-conversation-e2e",
      allowHarnessOverride: true,
      allowConversationImport: true,
      enableReadOnlySession: true,
    });
    services.push(restartedProduct);
    productSession = await restartedProduct.start();

    evalService = await new EvalService({
      stateFile,
      productSession,
      configurationPaths: [],
      conversationImportEnabled: true,
    }).open();
    const replay = evalService.getRun(imported.id);
    expect(replay.executions[0].threadIds).toEqual(importedExecution.threadIds);
    expect(evalService.reviewContext(importedExecution.id)).toMatchObject({
      readOnly: true,
      origin: { kind: "external-conversation-export", sourceSha256: importedExecution.origin.sourceSha256 },
    });
    const replayLayer = await loadLayer(
      productSession,
      importedDetail.thread.id,
      importedFirst.id,
      rootReference.targetLayerId,
    );
    expect(replayLayer.nodes[0].title).toBe("Shared reference");
    const replayAsset = await productRequest(
      productSession,
      `/api/threads/${importedDetail.thread.id}/interactions/${importedFirst.id}/nodes/${importedAssetNode.id}/detail-assets/${importedAsset.id}?layerId=${rootLayer.layer.id}`,
    );
    expect(replayAsset.contentBase64).toBe(contentRecords[0].contentBase64);

    const foreignRecords = structuredClone(records);
    const foreignFirstTurn = foreignRecords.find(({ recordType }) => recordType === "turn");
    const foreignPath = "/foreign-host/private/workspace/credentials.txt";
    foreignRecords[0].conversation.title = `Foreign visible text ${foreignPath}`;
    foreignFirstTurn.text = `Explain visible source text ${foreignPath}`;
    foreignFirstTurn.acceptedView.layers[0].nodes[0].detail = `Untrusted source text ${foreignPath}`;
    const foreignSource = join(dataDirectory, "foreign-visible-content.jsonl");
    const foreignBytes = Buffer.from(`${foreignRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
    await writeFile(foreignSource, foreignBytes);
    const foreignRun = await evalService.importConversation(foreignSource);
    const foreignExecution = foreignRun.executions[0];
    const foreignDetail = await productRequest(productSession, `/api/threads/${foreignExecution.threadIds[0]}`);
    expect(foreignDetail.thread).toMatchObject({ imported: true, title: `Foreign visible text ${foreignPath}` });
    expect(foreignDetail.interactions[0].text).toContain(foreignPath);
    expect(foreignDetail.interactions[0].completionOutput.rootLayer.nodes[0].detail).toContain(foreignPath);
    expect(typeof foreignDetail.interactions[0].id).toBe("number");
    expect(typeof foreignDetail.interactions[0].graphNodeId).toBe("number");
    expect(typeof foreignDetail.interactions[0].completionOutput.rootLayer.layer.id).toBe("number");
    expect(await readFile(join(dataDirectory, "eval-data", foreignRun.sourceRef))).toEqual(foreignBytes);
    await expect(productRequest(productSession, `/api/threads/${foreignDetail.thread.id}/interactions`, {
      method: "POST",
      body: JSON.stringify({ text: "Imported foreign text must stay inert", modelSelection: selection }),
    })).rejects.toMatchObject({
      status: 422,
      code: "invalid_input",
      message: "imported conversations are immutable",
    });

    await expectHostileImports({ evalService, exportPath, exactExportBytes, dataDirectory });
  }, 45_000);
});

function complexConversationFactory(projectPath) {
  const centeredLayout = (node) => new LayerLayoutObject([
    new NodePlacementObject(node, 0.5, 0.5),
  ]);
  return () => ({
    traceSupport: () => ({
      prompt: "none", messages: "none", reasoningSummaries: "none", modelCalls: "none",
      toolCalls: "none", usage: "none", childStreams: "none", nativeArtifacts: "none",
    }),
    state: () => ({}),
    async complete(context, signal) {
      if (context.inputGraph.detail === "FAIL_FIXTURE") throw new Error(`fixture failure at ${projectPath}`);
      if (context.inputGraph.detail === "RUNNING_FIXTURE") {
        await new Promise((resolvePromise) => signal.addEventListener("abort", resolvePromise, { once: true }));
        throw new Error("fixture aborted");
      }
      const graph = new RelayerGraphClient(context.graph.acquireCapability());
      if (context.inputGraph.detail === "Explain the imported-safe follow-up") {
        const followup = new NodeObject("info", "Action-created follow-up", "The invoke action created this accepted turn.", "concept", "followup");
        await graph.submitNode(followup);
        const layer = new LayerObject([followup], [], centeredLayout(followup), "followup-layer");
        await graph.submitLayer(layer);
        await graph.addAction(context.inputGraph.id, { kind: "navigate", relation: "expand", label: "Response", target: layer, clientKey: "followup-root" });
        await graph.submit(context.inputGraph.id);
        return;
      }
      const rootNode = new NodeObject("info", "Root answer", `Portable detail replaces ${projectPath}.`, "concept", "root");
      const assetScope = await graph.visualAssets.scope();
      const asset = await graph.visualAssets.add({
        scope: assetScope,
        name: "Portable status illustration",
        file: {
          name: "portable-status.svg",
          mediaType: "image/svg+xml",
          async read() { return new TextEncoder().encode(PORTABLE_SVG); },
        },
      });
      rootNode.detailAuthoring.setComponent(
        "portable-visual",
        html`<figure><img alt="Portable status illustration" asset=${assetRef(asset.id)}></figure>`,
      );
      const rootEvidenceNode = new NodeObject("link", "Root evidence", "Portable layout keeps this evidence offset from the answer.", "evidence", "root-evidence");
      const expandedNode = new NodeObject("info", "Expanded detail", "First expansion.", "detail", "expanded");
      const nestedNode = new NodeObject("info", "Nested expansion", "Second expansion.", "detail", "nested");
      const sharedNode = new NodeObject("info", "Shared reference", "Referenced from root and expansion.", "evidence", "shared");
      const cycleNode = new NodeObject("info", "Reference cycle", "References the shared layer again.", "evidence", "cycle");
      for (const node of [rootNode, rootEvidenceNode, expandedNode, nestedNode, sharedNode, cycleNode]) await graph.submitNode(node);
      const rootEdge = new EdgeObject([rootNode, rootEvidenceNode], "root-evidence-edge");
      await graph.createEdge(rootEdge);
      const root = new LayerObject(
        [rootNode, rootEvidenceNode],
        [rootEdge],
        new LayerLayoutObject([
          new NodePlacementObject(rootNode, 0.2, 0.35),
          new NodePlacementObject(rootEvidenceNode, 0.8, 0.65),
        ]),
        "root-layer",
      );
      const expanded = new LayerObject([expandedNode], [], centeredLayout(expandedNode), "expanded-layer");
      const nested = new LayerObject([nestedNode], [], centeredLayout(nestedNode), "nested-layer");
      const shared = new LayerObject([sharedNode], [], centeredLayout(sharedNode), "shared-layer");
      const cycle = new LayerObject([cycleNode], [], centeredLayout(cycleNode), "cycle-layer");
      for (const layer of [root, expanded, nested, shared, cycle]) await graph.submitLayer(layer);
      await graph.addAction(rootNode, { kind: "navigate", relation: "expand", sourceLayer: root, label: "Expand", target: expanded, clientKey: "root-expand" });
      await graph.addAction(expandedNode, { kind: "navigate", relation: "expand", sourceLayer: expanded, label: "Expand again", target: nested, clientKey: "nested-expand" });
      await graph.addAction(rootNode, { kind: "navigate", relation: "reference", sourceLayer: root, label: "Shared", target: shared, clientKey: "root-shared" });
      await graph.addAction(expandedNode, { kind: "navigate", relation: "reference", sourceLayer: expanded, label: "Shared again", target: shared, clientKey: "expanded-shared" });
      await graph.addAction(sharedNode, { kind: "navigate", relation: "reference", sourceLayer: shared, label: "Cycle forward", target: cycle, clientKey: "shared-cycle" });
      await graph.addAction(cycleNode, { kind: "navigate", relation: "reference", sourceLayer: cycle, label: "Cycle back", target: shared, clientKey: "cycle-shared" });
      await graph.addAction(rootNode, { kind: "invoke", sourceLayer: root, label: "Follow up", interactionText: "Explain the imported-safe follow-up", clientKey: "followup" });
      await graph.addAction(context.inputGraph.id, { kind: "navigate", relation: "expand", label: "Response", target: root, clientKey: "response" });
      await graph.submit(context.inputGraph.id);
    },
  });
}

function fixtureCatalog() {
  return {
    providerId: "codex",
    label: "Fixture provider",
    connected: true,
    models: [{ id: "fixture-model", label: "Fixture model", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }],
    systemFamily: { key: "codex", name: "Codex", modelIds: ["fixture-model"] },
  };
}

async function productRequest(session, path, options = {}) {
  const response = await fetch(new URL(path, session.origin), {
    ...options,
    headers: {
      ...options.headers,
      Cookie: `${session.cookie.name}=${session.cookie.value}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error || `Product request failed (${response.status}).`), value, { status: response.status });
  return value;
}

async function waitForStatus(session, threadId, turnIndex, status) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const detail = await productRequest(session, `/api/threads/${threadId}`);
    if (detail.interactions[turnIndex]?.completionStatus === status) return detail;
    if (detail.interactions[turnIndex]?.completionStatus === "failed" && status !== "failed") {
      throw new Error(`Turn ${turnIndex + 1} failed: ${detail.interactions[turnIndex].completionError}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Turn ${turnIndex + 1} did not reach ${status}.`);
}

function loadLayer(session, threadId, interactionId, layerId) {
  return productRequest(session, `/api/threads/${threadId}/interactions/${interactionId}/layers/${layerId}`);
}

function simulatedJudgeResult(turnId) {
  return {
    status: "completed",
    passed: true,
    rubricRef: `rubric-${turnId}.json`,
    configurationRef: `configuration-${turnId}.json`,
    interactionTraceRef: `trace-${turnId}.json`,
    screenshotRefs: [`screenshots/${turnId}/metadata.json`],
    reviewRef: `review-${turnId}.json`,
    coverageRef: `coverage-${turnId}.json`,
    review: { turn: { ratings: { answer_quality: 4 } } },
    coverage: { complete: true, missingSubjects: [] },
    summary: "Deterministic simulated review.",
  };
}

async function expectHostileImports({ evalService, exportPath, exactExportBytes, dataDirectory }) {
  const hostile = async (name, bytes, pattern) => {
    const path = join(dataDirectory, `${name}.jsonl`);
    await writeFile(path, bytes);
    await expect(evalService.importConversation(path)).rejects.toThrow(pattern);
  };
  await hostile("malformed", Buffer.from("{not-json}\n"), /JSON|json/i);
  await hostile("truncated", exactExportBytes.subarray(0, exactExportBytes.length - 8), /JSON|truncated|line/i);
  const newer = exactExportBytes.toString("utf8").replace('"exportVersion":1', '"exportVersion":999');
  await hostile("newer", Buffer.from(newer), /version|unsupported/i);
  const maliciousRecords = exactExportBytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);
  const invalidPng = Buffer.from("this is not a PNG");
  const maliciousDigest = createHash("sha256").update(invalidPng).digest("hex");
  const maliciousContent = maliciousRecords.find(({ recordType }) => recordType === "visualAssetContent");
  const originalDigest = maliciousContent.digestSha256;
  Object.assign(maliciousContent, {
    digestSha256: maliciousDigest,
    mediaType: "image/png",
    byteLength: invalidPng.length,
    contentBase64: invalidPng.toString("base64"),
  });
  for (const node of maliciousRecords.slice(1).flatMap((turn) => turn.acceptedView?.layers ?? []).flatMap((layer) => layer.nodes)) {
    for (const association of node.authoredDetailAssets ?? []) {
      if (association.digestSha256 !== originalDigest) continue;
      association.digestSha256 = maliciousDigest;
      association.mediaType = "image/png";
      association.byteLength = invalidPng.length;
    }
    for (const pin of node.authoredDetail?.assets ?? []) {
      if (pin.digestSha256 !== originalDigest) continue;
      pin.digestSha256 = maliciousDigest;
      pin.mediaType = "image/png";
    }
    if (node.authoredDetail?.assets?.some((pin) => pin.digestSha256 === maliciousDigest)) {
      node.authoredDetail.integritySha256 = createHash("sha256").update(canonicalJson({
        version: node.authoredDetail.version,
        components: node.authoredDetail.components,
        mounts: node.authoredDetail.mounts,
        assets: node.authoredDetail.assets,
      })).digest("hex");
    }
  }
  const importsBeforeInvalidMedia = await productRequest(
    evalService.productSession,
    "/api/internal/conversation-imports",
  );
  await hostile(
    "malicious-media",
    Buffer.from(`${maliciousRecords.map((record) => JSON.stringify(record)).join("\n")}\n`),
    /png|media|malformed|signature/i,
  );
  expect(await productRequest(
    evalService.productSession,
    "/api/internal/conversation-imports",
  )).toEqual(importsBeforeInvalidMedia);
  const oversizedService = await new EvalService({
    stateFile: join(dataDirectory, "eval-data", "oversized-state.json"),
    productSession: evalService.productSession,
    configurationPaths: [],
    conversationImportEnabled: true,
    conversationImportMaxBytes: exactExportBytes.length - 1,
  }).open();
  await expect(oversizedService.importConversation(exportPath)).rejects.toThrow(/exceeds/i);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
