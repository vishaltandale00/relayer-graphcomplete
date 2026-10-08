import { interactionPositionCondition as turnReady } from "./interaction-navigator-driver.mjs";
import { app, BrowserWindow, ipcMain } from "electron";
import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { RelayerGraphClient, NodeObject, LayerObject, LayerLayoutObject, NodePlacementObject, detailCapability, html } from "@relayer/graph-client";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";

import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
import { GraphCompleteRuntimeService, createDesktopGraphRuntime } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
function invocationResultQuery(interactionId) {
  const selector = JSON.stringify(`[data-invocation-result-interaction-id="${interactionId}"]`);
  return `(document.querySelector(${selector}) ?? document.querySelector("[data-node-detail-runtime]")?.shadowRoot?.querySelector(${selector}))`;
}
function invocationDestinationReady(layerId) {
  return `import("./src/state.js").then(({appState}) => String(appState.visibleLayer?.layer?.id) === "${layerId}" && [...document.querySelectorAll(".breadcrumb-label")].some(label => label.textContent === "Results store"))`;
}
const screenshotPath = process.env.RELAYER_FIRST_MESSAGE_SCREENSHOT
  || join(repositoryRoot, ".relayer", "evidence", "first-message-enter-smoke.png");
const evalScreenshotPath = process.env.RELAYER_NAVIGATION_EVAL_SCREENSHOT
  || screenshotPath.replace(/\.png$/i, "-eval.png");
const evalNarrowScreenshotPath = process.env.RELAYER_NAVIGATION_EVAL_NARROW_SCREENSHOT
  || screenshotPath.replace(/\.png$/i, "-eval-narrow.png");
const invokeEvidenceDirectory = process.env.RELAYER_INVOKE_EVIDENCE_DIR
  || join(repositoryRoot, ".relayer", "evidence", "invoke-navigation");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-first-message-app-"));
const services = [];
const typedPermissions = process.env.RELAYER_TEST_INTERACTION_PERMISSIONS !== "0";
const createRuntime = typedPermissions ? createDesktopGraphRuntime : (options) => new GraphCompleteRuntimeService(options);

const ancillaryFailures = [];
let window;
let evalWindow;
let exitCode = 1;
let reviewContext = {
  selectedExecutionId: "navigation-smoke",
  harnessConfigurationName: "fixture-task-system",
  readOnly: true,
  cases: [],
};

app.setName("Relayer First Message Smoke");
const electronProfileDirectory = join(dataDirectory, "electron-profile");
mkdirSync(electronProfileDirectory, { recursive: true });
app.setPath("userData", electronProfileDirectory);
app.commandLine.appendSwitch("disable-gpu");
// Keep the evidence process alive while both application services are reopened.
app.on("window-all-closed", () => {});

function registerTestIpc() {
  // This isolated fixture has no pending network publication attempts.
  ipcMain.handle("relayer:share-pending", () => null);
  let composerDrafts = {};
  ipcMain.handle("relayer:composer-drafts-read", () => composerDrafts);
  ipcMain.handle("relayer:composer-drafts-write", (_event, value) => { composerDrafts = value; return value; });
  ipcMain.handle("relayer:account-read", () => ({ status: "signed-in", channel: "stable", subject: "fixture|interaction-permissions" }));
  ipcMain.handle("relayer:provider-status", () => ({ adapters: [], definitions: [], hasCompletedOnboarding: true }));
  ipcMain.handle("relayer:tutorial-read", () => ({ status: "dismissed", automaticEligible: false }));
  ipcMain.handle("relayer:appearance-read", () => ({ appearance: "dark" }));
  ipcMain.handle("relayer:update-status", () => ({
    phase: "development",
    channel: "stable",
    version: "test",
    availableVersion: null,
    percent: null,
    error: null,
  }));
  ipcMain.handle("relayer-eval:review-context", () => reviewContext);
}

function unregisterTestIpc() {
  for (const channel of [
    "relayer:share-pending",
    "relayer:account-read",
    "relayer:provider-status",
    "relayer:tutorial-read",
    "relayer:composer-drafts-read",
    "relayer:composer-drafts-write",
    "relayer:appearance-read",
    "relayer:update-status",
    "relayer-eval:review-context",
  ]) ipcMain.removeHandler(channel);
}

