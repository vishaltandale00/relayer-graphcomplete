import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { nativeBinaryName } from "../shared/target.mjs";

import {
  gradeInputRoundTripSet,
  gradeInputRoundTripControlSet,
  InputOperatorController,
  runInputGroundingJudge,
  taskSystemFixtureFactory,
} from "@relayer/eval-runner";
import { evalHarnessConfigurationPaths } from "./configuration-paths.mjs";
import { EvalService } from "./eval-service.mjs";
import { loadAtomicAnnotationSnapshots } from "./annotation-snapshot-loader.mjs";
import { loadJudgeScreenshotArtifact } from "./judge-screenshot-loader.mjs";
import { ReviewSession } from "./review-session.mjs";
import { loadReadyReviewWorkspace } from "./review-workspace-readiness.mjs";
import {
  LOCAL_SIMULATED_USER_JUDGE_CONFIGURATION as LOCAL_INPUT_GROUNDING_JUDGE_CONFIGURATION,
  buildInputGroundingTopology,
  captureGroundingTargets,
  createInputOperatorLease,
  createLocalSimulatedUserJudgeRunner,
  groundingCaptureTargets,
  operatorInteractionIsTerminal,
  releaseInputOperatorLease,
  resolveLocalSimulatedUserAutorun,
} from "./simulated-user-judge.mjs";
import {
  GraphCompleteRuntimeService,
  RECURSIVE_TEMPORAL_FEATURES,
} from "../main/services/graphcomplete-runtime.mjs";
import { inspectCodexBrowserMcpRuntime } from "../main/services/codex-browser-mcp-runtime.mjs";
import { RelayerAppServerService } from "../main/services/relayer-app-server.mjs";
import { claimPrimaryDesktopInstance } from "../main/single-instance.mjs";
import { confirmManagedRuntimeQuit } from "../main/managed-runtimes/quit-guard.mjs";
import {
  createEvalCodexExecutionLease,
  createEvalCodexCatalogProvisioner,
  createEvalManagedCodexRuntime,
} from "./managed-codex-runtime.mjs";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopDirectory, "..");
if (process.env.RELAYER_EVAL_USER_DATA_DIR) {
  app.setPath("userData", resolve(process.env.RELAYER_EVAL_USER_DATA_DIR));
}
app.setName("Relayer Eval");

const userDataDirectory = app.getPath("userData");
const graphServerBinary = app.isPackaged
  ? join(process.resourcesPath, "bin", nativeBinaryName("relayer-graph-server"))
  : resolve(process.env.RELAYER_GRAPH_SERVER_BIN || join(repositoryRoot, "target", "debug", "relayer-graph-server"));
const appServerBinary = app.isPackaged
  ? join(process.resourcesPath, "bin", nativeBinaryName("relayer-app-server"))
  : resolve(process.env.RELAYER_APP_SERVER_BINARY || join(repositoryRoot, "target", "debug", "relayer-app-server"));
const harnessDirectory = app.isPackaged ? join(process.resourcesPath, "harnesses") : join(repositoryRoot, "harnesses");
const permissionCatalogPath = app.isPackaged
  ? join(process.resourcesPath, "permissions", "desktop.json")
  : join(repositoryRoot, "permissions", "desktop.json");
const productRendererDirectory = app.isPackaged ? join(process.resourcesPath, "renderer") : join(desktopDirectory, "renderer");
const evalRendererDirectory = app.isPackaged ? join(process.resourcesPath, "eval-renderer") : join(desktopDirectory, "eval-renderer");
const configurationPaths = evalHarnessConfigurationPaths({ harnessDirectory, isPackaged: app.isPackaged });
if (!app.isPackaged) {
  const pythonClientPath = join(repositoryRoot, "python", "relayer-graph", "src");
  process.env.PYTHONPATH = [pythonClientPath, process.env.PYTHONPATH].filter(Boolean).join(delimiter);
}
const graphClientModuleUrl = app.isPackaged
  ? pathToFileURL(join(process.resourcesPath, "graph-client", "index.js")).href
  : undefined;
