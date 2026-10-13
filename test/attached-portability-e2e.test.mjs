import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { restoreHistoricalInvokePolicy } from "./support/historical-invoke-policy.mjs";
import { pathToFileURL } from "node:url";
import { createShareServiceClient } from "../desktop/main/services/share-service-client.mjs";
import { renderPublicViewerTemplate } from "../desktop/renderer/src/public-share-viewer/template.js";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { LayerObject, LayerLayoutObject, NodeObject, NodePlacementObject, RelayerGraphClient, assetRef, detailCapability, html, css } from "@relayer/graph-client";
import { createDesktopGraphRuntime } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { EvalService } from "../desktop/eval-main/eval-service.mjs";
import { parseConversationExportV1 } from "../desktop/renderer/src/public-share-viewer/snapshot.js";
import { createPublicViewerAdapter } from "../desktop/renderer/src/public-share-viewer/adapter.js";
import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";
import { mountCompiledNodeDetail } from "../desktop/renderer/src/product-workspace/node-detail-runtime.js";

const root = resolve(import.meta.dirname, "..");
const services = [];
const directories = [];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#2563eb"/></svg>';
const privateKey = "sk-proj-attached-portability-private-key";
const centered = (node) => new LayerLayoutObject([new NodePlacementObject(node, .5, .5)], "default");

afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it("preserves accepted attached navigation, converted invokes, rich controls and assets through ordinary import and public sharing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relayer-attached-portability-"));
  directories.push(directory);
  const projectPath = join(directory, "private-project");
  await mkdir(projectPath);
  const configurationPath = join(directory, "fixture.yaml");
  await writeFile(configurationPath, `schemaVersion: 1\nname: fixture-attached-portability\nimplementation: fixture.task-system\nimplementationVersion: 1\npermissionBindings:\n  ask: {}\n  auto: {}\n  full: {}\nmodelCompatibility:\n  - providerId: codex\nexecutionAccessContracts: [managed-runtime@1]\nsettings: {}\n`);
  const fixture = { calls: 0, omittedResponseRejected: false };
  const runtime = createDesktopGraphRuntime({
    userDataDirectory: directory,
    graphServerBinary: join(root, "target/debug/relayer-graph-server"),
    configurationPaths: [configurationPath],
    additionalImplementations: { "fixture.task-system": fixtureFactory(fixture) },
    acquireProviderExecution: async (providerId) => ({
      definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
      descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
      runtime: { async executionAccess() { return { kind: "managed-runtime", environment: {} }; } },
      async release() {},
    }),
  });
  services.push(runtime);
  const runtimeSession = await runtime.start();
  const product = new RelayerAppServerService({
    userDataDirectory: directory, binaryPath: join(root, "target/debug/relayer-app-server"),
    webDirectory: join(root, "desktop/renderer"), permissionCatalogPath: join(root, "permissions/desktop.json"),
    runtimeSession, defaultHarnessConfiguration: "fixture-attached-portability", allowHarnessOverride: true,
    allowConversationImport: true, enableReadOnlySession: true,
    exportProducer: { desktopVersion: "portability-fixture", buildCommit: "0".repeat(40), platform: "darwin", architecture: "arm64" },
  });
  services.push(product);
  const session = await product.start();
  await product.seedProviderCatalog({ providerId: "codex", label: "Fixture", connected: true,
    models: [{ id: "fixture-model", label: "Fixture", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }],
    systemFamily: { key: "codex", name: "Codex", modelIds: ["fixture-model"] } });
  const project = await request(session, "/api/projects", { path: projectPath });
  const family = await request(session, "/api/model-families", { name: "Fixture", enabled: true, members: [{ providerId: "codex", modelId: "fixture-model" }] });
  const modelSelection = { familyId: family.id, providerId: "codex", modelId: "fixture-model" };
  const thread = await request(session, "/api/threads", { title: "Attached portability", initialMessage: "SOURCE", projectId: project.id,
    permissionProfileId: "auto", harnessId: "fixture-attached-portability", modelSelection });
  let detail = await accepted(session, thread.id, 0);
  const source = detail.interactions[0];
  const sourceLayer = source.completionOutput.rootLayer;
  const invoke = sourceLayer.actions[0];
  // This portability checkpoint is specifically about historical converted
  // invokes. New reusable Invocation replay belongs to its separate protocol.
  const legacyGraph = new DatabaseSync(join(directory, "graphcomplete-runtime/graph.sqlite3"));
  try {
    restoreHistoricalInvokePolicy(legacyGraph, invoke.id);
    legacyGraph.exec("DROP TRIGGER completion_contract_marker_guard; DROP TRIGGER completion_contract_delete_guard;");
    legacyGraph.prepare("UPDATE completion_states SET completion_contract_digest=NULL WHERE interaction_node_id=?").run(source.graphNodeId);
    legacyGraph.prepare("DELETE FROM completion_contracts WHERE interaction_node_id=?").run(source.graphNodeId);
  } finally { legacyGraph.close(); }
  const invocation = await request(session, `/api/threads/${thread.id}/interactions/${source.id}/actions/${invoke.id}/invoke`, {});
  expect(invocation.created).toBe(true);
  detail = await accepted(session, thread.id, 1);
  await request(session, `/api/threads/${thread.id}/interactions`, { text: "ATTACH", modelSelection, inputId: "attached-portability",
    contexts: [{ target: { nodeId: invoke.sourceNodeId, sourceInteractionNodeId: source.graphNodeId, sourceLayerId: sourceLayer.layer.id }, annotations: ["Add the new response"] }] });
  detail = await accepted(session, thread.id, 2);
  expect(fixture.calls).toBe(3);
  expect(fixture.omittedResponseRejected).toBe(true);

  const bytes = await product.exportConversation(thread.id);
  const records = decode(bytes);
  expect(records[0].exportVersion).toBe(3);
  const turns = records.filter((record) => record.recordType === "turn");
  expect(turns[2].contexts[0].source.ownerTurnId).toBe(turns[0].id);
  const content = records.filter((record) => record.recordType === "visualAssetContent");
  expect(content).toHaveLength(1);
  expect(Buffer.from(content[0].contentBase64, "base64").toString()).toBe(svg);
  const currentRoot = turns[0].acceptedView.layers.find((layer) => layer.layer.id === turns[0].acceptedView.rootLayerId);
  const converted = currentRoot.actions.find((action) => action.convertedFromInvoke);
  const added = currentRoot.actions.find((action) => action.relation === "reference");
  expect(converted).toMatchObject({ kind: "navigate", relation: "expand", targetLayerId: turns[1].acceptedView.rootLayerId });
  expect(added.targetLayerId).toBe(turns[2].acceptedView.rootLayerId);
  expect(added.sourceLayerId).toBeUndefined();
  const attachedRoot = turns[2].acceptedView.layers.find((layer) => layer.layer.id === turns[2].acceptedView.rootLayerId);
  expect(attachedRoot.actions.find((action) => action.label === "Reference invoked response"))
    .toMatchObject({ relation: "reference", targetLayerId: converted.targetLayerId });
  expect(turns[1].origin).toMatchObject({ kind: "action", source_action_id: converted.id });
  expect(currentRoot.nodes[0].authoredDetail.components[0].html).toContain("Attached response");
  expect(currentRoot.nodes[0].authoredDetailAssets[0].digestSha256).toBe(content[0].digestSha256);
  expect(new TextDecoder().decode(bytes)).not.toContain(await realpath(projectPath));
  expect(new TextDecoder().decode(bytes)).not.toMatch(/interactionPermissions|invokeResolutionTransitions|harnessControlToken/);

  const exportPath = join(directory, "export.jsonl");
  await writeFile(exportPath, bytes);
  const evalService = await new EvalService({ stateFile: join(directory, "eval-data/test-runs.json"), productSession: session,
    configurationPaths: [], conversationImportEnabled: true }).open();
  const imported = await evalService.importConversation(exportPath);
  const importedId = imported.executions[0].threadIds[0];
  const importedDetail = await request(session, `/api/threads/${importedId}`);
  const importedSource = importedDetail.interactions[0];
  const importedRoot = importedSource.completionOutput.rootLayer;
  const importedConverted = importedRoot.actions.find((action) => action.convertedFromInvoke);
  expect(importedConverted).toMatchObject({ kind: "navigate", relation: "expand", targetLayerId: importedDetail.interactions[1].completionOutput.rootLayer.layer.id });
  expect(importedConverted.resolvedInvokeInteractionId).toBeUndefined();
  // Exercise the production workspace dispatch and real Product layer endpoint,
  // including Eval's read-only session. An import has no native invoke receipt.
  for (const mode of ["interactive", "review"]) {
    for (const presentation of ["compiled", "ordinary"]) {
      await navigateImportedControl({ session: mode === "review" ? { ...session, cookie: session.readOnlyCookie } : session,
        detail: importedDetail, mode, presentation });
    }
  }
  expect(importedRoot.nodes[0].authoredDetail).toEqual(currentRoot.nodes[0].authoredDetail);
  await expect(request(session, `/api/threads/${importedId}/interactions`, { text: "No new authority", modelSelection })).rejects.toMatchObject({ status: 422, message: "imported conversations are immutable" });
  await expect(request(session, `/api/threads/${importedId}/interactions/${importedSource.id}/actions/${importedConverted.id}/invoke`, {})).rejects.toMatchObject({ status: 422, message: "action is not an accepted invoke action for this interaction" });
  const replay = decode(await product.exportConversation(importedId));
  expect(replay[0].exportVersion).toBe(3);
  const replayTurns = replay.filter((record) => record.recordType === "turn");
  expect(replayTurns[1].origin).toEqual(turns[1].origin);
  expect(replayTurns.map((turn) => turn.contexts)).toEqual(turns.map((turn) => turn.contexts));
  expect(replayTurns.map((turn) => turn.acceptedView)).toEqual(turns.map((turn) => turn.acceptedView));
  expect(replay.filter((record) => record.recordType === "visualAssetContent")).toEqual(content);

  const external = structuredClone(records);
  external[0].turns[0].id = "turn:original-owner";
  for (const turn of external.filter((record) => record.recordType === "turn")) {
    if (turn.id === turns[0].id) turn.id = "turn:original-owner";
    if (turn.origin.source_turn_id === turns[0].id) turn.origin.source_turn_id = "turn:original-owner";
    if (turn.origin.sourceTurnId === turns[0].id) turn.origin.sourceTurnId = "turn:original-owner";
    for (const context of turn.contexts ?? []) {
      if (context.source.ownerTurnId === turns[0].id) context.source.ownerTurnId = "turn:original-owner";
    }
  }
  for (const turn of external.filter((record) => record.recordType === "turn")) {
    for (const layer of turn.acceptedView.layers) for (const action of layer.actions) {
      if (action.convertedFromInvoke) action.sourceLayerId = "layer:999999";
    }
  }
  const externalPath = join(directory, "external-provenance.jsonl");
  await writeFile(externalPath, `${external.map(JSON.stringify).join("\n")}\n`);
  const externalImport = await evalService.importConversation(externalPath);
  const externalThread = externalImport.executions[0].threadIds[0];
  const externalDetail = await request(session, `/api/threads/${externalThread}`);
  const externalRoot = externalDetail.interactions[0].completionOutput.rootLayer;
  const externalAction = externalRoot.actions.find((action) => action.convertedFromInvoke);
  expect(externalAction.sourceLayerClientKey).toBe(sourceLayer.layer.clientKey);
  expect(externalRoot.layer.id).not.toBe(externalAction.sourceLayerId);
  const externalWindow = new Window();
  const externalHost = externalWindow.document.createElement("div");
  externalWindow.document.body.append(externalHost);
  const externalNavigate = vi.fn();
  const externalInvoke = vi.fn();
  try {
    const mounted = await mountCompiledNodeDetail({ host: externalHost, detail: externalRoot.nodes[0].authoredDetail,
      resolveAction: (reference) => externalRoot.actions.find((action) => action.clientKey === reference.clientKey
        && (!reference.sourceLayer || action.sourceLayerClientKey === reference.sourceLayer.clientKey)),
      onNavigate: externalNavigate, onInvoke: externalInvoke });
    expect(mounted.status).toBe("mounted");
    const convertedControl = [...externalHost.shadowRoot.querySelectorAll("button")].find((button) => button.textContent === "Invoked result");
    expect(convertedControl.disabled).toBe(false);
    convertedControl.click();
    await externalWindow.happyDOM.waitUntilComplete();
    expect(externalNavigate).toHaveBeenCalledWith(externalAction, expect.anything());
    expect(externalInvoke).not.toHaveBeenCalled();
    mounted.dispose();
  } finally { await externalWindow.close(); }
  const externalReplay = decode(await product.exportConversation(externalThread));
  const externalReplayTurns = externalReplay.filter((record) => record.recordType === "turn");
  expect(externalReplayTurns[2].contexts[0].source.ownerTurnId).toBe(externalReplayTurns[0].id);
  expect(externalReplayTurns[0].id).not.toBe("turn:original-owner");
  expect(externalReplay.filter((record) => record.recordType === "turn").map((turn) => turn.acceptedView))
    .toEqual(external.filter((record) => record.recordType === "turn").map((turn) => turn.acceptedView));
  expect(externalReplay.filter((record) => record.recordType === "turn")[0].acceptedView.layers)
    .toHaveLength(turns[0].acceptedView.layers.length);

  const shareBytes = await product.exportShareSnapshot(thread.id, "Public attached workflow");
  if (process.env.RELAYER_ATTACHED_PORTABILITY_CAPTURE) await writeFile(process.env.RELAYER_ATTACHED_PORTABILITY_CAPTURE, shareBytes);
  const shareText = new TextDecoder().decode(shareBytes);
  if (process.env.RELAYER_PRIVATE_SHARE_SERVICE_ROOT) {
    const harnessModule = await import(pathToFileURL(join(process.env.RELAYER_PRIVATE_SHARE_SERVICE_ROOT, "share-service/test-support/joined-production-journey.ts")).href);
    const harness = harnessModule.createJoinedProductionJourneyHarness({ viewerTemplate: renderPublicViewerTemplate });
    const client = createShareServiceClient({ endpoint: "https://share.example.test", fetchImpl: harness.fetchImpl, uploadFetchImpl: harness.uploadFetchImpl });
    const publication = { authorization: harness.authorization, snapshotBytes: shareBytes,
      attempt: { attemptId: "2".repeat(32), sourceThreadId: "synthetic-attached-workflow", title: "Public attached workflow",
        byteLength: shareBytes.byteLength, lineCount: shareText.trimEnd().split("\n").length,
        snapshotSha256: createHash("sha256").update(shareBytes).digest("hex") } };
    // The production harness loses one successful finalize response; retry must
    // recover the same immutable publication, not upload a different snapshot.
    await expect(client.publish(publication)).rejects.toMatchObject({ code: "share_service_failed" });
    const result = await client.publish(publication);
    expect(result.url).toBe(`https://share.example.test/t/${harness.shareId}`);
    const page = await harness.fetchPublicPage(harness.shareId);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("relayerPublicSnapshot");
    expect(html).toContain("convertedFromInvoke");
    expect(html).not.toContain(privateKey);
  }

  expect(shareBytes.byteLength).toBeLessThan(16 * 1024 * 1024);
  expect(shareText).not.toContain(privateKey);
  expect(shareText).not.toContain(await realpath(projectPath));
  expect(shareText).not.toMatch(/resolvedInvokeInteractionId|interactionPermissions|harnessControlToken/);
  const sharedTurns = decode(shareBytes).filter((record) => record.recordType === "turn");
  expect(sharedTurns[2].contexts[0].source.ownerTurnId).toBe(sharedTurns[0].id);
  const snapshot = parseConversationExportV1(shareText);
  expect(snapshot.header.exportVersion).toBe(3);
  const publicRoot = snapshot.interactions[0].completionOutput.rootLayer;
  const publicNode = publicRoot.nodes[0];
  expect(publicNode.authoredDetail).toBeTruthy();
  expect(publicRoot.actions.some((action) => action.convertedFromInvoke)).toBe(true);
  const adapter = createPublicViewerAdapter(snapshot);
  adapter.selectTurnById(snapshot.interactions[2].id, { responseRoot: true });
  const backlink = adapter.state.actions.find((action) => action.label === "Reference invoked response");
  await expect(adapter.navigateLayer(backlink.targetLayerId, { action: backlink, sourceNode: adapter.state.nodes[0] }))
    .resolves.toBe(true);
  expect(adapter.state.visibleLayer.layer.id).toBe(snapshot.interactions[1].completionOutput.rootLayer.layer.id);
  expect(adapter.state.nodes[0].title).toBe("Invoked response");
  const window = new Window({ url: "https://share.example.test/t/fixture" });
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const navigated = vi.fn();
  const invoked = vi.fn();
  try {
    const mounted = await mountCompiledNodeDetail({ host, detail: publicNode.authoredDetail,
      resolveAction: (reference) => publicRoot.actions.find((action) => action.clientKey === reference.clientKey
        && (!reference.sourceLayer || action.sourceLayerClientKey === reference.sourceLayer.clientKey)),
      onNavigate: navigated, onInvoke: invoked,
      resolveAsset: (asset) => snapshot.resolveNodeDetailAsset(asset),
    });
    expect(mounted.status).toBe("mounted");
    const buttons = [...host.shadowRoot.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.disabled).toBe(false);
      button.click();
      await window.happyDOM.waitUntilComplete();
    }
    expect(navigated).toHaveBeenCalledTimes(2);
    expect(invoked).not.toHaveBeenCalled();
    expect(navigated.mock.calls.map(([action]) => action.targetLayerId).sort()).toEqual(publicRoot.actions.map((action) => action.targetLayerId).sort());
    const authoredCss = [...host.shadowRoot.adoptedStyleSheets ?? []].flatMap((sheet) => [...sheet.cssRules]).map((rule) => rule.cssText).join("\n")
      || [...host.shadowRoot.querySelectorAll("style")].map((style) => style.textContent).join("\n");
    expect(authoredCss).toContain("border-radius");
    await vi.waitFor(() => expect(host.shadowRoot.querySelector("img").dataset.assetState).toBe("available"));
    mounted.dispose();
  } finally { await window.close(); }
  expect(() => parseConversationExportV1(" ".repeat(16 * 1024 * 1024 + 1))).toThrow(/limit|large/i);

  // A separate source without an invoke proves V3 survives import solely from
  // its node-owned attached navigation, with no conversion marker to mask loss.
  const pure = await request(session, "/api/threads", { title: "Only attached navigation", initialMessage: "PURE_SOURCE", projectId: project.id,
    permissionProfileId: "auto", harnessId: "fixture-attached-portability", modelSelection });
  const pureBefore = (await accepted(session, pure.id, 0)).interactions[0];
  const pureRoot = pureBefore.completionOutput.rootLayer;
  await request(session, `/api/threads/${pure.id}/interactions`, { text: "ATTACH_PURE", modelSelection, inputId: "pure-attached-portability",
    contexts: [{ target: { nodeId: pureRoot.nodes[0].id, sourceInteractionNodeId: pureBefore.graphNodeId, sourceLayerId: pureRoot.layer.id }, annotations: [] }] });
  await accepted(session, pure.id, 1);
  const pureBytes = await product.exportConversation(pure.id);
  const pureRecords = decode(pureBytes);
  expect(pureRecords[0].exportVersion).toBe(3);
  const pureActions = pureRecords.filter((record) => record.recordType === "turn").flatMap((turn) => turn.acceptedView.layers).flatMap((layer) => layer.actions);
  expect(pureActions).toHaveLength(1);
  expect(pureActions[0]).toMatchObject({ kind: "navigate", relation: "reference" });
  expect(pureActions[0].sourceLayerId).toBeUndefined();
  expect(pureActions[0].convertedFromInvoke).toBeUndefined();
  const purePath = join(directory, "pure-export.jsonl");
  await writeFile(purePath, pureBytes);
  const pureImport = await evalService.importConversation(purePath);
  const pureReplay = decode(await product.exportConversation(pureImport.executions[0].threadIds[0]));
  expect(pureReplay[0].exportVersion).toBe(3);
  expect(pureReplay.filter((record) => record.recordType === "turn").map((turn) => turn.acceptedView))
    .toEqual(pureRecords.filter((record) => record.recordType === "turn").map((turn) => turn.acceptedView));
  // V3 is durable even when no remaining action shape independently signals it:
  // a valid portable occurrence may retain source-layer provenance and no invoke.
  const explicit = structuredClone(pureRecords);
  const explicitTurns = explicit.filter((record) => record.recordType === "turn");
  const firstRoot = explicitTurns[0].acceptedView.layers.find((layer) => layer.layer.id === explicitTurns[0].acceptedView.rootLayerId);
  const sourceKey = firstRoot.nodes[0].clientKey;
  const layerKey = firstRoot.layer.clientKey;
  for (const turn of explicitTurns) for (const layer of turn.acceptedView.layers) {
    layer.layer.clientKey = layerKey;
    for (const node of layer.nodes) node.clientKey = sourceKey;
    for (const action of layer.actions) action.sourceLayerId = firstRoot.layer.id;
  }
  const explicitPath = join(directory, "explicit-v3-export.jsonl");
  await writeFile(explicitPath, `${explicit.map(JSON.stringify).join("\n")}\n`);
  const explicitImport = await evalService.importConversation(explicitPath);
  const explicitReplay = decode(await product.exportConversation(explicitImport.executions[0].threadIds[0]));
  expect(explicitReplay[0].exportVersion).toBe(3);
  expect(explicitReplay.filter((record) => record.recordType === "turn").map((turn) => turn.acceptedView))
    .toEqual(explicitTurns.map((turn) => turn.acceptedView));
  expect(decode(await product.exportShareSnapshot(pure.id, "Only attached navigation"))[0].exportVersion).toBe(3);
  expect(fixture.calls).toBe(5);
}, 45_000);

