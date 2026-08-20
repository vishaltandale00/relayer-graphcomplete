import { app, BrowserWindow, ipcMain } from "electron";
import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";

import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const screenshotPath = process.env.RELAYER_FIRST_MESSAGE_SCREENSHOT
  || join(repositoryRoot, ".relayer", "evidence", "first-message-enter-smoke.png");
const evalScreenshotPath = process.env.RELAYER_NAVIGATION_EVAL_SCREENSHOT
  || screenshotPath.replace(/\.png$/i, "-eval.png");
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

function pressEnter(webContents, modifiers = [], { insertText = false } = {}) {
  webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers });
  if (insertText) webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
  webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter", modifiers });
}

async function run() {
  process.stdout.write("Electron application ready.\n");
  registerTestIpc();
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
    enableReadOnlySession: true,
  });
  services.push(product);
  const productSession = await product.start();
  await product.publishProviderCatalog({
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
  });
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
  let navigationDetail = accepted;
  for (let turnNumber = 2; turnNumber <= 4; turnNumber += 1) {
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
  await evalContents.executeJavaScript(`document.querySelector('[data-node="${navigateAction.sourceNodeId}"]')?.click()`);
  await waitFor("the Eval navigate action", () => evalContents.executeJavaScript(
    `Boolean(document.querySelector('[data-action-id="${navigateAction.id}"]'))`,
  ));
  await evalContents.executeJavaScript(`document.querySelector('[data-action-id="${navigateAction.id}"]')?.click()`);
  await waitFor("the Eval descendant layer", () => evalContents.executeJavaScript(
    `document.querySelectorAll("#workspaceBreadcrumb .breadcrumb-segment").length === 2`,
  ));
  await evalContents.executeJavaScript(`document.querySelector("[data-node]")?.click(); document.querySelector("#turnPickerButton")?.click()`);
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
    };
  })()`));
  await mkdir(dirname(evalScreenshotPath), { recursive: true });
  await writeFile(evalScreenshotPath, (await evalContents.capturePage()).toPNG());

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
    productNavigationState,
    evalNavigationState,
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
  .catch((error) => process.stderr.write(`${error.stack || error.message}\n`))
  .finally(shutdown);