const codexBrowserMcpInspection = await inspectCodexBrowserMcpRuntime({
  executable: process.execPath,
  packageRoot: app.isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked", "node_modules", "chrome-devtools-mcp")
    : join(repositoryRoot, "node_modules", "chrome-devtools-mcp"),
});
if (!codexBrowserMcpInspection.available) {
  console.error("Codex browser helper unavailable", {
    code: codexBrowserMcpInspection.code,
    message: codexBrowserMcpInspection.message,
    diagnostics: codexBrowserMcpInspection.diagnostics,
  });
}
const developmentCodexBinary = !app.isPackaged && process.env.RELAYER_CODEX_BINARY
  ? resolve(process.env.RELAYER_CODEX_BINARY)
  : undefined;
const managedCodexRuntime = createEvalManagedCodexRuntime({
  root: join(userDataDirectory, "managed-runtimes"),
  developmentExecutable: developmentCodexBinary,
  enableMaintenance: app.isPackaged,
});
const acquireEvalProviderExecution = createEvalCodexExecutionLease(
  () => managedCodexRuntime.resolve(),
);

let dashboardWindow;
const primaryInstance = claimPrimaryDesktopInstance({ app, getWindow: () => dashboardWindow });

const reviewWindows = new Set();
const reviewSessions = new Map();
const manualReviewWindows = new Map();
const automatedReviewWindows = new Map();
const judgeWindows = new Map();
const traceWindows = new Map();
const evalStateFile = join(userDataDirectory, "eval-data", "test-runs.json");
const graphRuntime = new GraphCompleteRuntimeService({
  userDataDirectory,
  graphServerBinary,
  configurationPaths,
  additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory },
  codexBasicClientModuleUrl: graphClientModuleUrl,
  ...(codexBrowserMcpInspection.available ? { codexBrowserMcpRuntime: codexBrowserMcpInspection } : {}),
  resolveCodexRuntime: () => managedCodexRuntime.resolve(),
  acquireProviderExecution: acquireEvalProviderExecution,
  // Eval keeps the temporal substrate coherent for every matrix cell. The selected
  // harness configuration independently controls whether agent-authored Complete is
  // exposed, so control and treatment can share one production-faithful runtime.
  temporalFeatures: RECURSIVE_TEMPORAL_FEATURES,
  candidateTrace: {
    directory: join(userDataDirectory, "eval-data", "candidate-trace-spool"),
    policy: {
      mode: "required",
      requiredFeatures: {},
      includeNativeArtifacts: false,
      maxBytesPerTurn: 10 * 1024 * 1024,
      maxEventsPerTurn: 50_000,
    },
  },
  onUnexpectedStop: () => app.quit(),
});
let productServer;
let evalService;
let stopping = false;
let stopPromise;
let quitFlowPromise;
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
  const { window, productOrigin } = await createReadOnlyReviewWindow(executionId, { annotations: true });
  manualReviewWindows.set(executionId, window);
  let reviewSession;
  window.on("closed", () => {
    if (manualReviewWindows.get(executionId) === window) manualReviewWindows.delete(executionId);
    if (reviewSessions.get(executionId) === reviewSession) reviewSessions.delete(executionId);
  });
  const navigationToken = randomBytes(16).toString("hex");
  await loadReadyReviewWorkspace({
    window,
    ipc: ipcMain,
    url: `${productOrigin}/?threadId=${encodeURIComponent(threadId)}`
      + `&review=1&reviewSession=${encodeURIComponent(navigationToken)}`,
    expected: {
      executionId,
      threadId,
      navigationToken,
    },
  });
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

