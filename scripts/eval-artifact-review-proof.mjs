// Accepted Product artifact navigation through the real read-only judge bridge.
// No inference: the ordinary harness boundary authors and accepts the fixture.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RelayerGraphClient, NodeObject, LayerObject, LayerLayoutObject, NodePlacementObject, EdgeObject, html, css, detailCapability } from "@relayer/graph-client";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { EvalService } from "../desktop/eval-main/eval-service.mjs";
import { HumanTaskService } from "../desktop/eval-main/human-task-service.mjs";
import { openBrowserReview } from "../desktop/eval-main/browser-review.mjs";
import { createRecursiveScreenshotEvidenceValidator } from "@relayer/eval-runner";

export async function proveArtifactReview({ browser, directory }) {
  const data = join(directory, "artifact-review");
  await mkdir(data, { recursive: true });
  const configuration = join(data, "fixture-artifact-review.yaml");
  await writeFile(configuration, "schemaVersion: 1\nname: fixture-artifact-review\nimplementation: fixture.artifact-review\nimplementationVersion: 1\npermissionBindings:\n  ask: {}\n  auto: {}\n  full: {}\nmodelCompatibility:\n  - providerId: codex\nexecutionAccessContracts: [managed-runtime@1]\nsettings: {}\n");
  const resources = [];
  let targetLayer, targetNode, questionNode, questionActionId, action;
  try {
    const binaries = resolve(process.env.CARGO_TARGET_DIR || "target", "debug");
    const runtime = new GraphCompleteRuntimeService({ userDataDirectory: data, graphServerBinary: join(binaries, "relayer-graph-server"), configurationPaths: [configuration],
      acquireProviderExecution: async providerId => ({ definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" }, descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" }, runtime: { executionAccess: async () => ({ kind: "managed-runtime", environment: {} }) }, async release() {} }),
      additionalImplementations: { "fixture.artifact-review": factory => ({ state: () => ({}), async complete(context) {
        try {
        await writeFile(join(factory.workingDirectory, "brief.md"), "# Accepted brief\nThis local content is unavailable in a browser-only review.\n");
        const graph = new RelayerGraphClient(context.graph.acquireCapability());
        const source = new NodeObject("file", "Delivery", "Open the accepted brief.", "concept", "delivery");
        const question = new NodeObject("message-square", "Review question", "Choose a boundary.", "concept", "question");
        const edge = new EdgeObject([source, question], "delivery-question");
        const root = new LayerObject([source, question], [edge], new LayerLayoutObject([new NodePlacementObject(source, 0.25, 0.5), new NodePlacementObject(question, 0.75, 0.5)], "default"), "delivery-root", source);
        const input = { kind: "input", control: "text", prompt: "Which boundary should change?", label: "Boundary", sourceLayer: root, clientKey: "boundary" };
        question.detailAuthoring.setComponent("question", html`<label>Which boundary should change?<textarea aria-label="Which boundary should change?" gc=${detailCapability.input("boundary", input)}></textarea></label><section class="full-context">Read the full authored context before answering.</section><footer>END OF AUTHORED CONTEXT</footer>`, css`.full-context { height: 1500px; } footer { height: 100px; background-color: rgb(24, 160, 96); }`);
        await graph.submitNode(source);
        await graph.submitNode(question); questionNode = String(question.ref.id);
        await graph.createEdge(edge);
        await graph.submitLayer(root);
        await graph.addAction(question, input);
        const artifact = new NodeObject("file-text", "Accepted brief", "Private node detail must not replace viewer pixels.", "artifact", "brief");
        artifact.artifact = { kind: "markdown", source: { file: "brief.md" } };
        await graph.submitNode(artifact);
        const layer = LayerObject.forArtifact(artifact, "brief-viewer");
        await graph.submitLayer(layer);
        targetLayer = String(layer.ref.id); targetNode = String(artifact.ref.id);
        await graph.addAction(source, { kind: "navigate", relation: "expand", sourceLayer: root, label: "Read accepted brief", target: layer, clientKey: "open-brief" });
        await graph.addAction(context.inputGraph.id, { kind: "navigate", relation: "expand", label: "Delivery", target: root, clientKey: "response" });
        await graph.submit(context.inputGraph.id);
        } catch (error) {
          console.error("ARTIFACT_REVIEW_FIXTURE_ERROR", error.code, String(error.message).replace(/https?:\/\/\S+/g, "[loopback]"), JSON.stringify(error.issues));
          throw error;
        }
      } }) },
    });
    resources.push(runtime);
    const product = new RelayerAppServerService({ userDataDirectory: data, binaryPath: join(binaries, "relayer-app-server"), webDirectory: resolve("desktop/renderer"), permissionCatalogPath: resolve("permissions/desktop.json"), runtimeSession: await runtime.start(), defaultHarnessConfiguration: "fixture-artifact-review", allowHarnessOverride: true, evalMode: true, enableReadOnlySession: true });
    resources.push(product);
    const productSession = await product.start();
    await product.seedProviderCatalog({ providerId: "codex", label: "Fixture", connected: true, models: [{ id: "fixture-model", label: "Fixture", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }], systemFamily: { key: "codex", name: "Fixture", modelIds: ["fixture-model"] } });
    const service = await new EvalService({ stateFile: join(data, "runs.json"), productSession, configurationPaths: [configuration] }).open();
    const tasks = await new HumanTaskService({ stateFile: join(data, "tasks.json"), evalService: service, productSession }).open();
    const task = await tasks.create({ testCaseId: "empty-project.task-system.two-turn", harnessConfigurationName: "fixture-artifact-review", maxCompletions: 1, endpoint: "Read the brief" });
    const threadId = task.threadIds[0];
    let turn;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const response = await fetch(new URL(`/api/state?threadId=${threadId}`, productSession.origin), { headers: { Cookie: `${productSession.cookie.name}=${productSession.cookie.value}` } });
      const state = await response.json();
      turn = state.interactions?.find(item => item.completionStatus === "accepted");
      if (turn) break;
      assert.ok(!state.interactions?.some(item => ["failed", "stopped"].includes(item.completionStatus)), "deterministic review fixture failed before acceptance");
      await new Promise(done => setTimeout(done, 50));
    }
    assert.ok(turn, "fixture must be accepted before read-only review");
    const opened = await openBrowserReview({ browser, productSession, executionId: task.id, threadId, turnId: turn.id, rootLayerId: turn.completionOutput.rootLayer.layer.id,
      artifactDirectory: join(data, "screenshots"), context: { readOnly: true, selectedExecutionId: task.id, cases: [{ executionId: task.id, name: "Artifact review", threadIds: [threadId], threads: [{ id: threadId, name: "Artifact review" }] }] } });
    resources.push({ close: opened.release });
    const page = browser.contexts().at(-1).pages()[0];
    const before = await opened.session.state();
    const questionControl = before.controls.find(control => control.elementRef === `node-${questionNode}`); assert.ok(questionControl);
    await opened.session.interact({ elementRef: questionControl.elementRef, activate: true });
    const questionState = await opened.session.state();
    const inputRegion = questionState.controls.find(control => control.kind === "capture-region" && control.elementRef.startsWith(`input-action-${turn.graphNodeId}-${before.layerId}-`));
    assert.ok(inputRegion, "compiled input exposes its exact accepted occurrence");
    questionActionId = inputRegion.actionId;
    const inspector = page.locator("#inspectorContent");
    await inspector.evaluate(element => { element.scrollTop = 40; });
    const originalScroll = await inspector.evaluate(element => element.scrollTop);
    const observedTiles = [];
    // Observe actual capture positions without changing the production capture behavior.
    await page.exposeFunction("recordCompiledCaptureTile", value => observedTiles.push(value));
    await page.evaluate(() => {
      window.__unwrappedPresentation = window.__evalPresentation;
      const original = window.__evalPresentation.prepareCaptureTile.bind(window.__evalPresentation);
      window.__evalPresentation = { ...window.__evalPresentation, prepareCaptureTile: async tile => {
        const result = await original(tile);
        const inspector = document.querySelector("#inspectorContent");
        const footer = document.querySelector(".node-detail-runtime-host").shadowRoot.querySelector("footer").getBoundingClientRect();
        const viewport = inspector.getBoundingClientRect();
        await window.recordCompiledCaptureTile({ index: tile.index, top: inspector.scrollTop, footerVisible: footer.top >= viewport.top && footer.bottom <= viewport.bottom });
        return result;
      } };
    });
    const inputShot = await opened.session.screenshot({ target: { kind: "element", elementRef: inputRegion.elementRef }, mode: "full", label: "Authored prompt and input" });
    await page.evaluate(() => { window.__evalPresentation = window.__unwrappedPresentation; delete window.__unwrappedPresentation; });
    assert.equal(inputShot.ok, true);
    assert.ok(inputShot.screenshot.tileCount > 1, "long authored input uses the real inspector overflow");
    assert.equal(observedTiles.length, inputShot.screenshot.tileCount);
    assert.ok(observedTiles.at(-1).top > observedTiles[0].top);
    assert.equal(observedTiles.at(-1).footerVisible, true, "last actual screenshot tile contains the authored footer");
    assert.equal(await inspector.evaluate(element => element.scrollTop), originalScroll, "capture restores inspector position");
    assert.equal(await page.locator(".node-detail-runtime-host textarea").isDisabled(), true);
    await page.getByText("Which boundary should change?", { exact: true }).waitFor();
    const inputRequest = { kind: "node", subject: { layerId: before.layerId, nodeId: questionNode }, actionSubjects: [{ actionId: questionActionId, occurrence: { presentingInteractionNodeId: turn.graphNodeId, presentingLayerId: Number(before.layerId), actionId: Number(questionActionId) } }], review: { evidence: { context: [inputShot.screenshot.screenshotId], detail: [inputShot.screenshot.screenshotId] }, semantic: { evidence: [] }, allocationSteps: [], findings: [], actions: [{ kind: "input", actionId: questionActionId, evidence: [inputShot.screenshot.screenshotId] }] } };
    createRecursiveScreenshotEvidenceValidator({ executionId: task.id, threadId: String(threadId), turnId: String(turn.id), screenshots: new Map([[inputShot.screenshot.screenshotId, inputShot.screenshot]]) })(inputRequest);
    await opened.session.interact({ elementRef: `node-${before.selectedNodeId}`, activate: true });
    const sourceRegion = before.controls.find(control => control.kind === "capture-region");
    action = before.controls.find(control => control.name === "Read accepted brief");
    assert.ok(action); assert.ok(sourceRegion);
    const sourceShot = await opened.session.screenshot({ target: { kind: "viewport" }, label: "Source" });
    const activated = await opened.session.interact({ elementRef: action.elementRef, activate: true });
    assert.equal(activated.ok, true, JSON.stringify(activated));
    const visible = await opened.session.state();
    assert.ok(!visible.controls.some(control => control.elementRef === inputRegion.elementRef), "artifact modal covers compiled input captures");
    assert.equal(visible.layerId, targetLayer);
    assert.equal(visible.selectedNodeId, targetNode);
    assert.equal(await page.evaluate(async () => {
      const { viewState } = await import("/src/state.js");
      const turnId = viewState.currentInteractionId;
      try {
        viewState.currentInteractionId = "wrong-turn";
        try { window.__evalPresentation.snapshot(); return false; }
        catch (error) { return error.message.includes("does not belong"); }
      } finally { viewState.currentInteractionId = turnId; }
    }), true, "a stale visible artifact fails closed instead of labeling source pixels");
    assert.deepEqual(visible.navigationPath, [...before.navigationPath, { layerId: targetLayer, viaActionId: action.actionId }]);
    assert.ok(!visible.controls.some(control => control.elementRef === action.elementRef || control.elementRef === sourceRegion.elementRef), "covered graph controls and regions are not offered");
    await assert.rejects(opened.session.interact({ elementRef: action.elementRef, activate: true }), /unknown|visible|control/i, "stale covered controls cannot activate");
    await assert.rejects(opened.session.screenshot({ target: { kind: "element", elementRef: sourceRegion.elementRef }, label: "Covered source" }), /unknown|visible|target/i, "covered source cannot masquerade as artifact detail");
    const region = visible.controls.find(control => control.kind === "capture-region" && control.elementRef === "artifact-viewer");
    assert.ok(region);
    const shot = await opened.session.screenshot({ target: { kind: "element", elementRef: region.elementRef }, mode: "full", label: "Artifact availability card" });
    assert.equal(shot.ok, true);
    assert.equal(shot.screenshot.layerId, targetLayer); assert.equal(shot.screenshot.selectedNodeId, targetNode);
    await page.getByText("Available in Relayer on the machine that made it.", { exact: true }).waitFor();
    assert.equal(await page.locator(".artifact-viewer iframe").count(), 0, "no unseen file content is credited as rendered");
    const request = { kind: "node", subject: { layerId: targetLayer, nodeId: targetNode }, actionSubjects: [], review: { evidence: { context: [shot.screenshot.screenshotId], detail: [shot.screenshot.screenshotId] }, semantic: { evidence: [shot.screenshot.screenshotId] }, allocationSteps: [], actions: [], findings: [] } };
    const validate = screenshots => createRecursiveScreenshotEvidenceValidator({ executionId: task.id, threadId: String(threadId), turnId: String(turn.id), screenshots })(request);
    validate(new Map([[shot.screenshot.screenshotId, shot.screenshot]]));
    assert.throws(() => validate(new Map([[shot.screenshot.screenshotId, sourceShot.screenshot]])), /evidence/i, "source metadata still fails artifact evidence");
    assert.throws(() => validate(new Map([[shot.screenshot.screenshotId, { ...shot.screenshot, turnId: "wrong-turn" }]])), /evidence/i);
    const graph = visible.controls.find(control => control.name === "Graph"); assert.ok(graph);
    assert.equal((await opened.session.interact({ elementRef: graph.elementRef, activate: true })).ok, true);
    const restored = await opened.session.state();
    for (const key of ["layerId", "selectedNodeId", "navigationPath"]) assert.deepEqual(restored[key], before[key]);
    await assert.rejects(opened.session.screenshot({ target: { kind: "element", elementRef: region.elementRef }, label: "Closed artifact" }), /unknown|target/i);
    await opened.session.interact({ elementRef: action.elementRef, activate: true });
    await page.keyboard.press("Escape");
    assert.equal((await opened.session.state()).layerId, before.layerId);
    console.log("PASS artifact judge: accepted navigation, truthful viewer identity, strict evidence, covered-control rejection and Graph/Esc source restoration; compiled input prompt/control captured under exact occurrence while read-only");
  } finally {
    const errors = [];
    for (const resource of resources.reverse()) { try { await resource.close(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Artifact review cleanup failed");
  }
}