function fixtureFactory(state) {
  let asset;
  return () => ({
    traceSupport: () => ({ prompt: "none", messages: "none", reasoningSummaries: "none", modelCalls: "none", toolCalls: "none", usage: "none", childStreams: "none", nativeArtifacts: "none" }),
    state: () => ({}),
    async complete(context) {
      state.calls += 1;
      const graph = new RelayerGraphClient(context.graph.acquireCapability());
      const input = await graph.getInteractionInput();
      expect(input.interactionPermissions).toMatchObject({ version: "2", enabled: true });
      const isSource = ["SOURCE", "PURE_SOURCE"].includes(context.inputGraph.detail);
      const isPure = context.inputGraph.detail.endsWith("PURE") || context.inputGraph.detail === "PURE_SOURCE";
      const node = new NodeObject("info", isSource ? "Source" : context.inputGraph.detail === "ATTACH" ? "Attached response" : "Invoked response", "Portable evidence", "concept", isSource ? `${privateKey}-node` : "answer");
      const layer = new LayerObject([node], [], centered(node), isSource ? `${privateKey}-layer` : "answer-layer");
      const invoke = { kind: "invoke", sourceLayer: layer, label: "Invoke result", interactionText: "INVOKE", clientKey: `${privateKey}-invoke` };
      if (isSource) {
        asset = await graph.visualAssets.add({ scope: await graph.visualAssets.scope(), name: "Portable square", file: {
          name: "square.svg", mediaType: "image/svg+xml", async read() { return new TextEncoder().encode(svg); },
        } });
        if (!isPure) node.detailAuthoring.setComponent("card", html`<article><img alt="Portable square" asset=${assetRef(asset.id)}><button gc=${detailCapability.invoke("invoke", invoke)}>Invoke result</button></article>`, css`article { border-radius: 1rem; padding: 1rem; }`);
      }
      await graph.submitNode(node);
      await graph.submitLayer(layer);
      if (context.inputGraph.detail === "INVOKE") state.invokedLayer = layer;
      if (isSource && !isPure) await graph.addAction(node, invoke);
      await graph.addAction(context.inputGraph.id, { kind: "navigate", relation: "expand", label: "Response", target: layer, clientKey: "response" });
      if (context.inputGraph.detail.startsWith("ATTACH")) {
        const source = input.contexts[0].targetNode;
        const before = await graph.getNodePresentation(source.id);
        if (!isPure) expect(before.actions[0].resolvedInvokeInteractionId).toBeTruthy();
        await expect(graph.submit(context.inputGraph.id)).rejects.toMatchObject({ code: "attached_response_navigation_required" });
        state.omittedResponseRejected = true;
        const addition = { kind: "navigate", relation: "reference", label: "Attached response", target: layer, clientKey: `${privateKey}-attached` };
        await graph.addAction(source.id, addition);
        if (!isPure) {
          // The source expands the accepted invoke result while this later
          // completion references that same nonroot layer. Both are valid.
          await graph.addAction(node, { kind: "navigate", relation: "reference", sourceLayer: layer,
            label: "Reference invoked response", target: state.invokedLayer, clientKey: "invoked-reference" });
        }
        const replacement = new NodeObject(source.icon, source.title, source.detail, before.node.kind, before.node.clientKey);
        if (isPure) {
          replacement.detailAuthoring.setComponent("card", html`<article><button gc=${detailCapability.reference("attached", addition)}>Attached response</button></article>`, css`article { border-radius: 1rem; padding: 1rem; }`);
        } else {
        const old = before.actions[0];
        const sourceLayer = new LayerObject([replacement], [], centered(replacement), old.sourceLayerClientKey);
        const preserved = { kind: "invoke", sourceLayer, label: old.label, interactionText: "INVOKE", clientKey: old.clientKey };
        replacement.detailAuthoring.setComponent("card", html`<article><img alt="Portable square" asset=${assetRef(asset.id)}><button gc=${detailCapability.invoke("invoke", preserved)}>Invoked result</button><button gc=${detailCapability.reference("attached", addition)}>Attached response</button></article>`, css`article { border-radius: 1rem; padding: 1rem; }`);
        }
        await graph.replaceNodePresentation(source.id, before.revision, replacement);
      }
      await graph.submit(context.inputGraph.id);
    },
  });
}

