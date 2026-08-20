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
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-first-message-app-"));
const services = [];
let window;
let exitCode = 1;

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
}

function unregisterTestIpc() {
  for (const channel of [
    "relayer:account-read",
    "relayer:appearance-read",
    "relayer:update-status",
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

async function productRequest(session, path) {
  const response = await fetch(new URL(path, session.origin), {
    headers: { Cookie: `${session.cookie.name}=${session.cookie.value}` },
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
    runtimeSession,
    defaultHarnessConfiguration: "fixture-task-system",
  });
  services.push(product);
  const productSession = await product.start();
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
  await mkdir(dirname(screenshotPath), { recursive: true });
  await writeFile(screenshotPath, (await webContents.capturePage()).toPNG());

  const result = {
    passed: true,
    harness: "fixture-task-system",
    inferenceCalls: 0,
    shiftEnterValue: shiftedValue,
    threadCount: 1,
    completionStatus: accepted.interactions[0].completionStatus,
    renderedNodes,
    screenshotPath,
  };
  process.stdout.write(`RELAYER_FIRST_MESSAGE_SMOKE ${JSON.stringify(result)}\n`);
  exitCode = 0;
}

async function shutdown() {
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