async function createJudgeWindow(executionId) {
  const existing = judgeWindows.get(executionId);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  const context = evalService.reviewContext(executionId);
  const window = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0b0c0d",
    webPreferences: {
      preload: join(desktopDirectory, "preload", "eval-judge.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  judgeWindows.set(executionId, window);
  window.on("closed", () => {
    if (judgeWindows.get(executionId) === window) judgeWindows.delete(executionId);
  });
  windowSecurity(window);
  try {
    await window.loadFile(join(evalRendererDirectory, "judge.html"), {
      query: { runId: String(context.runId), executionId: String(executionId) },
    });
  } catch (error) {
    if (!window.isDestroyed()) window.close();
    throw error;
  }
  return window;
}

async function createTraceWindow(executionId, interactionId) {
  const key = `${executionId}:${interactionId || "first"}`;
  const existing = traceWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0b0c0d",
    webPreferences: {
      preload: join(desktopDirectory, "preload", "eval-trace.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  traceWindows.set(key, window);
  window.on("closed", () => {
    if (traceWindows.get(key) === window) traceWindows.delete(key);
  });
  windowSecurity(window);
  await window.loadFile(join(evalRendererDirectory, "trace.html"), {
    query: {
      executionId: String(executionId),
      ...(interactionId === undefined ? {} : { interactionId: String(interactionId) }),
    },
  });
  return window;
}

async function createReadOnlyReviewWindow(executionId, { annotations = false } = {}) {
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
      // Cookies are capabilities. A unique in-memory partition prevents a
      // manual annotation cookie from becoming visible to automated or other
      // review windows that happen to share the same app process.
      partition: `relayer-eval-review-${randomBytes(16).toString("hex")}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  reviewWindows.add(window);
  window.on("closed", () => reviewWindows.delete(window));
  try {
    windowSecurity(window, productOrigin);
    await window.webContents.session.cookies.set({
      url: productSession.origin,
      name: productSession.readOnlyCookie.name,
      value: productSession.readOnlyCookie.value,
      httpOnly: true,
      sameSite: "strict",
      secure: false,
    });
    if (annotations) {
      const annotationSessionToken = randomBytes(32).toString("hex");
      const context = evalService.reviewContext(executionId);
      const annotationThreadIds = [...new Set(
        context.cases.flatMap((item) => item.threadIds || []),
      )];
      const displayName = String(process.env.RELAYER_EVAL_ANNOTATOR_NAME || userInfo().username).trim();
      const response = await fetch(new URL("/api/internal/annotation-sessions", productSession.origin), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${productSession.cookie.name}=${productSession.cookie.value}`,
        },
        body: JSON.stringify({
          token: annotationSessionToken,
          threadIds: annotationThreadIds,
          authorId: `local:${userInfo().username}`,
          authorDisplayName: displayName,
        }),
      });
      if (!response.ok) {
        const value = await response.json().catch(() => ({}));
        throw new Error(value?.error || `Annotation session registration failed (${response.status}).`);
      }
      await window.webContents.session.cookies.set({
        url: productSession.origin,
        name: "relayer_annotation",
        value: annotationSessionToken,
        httpOnly: true,
        sameSite: "strict",
        secure: false,
      });
    }
    return {
      window,
      productOrigin,
      loadInputDraftRevision: async (selectedThreadId) => {
        const state = await productRequest(
          productSession,
          `/api/state?threadId=${encodeURIComponent(selectedThreadId)}`,
        );
        return state.inputDraftRevision;
      },
    };
  } catch (error) {
    reviewWindows.delete(window);
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

async function openAutomatedReviewSession({
  executionId,
  threadId,
  turnId,
  rootLayerId,
  artifactDirectory,
  inputOperatorAvailable = false,
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
  const navigationToken = randomBytes(16).toString("hex");
  await loadReadyReviewWorkspace({
    window: entry.window,
    ipc: ipcMain,
    url: `${entry.productOrigin}/?threadId=${encodeURIComponent(threadId)}`
      + `&interactionId=${encodeURIComponent(turnId)}&review=1`
      + `${inputOperatorAvailable ? "&inputOperator=1" : ""}`
      + `&reviewSession=${encodeURIComponent(navigationToken)}`,
    expected: {
      executionId,
      threadId,
      turnId,
      navigationToken,
    },
  });
  const session = new ReviewSession({
    executionId,
    readOnly: context.readOnly,
    webContents: entry.window.webContents,
    artifactDirectory,
    ipc: ipcMain,
    loadInputDraftRevision: entry.loadInputDraftRevision,
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
  ipcMain.handle("relayer-eval:import-conversation", async () => {
    const selection = await dialog.showOpenDialog(dashboardWindow, {
      title: "Import conversation",
      properties: ["openFile"],
      filters: [{ name: "Relayer conversation", extensions: ["jsonl"] }],
    });
    if (selection.canceled || selection.filePaths.length !== 1) return null;
    return evalService.importConversation(selection.filePaths[0]);
  });
  ipcMain.handle("relayer-eval:judge-imported-conversation", (_event, executionId, judgeConfigurationName) => (
    evalService.judgeImportedConversation(executionId, judgeConfigurationName)
  ));
  ipcMain.handle("relayer-eval:rejudge-execution", (_event, executionId, judgeConfigurationName) => (
    evalService.rejudgeExecution(executionId, judgeConfigurationName)
  ));
  ipcMain.handle("relayer-eval:open-review", async (_event, executionId) => {
    await createReviewWindow(executionId);
    return true;
  });
  ipcMain.handle("relayer-eval:export-annotations", (_event, executionId) => (
    evalService.exportAnnotatedExecution(executionId)
  ));
  ipcMain.handle("relayer-eval:open-judge-review", async (_event, executionId) => {
    await createJudgeWindow(executionId);
    return true;
  });
  ipcMain.handle("relayer-eval:open-candidate-trace", async (_event, executionId, interactionId) => {
    await createTraceWindow(executionId, interactionId);
    return true;
  });
  ipcMain.handle("relayer-eval:load-candidate-trace", (_event, executionId, interactionId) => (
    evalService.candidateTraceContext(executionId, interactionId)
  ));
  ipcMain.handle("relayer-eval:load-judge-screenshot", (_event, input) => (
    loadJudgeScreenshotArtifact({ ...input, stateFile: evalStateFile })
  ));
  ipcMain.handle("relayer-eval:review-context", (_event, executionId) => evalService.reviewContext(executionId));
}

async function start() {
  const pruning = await managedCodexRuntime.pruneInactiveInstallations();
  if (pruning.failures.length) {
    console.error("Retired managed runtime cleanup failed:", new AggregateError(
      pruning.failures.map(({ error }) => error),
      "One or more retired managed runtimes could not be removed.",
    ));
  }
  const runtimeSession = await graphRuntime.start();
  productServer = new RelayerAppServerService({
    userDataDirectory,
    binaryPath: appServerBinary,
    webDirectory: productRendererDirectory,
    permissionCatalogPath,
    runtimeSession,
    defaultHarnessConfiguration: "fixture-task-system",
    allowHarnessOverride: true,
    allowConversationImport: true,
    enableReadOnlySession: true,
    exportProducer: {
      desktopVersion: app.getVersion(),
      buildCommit: "development",
      platform: process.platform,
      architecture: process.arch,
    },
    onUnexpectedStop: () => app.quit(),
  });
  const productSession = await productServer.start();
  const ensureEvalCodexCatalog = createEvalCodexCatalogProvisioner({
    productSession,
    resolveRuntime: () => managedCodexRuntime.resolve(),
  });
  const simulatedUserJudgeRunner = createLocalSimulatedUserJudgeRunner({
    resolveCodexRuntime: () => managedCodexRuntime.resolve(),
    loadLayer: ({ threadId, turnId, layerId }) => productRequest(productSession, (
      `/api/threads/${encodeURIComponent(threadId)}`
      + `/interactions/${encodeURIComponent(turnId)}`
      + `/layers/${encodeURIComponent(layerId)}`
    )),
    openReviewSession: openAutomatedReviewSession,
    createInputOperator: (input) => createScopedInputOperator(productSession, input),
    captureInputRoundTrip: (input) => captureInputRoundTripEvidence(productSession, input),
  });
  evalService = await new EvalService({
    stateFile: evalStateFile,
    productSession,
    configurationPaths,
    simulatedUserJudgeRunner,
    candidateTraceExporter: (productInteractionId, targetDirectory, correlation) => (
      graphRuntime.exportCandidateTrace(productInteractionId, targetDirectory, correlation)
    ),
    candidateTraceAttributionLoader: (productInteractionId) => (
      graphRuntime.candidateTracePersonalPresentationVersionId(productInteractionId)
    ),
    candidateTraceRequired: true,
    ensureModelCatalog: ensureEvalCodexCatalog,
    conversationImportEnabled: true,
    annotationSnapshotLoader: (threadIds) => loadAnnotationSnapshots(productSession, threadIds),
    onChanged: (runs) => dashboardWindow?.webContents.send("relayer-eval:runs-changed", runs),
  }).open();
  registerEvalIpc();
  dashboardWindow = await createDashboardWindow();
  primaryInstance.presentPendingWindow();
  const localAutorun = resolveLocalSimulatedUserAutorun({
    packaged: app.isPackaged,
    availableHarnessConfigurationNames: evalService.catalog().harnessConfigurations
      .map((configuration) => configuration.name),
  });
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

async function createScopedInputOperator(session, { context, inputBindings }) {
  const occurrences = [...new Map([...inputBindings.values()].map((binding) => [
    JSON.stringify(binding.occurrence),
    binding.occurrence,
  ])).values()];
  if (occurrences.length === 0) return undefined;
  const authorityId = `eval-input-operator:${context.execution.id}:${context.turn.id}`;
  const token = randomBytes(32).toString("hex");
  const operator = new InputOperatorController({
    authority: {
      kind: "scoped_product_write",
      threadId: context.thread.id,
      authorityId,
    },
    transport: {
      request: (path, request) => operatorProductRequest(session, token, path, request),
    },
  });
  const lease = createInputOperatorLease({
    operator,
    revoke: () => controlProductRequest(session, "/api/internal/input-operator-sessions", {
      method: "DELETE",
      body: { token },
    }),
  });
  try {
    await controlProductRequest(session, "/api/internal/input-operator-sessions", {
      method: "POST",
      body: {
        token,
        threadId: Number(context.thread.id),
        occurrences,
      },
    });
  } catch (registrationError) {
    try {
      await releaseInputOperatorLease(lease);
    } catch (revocationError) {
      throw new AggregateError(
        [registrationError, revocationError],
        "Input operator session registration failed and its credential could not be revoked.",
      );
    }
    throw registrationError;
  }
  return lease;
}

async function controlProductRequest(session, path, request) {
  const cookie = session.cookie;
  if (!cookie) throw new Error("Relayer Eval product control authority is unavailable.");
  return productWriteRequest(session, path, request, `${cookie.name}=${cookie.value}`);
}

async function operatorProductRequest(session, token, path, request) {
  const cookie = session.readOnlyCookie;
  if (!cookie) throw new Error("Relayer Eval read-only input operator authority is unavailable.");
  return productWriteRequest(
    session,
    path,
    request,
    `${cookie.name}=${cookie.value}; relayer_input_operator=${token}`,
  );
}

async function productWriteRequest(session, path, request, cookieHeader) {
  const response = await fetch(new URL(path, session.origin), {
    method: request.method,
    headers: {
      Accept: "application/json",
      Cookie: cookieHeader,
      ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.error || `Input operator product request failed (${response.status}).`);
  return value;
}

async function captureInputRoundTripEvidence(session, { context, topology, operatorTrace, artifactDirectory }) {
  const commits = operatorTrace.filter((event) => event.operation === "input_commit");
  const send = operatorTrace.findLast((event) => event.operation === "send");
  if (commits.length === 0 || !send) {
    return {
      schemaVersion: 1,
      status: "not_exercised",
      passed: false,
      checks: [],
      detail: "The simulated user did not commit an input and activate Send.",
    };
  }
  const interactionId = Number(send.response?.id);
  if (!Number.isSafeInteger(interactionId) || interactionId < 1) {
    throw new Error("Input operator Send returned no product interaction identity.");
  }
  const interaction = await waitForOperatorInteraction(session, context.thread.id, interactionId);
  const traceDirectory = join(artifactDirectory, "candidate-trace");
  const descriptor = await graphRuntime.exportCandidateTrace(interactionId, traceDirectory, {
    runId: context.execution.testRunId,
    executionId: context.execution.id,
    interactionId: String(interactionId),
    harnessConfigurationName: context.execution.harnessConfigurationName,
  });
  const traceEvents = (await readFile(join(traceDirectory, "events.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const childrenResponse = await productRequest(
    session,
    `/api/threads/${encodeURIComponent(context.thread.id)}`
      + `/interactions/${encodeURIComponent(interactionId)}/input-children`,
  );
  const authoredInputs = topology.layers.flatMap((layer) => layer.actions
    .filter((action) => action.kind === "input")
    .map((action) => ({
      presentingInteractionNodeId: Number(action.occurrence?.presentingInteractionNodeId),
      presentingLayerId: Number(layer.id),
      sourceNodeId: Number(action.sourceNodeId),
      actionId: Number(action.id),
      control: action.control,
      prompt: action.prompt,
      options: action.options ?? [],
      ...(action.minimumSelections === undefined ? {} : { minimumSelections: action.minimumSelections }),
    })));
  const controlSet = gradeInputRoundTripControlSet(authoredInputs, commits.map((commit) => ({
    presentingInteractionNodeId: Number(commit.occurrence.presentingInteractionNodeId),
    presentingLayerId: Number(commit.occurrence.presentingLayerId),
    sourceNodeId: Number(commit.sourceNodeId),
    actionId: Number(commit.occurrence.actionId),
    control: commit.action.control,
    prompt: commit.action.prompt,
    options: commit.action.options ?? [],
    ...(commit.action.minimumSelections === undefined ? {} : { minimumSelections: commit.action.minimumSelections }),
  })));
  const authoredAccepted = commits.every((commit) => topology.layers.some((layer) => layer.actions.some((action) => (
      action.kind === "input"
      && String(action.id) === String(commit.occurrence.actionId)
      && String(layer.id) === String(commit.occurrence.presentingLayerId)
      && action.occurrence?.presentingInteractionNodeId === commit.occurrence.presentingInteractionNodeId
    ))));
  const roundTripSet = gradeInputRoundTripSet(commits.map((commit) => ({
      occurrence: commit.occurrence,
      sourceNodeId: commit.sourceNodeId,
      action: commit.action,
      value: commit.value,
    })), {
    authoredAccepted,
    interaction: {
      id: interaction.id,
      graphNodeId: interaction.graphNodeId,
      submittedInputs: interaction.submittedInputs ?? [],
    },
    inputChildren: childrenResponse.children ?? [],
    harnessTraceEvents: traceEvents,
  });
  const structuralPassed = controlSet.passed && roundTripSet.passed;
  const groundingRating = structuralPassed
    ? await captureInputGroundingRating({ session, context, interaction, commits, artifactDirectory })
    : null;
  const groundingPassed = groundingRating?.status === "completed"
    && groundingRating.verdict === "grounded";
  const groundingCheck = {
    name: "input-roundtrip:visible-follow-up-use",
    passed: groundingPassed,
    detail: groundingPassed
      ? "The rendered follow-up visibly uses every submitted matrix value."
      : "The rendered follow-up does not visibly use every submitted matrix value.",
  };
  return {
    schemaVersion: 1,
    status: interaction.completionStatus,
    interactionId,
    candidateTrace: descriptor,
    operatorTrace,
    passed: structuralPassed && groundingPassed,
    checks: [...controlSet.checks, ...roundTripSet.checks, groundingCheck],
    ...(groundingRating === null ? {} : { groundingRating }),
  };
}

async function captureInputGroundingRating({ session, context, interaction, commits, artifactDirectory }) {
  const rootLayerId = interaction.completionOutput?.rootLayer?.layer?.id;
  if (!rootLayerId) {
    return { schemaVersion: 1, status: "indeterminate", error: "Accepted input response has no visible root layer." };
  }
  let opened;
  try {
    const topology = await buildInputGroundingTopology({
      threadId: context.thread.id,
      interaction,
      loadLayer: ({ threadId, turnId, layerId }) => productRequest(session, (
        `/api/threads/${encodeURIComponent(threadId)}`
        + `/interactions/${encodeURIComponent(turnId)}`
        + `/layers/${encodeURIComponent(layerId)}`
      )),
    });
    const screenshotDirectory = join(artifactDirectory, "grounding-screenshot");
    opened = await openAutomatedReviewSession({
      executionId: context.execution.id,
      threadId: context.thread.id,
      turnId: interaction.id,
      rootLayerId,
      artifactDirectory: screenshotDirectory,
    });
    const targets = groundingCaptureTargets(topology);
    const captures = await captureGroundingTargets(opened.session, targets);
    if (captures.length === 0) {
      captures.push(await opened.session.screenshot({
        target: { kind: "viewport" },
        mode: "visible",
        label: "Input round-trip response",
      }));
    }
    if (captures.some((capture) => !capture?.ok || !capture.screenshot?.screenshotId)) {
      throw new Error("Production review workspace did not capture every input response root.");
    }
    const screenshots = captures.map(({ screenshot }) => screenshot);
    if (new Set(screenshots.map(({ threadRevision }) => threadRevision)).size !== 1) {
      throw new Error("Input grounding captures do not share one stable response revision.");
    }
    const groundingImages = screenshots.flatMap((screenshot) => {
      const directory = opened.session.artifactDirectoryFor(screenshot.screenshotId);
      if (!directory) throw new Error("Input grounding screenshot artifact directory is missing.");
      return [...screenshot.tiles]
        .sort((left, right) => left.index - right.index)
        .map((tile) => ({
          screenshotId: screenshot.screenshotId,
          path: join(
            directory,
            `${screenshot.screenshotId}-${String(tile.index + 1).padStart(3, "0")}.png`,
          ),
        }));
    });
    const imagePaths = groundingImages.map(({ path }) => path);
    const runtime = await managedCodexRuntime.resolve();
    return await runInputGroundingJudge({
      submittedInput: commits.length === 1
        ? commits[0].value
        : { values: commits.map((commit) => commit.value) },
      screenshot: {
        screenshotId: screenshots.map(({ screenshotId }) => screenshotId).join("+"),
        threadRevision: screenshots[0].threadRevision,
        imagePaths,
        imageRefs: groundingImages.map(({ path, screenshotId }) => [
          "input-roundtrip",
          "grounding-screenshot",
          screenshotId,
          path.split(/[\\/]/).at(-1),
        ].join("/")),
      },
      codexPathOverride: runtime.executable,
      environment: runtime.environment,
      workingDirectory: context.artifact?.workingDirectory || context.artifactDirectory,
      model: LOCAL_INPUT_GROUNDING_JUDGE_CONFIGURATION.model,
      modelReasoningEffort: LOCAL_INPUT_GROUNDING_JUDGE_CONFIGURATION.modelReasoningEffort,
    });
  } catch (error) {
    return {
      schemaVersion: 1,
      status: "indeterminate",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (opened) await opened.release({ close: true });
  }
}

async function waitForOperatorInteraction(session, threadId, interactionId) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const detail = await productRequest(session, `/api/threads/${encodeURIComponent(threadId)}`);
    const interaction = detail.interactions?.find((candidate) => Number(candidate.id) === interactionId);
    if (!interaction) throw new Error(`Input operator interaction ${interactionId} disappeared.`);
    if (operatorInteractionIsTerminal(interaction.completionStatus)) return interaction;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for input operator interaction ${interactionId}.`);
}

async function loadAnnotationSnapshots(session, threadIds) {
  const token = randomBytes(32).toString("hex");
  const username = userInfo().username;
  return loadAtomicAnnotationSnapshots({
    session,
    threadIds,
    token,
    authorId: `local:${username}`,
    authorDisplayName: String(process.env.RELAYER_EVAL_ANNOTATOR_NAME || username).trim(),
  });
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
    for (const window of judgeWindows.values()) {
      try { if (!window.isDestroyed()) window.close(); } catch (error) { errors.push(error); }
    }
    judgeWindows.clear();
    for (const window of traceWindows.values()) {
      try { if (!window.isDestroyed()) window.close(); } catch (error) { errors.push(error); }
    }
    traceWindows.clear();
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
    if (quitFlowPromise) return;
    quitFlowPromise = (async () => {
      if (!await confirmManagedRuntimeQuit({ installer: managedCodexRuntime, dialog, parent: dashboardWindow })) return;
      stopping = true;
      await stop().catch((error) => console.error("Relayer Eval shutdown failed:", error));
      app.quit();
    })().finally(() => {
      if (!stopping) quitFlowPromise = undefined;
    });
  });
}