async function waitFor(label, check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function graphPresentation(webContents) {
  return webContents.executeJavaScript(`(() => {
    const stage = document.querySelector("#graphStage")?.getBoundingClientRect();
    const inspector = document.querySelector("#inspector")?.getBoundingClientRect();
    const nodes = [...document.querySelectorAll("[data-node]")].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        id: node.dataset.node,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        worldX: Number(node.dataset.worldX),
        worldY: Number(node.dataset.worldY),
        canonicalWorldX: Number(node.dataset.canonicalWorldX),
        canonicalWorldY: Number(node.dataset.canonicalWorldY),
        layoutSource: node.dataset.layoutSource,
      };
    });
    return {
      innerWidth: window.innerWidth,
      inspectorOpen: !document.querySelector("#inspector")?.classList.contains("hidden"),
      inspector: inspector && { left: inspector.left, right: inspector.right, width: inspector.width },
      stage: stage && { left: stage.left, right: stage.right, top: stage.top, bottom: stage.bottom, width: stage.width },
      nodes,
    };
  })()`);
}

async function waitForPaint(webContents) {
  await webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
}

function nodesAreContained(presentation) {
  const { stage } = presentation;
  return Boolean(stage) && presentation.nodes.length > 0 && presentation.nodes.every((node) => (
    node.left >= stage.left - 1
    && node.right <= stage.right + 1
    && node.top >= stage.top - 1
    && node.bottom <= stage.bottom + 1
  ));
}

function nodeRectSignature(presentation) {
  return presentation.nodes.map(({ id, left, right, top, bottom }) => [
    id,
    Math.round(left),
    Math.round(right),
    Math.round(top),
    Math.round(bottom),
  ]);
}

// Camera coordinates are local to the graph stage. Responsive layout may move
// that stage on screen without changing its camera transform.
function nodeCameraSignature(presentation) {
  const { left: stageLeft, top: stageTop } = presentation.stage;
  return presentation.nodes.map(({ id, left, right, top, bottom }) => [
    id, Math.round(left - stageLeft), Math.round(right - stageLeft),
    Math.round(top - stageTop), Math.round(bottom - stageTop),
  ]);
}

function canonicalLayoutSignature(presentation) {
  return [...presentation.nodes]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map(({ id, canonicalWorldX, canonicalWorldY, layoutSource }) => [
      id,
      canonicalWorldX,
      canonicalWorldY,
      layoutSource,
    ]);
}

function requireAuthoredLayout(label, presentation) {
  if (!presentation.nodes.length || presentation.nodes.some((node) => (
    node.layoutSource !== "authored"
    || !Number.isFinite(node.canonicalWorldX)
    || !Number.isFinite(node.canonicalWorldY)
  ))) {
    throw new Error(`${label} did not expose a complete authored canonical layout.`);
  }
  return canonicalLayoutSignature(presentation);
}

async function waitForStableGraph(label, webContents) {
  let previous = null;
  let stableSamples = 0;
  return waitFor(label, async () => {
    const presentation = await graphPresentation(webContents);
    const signature = JSON.stringify(nodeRectSignature(presentation));
    stableSamples = signature === previous ? stableSamples + 1 : 0;
    previous = signature;
    return stableSamples >= 3 ? presentation : false;
  }, 15_000);
}

async function productRequest(session, path, init = {}) {
  const response = await fetch(new URL(path, session.origin), {
    ...init,
    headers: {
      Accept: "application/json",
      Cookie: `${session.cookie.name}=${session.cookie.value}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}

async function captureEvidence(webContents, name, { settle = true } = {}) {
  const path = join(invokeEvidenceDirectory, `${name}.png`);
  await mkdir(dirname(path), { recursive: true });
  if (settle) {
    await webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  }
  await writeFile(path, (await webContents.capturePage()).toPNG());
  return path;
}

function pressEnter(webContents, modifiers = [], { insertText = false } = {}) {
  webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers });
  if (insertText) webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
  webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter", modifiers });
}

const attachedResponseText = "Explain the attached results store.";
let attachedFixtureRejectedOmission = false;
let attachedFixtureFailure = null;
function requiredNavigationFixtureFactory(configuration) {
  const harness = taskSystemFixtureFactory(configuration);
  const ordinaryComplete = harness.complete.bind(harness);
  harness.complete = async (context) => {
    if (context.inputGraph.detail !== attachedResponseText) return ordinaryComplete(context);
    try {
    const graph = new RelayerGraphClient(context.graph.acquireCapability());
    const input = await graph.getInteractionInput();
    if (input.interactionPermissions?.version !== "2" || !input.interactionPermissions.enabled || input.contexts.length !== 1) {
      throw new Error("Required navigation fixture did not receive exact frozen V2 input.");
    }
    const source = input.contexts[0].targetNode;
    const before = await graph.getNodePresentation(source.id);
    const callable = before.actions.filter((action) => action.kind === "invoke" && action.targetLayerId == null);
    if (callable.length !== 1 || before.actions.some((action) => !["invoke", "navigate"].includes(action.kind))) throw new Error("Fixture expected one preserved reusable callable and its prior analysis controls.");
    const answer = new NodeObject("info", "Attached response", "The results store retains completed work.", "concept", "attached-answer");
    await graph.submitNode(answer);
    const response = new LayerObject([answer], [], new LayerLayoutObject([new NodePlacementObject(answer, .5, .5)], "default"), "attached-response");
    await graph.submitLayer(response);
    await graph.addAction(context.inputGraph.id, {kind:"navigate",relation:"expand",label:"Response",target:response,clientKey:"response"});
    try {
      await graph.submit(context.inputGraph.id);
      throw new Error("Response-only completion unexpectedly accepted.");
    } catch (error) {
      if (error.code !== "attached_response_navigation_required") throw error;
      attachedFixtureRejectedOmission = true;
    }
    const addition = {kind:"navigate",relation:"reference",label:"Open attached response",target:response,clientKey:"required-response"};
    await graph.addAction(source.id, addition);
    const presentation = new NodeObject(source.icon, source.title, source.detail, before.node.kind, before.node.clientKey);
    presentation.detailAuthoring.setComponent("continuation", html`<p>Completed tasks remain in the results store.</p><button gc=${detailCapability.reference("required", addition)}>Open attached response</button>`);
    for (const old of before.actions) {
      // Reconstruct exact binding provenance only; this layer is never submitted.
      const sourceLayer = old.sourceLayerId == null ? undefined : new LayerObject([presentation], [], new LayerLayoutObject([new NodePlacementObject(presentation, .5, .5)], "default"), old.sourceLayerClientKey);
      const preserved = {kind:old.kind,label:old.label,clientKey:old.clientKey,...(sourceLayer ? {sourceLayer} : {}),...(old.kind === "invoke" ? {interactionText:old.interactionText} : {relation:old.relation,target:old.targetLayerId})};
      const binding = old.kind === "invoke" ? detailCapability.invoke(`preserved-${old.id}`, preserved) : old.relation === "reference" ? detailCapability.reference(`preserved-${old.id}`, preserved) : detailCapability.expand(`preserved-${old.id}`, preserved);
      presentation.detailAuthoring.setComponent(`preserved-${old.id}`, old.kind === "invoke"
        ? html`<section><button gc=${binding}>Plan the next improvement</button></section>`
        : html`<section><button gc=${binding}>Earlier overall analysis</button></section>`);
    }
    await graph.replaceNodePresentation(source.id, before.revision, presentation);
    await graph.submit(context.inputGraph.id);
    } catch (error) { attachedFixtureFailure = `${error.stack ?? error} ${JSON.stringify(error.issues ?? [])}`; throw error; }
  };
  return harness;
}

async function activateRequiredResponse(contents, sourceInteractionId, nodeId, responseNodeId, responseLayerId, evidenceName) {
  await waitFor("required response workspace initialization", () => contents.executeJavaScript(`document.querySelectorAll("#turnPopover .interaction-graph-node").length === 5 && document.querySelectorAll(".graph-node").length > 0`));
  await contents.executeJavaScript(`import("./src/threads.js").then(({ selectTurnById }) => selectTurnById(${sourceInteractionId}, { responseRoot: true }))`);
  await waitFor("attached source node", () => contents.executeJavaScript(`Boolean(document.querySelector('[data-node="${nodeId}"]'))`));
  await contents.executeJavaScript(`document.querySelector('[data-node="${nodeId}"]').click()`);
  const buttonExpression = `[...document.querySelector("[data-node-detail-runtime]")?.shadowRoot?.querySelectorAll("button") || []].find(button => button.textContent === "Open attached response")`;
  await waitFor("visible required response button", () => contents.executeJavaScript(`(() => { const button=${buttonExpression}; const rect=button?.getBoundingClientRect(); return Boolean(button && !button.disabled && rect.width>0 && rect.height>0 && getComputedStyle(button).visibility!=="hidden" && getComputedStyle(button).display!=="none"); })()`));
  const capture = await captureEvidence(contents, evidenceName);
  await contents.executeJavaScript(`(${buttonExpression}).click()`);
  await waitFor("exact attached response destination", () => contents.executeJavaScript(`import("./src/state.js").then(({appState}) => String(appState.visibleLayer?.layer?.id) === "${responseLayerId}" && Boolean(document.querySelector('[data-node="${responseNodeId}"]')))`));
  process.stdout.write(`RELAYER_REQUIRED_RESPONSE_CONTROL ${JSON.stringify({stage:evidenceName,sourceNodeId:nodeId,responseNodeId,responseLayerId,visible:true,navigated:true,capture})}\n`);
  return capture;
}

async function run() {
  process.stdout.write("Electron application ready.\n");
  registerTestIpc();
  const invokeGatePath = join(dataDirectory, "invoke-evidence-gate");
  await writeFile(invokeGatePath, "hold");
  process.env.RELAYER_FIXTURE_INVOKE_GATE_FILE = invokeGatePath;
  const configurationPath = join(repositoryRoot, "harnesses", "fixture-task-system.yaml");
  const runtimeOptions = {
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [configurationPath],
    additionalImplementations: { "fixture.task-system": requiredNavigationFixtureFactory },
    acquireProviderExecution: async (providerId) => ({
      definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
      descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
      runtime: { executionAccess: async () => ({ kind: "managed-runtime", environment: {} }) },
      async release() {},
    }),
  };
  const runtime = createRuntime(runtimeOptions);
  services.push(runtime);
  const runtimeSession = await runtime.start();
  let product;
  const catalogSnapshot = {
    providerId: "codex",
    label: "Codex",
    connected: true,
    models: [{
      id: "fixture-model",
      label: "Fixture model",
      order: 0,
      visible: true,
      available: true,
      providerDefault: true,
      metadata: {},
    }],
    systemFamily: { key: "codex", name: "Codex", modelIds: ["fixture-model"] },
  };
  const modelCatalogRefreshServer = await startModelCatalogRefreshServer({
    refresh: () => product.seedProviderCatalog(catalogSnapshot),
  });
  services.push(modelCatalogRefreshServer);
  const productOptions = {
    userDataDirectory: dataDirectory,
    binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    providerCatalogRefreshSession: modelCatalogRefreshServer.session,
    defaultHarnessConfiguration: "fixture-task-system",
    enableReadOnlySession: true,
  };
  product = new RelayerAppServerService(productOptions);
  services.push(product);
  const productSession = await product.start();
  await product.seedProviderCatalog(catalogSnapshot);
  await productRequest(productSession, "/api/model-families", {
    method: "POST",
    body: JSON.stringify({ name: "Fixture models", enabled: true,
      members: [{ providerId: "codex", modelId: "fixture-model" }] }),
  });
  const createWindow = createWindowFactory({
    BrowserWindow,
    desktopDirectory: join(repositoryRoot, "desktop"),
    getAppearance: () => "dark",
    updater: { status: () => ({ phase: "development" }) },
    openExternal: async () => { throw new Error("External navigation is outside this deterministic fixture."); },
  });
  window = await createWindow(productSession);
  window.webContents.setBackgroundThrottling(false);
  const webContents = window.webContents;
  const electronInputs = [];
  let acceptingTestInput = false;
  webContents.on("before-input-event", (event, input) => {
    electronInputs.push({ type: input.type, key: input.key, shift: input.shift });
    if (!acceptingTestInput) event.preventDefault();
  });
  const pressTestEnter = (modifiers = [], options = {}) => {
    acceptingTestInput = true;
    try {
      pressEnter(webContents, modifiers, options);
    } finally {
      acceptingTestInput = false;
    }
  };
  window.show();
  window.webContents.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
  window.focus();
  if (process.env.RELAYER_INVOKE_EVIDENCE_SKIP_NATIVE_KEYBOARD !== "1") {
    await waitFor("the Electron window to receive keyboard focus", () => window.isFocused());
  }

  await waitFor("the first-message composer", () => webContents.executeJavaScript(`(() => {
    const prompt = document.querySelector("#newThreadPrompt");
    const send = document.querySelector("#createThread");
    if (!prompt || !send || !prompt.onkeydown) return false;
    window.__relayerSmokeKeys = [];
    prompt.addEventListener("keydown", (event) => {
      const key = { key: event.key, shiftKey: event.shiftKey, defaultPrevented: event.defaultPrevented };
      setTimeout(() => window.__relayerSmokeKeys.push({ ...key, value: prompt.value }), 0);
    });
    prompt.focus();
    return document.activeElement === prompt;
  })()`));
  await webContents.executeJavaScript(`(() => {
    const prompt = document.querySelector("#newThreadPrompt");
    prompt.value = "Show the deterministic task system.";
    prompt.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  })()`);
  await waitFor("the enabled first-message send button", () => webContents.executeJavaScript(
    `document.querySelector("#createThread")?.disabled === false`,
  )).catch(async (error) => {
    process.stderr.write(await webContents.executeJavaScript(`document.body.innerText`) + "\n");
    throw error;
  });

  let shiftedValue = null;
  if (process.env.RELAYER_INVOKE_EVIDENCE_SKIP_NATIVE_KEYBOARD === "1") {
    await webContents.executeJavaScript(`document.querySelector("#createThread").click()`);
  } else {
  pressTestEnter(["shift"], { insertText: true });
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  const shiftState = await webContents.executeJavaScript(`({
    value: document.querySelector("#newThreadPrompt")?.value,
    events: window.__relayerSmokeKeys,
    activeElement: document.activeElement?.id,
  })`);
  if (!shiftState.value?.endsWith("\n")) {
    throw new Error(`Shift+Enter did not insert a newline: ${JSON.stringify({ shiftState, electronInputs })}`);
  }
  shiftedValue = shiftState.value;
  const stateAfterShift = await productRequest(productSession, "/api/state");
  if (stateAfterShift.threads.length !== 0) {
    throw new Error("Shift+Enter unexpectedly created a thread.");
  }

  pressTestEnter();
  }
  const accepted = await waitFor("the deterministic graph to be accepted", async () => {
    const state = await productRequest(productSession, "/api/state");
    if (state.threads.length !== 1) return false;
    const detail = await productRequest(productSession, `/api/threads/${state.threads[0].id}`);
    if (detail.interactions[0]?.latestAttempt?.finishedAt && detail.interactions[0]?.latestAttempt?.outcome !== "accepted") throw new Error(`Fixture failed: ${JSON.stringify(detail.interactions[0])}`);
    return detail.interactions[0]?.completionStatus === "accepted" ? detail : false;
  }).catch(async (error) => {
    const failedState = await productRequest(productSession, "/api/state");
    if (failedState.threads[0]) {
      const failedDetail = await productRequest(productSession, `/api/threads/${failedState.threads[0].id}`);
      process.stderr.write(JSON.stringify(failedDetail.interactions) + "\n");
    }
    process.stderr.write(await webContents.executeJavaScript(`document.body.innerText`) + "\n");
    throw error;
  });
  const renderedNodes = await waitFor("the accepted graph to render", () => (
    webContents.executeJavaScript(`(() => {
      const nodes = [...document.querySelectorAll(".graph-node b")].map((node) => node.textContent);
      return nodes.length === 3 ? nodes : false;
    })()`)
  ));
  const expectedNodes = ["Incoming queue", "Two-worker pool", "Results store"];
  if (JSON.stringify(renderedNodes) !== JSON.stringify(expectedNodes)) {
    throw new Error(`Unexpected rendered nodes: ${JSON.stringify(renderedNodes)}`);
  }

  const threadId = accepted.thread.id;
  const sourceInteraction = accepted.interactions[0];
  const invokeAction = sourceInteraction.completionOutput.rootLayer.actions.find((action) => action.kind === "invoke");
  if (!invokeAction) throw new Error("The deterministic root did not expose an invoke action.");
  const sourcePackage = sourceInteraction.completionOutput.rootLayer.nodes.find((node) => node.id === invokeAction.sourceNodeId)?.authoredDetail;
  const sourceCallableMount = sourcePackage?.mounts.find((mount) => mount.kind === "capability" && mount.capability?.kind === "invoke" && mount.capability.action?.clientKey === invokeAction.clientKey);
  if (typedPermissions && !sourceCallableMount) throw new Error("The compiled source did not bind its exact callable.");
  const sourceCallableSelector = JSON.stringify(`[data-gc-mount="${sourceCallableMount?.id}"]`);
  const unresolvedActionVisible = `(() => {
    const inspector = document.querySelector("#inspector");
    const button = (document.querySelector("[data-node-detail-runtime]")?.shadowRoot?.querySelector(${sourceCallableSelector}) ?? (${typedPermissions} ? null : document.querySelector('[data-action-id="${invokeAction.id}"]')));
    return !inspector?.classList.contains("hidden")
      && document.querySelector("#detailTitle")?.textContent === "Results store"
      && Boolean(button && button.offsetParent !== null)
      && button?.disabled === false;
  })()`;
  let unresolvedReady = false;
  for (let attempt = 0; attempt < 5 && !unresolvedReady; attempt += 1) {
    await webContents.executeJavaScript(`document.querySelector('[data-node="${invokeAction.sourceNodeId}"]')?.click()`);
    await webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    unresolvedReady = await webContents.executeJavaScript(unresolvedActionVisible);
  }
  if (!unresolvedReady) throw new Error("The unresolved invoke action did not remain visibly selected for capture.");
  const invokeEvidencePaths = {
    unresolved: await captureEvidence(webContents, "01-unresolved", { settle: false }),
  };

  await webContents.executeJavaScript(`(document.querySelector("[data-node-detail-runtime]")?.shadowRoot?.querySelector(${sourceCallableSelector}) ?? (${typedPermissions} ? null : document.querySelector('[data-action-id="${invokeAction.id}"]')))?.click()`);
  const runningInteraction = await waitFor("the running invoked interaction", async () => {
    const detail = await productRequest(productSession, `/api/threads/${threadId}`);
    return detail.interactions.find((interaction) => interaction.completionStatus === "running");
  });
  // READ-001 preserves the source while pending. Explicit browsing cancels the
  // automatic ready-result switch so the mounted source control can be observed.
  await waitFor("the source to remain visible while invoke is pending", () => webContents.executeJavaScript(`${turnReady(1, 2)} && document.querySelector("#interactionText")?.textContent === "Show the deterministic task system."`));
  await webContents.executeJavaScript(`import("./src/threads.js").then(({ selectTurnById }) => selectTurnById(${runningInteraction.id}))`);
  await waitFor("the explicitly selected pending turn", () => webContents.executeJavaScript(`${turnReady(2, 2)} && document.querySelector("#interactionText")?.textContent === "Propose the most useful next improvement to this task system."`));
  await webContents.executeJavaScript(`import("./src/threads.js").then(({ selectTurnById }) => selectTurnById(${sourceInteraction.id}))`);
  await waitFor("the source turn while the invoked interaction runs", () => webContents.executeJavaScript(
    `document.querySelector("#interactionText")?.textContent === "Show the deterministic task system."`,
  ));
  await webContents.executeJavaScript(`document.querySelector('[data-node="${invokeAction.sourceNodeId}"]')?.click()`);
  await waitFor("the visible disabled Invocation result while its child runs", () => webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-invocation-result-interaction-id="${runningInteraction.id}"]');
    return document.querySelector("#interactionText")?.textContent === "Show the deterministic task system."
      && !document.querySelector("#inspector")?.classList.contains("hidden")
      && document.querySelector("#detailTitle")?.textContent === "Results store"
      && Boolean(button && button.offsetParent !== null)
      && button?.disabled === true;
  })()`));
  invokeEvidencePaths.runningDisabled = await captureEvidence(webContents, "02-running-disabled");
  if (typedPermissions) await webContents.executeJavaScript(`window.__runningInvokeButton = document.querySelector("[data-node-detail-runtime]").shadowRoot.querySelector(${sourceCallableSelector})`);
  await writeFile(invokeGatePath, "release");

  const invokedDetail = await waitFor("the invoked result to be accepted", async () => {
    const detail = await productRequest(productSession, `/api/threads/${threadId}`);
    return detail.interactions.length === 2
      && detail.interactions.every((interaction) => interaction.completionStatus === "accepted")
      ? detail
      : false;
  });
  const invokedResult = invokedDetail.interactions.find((interaction) => interaction.id !== sourceInteraction.id);
  const canonicalSourceDetail = await productRequest(productSession, `/api/threads/${threadId}`);
  const canonicalSource = canonicalSourceDetail.interactions.find((interaction) => (
    String(interaction.id) === String(sourceInteraction.id)
  ));
  const canonicalInvoke = canonicalSource?.completionOutput?.rootLayer?.actions?.find((action) => (
    String(action.id) === String(invokeAction.id)
  ));
  const invokedRootLayerId = invokedResult?.completionOutput?.rootLayer?.layer?.id;
  if (
    canonicalInvoke?.kind !== "invoke"
    || canonicalInvoke.targetLayerId != null
    || canonicalInvoke.interactionText !== invokeAction.interactionText
    || JSON.stringify(canonicalInvoke) !== JSON.stringify(invokeAction)
  ) {
    throw new Error("The accepted InvokeAction definition changed after its child Returned.");
  }
  const canonicalCall = canonicalSourceDetail.actionInvocations.find((call) => String(call.actionId) === String(invokeAction.id) && String(call.resultInteractionId) === String(invokedResult.id));
  if (!canonicalCall?.durable || canonicalCall.resultCompletionStatus !== "accepted" || invokedRootLayerId == null) throw new Error("The durable Invocation did not expose its accepted child result separately.");
  await waitFor("the visible Invocation result to become navigable", () => webContents.executeJavaScript(`(() => {
    const button = ${invocationResultQuery(invokedResult.id)};
    return document.querySelector("#interactionText")?.textContent === "Show the deterministic task system."
      && !document.querySelector("#inspector")?.classList.contains("hidden")
      && document.querySelector("#detailTitle")?.textContent === "Results store"
      && Boolean(button && button.offsetParent !== null)
      && button?.disabled === false;
  })()`)).catch(async (error) => { process.stderr.write(await webContents.executeJavaScript(`JSON.stringify({text:document.querySelector("#interactionText")?.textContent,title:document.querySelector("#detailTitle")?.textContent,inspector:document.querySelector("#inspector")?.className,shadow:document.querySelector("[data-node-detail-runtime]")?.shadowRoot?.innerHTML})`) + "\n"); throw error; });
  const integratedPackage = canonicalSource?.completionOutput?.rootLayer?.nodes?.find((node) => node.id === invokeAction.sourceNodeId)?.authoredDetail;
  const integratedCallableMount = integratedPackage?.mounts.find((mount) => mount.kind === "capability" && mount.capability?.kind === "invoke" && mount.capability.action?.clientKey === invokeAction.clientKey);
  const integratedCallableSelector = JSON.stringify(`[data-gc-mount="${integratedCallableMount?.id}"]`);
  if (typedPermissions) {
    if (!integratedCallableMount || JSON.stringify(integratedCallableMount.capability.action) !== JSON.stringify(sourceCallableMount.capability.action)) throw new Error("Integration changed the preserved callable's semantic binding.");
    if (integratedPackage.integritySha256 === sourcePackage.integritySha256) {
      if (!await webContents.executeJavaScript(`window.__runningInvokeButton === document.querySelector("[data-node-detail-runtime]").shadowRoot.querySelector(${integratedCallableSelector})`)) throw new Error("Capability-only acceptance replaced the mounted callable.");
    } else {
      const integration = canonicalSource.completionOutput.rootLayer.actions.find((action) => action.sourceNodeId === invokeAction.sourceNodeId && action.kind === "navigate" && action.targetLayerId === invokedRootLayerId);
      const mount = integratedPackage.mounts.find((item) => item.kind === "capability" && item.capability?.kind === "reference" && item.capability.action?.clientKey === integration?.clientKey);
      if (!integration || !mount || !await webContents.executeJavaScript(`Boolean(document.querySelector("[data-node-detail-runtime]")?.shadowRoot?.querySelector(${JSON.stringify(`[data-gc-mount="${mount?.id}"]`)}))`)) throw new Error("The new presentation did not expose its exact enclosing-analysis integration.");
      await webContents.executeJavaScript(`document.querySelector("[data-node-detail-runtime]").shadowRoot.querySelector(${JSON.stringify(`[data-gc-mount="${mount.id}"]`)}).click()`);
      await waitFor("compiled enclosing-analysis control to open the exact child response", () => webContents.executeJavaScript(`import("./src/state.js").then(({appState}) => String(appState.visibleLayer?.layer?.id) === "${invokedRootLayerId}")`));
      if ((await productRequest(productSession, `/api/threads/${threadId}`)).interactions.length !== canonicalSourceDetail.interactions.length) throw new Error("Reading the integrated analysis launched a new completion.");
      await webContents.executeJavaScript(`import("./src/threads.js").then(({navigateHistory}) => navigateHistory("back"))`);
      await waitFor("Back from integrated analysis to restore the source layer", () => webContents.executeJavaScript(`import("./src/state.js").then(({appState}) => String(appState.visibleLayer?.layer?.id) === "${canonicalSource.completionOutput.rootLayer.layer.id}")`));
    }
    if (!await webContents.executeJavaScript(`Boolean(document.querySelector("[data-node-detail-runtime]")?.shadowRoot?.querySelector(${integratedCallableSelector}))`)) throw new Error("The integrated presentation lost its preserved callable control.");
  }
  invokeEvidencePaths.resolved = await captureEvidence(webContents, "03-resolved");

  await webContents.executeJavaScript(`${invocationResultQuery(invokedResult.id)}?.click()`);
  await waitFor("the resolved cross-interaction destination", () => webContents.executeJavaScript(
    invocationDestinationReady(invokedRootLayerId),
  ));
  invokeEvidencePaths.crossInteraction = await captureEvidence(webContents, "04-cross-interaction-destination");
  await webContents.executeJavaScript(`import("./src/threads.js").then(({ navigateHistory }) => navigateHistory("back"))`);
  await waitFor("the revisited resolved source", () => webContents.executeJavaScript(
    `document.querySelector("#interactionText")?.textContent === "Show the deterministic task system."`,
  ));
  invokeEvidencePaths.revisited = await captureEvidence(webContents, "05-revisited-source");

  let navigationDetail = invokedDetail;
  for (let turnNumber = 3; turnNumber <= 4; turnNumber += 1) {
    const created = await productRequest(productSession, `/api/threads/${threadId}/interactions`, {
      method: "POST",
      body: JSON.stringify({ text: `Deterministic navigation turn ${turnNumber}.` }),
    });
    navigationDetail = await waitFor(`deterministic turn ${turnNumber} to be accepted`, async () => {
      const detail = await productRequest(productSession, `/api/threads/${threadId}`);
      const interaction = detail.interactions.find((candidate) => String(candidate.id) === String(created.id));
      return interaction?.completionStatus === "accepted" ? detail : false;
    });
  }

  await window.loadURL(`${productSession.origin}/?threadId=${encodeURIComponent(threadId)}`);
  window.show();
  window.focus();
  webContents.setBackgroundThrottling(false);
  await waitFor("the four-turn workspace", () => webContents.executeJavaScript(`(() => {
    return ${turnReady(4, 4)};
  })()`));
  const latest = navigationDetail.interactions.at(-1);
  const latestRoot = latest.completionOutput.rootLayer;
  const navigateAction = latestRoot.actions.find((action) => action.kind === "navigate");
  if (!navigateAction) throw new Error("The deterministic root did not expose a navigate action.");
  await webContents.executeJavaScript(`document.querySelector('[data-node="${navigateAction.sourceNodeId}"]')?.click()`);
  const productInspectorFit = await waitFor("the Product inspector fit", async () => {
    const presentation = await graphPresentation(webContents);
    return presentation.inspectorOpen && nodesAreContained(presentation) ? presentation : false;
  });
  const productStableOpen = await waitForStableGraph("the stable Product inspector view", webContents);
  const productOpenSignature = nodeRectSignature(productStableOpen);
  const productRootLayout = requireAuthoredLayout("Product root", productStableOpen);
  await mkdir(dirname(screenshotPath), { recursive: true });
  await waitForPaint(webContents);
  await writeFile(screenshotPath, (await webContents.capturePage()).toPNG());
  await webContents.executeJavaScript(`document.querySelector('[data-node]:not([data-node="${navigateAction.sourceNodeId}"])')?.click()`);
  await waitFor("the second Product node detail", () => webContents.executeJavaScript(
    `document.querySelector(".graph-node.selected")?.dataset.node !== "${navigateAction.sourceNodeId}"`,
  ));
  const productOpenToOpen = await graphPresentation(webContents);
  if (JSON.stringify(nodeRectSignature(productOpenToOpen)) !== JSON.stringify(productOpenSignature)) {
    throw new Error("Selecting another node while the inspector was open changed the Product graph camera.");
  }
  await webContents.executeJavaScript(`document.querySelector("#closeInspector")?.click()`);
  const productAfterClose = await waitForStableGraph("the expanded Product graph after closing details", webContents);
  if (productAfterClose.inspectorOpen || !nodesAreContained(productAfterClose)
    || JSON.stringify(requireAuthoredLayout("Product closed inspector", productAfterClose)) !== JSON.stringify(productRootLayout)) {
    throw new Error("Closing the inspector did not preserve canonical layout and fit the expanded Product graph.");
  }
  const dragPoint = await webContents.executeJavaScript(`(() => {
    const rect = document.querySelector("[data-node]")?.getBoundingClientRect();
    return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 23) } : null;
  })()`);
  if (!dragPoint) throw new Error("The Product graph did not expose a node to drag.");
  webContents.sendInputEvent({ type: "mouseDown", ...dragPoint, button: "left", clickCount: 1 });
  webContents.sendInputEvent({ type: "mouseMove", x: dragPoint.x + 24, y: dragPoint.y + 12, modifiers: ["leftButtonDown"] });
  webContents.sendInputEvent({
    type: "mouseUp",
    x: dragPoint.x + 24,
    y: dragPoint.y + 12,
    button: "left",
    clickCount: 1,
  });
  await waitForPaint(webContents);
  const dragSelectionSuppressed = await webContents.executeJavaScript(
    `document.querySelector("#inspector")?.classList.contains("hidden")`,
  );
  if (!dragSelectionSuppressed) {
    throw new Error("Dragging a Product graph node opened the inspector and refit the camera.");
  }
  await webContents.executeJavaScript(`document.querySelector('[data-node="${navigateAction.sourceNodeId}"]')?.click()`);
  await waitFor("the navigate action control", () => webContents.executeJavaScript(
    `Boolean(document.querySelector('[data-action-id="${navigateAction.id}"]'))`,
  ));
  await webContents.executeJavaScript(`document.querySelector('[data-action-id="${navigateAction.id}"]')?.click()`);
  const childNodes = await waitFor("the descendant layer", () => webContents.executeJavaScript(`(() => {
    const nodes = [...document.querySelectorAll("[data-node]")];
    return nodes.length === ${typedPermissions ? 3 : 2} && nodes.some((node) => node.querySelector("b")?.textContent === "Waiting tasks") ? nodes.map((node) => node.dataset.node) : false;
  })()`));
  await webContents.executeJavaScript(`document.querySelector('[data-node="${childNodes[0]}"]')?.click()`);
  await waitFor("the selected descendant node", () => webContents.executeJavaScript(`document.querySelector(".graph-node.selected")?.dataset.node === "${childNodes[0]}" && !document.querySelector("#inspector")?.classList.contains("hidden")`));
  await webContents.executeJavaScript(`document.querySelector("#historyBack")?.click()`);
  await waitFor("Back to restore the selected root node", () => webContents.executeJavaScript(`(() => (
    document.querySelector(".graph-node.selected")?.dataset.node === "${navigateAction.sourceNodeId}"
    && document.querySelector("#detailTitle")?.textContent === "Incoming queue"
  ))()`));
  await webContents.executeJavaScript(`document.querySelector("#historyForward")?.click()`);
  await waitFor("Forward to restore the selected descendant node", () => webContents.executeJavaScript(`(() => (
    document.querySelectorAll("#workspaceBreadcrumb .breadcrumb-segment").length === 2
    && !document.querySelector("#inspector")?.classList.contains("hidden")
  ))()`)).catch(async (error) => {
    process.stderr.write(await webContents.executeJavaScript(`JSON.stringify({breadcrumb: document.querySelector("#workspaceBreadcrumb")?.outerHTML, inspector:document.querySelector("#inspector")?.className, title:document.querySelector("#detailTitle")?.textContent, back:document.querySelector("#historyBack")?.outerHTML,forward:document.querySelector("#historyForward")?.outerHTML})`) + "\n");
    throw error;
  });
  const restoredInspectorFit = await waitFor("the restored Product inspector fit", async () => {
    const presentation = await graphPresentation(webContents);
    return presentation.inspectorOpen && nodesAreContained(presentation) ? presentation : false;
  });
  const productChildLayout = requireAuthoredLayout("Product child", restoredInspectorFit);
  invokeEvidencePaths.graphClosed = await captureEvidence(webContents, "09-interaction-graph-closed");
  await webContents.executeJavaScript(`document.querySelector("#turnPickerButton")?.click()`);
  const productNavigationState = await waitFor("the scrolling turn picker", () => webContents.executeJavaScript(`(() => {
    const popover = document.querySelector("#turnPopover");
    const rows = [...popover?.querySelectorAll("[data-turn-id]") || []];
    if (popover?.classList.contains("hidden") || rows.length !== 4) return false;
    return {
      rows: rows.length,
      scrollable: popover.scrollHeight > popover.clientHeight,
      backEnabled: document.querySelector("#historyBack")?.disabled === false,
      breadcrumbSegments: document.querySelectorAll("#workspaceBreadcrumb .breadcrumb-segment").length,
      selectedNodeId: document.querySelector(".graph-node.selected")?.dataset.node || null,
    };
  })()`));
  invokeEvidencePaths.graphOpen = await captureEvidence(webContents, "10-interaction-graph-open");
  await webContents.executeJavaScript(`document.querySelector('.interaction-graph-node[aria-current="true"]')?.click()`);
  await waitFor("B3 current selection to return to the response root", () => webContents.executeJavaScript(`Boolean(document.querySelector('[data-node="${latestRoot.nodes[0].id}"]')) && document.querySelector("#turnPopover")?.classList.contains("hidden") && document.querySelector("#workspaceBreadcrumb")?.classList.contains("hidden")`));
  invokeEvidencePaths.graphSelected = await captureEvidence(webContents, "11-interaction-graph-selected-root");
  await webContents.executeJavaScript(`document.querySelector("#historyBack")?.click()`);
  await waitFor("Back from B3 root to the prior descendant", () => webContents.executeJavaScript(`document.querySelectorAll("#workspaceBreadcrumb .breadcrumb-segment").length === 2`));
  productNavigationState.inspectorFit = {
    initialContained: nodesAreContained(productInspectorFit),
    restoredContained: nodesAreContained(restoredInspectorFit),
    openToOpenPreserved: true,
    closeCanonicalLayoutPreserved: true,
    closedContained: nodesAreContained(productAfterClose),
    dragSelectionSuppressed,
  };
  reviewContext = {
    ...reviewContext,
    cases: [{
      executionId: "navigation-smoke",
      name: "Navigation smoke",
      status: "passed",
      threadIds: [threadId],
      threads: [{ id: threadId, name: accepted.thread.title }],
    }],
  };
  evalWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    show: false,
    backgroundColor: "#0b0c0d",
    webPreferences: {
      // Keep Eval's read-only cookie out of the Product window's session.
      partition: "required-navigation-eval",
      preload: join(repositoryRoot, "desktop", "preload", "eval-review.cjs"),
      additionalArguments: ["--relayer-eval-execution=navigation-smoke"],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await evalWindow.webContents.session.cookies.set({
    url: productSession.origin,
    name: productSession.readOnlyCookie.name,
    value: productSession.readOnlyCookie.value,
    httpOnly: true,
    sameSite: "strict",
    secure: false,
  });
  await evalWindow.loadURL(`${productSession.origin}/?threadId=${encodeURIComponent(threadId)}&review=1`);
  const evalContents = evalWindow.webContents;
  evalContents.setBackgroundThrottling(false);
  await waitFor("the read-only Eval workspace", () => evalContents.executeJavaScript(`(() => (
    document.querySelector("#threadView")?.dataset.workspaceMode === "review"
    && ${turnReady(4, 4)}
  ))()`));
  const evalRootStable = await waitForStableGraph("the stable Eval root graph", evalContents);
  const evalRootLayout = requireAuthoredLayout("Eval root", evalRootStable);
  if (JSON.stringify(evalRootLayout) !== JSON.stringify(productRootLayout)) {
    throw new Error("Product and read-only Eval projected different canonical positions for the same accepted root layer.");
  }
  await evalContents.executeJavaScript(`import("./src/threads.js").then(({ selectTurnById }) => selectTurnById(${sourceInteraction.id}))`);
  await evalContents.executeJavaScript(`document.querySelector('[data-node="${invokeAction.sourceNodeId}"]')?.click()`);
  await waitFor("the Eval resolved invoke action", () => evalContents.executeJavaScript(`(() => {
    const button = ${invocationResultQuery(invokedResult.id)};
    return Boolean(button && button.offsetParent !== null && button.disabled === false);
  })()`));
  await evalContents.executeJavaScript(`${invocationResultQuery(invokedResult.id)}?.click()`);
  await waitFor("the Eval resolved invoke destination", () => evalContents.executeJavaScript(
    invocationDestinationReady(invokedRootLayerId),
  ));
  invokeEvidencePaths.evalCrossInteraction = await captureEvidence(evalContents, "06-eval-cross-interaction-destination");
  await evalContents.executeJavaScript(`import("./src/threads.js").then(({ selectTurnById }) => selectTurnById(${latest.id}))`);
  await evalContents.executeJavaScript(`document.querySelector('[data-node="${navigateAction.sourceNodeId}"]')?.click()`);
  const evalRootInspectorFit = await waitFor("the Eval root inspector fit", async () => {
    const presentation = await graphPresentation(evalContents);
    return presentation.inspectorOpen && nodesAreContained(presentation) ? presentation : false;
  }).catch(async (error) => {
    process.stderr.write(`Eval root inspector failure: ${JSON.stringify(await graphPresentation(evalContents))}\n`);
    await captureEvidence(evalContents, "failed-eval-root-inspector");
    throw error;
  });
  if (JSON.stringify(requireAuthoredLayout("Eval root inspector", evalRootInspectorFit)) !== JSON.stringify(evalRootLayout)) {
    throw new Error("Opening the Eval inspector changed canonical root positions.");
  }
  await waitForPaint(evalContents);
  await mkdir(dirname(evalScreenshotPath), { recursive: true });
  await writeFile(evalScreenshotPath, (await evalContents.capturePage()).toPNG());
  await waitFor("the Eval navigate action", () => evalContents.executeJavaScript(
    `Boolean(document.querySelector('[data-action-id="${navigateAction.id}"]'))`,
  ));
  await evalContents.executeJavaScript(`document.querySelector('[data-action-id="${navigateAction.id}"]')?.click()`);
  await waitFor("the Eval descendant layer", () => evalContents.executeJavaScript(
    `document.querySelectorAll("#workspaceBreadcrumb .breadcrumb-segment").length === 2`,
  ));
  await evalContents.executeJavaScript(`document.querySelector("[data-node]")?.click()`);
  const evalInspectorFit = await waitFor("the Eval inspector fit", async () => {
    const presentation = await graphPresentation(evalContents);
    return presentation.inspectorOpen && nodesAreContained(presentation) ? presentation : false;
  });
  const evalChildLayout = requireAuthoredLayout("Eval child", evalInspectorFit);
  if (JSON.stringify(evalChildLayout) !== JSON.stringify(productChildLayout)) {
    throw new Error("Product and read-only Eval projected different canonical positions for the same accepted child layer.");
  }

  await evalContents.executeJavaScript(`document.querySelector("#closeInspector")?.click()`);
  evalWindow.setContentSize(760, 920);
  await waitFor("the exact 760px Eval workspace", async () => {
    const presentation = await graphPresentation(evalContents);
    return presentation.innerWidth === 760 && !presentation.inspectorOpen
      ? presentation
      : false;
  });
  const narrowClosed = await waitForStableGraph(
    "the stable narrow Eval graph",
    evalContents,
  );
  const narrowClosedSignature = nodeCameraSignature(narrowClosed);
  await evalContents.executeJavaScript(`document.querySelector("[data-node]")?.click()`);
  await waitFor("the narrow Eval inspector", async () => {
    const presentation = await graphPresentation(evalContents);
    return presentation.innerWidth === 760
      && presentation.inspectorOpen
      && presentation.inspector?.width > 0
      && presentation.inspector.left < presentation.innerWidth
      && presentation.inspector.right <= presentation.innerWidth + 1
      ? presentation
      : false;
  });
  const evalNarrowInspector = await waitForStableGraph("the settled narrow Eval inspector", evalContents);
  if (Math.round(evalNarrowInspector.stage.width) !== Math.round(narrowClosed.stage.width)) {
    throw new Error(`The 760px inspector changed the Eval graph-stage width instead of overlaying it: ${JSON.stringify({ before: narrowClosed.stage, after: evalNarrowInspector.stage })}`);
  }
  const narrowStageResized = Math.round(evalNarrowInspector.stage.bottom - evalNarrowInspector.stage.top)
    !== Math.round(narrowClosed.stage.bottom - narrowClosed.stage.top);
  const narrowCameraPreserved = JSON.stringify(nodeCameraSignature(evalNarrowInspector)) === JSON.stringify(narrowClosedSignature);
  // Responsive details may change the graph's height. Automatic cameras refit
  // changed bounds; fixed bounds must retain the existing camera.
  if (!nodesAreContained(evalNarrowInspector)) throw new Error("The narrow Eval graph is clipped after details open.");
  if (!narrowStageResized && !narrowCameraPreserved) {
    ancillaryFailures.push({ checkpoint: "760px Eval camera preservation", before: narrowClosedSignature, after: nodeCameraSignature(evalNarrowInspector), stageBefore: narrowClosed.stage, stageAfter: evalNarrowInspector.stage });
  }
  if (JSON.stringify(requireAuthoredLayout("narrow Eval child", evalNarrowInspector)) !== JSON.stringify(evalChildLayout)) {
    throw new Error("The narrow Eval viewport changed canonical child positions.");
  }
  await waitForPaint(evalContents);
  await writeFile(evalNarrowScreenshotPath, (await evalContents.capturePage()).toPNG());
  evalWindow.setContentSize(1480, 920);
  const evalRedockedInspector = await waitFor("the redocked Eval inspector fit", async () => {
    const presentation = await graphPresentation(evalContents);
    return presentation.innerWidth === 1480
      && presentation.inspectorOpen
      && nodesAreContained(presentation)
      ? presentation
      : false;
  });
  await evalContents.executeJavaScript(`document.querySelector("#turnPickerButton")?.click()`);
  const evalNavigationState = await waitFor("the Eval scrolling turn picker", () => evalContents.executeJavaScript(`(() => {
    const popover = document.querySelector("#turnPopover");
    const rows = [...popover?.querySelectorAll("[data-turn-id]") || []];
    if (popover?.classList.contains("hidden") || rows.length !== 4) return false;
    return {
      rows: rows.length,
      scrollable: popover.scrollHeight > popover.clientHeight,
      backEnabled: document.querySelector("#historyBack")?.disabled === false,
      breadcrumbSegments: document.querySelectorAll("#workspaceBreadcrumb .breadcrumb-segment").length,
      readOnlyCopy: document.querySelector("#threadComposer")?.textContent,
      viewportWidth: window.innerWidth,
    };
  })()`));
  evalNavigationState.inspectorFit = {
    desktopContained: nodesAreContained(evalInspectorFit),
    narrowPreservedStageWidth: true,
    narrowStageResized,
    narrowCameraPreserved,
    narrowContained: nodesAreContained(evalNarrowInspector),
    redockedContained: nodesAreContained(evalRedockedInspector),
  };

  let requiredResponseJourney = null;
  if (typedPermissions) {
    const created = await productRequest(productSession, `/api/threads/${threadId}/interactions`, {
      method:"POST", body:JSON.stringify({text:attachedResponseText,inputId:"required-response-fixture",contexts:[{target:{nodeId:invokeAction.sourceNodeId,sourceInteractionNodeId:sourceInteraction.graphNodeId,sourceLayerId:canonicalSource.completionOutput.rootLayer.layer.id},annotations:["Explain this attached source"]}]})
    });
    const completed = await waitFor("required response acceptance after repair", async () => {
      const detail=await productRequest(productSession, `/api/threads/${threadId}`);
      const interaction=detail.interactions.find(value=>value.id===created.id);
      if (interaction?.completionStatus === "failed") throw new Error(attachedFixtureFailure ?? JSON.stringify(interaction));
      return interaction?.completionStatus === "accepted" ? interaction : false;
    });
    if (!attachedFixtureRejectedOmission) throw new Error("Missing response-only rejection receipt.");
    const responseNodeId=completed.completionOutput.rootLayer.nodes[0].id;
    const responseLayerId=completed.completionOutput.rootLayer.layer.id;
    await window.loadURL(`${productSession.origin}/?threadId=${threadId}`);
    const productCapture=await activateRequiredResponse(webContents,sourceInteraction.id,invokeAction.sourceNodeId,responseNodeId,responseLayerId,"12-required-product-button");
    await evalWindow.loadURL(`${productSession.origin}/?threadId=${threadId}&review=1`);
    const evalCapture=await activateRequiredResponse(evalContents,sourceInteraction.id,invokeAction.sourceNodeId,responseNodeId,responseLayerId,"13-required-eval-button");
    requiredResponseJourney={responseNodeId,responseLayerId,productCapture,evalCapture,rejectedOmission:true};
    evalWindow.destroy();
    window.destroy();
    await product.close();
    await runtime.close();
    const reopenedRuntime = createRuntime(runtimeOptions);
    services.push(reopenedRuntime);
    const reopenedSession = await reopenedRuntime.start();
    const reopenedProduct = new RelayerAppServerService({ ...productOptions, runtimeSession: reopenedSession });
    services.push(reopenedProduct);
    const reopenedProductSession = await reopenedProduct.start();
    window = await createWindow(reopenedProductSession);
    await window.loadURL(`${reopenedProductSession.origin}/?threadId=${threadId}`);
    const reopenedContents = window.webContents;
    reopenedContents.setBackgroundThrottling(false);
    const reopenedDetail = await productRequest(reopenedProductSession, `/api/threads/${threadId}`);
    const reopenedPackage = reopenedDetail.interactions.find((interaction) => interaction.id === sourceInteraction.id)?.completionOutput?.rootLayer?.nodes?.find((node) => node.id === invokeAction.sourceNodeId)?.authoredDetail;
    const reopenedCallableMount = reopenedPackage?.mounts.find((mount) => mount.kind === "capability" && mount.capability?.kind === "invoke" && mount.capability.action?.clientKey === invokeAction.clientKey);
    if (!reopenedCallableMount) throw new Error("Reopened presentation lost the exact preserved callable binding.");
    const reopenedCallableSelector = JSON.stringify(`[data-gc-mount="${reopenedCallableMount.id}"]`);
    await waitFor("reopened thread", () => reopenedContents.executeJavaScript(`${turnReady(5, 5)}`));
    await reopenedContents.executeJavaScript(`import("./src/threads.js").then(({ selectTurnById }) => selectTurnById(${sourceInteraction.id}))`);
    // Select the other occurrence through the source's queue expansion.
    const queueAction = canonicalSource.completionOutput.rootLayer.actions.find((action) => action.kind === "navigate" && action.id !== invokeAction.id);
    await reopenedContents.executeJavaScript(`document.querySelector('[data-node="${queueAction.sourceNodeId}"]')?.click()`);
    await waitFor("reopened queue control", () => reopenedContents.executeJavaScript(`Boolean(document.querySelector('[data-action-id="${queueAction.id}"]'))`));
    await reopenedContents.executeJavaScript(`document.querySelector('[data-action-id="${queueAction.id}"]')?.click()`);
    await waitFor("second source occurrence", () => reopenedContents.executeJavaScript(`Boolean(document.querySelector('[data-node="${invokeAction.sourceNodeId}"]')) && [...document.querySelectorAll(".graph-node b")].some(node => node.textContent === "Waiting tasks")`));
    await reopenedContents.executeJavaScript(`document.querySelector('[data-node="${invokeAction.sourceNodeId}"]')?.click()`);
    await waitFor("reopened compiled invoke binding", () => reopenedContents.executeJavaScript(`(() => { const button=document.querySelector("[data-node-detail-runtime]")?.shadowRoot?.querySelector(${reopenedCallableSelector}); return Boolean(button && !button.disabled && button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0 && !document.querySelector("#inspector")?.classList.contains("hidden") && document.querySelector(".graph-node.selected")?.dataset.node === "${invokeAction.sourceNodeId}"); })()`)).catch(async (error) => { process.stderr.write(await reopenedContents.executeJavaScript(`JSON.stringify({body:document.body.innerText,detail:document.querySelector("#inspector")?.innerHTML,shadow:document.querySelector("[data-node-detail-runtime]")?.shadowRoot?.innerHTML})`) + "\n"); throw error; });
    invokeEvidencePaths.reopenedSecondOccurrence = await captureEvidence(reopenedContents, "07-reopened-second-occurrence");
    await reopenedContents.executeJavaScript(`${invocationResultQuery(invokedResult.id)}?.click()`);
    await waitFor("reopened Invocation result destination and parent breadcrumb", () => reopenedContents.executeJavaScript(invocationDestinationReady(invokedRootLayerId)));
    const afterNavigation = await productRequest(reopenedProductSession, `/api/threads/${threadId}`);
    if (afterNavigation.interactions.length !== 5) throw new Error("Reopened compiled navigation launched execution.");
    invokeEvidencePaths.reopenedDestination = await captureEvidence(reopenedContents, "08-reopened-destination");
    requiredResponseJourney.reopenedCapture=await activateRequiredResponse(reopenedContents,sourceInteraction.id,invokeAction.sourceNodeId,requiredResponseJourney.responseNodeId,requiredResponseJourney.responseLayerId,"14-required-reopened-button");
    const afterRequired=await productRequest(reopenedProductSession, `/api/threads/${threadId}`);
    if (afterRequired.interactions.length !== 5) throw new Error("Required navigation launched execution.");
    requiredResponseJourney.reopenedNavigationPassed=true;
  }

  const result = {
    typedPermissions,
    requiredResponseJourney,
    nativeKeyboardVerified: process.env.RELAYER_INVOKE_EVIDENCE_SKIP_NATIVE_KEYBOARD !== "1",
    passed: ancillaryFailures.length === 0,
    typedPermissionJourneyPassed: typedPermissions,
    ancillaryFailures,
    harness: "fixture-task-system",
    inferenceCalls: 0,
    shiftEnterValue: shiftedValue,
    threadCount: 1,
    completionStatus: accepted.interactions[0].completionStatus,
    renderedNodes,
    screenshotPath,
    evalScreenshotPath,
    evalNarrowScreenshotPath,
    productNavigationState,
    evalNavigationState,
    layoutEvidence: {
      rootProductEvalParity: true,
      childProductEvalParity: true,
      narrowViewportPreservedCanonicalLayout: true,
      productRootLayout,
      productChildLayout,
    },
    invokeResultInteractionId: invokedResult.id,
    invokeEvidencePaths,
  };
  process.stdout.write(`RELAYER_FIRST_MESSAGE_SMOKE ${JSON.stringify(result)}\n`);
  exitCode = ancillaryFailures.length === 0 ? 0 : 1;
}

async function shutdown() {
  evalWindow?.destroy();
  window?.destroy();
  unregisterTestIpc();
  for (const service of services.reverse()) {
    try {
      await service.close();
    } catch (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      exitCode = 1;
    }
  }
  await rm(dataDirectory, { recursive: true, force: true });
  app.exit(exitCode);
}

process.stdout.write("Starting isolated Electron first-message smoke test...\n");
void app.whenReady()
  .then(run)
  .catch((error) => {
    exitCode = 1;
    process.exitCode = 1;
    process.stderr.write(`${error.stack || error.message}\n`);
  })
  .finally(shutdown);