function decode(bytes) { return new TextDecoder().decode(bytes).trimEnd().split("\n").map(JSON.parse); }
async function request(session, path, body) {
  const response = await fetch(new URL(path, session.origin), { method: body === undefined ? "GET" : "POST",
    headers: { Cookie: `${session.cookie.name}=${session.cookie.value}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error ?? `HTTP ${response.status}`), value, { status: response.status });
  return value;
}
async function accepted(session, threadId, index) {
  let detail;
  await vi.waitFor(async () => {
    detail = await request(session, `/api/threads/${threadId}`);
    const turn = detail.interactions[index];
    if (turn?.completionStatus === "failed") throw new Error(JSON.stringify(turn));
    expect(turn?.completionStatus).toBe("accepted");
  }, { timeout: 10_000, interval: 20 });
  return detail;
}

async function navigateImportedControl({ session, detail, mode, presentation }) {
  const window = new Window({ url: session.origin });
  const source = detail.interactions[0];
  // Strip only the in-memory presentation to cover fallback pills against the
  // same durable imported action and endpoint, without changing accepted data.
  const rootLayer = structuredClone(source.completionOutput.rootLayer);
  if (presentation === "ordinary") {
    for (const node of rootLayer.nodes) delete node.authoredDetail;
  }
  const converted = rootLayer.actions.find((action) => action.convertedFromInvoke);
  const state = { ...detail, status: "accepted", currentInteractionId: source.id, visibleLayer: rootLayer,
    nodes: rootLayer.nodes, actions: rootLayer.actions, projects: [], permissionProfiles: [],
    modelSettings: { defaults: {}, harnesses: [], providers: [], families: [] }, modelCatalog: [],
    actionInvocations: [], pendingActionInvocations: [] };
  const destinationRequests = [];
  const layerReads = [];
  let workspace;
  try {
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("lucide", new Proxy({ Circle: {}, createElement: (_icon, attributes) => {
      const element = window.document.createElement("svg");
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      return element;
    } }, { get: (target, key) => target[key] ?? {} }));
    window.document.body.innerHTML = '<section id="threadView"></section>';
    workspace = createProductWorkspace({ root: window.document, mode,
      getState: () => state, getThread: () => detail.thread,
      selection: { currentThreadId: detail.thread.id, currentInteractionId: source.id, selectedNodeId: null, layerPath: [] },
      showThread() {}, showEmpty() {},
      onNavigateResolvedInvoke: async (action) => {
        destinationRequests.push(action.id);
        return request(session, `/api/threads/${detail.thread.id}/interactions/${source.id}/actions/${action.id}/destination`);
      },
      onNavigateLayer: async (layerId) => {
        const resolved = await request(session, `/api/threads/${detail.thread.id}/interactions/${source.id}/layers/${layerId}`);
        layerReads.push(resolved);
        state.visibleLayer = resolved;
        state.nodes = resolved.nodes;
        state.actions = resolved.actions;
        workspace.render();
        return true;
      },
    });
    workspace.render();
    window.document.querySelector(`[data-node="${rootLayer.nodes[0].id}"]`).click();
    let button;
    await vi.waitFor(() => {
      const container = presentation === "compiled"
        ? window.document.querySelector("#detailContent [data-node-detail-runtime]")?.shadowRoot
        : window.document.querySelector("#detailActions");
      button = [...(container?.querySelectorAll("button") ?? [])]
        .find((candidate) => candidate.textContent.trim() === (presentation === "compiled" ? "Invoked result" : converted.label));
      expect(button, `${mode}/${presentation}: ${window.document.querySelector("#detailActions")?.textContent}`).toBeTruthy();
    });
    expect(button.disabled).toBe(false);
    button.click();
    await window.happyDOM.waitUntilComplete();
    expect(destinationRequests).toEqual([]);
    await vi.waitFor(() => expect(layerReads).toHaveLength(1));
    expect(layerReads[0].layer.id).toBe(converted.targetLayerId);
    expect(window.document.querySelector('.graph-node[aria-label="Open Invoked response"]')).toBeTruthy();
  } finally {
    workspace?.dispose();
    vi.unstubAllGlobals();
    await window.close();
  }
}
