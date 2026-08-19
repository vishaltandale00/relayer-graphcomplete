import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";
import { EvalService } from "./eval-service.mjs";
import { ReviewSession } from "./review-session.mjs";
import {
  createLocalSimulatedUserJudgeRunner,
  resolveLocalSimulatedUserAutorun,
} from "./simulated-user-judge.mjs";
import { GraphCompleteRuntimeService } from "../main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../main/services/relayer-app-server.mjs";
import { claimPrimaryDesktopInstance } from "../main/single-instance.mjs";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopDirectory, "..");
if (process.env.RELAYER_EVAL_USER_DATA_DIR) {
  app.setPath("userData", resolve(process.env.RELAYER_EVAL_USER_DATA_DIR));
}
app.setName("Relayer Eval");

const userDataDirectory = app.getPath("userData");
const graphServerBinary = app.isPackaged
  ? join(process.resourcesPath, "bin", "relayer-graph-server")
  : resolve(process.env.RELAYER_GRAPH_SERVER_BIN || join(repositoryRoot, "target", "debug", "relayer-graph-server"));
const appServerBinary = app.isPackaged
  ? join(process.resourcesPath, "bin", "relayer-app-server")
  : resolve(process.env.RELAYER_APP_SERVER_BINARY || join(repositoryRoot, "target", "debug", "relayer-app-server"));
const harnessDirectory = app.isPackaged ? join(process.resourcesPath, "harnesses") : join(repositoryRoot, "harnesses");
const productRendererDirectory = app.isPackaged ? join(process.resourcesPath, "renderer") : join(desktopDirectory, "renderer");
const evalRendererDirectory = app.isPackaged ? join(process.resourcesPath, "eval-renderer") : join(desktopDirectory, "eval-renderer");
const configurationPaths = [
  join(harnessDirectory, "fixture-task-system.yaml"),
  join(harnessDirectory, "codex-basic.yaml"),
  join(harnessDirectory, "codex-basic-high.yaml"),
];
const graphClientModuleUrl = app.isPackaged
  ? pathToFileURL(join(process.resourcesPath, "graph-client", "index.js")).href
  : undefined;
const bundledCodexBinary = app.isPackaged
  ? join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin", "codex")
  : join(repositoryRoot, "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin", "codex");

let dashboardWindow;
const primaryInstance = claimPrimaryDesktopInstance({ app, getWindow: () => dashboardWindow });

const reviewWindows = new Set();
const reviewSessions = new Map();
const manualReviewWindows = new Map();
const automatedReviewWindows = new Map();
const graphRuntime = new GraphCompleteRuntimeService({
  userDataDirectory,
  graphServerBinary,
  configurationPaths,
  additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory },
  codexBasicClientModuleUrl: graphClientModuleUrl,
  codexPathOverride: bundledCodexBinary,
  onUnexpectedStop: () => app.quit(),
});
let productServer;
let evalService;
let stopping = false;
let stopPromise;
let localAutorunStarted = false;

