import { app, BrowserWindow, ipcMain } from "electron";
import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";

import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
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

function registerTestIpc() {
  ipcMain.handle("relayer:account-read", () => ({
    status: "connected",
    account: { email: "zero-inference@relayer.test", planType: "Fixture" },
  }));
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
    "relayer:account-read",
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
      return { id: node.dataset.node, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
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

async function run() {
  process.stdout.write("Electron application ready.\n");
  registerTestIpc();
  const invokeGatePath = join(dataDirectory, "invoke-evidence-gate");
  await writeFile(invokeGatePath, "hold");
  process.env.RELAYER_FIXTURE_INVOKE_GATE_FILE = invokeGatePath;
  const configurationPath = join(repositoryRoot, "harnesses", "fixture-task-system.yaml");
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [configurationPath],
    additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory },
  });
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
    refresh: () => product.publishProviderCatalog(catalogSnapshot),
  });
  services.push(modelCatalogRefreshServer);
  product = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    providerCatalogRefreshSession: modelCatalogRefreshServer.session,
    defaultHarnessConfiguration: "fixture-task-system",
    enableReadOnlySession: true,
  });
  services.push(product);
  const productSession = await product.start();
  await product.publishProviderCatalog(catalogSnapshot);
  const createWindow = createWindowFactory({
    BrowserWindow,
    desktopDirectory: join(repositoryRoot, "desktop"),
    getAppearance: () => "dark",
    updater: { status: () => ({ phase: "development" }) },
  });
  window = await createWindow(productSession);
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
  if (process.platform === "darwin") app.focus({ steal: true });
  window.focus();
  await waitFor("the Electron window to receive keyboard focus", () => window.isFocused());

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
  ));

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
  const shiftedValue = shiftState.value;
  const stateAfterShift = await productRequest(productSession, "/api/state");
  if (stateAfterShift.threads.length !== 0) {
    throw new Error("Shift+Enter unexpectedly created a thread.");
  }

  pressTestEnter();
  const accepted = await waitFor("the deterministic graph to be accepted", async () => {
    const state = await productRequest(productSession, "/api/state");
    if (state.threads.length !== 1) return false;
    const detail = await productRequest(productSession, `/api/threads/${state.threads[0].id}`);
    return detail.interactions[0]?.completionStatus === "accepted" ? detail : false;
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
  const unresolvedActionVisible = `(() => {
    const inspector = document.querySelector("#inspector");
    const button = document.querySelector('[data-action-id="${invokeAction.id}"]');
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

  await webContents.executeJavaScript(`document.querySelector('[data-action-id="${invokeAction.id}"]')?.click()`);
  await waitFor("the running invoked interaction", async () => {
    const detail = await productRequest(productSession, `/api/threads/${threadId}`);
    return detail.interactions.some((interaction) => interaction.completionStatus === "running");
  });
  await webContents.executeJavaScript(`document.querySelector("#previousTurn")?.click()`);
  await waitFor("the source turn while the invoked interaction runs", () => webContents.executeJavaScript(
    `document.querySelector("#interactionText")?.textContent === "Show the deterministic task system."`,
  ));
  await webContents.executeJavaScript(`document.querySelector('[data-node="${invokeAction.sourceNodeId}"]')?.click()`);
  await waitFor("the visible disabled source invoke while its result runs", () => webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-action-id="${invokeAction.id}"]');
    return document.querySelector("#interactionText")?.textContent === "Show the deterministic task system."
      && !document.querySelector("#inspector")?.classList.contains("hidden")
      && document.querySelector("#detailTitle")?.textContent === "Results store"
      && Boolean(button && button.offsetParent !== null)
      && button?.disabled === true;
  })()`));
  invokeEvidencePaths.runningDisabled = await captureEvidence(webContents, "02-running-disabled");
  await writeFile(invokeGatePath, "release");

  const invokedDetail = await waitFor("the invoked result to be accepted", async () => {
    const detail = await productRequest(productSession, `/api/threads/${threadId}`);
    return detail.interactions.length === 2
      && detail.interactions.every((interaction) => interaction.completionStatus === "accepted")
      ? detail
      : false;
  });
  const invokedResult = invokedDetail.interactions.find((interaction) => interaction.id !== sourceInteraction.id);
  await waitFor("the visible source invoke to refresh as resolved navigation", () => webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-action-id="${invokeAction.id}"]');
    return document.querySelector("#interactionText")?.textContent === "Show the deterministic task system."
      && !document.querySelector("#inspector")?.classList.contains("hidden")
      && document.querySelector("#detailTitle")?.textContent === "Results store"
      && Boolean(button && button.offsetParent !== null)
      && button?.disabled === false;
  })()`));
  invokeEvidencePaths.resolved = await captureEvidence(webContents, "03-resolved");

  await webContents.executeJavaScript(`document.querySelector('[data-action-id="${invokeAction.id}"]')?.click()`);
  await waitFor("the resolved cross-interaction destination", () => webContents.executeJavaScript(
    `document.querySelector("#turnPickerButton")?.textContent === "Turn 2 of 2"`,
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
  await waitFor("the four-turn workspace", () => webContents.executeJavaScript(`(() => {
    const picker = document.querySelector("#turnPickerButton");
    return picker?.textContent === "Turn 4 of 4";
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
  await webContents.executeJavaScript(`document.querySelector('[data-node]:not([data-node="${navigateAction.sourceNodeId}"])')?.click()`);
  await waitFor("the second Product node detail", () => webContents.executeJavaScript(
    `document.querySelector(".graph-node.selected")?.dataset.node !== "${navigateAction.sourceNodeId}"`,
  ));
  const productOpenToOpen = await graphPresentation(webContents);
  if (JSON.stringify(nodeRectSignature(productOpenToOpen)) !== JSON.stringify(productOpenSignature)) {
    throw new Error("Selecting another node while the inspector was open changed the Product graph camera.");
  }
  await webContents.executeJavaScript(`document.querySelector("#closeInspector")?.click()`);
  const productAfterClose = await graphPresentation(webContents);
  if (JSON.stringify(nodeRectSignature(productAfterClose)) !== JSON.stringify(productOpenSignature)) {
    throw new Error("Closing the inspector changed the Product graph camera.");
  }
  const dragPoint = await webContents.executeJavaScript(`(() => {
    const rect = document.querySelector("[data-node]")?.getBoundingClientRect();
    return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 23) } : null;
  })()`);
  if (!dragPoint) throw new Error("The Product graph did not expose a node to drag.");
  webContents.sendInputEvent({ type: "mouseDown", ...dragPoint, button: "left", clickCount: 1 });
  webContents.sendInputEvent({ type: "mouseMove", x: dragPoint.x + 24, y: dragPoint.y + 12 });
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
    return nodes.length === 2 ? nodes.map((node) => node.dataset.node) : false;
  })()`));
  await webContents.executeJavaScript(`document.querySelector('[data-node="${childNodes[0]}"]')?.click()`);
  await webContents.executeJavaScript(`document.querySelector("#historyBack")?.click()`);
  await waitFor("Back to restore the selected root node", () => webContents.executeJavaScript(`(() => (
    document.querySelector("#workspaceBreadcrumb")?.textContent?.includes("Response")
    && document.querySelector("#detailTitle")?.textContent === "Incoming queue"
  ))()`));
  await webContents.executeJavaScript(`document.querySelector("#historyForward")?.click()`);
  await waitFor("Forward to restore the selected descendant node", () => webContents.executeJavaScript(`(() => (
    document.querySelectorAll("#workspaceBreadcrumb .breadcrumb-segment").length === 2
    && !document.querySelector("#inspector")?.classList.contains("hidden")
  ))()`));
  const restoredInspectorFit = await waitFor("the restored Product inspector fit", async () => {
    const presentation = await graphPresentation(webContents);
    return presentation.inspectorOpen && nodesAreContained(presentation) ? presentation : false;
  });
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
  productNavigationState.inspectorFit = {
    initialContained: nodesAreContained(productInspectorFit),
    restoredContained: nodesAreContained(restoredInspectorFit),
    openToOpenPreserved: true,
    closePreserved: true,
    dragSelectionSuppressed,
  };
  await mkdir(dirname(screenshotPath), { recursive: true });
  await writeFile(screenshotPath, (await webContents.capturePage()).toPNG());

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
  await waitFor("the read-only Eval workspace", () => evalContents.executeJavaScript(`(() => (
    document.querySelector("#threadView")?.dataset.workspaceMode === "review"
    && document.querySelector("#turnPickerButton")?.textContent === "Turn 4 of 4"
  ))()`));
  await evalContents.executeJavaScript(`import("./src/threads.js").then(({ selectTurnById }) => selectTurnById(${sourceInteraction.id}))`);
  await evalContents.executeJavaScript(`document.querySelector('[data-node="${invokeAction.sourceNodeId}"]')?.click()`);
  await waitFor("the Eval resolved invoke action", () => evalContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-action-id="${invokeAction.id}"]');
    return Boolean(button && button.offsetParent !== null && button.disabled === false);
  })()`));
  await evalContents.executeJavaScript(`document.querySelector('[data-action-id="${invokeAction.id}"]')?.click()`);
  await waitFor("the Eval resolved invoke destination", () => evalContents.executeJavaScript(
    `document.querySelector("#interactionText")?.textContent === "Propose the most useful next improvement to this task system."`,
  ));
  invokeEvidencePaths.evalCrossInteraction = await captureEvidence(evalContents, "06-eval-cross-interaction-destination");
  await evalContents.executeJavaScript(`import("./src/threads.js").then(({ selectTurnById }) => selectTurnById(${latest.id}))`);
  await evalContents.executeJavaScript(`document.querySelector('[data-node="${navigateAction.sourceNodeId}"]')?.click()`);
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
  await mkdir(dirname(evalScreenshotPath), { recursive: true });
  await writeFile(evalScreenshotPath, (await evalContents.capturePage()).toPNG());

  await evalContents.executeJavaScript(`document.querySelector("#closeInspector")?.click()`);
  evalWindow.setContentSize(760, 920);
  const narrowClosed = await waitFor("the exact 760px Eval workspace", async () => {
    const presentation = await graphPresentation(evalContents);
    return presentation.innerWidth === 760 && !presentation.inspectorOpen
      ? presentation
      : false;
  });
  const narrowClosedSignature = nodeRectSignature(await waitForStableGraph(
    "the stable narrow Eval graph",
    evalContents,
  ));
  await evalContents.executeJavaScript(`document.querySelector("[data-node]")?.click()`);
  const evalNarrowInspector = await waitFor("the narrow Eval inspector overlay", async () => {
    const presentation = await graphPresentation(evalContents);
    return presentation.innerWidth === 760
      && presentation.inspectorOpen
      && presentation.inspector?.width > 0
      && presentation.inspector.left < presentation.innerWidth
      && presentation.inspector.right <= presentation.innerWidth + 1
      ? presentation
      : false;
  });
  if (Math.round(evalNarrowInspector.stage.width) !== Math.round(narrowClosed.stage.width)) {
    throw new Error("The 760px inspector changed the Eval graph-stage width instead of overlaying it.");
  }
  if (JSON.stringify(nodeRectSignature(evalNarrowInspector)) !== JSON.stringify(narrowClosedSignature)) {
    throw new Error("The 760px inspector changed the Eval graph camera.");
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
    narrowOverlayPreservedStage: true,
    narrowOverlayPreservedCamera: true,
    redockedContained: nodesAreContained(evalRedockedInspector),
  };

  const result = {
    passed: true,
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
    invokeResultInteractionId: invokedResult.id,
    invokeEvidencePaths,
  };
  process.stdout.write(`RELAYER_FIRST_MESSAGE_SMOKE ${JSON.stringify(result)}\n`);
  exitCode = 0;
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
