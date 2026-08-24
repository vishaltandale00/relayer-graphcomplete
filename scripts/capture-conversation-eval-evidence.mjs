import { app, BrowserWindow, ipcMain } from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { LayerObject, NodeObject, RelayerGraphClient } from "@relayer/graph-client";

import { EvalService } from "../desktop/eval-main/eval-service.mjs";
import { createConversationExportService } from "../desktop/main/services/conversation-export.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";

const OPT_IN = "RELAYER_CAPTURE_CONVERSATION_EVAL_EVIDENCE";
const repositoryRoot = resolve(import.meta.dirname, "..");
const outputDirectory = join(repositoryRoot, "docs", "prd", "assets", "evidence", "conversation-export-eval");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-conversation-evidence-"));
const ordinaryExportFile = join(dataDirectory, "ordinary-owner-export.jsonl");
const stateFile = join(dataDirectory, "eval-data", "test-runs.json");
const ipcChannels = [];
const services = [];
const screenshots = [];
let dashboardWindow;
let reviewWindow;
let ordinaryWindow;
let evalService;
let productSession;
let productServer;
let reviewOpenPromise;

if (process.env[OPT_IN] !== "1") throw new Error(`Evidence capture is opt-in. Set ${OPT_IN}=1.`);

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const workingTreeDirty = Boolean(execFileSync("git", ["status", "--porcelain"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim());

app.setName("Relayer Conversation Eval Evidence");
mkdirSync(join(dataDirectory, "electron-profile"), { recursive: true });
app.setPath("userData", join(dataDirectory, "electron-profile"));
app.commandLine.appendSwitch("disable-gpu");

function register(channel, handler) {
  ipcMain.handle(channel, handler);
  ipcChannels.push(channel);
}

function statusFixtureFactory() {
  return () => {
    return {
      traceSupport: () => ({ prompt: "none", messages: "none", reasoningSummaries: "none", modelCalls: "none", toolCalls: "none", usage: "none", childStreams: "none", nativeArtifacts: "none" }),
      state: () => ({}),
      async complete(context, signal) {
        if (context.inputGraph.detail === "FAIL_EVIDENCE") throw new Error("Deterministic evidence failure");
        if (context.inputGraph.detail === "RUNNING_EVIDENCE") {
          await new Promise((resolveWait) => signal?.addEventListener("abort", resolveWait, { once: true }));
          throw new Error("Evidence fixture stopped during supervised restart");
        }
        const graph = new RelayerGraphClient(context.graph.acquireCapability());
        const rootNode = new NodeObject("info", "Imported debugging answer", "The owner-exported accepted answer is rendered by ProductWorkspace.", "concept", "root");
        const expandedNode = new NodeObject("info", "Expanded diagnosis", "A nested expansion preserves authored hierarchy.", "detail", "expanded");
        const nestedNode = new NodeObject("info", "Nested finding", "The second expansion remains navigable after import.", "detail", "nested");
        const sharedNode = new NodeObject("info", "Shared evidence", "A reference destination can be shared without duplicating content.", "concept", "shared");
        const cycleNode = new NodeObject("info", "Reference cycle", "This layer safely links back to the shared evidence layer.", "concept", "cycle");
        for (const node of [rootNode, expandedNode, nestedNode, sharedNode, cycleNode]) await graph.submitNode(node);
        const root = new LayerObject([rootNode], [], "root-layer");
        const expanded = new LayerObject([expandedNode], [], "expanded-layer");
        const nested = new LayerObject([nestedNode], [], "nested-layer");
        const shared = new LayerObject([sharedNode], [], "shared-layer");
        const cycle = new LayerObject([cycleNode], [], "cycle-layer");
        for (const layer of [root, expanded, nested, shared, cycle]) await graph.submitLayer(layer);
        await graph.addAction(rootNode, { kind: "navigate", relation: "expand", sourceLayer: root, label: "Expand diagnosis", target: expanded, clientKey: "root-expand" });
        await graph.addAction(expandedNode, { kind: "navigate", relation: "expand", sourceLayer: expanded, label: "Open nested finding", target: nested, clientKey: "nested-expand" });
        await graph.addAction(rootNode, { kind: "navigate", relation: "reference", sourceLayer: root, label: "Open shared evidence", target: shared, clientKey: "root-reference" });
        await graph.addAction(expandedNode, { kind: "navigate", relation: "reference", sourceLayer: expanded, label: "Reuse shared evidence", target: shared, clientKey: "shared-reference" });
        await graph.addAction(sharedNode, { kind: "navigate", relation: "reference", sourceLayer: shared, label: "Follow reference cycle", target: cycle, clientKey: "cycle-forward" });
        await graph.addAction(cycleNode, { kind: "navigate", relation: "reference", sourceLayer: cycle, label: "Back to shared evidence", target: shared, clientKey: "cycle-back" });
        await graph.addAction(context.inputGraph.id, { kind: "navigate", relation: "expand", label: "Response", target: root, clientKey: "response" });
        await graph.submit(context.inputGraph.id);
      },
    };
  };
}

async function productRequest(path, options = {}) {
  const response = await fetch(new URL(path, productSession.origin), {
    ...options,
    headers: {
      ...options.headers,
      Cookie: `${productSession.cookie.name}=${productSession.cookie.value}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Product request failed (${response.status}).`);
  return value;
}

async function waitForTurn(threadId, index, status) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const detail = await productRequest(`/api/threads/${threadId}`);
    if (detail.interactions[index]?.completionStatus === status) return detail;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Evidence turn ${index + 1} did not reach ${status}.`);
}

async function createOrdinaryExport() {
  await productServer.publishProviderCatalog({
    providerId: "codex",
    label: "Codex fixture",
    connected: true,
    models: [{ id: "fixture-model", label: "Fixture model", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }],
    systemFamily: { key: "codex", name: "Codex", modelIds: ["fixture-model"] },
  });
  const settings = await productRequest("/api/model-settings");
  const modelSelection = { familyId: settings.families[0].id, providerId: "codex", modelId: "fixture-model" };
  const thread = await productRequest("/api/threads", {
    method: "POST",
    body: JSON.stringify({ title: "Ordinary owner conversation", initialMessage: "Explain the task queue", harnessId: "fixture-task-system", modelSelection }),
  });
  await waitForTurn(thread.id, 0, "accepted");
  await productRequest(`/api/threads/${thread.id}/interactions`, { method: "POST", body: JSON.stringify({ text: "FAIL_EVIDENCE", modelSelection }) });
  await waitForTurn(thread.id, 1, "failed");
  await productRequest(`/api/threads/${thread.id}/interactions`, { method: "POST", body: JSON.stringify({ text: "RUNNING_EVIDENCE", modelSelection }) });
  await waitForTurn(thread.id, 2, "running");

  ordinaryWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    show: false,
    backgroundColor: "#0b0c0d",
    webPreferences: { preload: join(repositoryRoot, "desktop", "preload", "index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await ordinaryWindow.webContents.session.cookies.set({
    url: productSession.origin,
    name: productSession.cookie.name,
    value: productSession.cookie.value,
    httpOnly: true,
    sameSite: "strict",
    secure: false,
  });
  await ordinaryWindow.loadURL(`${productSession.origin}/?threadId=${thread.id}`);
  ordinaryWindow.show();
  await waitFor("ordinary conversation sidebar", ordinaryWindow, `Boolean(document.querySelector('[data-thread="${thread.id}"]'))`);
  await ordinaryWindow.webContents.executeJavaScript(`document.querySelector('[data-thread="${thread.id}"]')?.click()`);
  await waitFor("ordinary conversation settings", ordinaryWindow, `Boolean(document.querySelector('#conversationSettingsButton:not(.hidden):not(:disabled)'))`);
  await ordinaryWindow.webContents.executeJavaScript(`document.querySelector('#conversationSettingsButton').click()`);
  await waitFor("ordinary export menu item", ordinaryWindow, `Boolean(document.querySelector('#conversationSettingsMenu:not(.hidden) #exportConversation:not(.hidden):not(:disabled)'))`);
  await capture(ordinaryWindow, "ordinary-conversation-export", ["Owner opens Conversation settings and sees the enabled Export conversation menu item"]);
  await ordinaryWindow.webContents.executeJavaScript(`document.querySelector('#exportConversation').click()`);
  const exportDeadline = Date.now() + 10_000;
  while (Date.now() < exportDeadline) {
    try { if ((await readFile(ordinaryExportFile)).length) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Ordinary export UI did not save JSONL bytes.");
}

async function waitFor(label, window, expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const diagnostic = window && !window.isDestroyed()
    ? await window.webContents.executeJavaScript(`({ url: location.href, body: document.body?.innerText?.slice(0, 2000), toast: document.querySelector('#toast')?.textContent, mainView: document.querySelector('#mainView')?.className })`).catch(() => null)
    : null;
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
}

async function capture(window, name, requirements) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  const bytes = (await window.webContents.capturePage()).toPNG();
  const path = join(outputDirectory, `${name}.png`);
  await writeFile(path, bytes);
  screenshots.push({ file: `${name}.png`, sha256: createHash("sha256").update(bytes).digest("hex"), requirements });
}

async function createReview(executionId) {
  const context = evalService.reviewContext(executionId);
  const threadId = context.cases[0].threadIds[0];
  const acceptedTurn = evalService.getRun(context.runId).executions
    .find((execution) => execution.id === executionId)?.turns
    .find((turn) => turn.status === "accepted");
  if (!acceptedTurn) throw new Error("Evidence fixture has no accepted turn.");
  reviewWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    show: false,
    backgroundColor: "#0b0c0d",
    webPreferences: {
      preload: join(repositoryRoot, "desktop", "preload", "eval-review.cjs"),
      additionalArguments: [`--relayer-eval-execution=${executionId}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await reviewWindow.webContents.session.cookies.set({
    url: productSession.origin,
    name: productSession.readOnlyCookie.name,
    value: productSession.readOnlyCookie.value,
    httpOnly: true,
    sameSite: "strict",
    secure: false,
  });
  await reviewWindow.loadURL(`${productSession.origin}/?threadId=${threadId}&interactionId=${acceptedTurn.interactionId}&review=1`);
  const browserState = await reviewWindow.webContents.executeJavaScript(`fetch('/api/state?threadId=${threadId}').then(async (response) => ({ status: response.status, body: await response.text() }))`);
  if (browserState.status !== 200) throw new Error(`Review product state failed: ${JSON.stringify(browserState)}`);
  const parsedBrowserState = JSON.parse(browserState.body);
  process.stdout.write(`Review state thread ${threadId}: ${JSON.stringify({ threads: parsedBrowserState.threads?.map((thread) => thread.id), interactions: parsedBrowserState.interactions?.map((turn) => [turn.id, turn.completionStatus]) })}\n`);
  reviewWindow.show();
  await waitFor("imported thread sidebar entry", reviewWindow, `Boolean(document.querySelector('[data-thread="${threadId}"]'))`);
  await reviewWindow.webContents.executeJavaScript(`document.querySelector('[data-thread="${threadId}"]')?.click()`);
  await waitFor("review turn picker", reviewWindow, `Boolean(document.querySelector('#turnPickerButton'))`);
  await waitFor("review thread hydration", reviewWindow, `document.querySelector('#interactionText')?.textContent === 'RUNNING_EVIDENCE'`);
  return reviewWindow;
}

async function run() {
  await mkdir(outputDirectory, { recursive: true });
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [join(repositoryRoot, "harnesses", "fixture-task-system.yaml")],
    additionalImplementations: { "fixture.task-system": statusFixtureFactory() },
  });
  services.push(runtime);
  const runtimeSession = await runtime.start();
  productServer = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    defaultHarnessConfiguration: "fixture-task-system",
    allowHarnessOverride: true,
    allowConversationImport: true,
    enableReadOnlySession: true,
  });
  services.push(productServer);
  productSession = await productServer.start();
  const nativeExporter = createConversationExportService({
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: ordinaryExportFile }) },
    getWindow: () => ordinaryWindow,
    exportConversation: (threadId) => productServer.exportConversation(threadId),
    createTemporaryId: () => "evidence",
  });
  register("relayer:conversation-export", (_event, threadId) => nativeExporter.save(threadId));
  register("relayer:account-read", () => ({ status: "connected", account: { email: "evidence@relayer.test", planType: "Evidence" } }));
  register("relayer:account-login", () => ({ status: "connected" }));
  register("relayer:account-logout", () => ({ status: "disconnected" }));
  register("relayer:model-catalog-settings-open", () => null);
  register("relayer:model-catalog-refresh", () => null);
  register("relayer:folder-choose", () => null);
  register("relayer:appearance-read", () => ({ appearance: "dark" }));
  register("relayer:appearance-set", () => ({ appearance: "dark" }));
  register("relayer:update-status", () => ({ phase: "development", channel: "stable", version: "evidence" }));
  register("relayer:update-check", () => ({ phase: "development" }));
  register("relayer:update-download", () => ({ phase: "development" }));
  register("relayer:update-install", () => ({ installing: false }));
  register("relayer:update-channel", () => ({ phase: "development" }));
  await createOrdinaryExport();
  evalService = await new EvalService({
    stateFile,
    productSession,
    configurationPaths: [join(repositoryRoot, "harnesses", "fixture-task-system.yaml")],
    conversationImportEnabled: true,
    onChanged: (runs) => dashboardWindow?.webContents.send("relayer-eval:runs-changed", runs),
  }).open();

  register("relayer-eval:catalog", () => evalService.catalog());
  register("relayer-eval:list-runs", () => evalService.listRuns());
  register("relayer-eval:get-run", (_event, id) => evalService.getRun(id));
  register("relayer-eval:create-run", () => { throw new Error("Evidence capture does not execute cases."); });
  register("relayer-eval:import-conversation", () => evalService.importConversation(ordinaryExportFile));
  register("relayer-eval:judge-imported-conversation", (_event, id, judge) => evalService.judgeImportedConversation(id, judge));
  register("relayer-eval:open-review", async (_event, id) => {
    reviewOpenPromise = createReview(id);
    await reviewOpenPromise;
    return true;
  });
  register("relayer-eval:open-judge-review", () => false);
  register("relayer-eval:open-candidate-trace", () => false);
  register("relayer-eval:load-candidate-trace", () => null);
  register("relayer-eval:load-judge-screenshot", () => null);
  register("relayer-eval:review-context", (_event, id) => evalService.reviewContext(id));

  dashboardWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    show: false,
    backgroundColor: "#0b0c0d",
    webPreferences: { preload: join(repositoryRoot, "desktop", "preload", "eval-dashboard.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await dashboardWindow.loadFile(join(repositoryRoot, "desktop", "eval-renderer", "index.html"));
  dashboardWindow.show();
  await waitFor("Eval empty dashboard", dashboardWindow, `Boolean(document.querySelector('#importConversation'))`);
  await dashboardWindow.webContents.executeJavaScript(`document.querySelector('#importConversation').click()`);
  await waitFor("imported run in dashboard", dashboardWindow, `document.querySelector('#runMetadata')?.textContent.includes('Imported conversation')`);
  await capture(dashboardWindow, "eval-dashboard-imported", ["Eval dashboard imported the exact owner-saved JSONL as an immutable external conversation"]);
  await dashboardWindow.webContents.executeJavaScript(`document.querySelector('[data-run-imported-judge="deterministic-graph-contract"]').click()`);
  await waitFor("deterministic judge completion", dashboardWindow, `document.querySelector('#runStatus')?.textContent === 'passed'`);
  await capture(dashboardWindow, "eval-dashboard-judged", ["Existing deterministic judge completed", "Product workspace action remains available"]);
  const importedExecution = evalService.listRuns()[0].executions[0];
  await dashboardWindow.webContents.executeJavaScript(`document.querySelector('[data-product-execution]')?.click()`);
  const openDeadline = Date.now() + 15_000;
  while (!reviewOpenPromise && Date.now() < openDeadline) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  if (!reviewOpenPromise) throw new Error("Dashboard did not open ProductWorkspace.");
  await reviewOpenPromise;
  const acceptedInteractionId = importedExecution.turns.find((turn) => turn.status === "accepted").interactionId;
  await waitFor("loaded review controls", reviewWindow, `Boolean(document.querySelector('#turnPickerButton'))`);
  await reviewWindow.webContents.executeJavaScript(`document.querySelector('#turnPickerButton')?.click()`);
  await waitFor("accepted turn option after review open", reviewWindow, `Boolean(document.querySelector('[data-turn-id="${acceptedInteractionId}"]'))`);
  await reviewWindow.webContents.executeJavaScript(`document.querySelector('[data-turn-id="${acceptedInteractionId}"]')?.click()`);
  await waitFor("review root", reviewWindow, `document.querySelector('.graph-node b')?.textContent === 'Imported debugging answer'`);
  await capture(reviewWindow, "product-workspace-imported-root", ["Production ProductWorkspace renders imported accepted turn", "Review mode is read-only", "Turn navigation includes unfinished and failed turns"]);
  await reviewWindow.webContents.executeJavaScript(`document.querySelector('#turnPickerButton').click()`);
  await waitFor("turn statuses", reviewWindow, `document.querySelectorAll('.turn-option-status').length === 3`);
  await capture(reviewWindow, "product-workspace-turn-statuses", ["Turn picker visibly distinguishes accepted, failed, and unfinished imported turns"]);
  await reviewWindow.webContents.executeJavaScript(`document.querySelector('#turnPickerButton').click()`);
  await reviewWindow.webContents.executeJavaScript(`document.querySelector('.graph-node')?.click()`);
  await waitFor("root node action", reviewWindow, `document.querySelector('#detailTitle')?.textContent === 'Imported debugging answer' && Boolean(document.querySelector('[data-action-id]'))`);
  await reviewWindow.webContents.executeJavaScript(`[...document.querySelectorAll('[data-action-id]')].find((button) => button.textContent.includes('shared evidence'))?.click()`);
  await waitFor("reference layer", reviewWindow, `document.querySelector('.graph-node b')?.textContent === 'Shared evidence'`);
  await reviewWindow.webContents.executeJavaScript(`document.querySelector('.graph-node')?.click()`);
  await waitFor("node detail", reviewWindow, `document.querySelector('#detailTitle')?.textContent === 'Shared evidence'`);
  await capture(reviewWindow, "product-workspace-reference-detail", ["Reference navigation reached shared layer", "Breadcrumb preserves authored path", "Node detail renders in production inspector"]);

  const importedRunBeforeRestart = evalService.listRuns()[0];
  const importedExecutionBeforeRestart = importedRunBeforeRestart.executions[0];
  const acceptedBeforeRestart = importedExecutionBeforeRestart.turns.find((turn) => turn.status === "accepted");
  const sourceShaBeforeRestart = importedRunBeforeRestart.sourceSha256;
  const judgeProvenanceBeforeRestart = acceptedBeforeRestart.deterministicJudge?.provenance;
  if (!judgeProvenanceBeforeRestart) throw new Error("Evidence run is missing deterministic judge provenance before restart.");

  reviewWindow.destroy();
  reviewWindow = undefined;
  dashboardWindow.destroy();
  dashboardWindow = undefined;
  await productServer.close();
  await runtime.close();

  const restartedRuntime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [join(repositoryRoot, "harnesses", "fixture-task-system.yaml")],
    additionalImplementations: { "fixture.task-system": statusFixtureFactory() },
  });
  services.push(restartedRuntime);
  const restartedRuntimeSession = await restartedRuntime.start();
  productServer = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession: restartedRuntimeSession,
    defaultHarnessConfiguration: "fixture-task-system",
    allowHarnessOverride: true,
    allowConversationImport: true,
    enableReadOnlySession: true,
  });
  services.push(productServer);
  productSession = await productServer.start();
  evalService = await new EvalService({
    stateFile,
    productSession,
    configurationPaths: [join(repositoryRoot, "harnesses", "fixture-task-system.yaml")],
    conversationImportEnabled: true,
    onChanged: (runs) => dashboardWindow?.webContents.send("relayer-eval:runs-changed", runs),
  }).open();
  const replayedRun = evalService.getRun(importedRunBeforeRestart.id);
  const replayedExecution = replayedRun.executions.find((execution) => execution.id === importedExecutionBeforeRestart.id);
  const replayedAccepted = replayedExecution?.turns.find((turn) => turn.status === "accepted");
  if (
    replayedRun.sourceSha256 !== sourceShaBeforeRestart
    || replayedRun.status !== "passed"
    || replayedAccepted?.deterministicJudge?.provenance?.sourceSha256 !== judgeProvenanceBeforeRestart.sourceSha256
    || replayedAccepted?.deterministicJudge?.provenance?.sourceTurnId !== judgeProvenanceBeforeRestart.sourceTurnId
  ) {
    throw new Error("Restarted Eval run did not preserve source, status, and judge provenance.");
  }

  dashboardWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    show: false,
    backgroundColor: "#0b0c0d",
    webPreferences: { preload: join(repositoryRoot, "desktop", "preload", "eval-dashboard.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await dashboardWindow.loadFile(join(repositoryRoot, "desktop", "eval-renderer", "index.html"));
  dashboardWindow.show();
  await waitFor("restarted imported dashboard", dashboardWindow, `document.querySelector('#runStatus')?.textContent === 'passed' && document.querySelector('#runMetadata')?.textContent.includes(${JSON.stringify(sourceShaBeforeRestart)})`);
  await capture(dashboardWindow, "eval-dashboard-restarted", ["Eval restart replays the same imported source digest and completed deterministic judge"]);

  reviewOpenPromise = undefined;
  await dashboardWindow.webContents.executeJavaScript(`document.querySelector('[data-product-execution]')?.click()`);
  const replayOpenDeadline = Date.now() + 15_000;
  while (!reviewOpenPromise && Date.now() < replayOpenDeadline) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  if (!reviewOpenPromise) throw new Error("Restarted dashboard did not reopen ProductWorkspace.");
  await reviewOpenPromise;
  const replayedAcceptedInteractionId = replayedAccepted.interactionId;
  await reviewWindow.webContents.executeJavaScript(`document.querySelector('#turnPickerButton')?.click()`);
  await waitFor("replayed accepted turn", reviewWindow, `Boolean(document.querySelector('[data-turn-id="${replayedAcceptedInteractionId}"]'))`);
  await reviewWindow.webContents.executeJavaScript(`document.querySelector('[data-turn-id="${replayedAcceptedInteractionId}"]')?.click()`);
  await waitFor("replayed root graph", reviewWindow, `document.querySelector('.graph-node b')?.textContent === 'Imported debugging answer'`);
  await reviewWindow.webContents.executeJavaScript(`document.querySelector('.graph-node')?.click()`);
  await waitFor("replayed reference action", reviewWindow, `Boolean([...document.querySelectorAll('[data-action-id]')].find((button) => button.textContent.includes('shared evidence')))`);
  await reviewWindow.webContents.executeJavaScript(`[...document.querySelectorAll('[data-action-id]')].find((button) => button.textContent.includes('shared evidence'))?.click()`);
  await waitFor("replayed shared reference", reviewWindow, `document.querySelector('.graph-node b')?.textContent === 'Shared evidence'`);
  await capture(reviewWindow, "product-workspace-restarted-reference", ["After graph, product, and Eval restart, the same imported execution reopens and reference navigation still works"]);

  const ownerExportBytes = await readFile(ordinaryExportFile);
  const ownerExportSha256 = `sha256:${createHash("sha256").update(ownerExportBytes).digest("hex")}`;
  const ordinaryImportedRun = evalService.listRuns().find((run) => run.title === "Ordinary owner conversation");
  const manifest = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    sourceCommit,
    workingTreeDirty,
    command: `${OPT_IN}=1 electron scripts/capture-conversation-eval-evidence.mjs`,
    paidInferenceCalls: 0,
    ownerExportSha256,
    importedSourceSha256: ordinaryImportedRun?.sourceSha256,
    exactOwnerBytesImported: ordinaryImportedRun?.sourceSha256 === ownerExportSha256,
    restartReplay: {
      runId: replayedRun.id,
      executionId: replayedExecution.id,
      sourceSha256: replayedRun.sourceSha256,
      status: replayedRun.status,
      judgeProvenance: replayedAccepted.deterministicJudge.provenance,
    },
    renderer: "desktop/renderer ProductWorkspace and desktop/eval-renderer dashboard",
    screenshots,
  };
  await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

async function stop() {
  for (const channel of ipcChannels) ipcMain.removeHandler(channel);
  if (ordinaryWindow && !ordinaryWindow.isDestroyed()) ordinaryWindow.destroy();
  if (reviewWindow && !reviewWindow.isDestroyed()) reviewWindow.destroy();
  if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.destroy();
  for (const service of services.reverse()) await service.close().catch(() => undefined);
  await rm(dataDirectory, { recursive: true, force: true });
}

app.whenReady().then(run).then(async () => {
  await stop();
  app.exit(0);
}).catch(async (error) => {
  console.error(error);
  await stop();
  app.exit(1);
});