function windowSecurity(window, trustedOrigin = null) {
  const blockUntrusted = (event, target) => {
    if (trustedOrigin) {
      try { if (new URL(target).origin === trustedOrigin) return; } catch {}
    }
    if (!trustedOrigin && target.startsWith("file:")) return;
    event.preventDefault();
  };
  window.webContents.on("will-navigate", blockUntrusted);
  window.webContents.on("will-redirect", blockUntrusted);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

async function createDashboardWindow() {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0b0c0d",
    webPreferences: {
      preload: join(desktopDirectory, "preload", "eval-dashboard.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windowSecurity(window);
  await window.loadFile(join(evalRendererDirectory, "index.html"));
  window.on("closed", () => { if (dashboardWindow === window) dashboardWindow = undefined; });
  return window;
}

async function createReviewWindow(executionId) {
  const existing = manualReviewWindows.get(executionId);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  const context = evalService.reviewContext(executionId);
  const selected = context.cases.find((item) => item.executionId === executionId);
  const threadId = selected?.threadIds?.[0];
  if (!threadId) throw new Error("This case × harness execution has no product thread to review.");
  const { window, productOrigin } = await createReadOnlyReviewWindow(executionId);
  manualReviewWindows.set(executionId, window);
  let reviewSession;
  window.on("closed", () => {
    if (manualReviewWindows.get(executionId) === window) manualReviewWindows.delete(executionId);
    if (reviewSessions.get(executionId) === reviewSession) reviewSessions.delete(executionId);
  });
  await window.loadURL(`${productOrigin}/?threadId=${encodeURIComponent(threadId)}&review=1`);
  reviewSession = new ReviewSession({
    executionId,
    readOnly: context.readOnly,
    webContents: window.webContents,
    artifactDirectory: join(userDataDirectory, "eval-data", "review-sessions", executionId),
    ipc: ipcMain,
  });
  await reviewSession.open();
  reviewSessions.set(executionId, reviewSession);
  return window;
}

async function createReadOnlyReviewWindow(executionId) {
  const productSession = await productServer.start();
  if (!productSession.readOnlyCookie) throw new Error("Relayer Eval review session is unavailable.");
  const productOrigin = new URL(productSession.origin).origin;
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0b0c0d",
    webPreferences: {
      preload: join(desktopDirectory, "preload", "eval-review.cjs"),
      additionalArguments: [`--relayer-eval-execution=${executionId}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  reviewWindows.add(window);
  window.on("closed", () => reviewWindows.delete(window));
  windowSecurity(window, productOrigin);
  await window.webContents.session.cookies.set({
    url: productSession.origin,
    name: productSession.readOnlyCookie.name,
    value: productSession.readOnlyCookie.value,
    httpOnly: true,
    sameSite: "strict",
    secure: false,
  });
  return { window, productOrigin };
}

async function openAutomatedReviewSession({
  executionId,
  threadId,
  turnId,
  rootLayerId,
  artifactDirectory,
}) {
  const context = evalService.reviewContext(executionId);
  const executionCase = context.cases.find((item) => item.executionId === executionId);
  if (!executionCase?.threadIds?.some((candidate) => String(candidate) === String(threadId))) {
    throw new Error("The simulated-user review thread does not belong to its execution.");
  }
  let entry = automatedReviewWindows.get(executionId);
  if (!entry || entry.window.isDestroyed()) {
    entry = await createReadOnlyReviewWindow(executionId);
    automatedReviewWindows.set(executionId, entry);
    entry.window.on("closed", () => {
      if (automatedReviewWindows.get(executionId)?.window === entry.window) {
        automatedReviewWindows.delete(executionId);
      }
    });
  }
  await entry.window.loadURL(
    `${entry.productOrigin}/?threadId=${encodeURIComponent(threadId)}`
      + `&interactionId=${encodeURIComponent(turnId)}&review=1`,
  );
  const session = new ReviewSession({
    executionId,
    readOnly: context.readOnly,
    webContents: entry.window.webContents,
    artifactDirectory,
    ipc: ipcMain,
  });
  const state = await session.open();
  if (String(state.layerId) !== String(rootLayerId)) {
    throw new Error("The simulated-user review window did not open the accepted root layer.");
  }
  let released = false;
  return {
    session,
    state,
    release: async ({ close }) => {
      if (released) return;
      released = true;
      if (close && !entry.window.isDestroyed()) entry.window.close();
    },
  };
}

function registerEvalIpc() {
  ipcMain.handle("relayer-eval:catalog", () => evalService.catalog());
  ipcMain.handle("relayer-eval:list-runs", () => evalService.listRuns());
  ipcMain.handle("relayer-eval:get-run", (_event, runId) => evalService.getRun(runId));
  ipcMain.handle("relayer-eval:create-run", (_event, selection) => evalService.createRun(selection));
  ipcMain.handle("relayer-eval:open-review", async (_event, executionId) => {
    await createReviewWindow(executionId);
    return true;
  });
  ipcMain.handle("relayer-eval:review-context", (_event, executionId) => evalService.reviewContext(executionId));
}

async function start() {
  const runtimeSession = await graphRuntime.start();
  productServer = new RelayerAppServerService({
    userDataDirectory,
    binaryPath: appServerBinary,
    webDirectory: productRendererDirectory,
    runtimeSession,
    defaultHarnessConfiguration: "fixture-task-system",
    allowHarnessOverride: true,
    enableReadOnlySession: true,
    onUnexpectedStop: () => app.quit(),
  });
  const productSession = await productServer.start();
  const simulatedUserJudgeRunner = createLocalSimulatedUserJudgeRunner({
    loadLayer: ({ threadId, turnId, layerId }) => productRequest(productSession, (
      `/api/threads/${encodeURIComponent(threadId)}`
      + `/interactions/${encodeURIComponent(turnId)}`
      + `/layers/${encodeURIComponent(layerId)}`
    )),
    openReviewSession: openAutomatedReviewSession,
  });
  evalService = await new EvalService({
    stateFile: join(userDataDirectory, "eval-data", "test-runs.json"),
    productSession,
    configurationPaths,
    simulatedUserJudgeRunner,
    onChanged: (runs) => dashboardWindow?.webContents.send("relayer-eval:runs-changed", runs),
  }).open();
  registerEvalIpc();
  dashboardWindow = await createDashboardWindow();
  primaryInstance.presentPendingWindow();
  const localAutorun = resolveLocalSimulatedUserAutorun({ packaged: app.isPackaged });
  if (localAutorun && !localAutorunStarted) {
    localAutorunStarted = true;
    await evalService.createRun(localAutorun);
  }
}

async function productRequest(session, path) {
  const cookie = session.readOnlyCookie;
  if (!cookie) throw new Error("Relayer Eval read-only product session is unavailable.");
  const response = await fetch(new URL(path, session.origin), {
    headers: {
      Accept: "application/json",
      Cookie: `${cookie.name}=${cookie.value}`,
    },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.error || `Product request failed (${response.status}).`);
  return value;
}

function stop() {
  stopPromise ??= (async () => {
    const errors = [];
    for (const window of [...reviewWindows]) {
      try { if (!window.isDestroyed()) window.close(); } catch (error) { errors.push(error); }
    }
    reviewSessions.clear();
    manualReviewWindows.clear();
    automatedReviewWindows.clear();
    if (productServer) {
      try { await productServer.close(); } catch (error) { errors.push(error); }
    }
    try { await graphRuntime.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Relayer Eval services did not stop cleanly.");
  })();
  return stopPromise;
}

if (primaryInstance) {
  app.whenReady().then(start).catch((error) => {
    console.error("Relayer Eval startup failed:", error);
    dialog.showErrorBox("Relayer Eval could not start", error.message);
    app.quit();
  });
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (evalService) dashboardWindow = await createDashboardWindow();
    } else {
      primaryInstance.presentPrimaryWindow();
    }
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", (event) => {
    if (stopping) return;
    event.preventDefault();
    stopping = true;
    void stop().catch((error) => console.error("Relayer Eval shutdown failed:", error)).finally(() => {
      app.quit();
    });
  });
}
