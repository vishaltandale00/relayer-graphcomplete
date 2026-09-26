import { app, BrowserWindow, ipcMain } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { nodeDetailFixtureFactory } from "@relayer/eval-runner";

import { EvalService } from "../desktop/eval-main/eval-service.mjs";
import { ReviewSession } from "../desktop/eval-main/review-session.mjs";
import { loadReadyReviewWorkspace } from "../desktop/eval-main/review-workspace-readiness.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-visual-node-detail-"));
const evidenceRoot = resolve(
  process.env.RELAYER_VISUAL_NODE_DETAIL_EVIDENCE_DIR
    || join(repositoryRoot, ".relayer", "evidence", "visual-node-details"),
);
const artifactDirectory = join(
  evidenceRoot,
  `run-${new Date().toISOString().replaceAll(":", "-")}-${randomBytes(4).toString("hex")}`,
);
const stateFile = join(dataDirectory, "eval-data", "test-runs.json");
const configurationPath = join(repositoryRoot, "harnesses", "fixture-node-detail.yaml");
const resultFile = process.env.RELAYER_VISUAL_NODE_DETAIL_RESULT_FILE || null;
const services = [];
let evalService;
let productSession;
let reviewWindow;
let keepaliveWindow;

app.setName("Relayer Visual Node Detail Evidence");
app.setPath("userData", join(dataDirectory, "electron-profile"));
app.commandLine.appendSwitch("disable-gpu");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function productRequest(session, path, options = {}) {
  const response = await fetch(new URL(path, session.origin), {
    ...options,
    headers: {
      Accept: "application/json",
      ...options.headers,
      Cookie: `${session.cookie.name}=${session.cookie.value}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error || value.message || `Product request failed (${response.status}).`);
    error.status = response.status;
    error.code = value.code;
    throw error;
  }
  return value;
}

async function waitForCompletedRun(runId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = evalService.getRun(runId);
    if (!["queued", "running"].includes(run.status)) {
      await evalService.persistTail;
      return run;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Visual Node Detail Eval run did not finish: ${JSON.stringify(evalService.getRun(runId))}`);
}

async function waitForRenderedAsset(window, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await window.webContents.executeJavaScript(`(() => {
      const image = document.querySelector('.node-detail-runtime-host')?.shadowRoot?.querySelector('img');
      return image ? {
        alt: image.alt,
        assetState: image.dataset.assetState,
        sourceProtocol: image.src ? new URL(image.src).protocol : null,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
      } : null;
    })()`);
    if (result?.assetState === "available" && result.sourceProtocol === "blob:"
      && result.complete && result.naturalWidth > 0) return result;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Accepted visual asset did not load through the production Node Detail runtime.");
}

function controlByName(state, name, kind) {
  return state.controls.find((control) => control.name === name && (!kind || control.kind === kind));
}

async function openReview({ execution, threadId, turnId, rootLayerId }) {
  const context = evalService.reviewContext(execution.id);
  invariant(context.readOnly === true, "Eval review context is not server-enforced read-only.");
  const navigationToken = randomBytes(16).toString("hex");
  const partition = `relayer-visual-node-detail-${randomBytes(12).toString("hex")}`;
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    show: true,
    backgroundColor: "#0b0c0d",
    webPreferences: {
      preload: join(repositoryRoot, "desktop", "preload", "eval-review.cjs"),
      additionalArguments: [`--relayer-eval-execution=${execution.id}`],
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.webContents.session.cookies.set({
    url: productSession.origin,
    name: productSession.readOnlyCookie.name,
    value: productSession.readOnlyCookie.value,
    httpOnly: true,
    sameSite: "strict",
    secure: false,
  });
  try {
    await loadReadyReviewWorkspace({
      window,
      ipc: ipcMain,
      url: `${productSession.origin}/?threadId=${encodeURIComponent(threadId)}`
        + `&interactionId=${encodeURIComponent(turnId)}&review=1`
        + `&reviewSession=${encodeURIComponent(navigationToken)}`,
      expected: { executionId: execution.id, threadId, turnId, navigationToken },
    });
  } catch (error) {
    const diagnostic = await window.webContents.executeJavaScript(`({
      url: location.href,
      body: document.body?.innerText?.slice(0, 2000),
      toast: document.querySelector('#toast')?.textContent,
      hasReviewBridge: Boolean(window.relayerEvalReview),
    })`).catch(() => null);
    throw new Error(`${error.message} Diagnostic: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  const session = new ReviewSession({
    executionId: execution.id,
    readOnly: true,
    webContents: window.webContents,
    artifactDirectory,
    ipc: ipcMain,
    loadInputDraftRevision: async (selectedThreadId) => {
      const state = await productRequest(productSession, `/api/state?threadId=${encodeURIComponent(selectedThreadId)}`);
      return state.inputDraftRevision;
    },
  });
  const state = await session.open();
  invariant(String(state.layerId) === String(rootLayerId), "Review opened outside the accepted root layer.");
  return { window, session, state };
}

async function run() {
  keepaliveWindow = new BrowserWindow({ width: 1, height: 1, show: false });
  await mkdir(artifactDirectory, { recursive: true });
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [configurationPath],
    additionalImplementations: { "fixture.node-detail": nodeDetailFixtureFactory },
  });
  services.push(runtime);
  const runtimeSession = await runtime.start();
  const product = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    defaultHarnessConfiguration: "fixture-node-detail",
    allowHarnessOverride: true,
    allowConversationImport: true,
    enableReadOnlySession: true,
    exportProducer: {
      desktopVersion: "visual-node-detail-evidence",
      buildCommit: "0000000000000000000000000000000000000000",
      platform: process.platform,
      architecture: process.arch,
    },
  });
  services.push(product);
  productSession = await product.start();
  evalService = await new EvalService({
    stateFile,
    productSession,
    configurationPaths: [configurationPath],
    conversationImportEnabled: true,
  }).open();
  ipcMain.handle("relayer-eval:review-context", (_event, executionId) => evalService.reviewContext(executionId));

  const created = await evalService.createRun({
    testCaseIds: ["empty-project.visual-node-detail.single-turn"],
    harnessConfigurationNames: ["fixture-node-detail"],
    judgeConfigurationName: "deterministic-graph-contract",
  });
  const completed = await waitForCompletedRun(created.id);
  const execution = completed.executions[0];
  const threadId = execution.threadIds[0];
  const thread = await productRequest(productSession, `/api/threads/${encodeURIComponent(threadId)}`);
  invariant(completed.status === "passed", `Deterministic fixture failed: ${JSON.stringify({ completed, thread })}`);
  const turn = thread.interactions.find((interaction) => interaction.completionStatus === "accepted");
  invariant(turn?.completionOutput, "Fixture did not produce ordinary accepted product state.");
  const rootLayer = turn.completionOutput.rootLayer;
  const authoredNode = rootLayer.nodes.find((node) => node.title === "Accepted Visual Node Detail");
  invariant(authoredNode?.authoredDetail?.version === 1, "Accepted node is missing its canonical authored package.");
  invariant(JSON.stringify(authoredNode.authoredDetail.components.map(({ id }) => id))
    === JSON.stringify(["primary", "status", "facts", "visual", "navigation", "actions"]), "Authored component order drifted.");
  invariant(authoredNode.authoredDetail.assets.length === 1, "Accepted package did not retain its pinned visual asset.");
  const [acceptedAsset] = authoredNode.authoredDetail.assets;
  invariant(acceptedAsset.mediaType === "image/svg+xml" && /^[a-f0-9]{64}$/.test(acceptedAsset.digestSha256),
    "Accepted package visual asset pin is invalid.");

  const opened = await openReview({
    execution,
    threadId,
    turnId: turn.id,
    rootLayerId: rootLayer.layer.id,
  });
  reviewWindow = opened.window;
  let session = opened.session;
  let state = opened.state;
  const nodeControl = controlByName(state, "Open Accepted Visual Node Detail", "node");
  invariant(nodeControl, `Authored node is not discoverable: ${JSON.stringify(state.controls)}`);
  await session.interact({ elementRef: nodeControl.elementRef, activate: true });
  state = await session.state();
  invariant(String(state.selectedNodeId) === String(authoredNode.id), "Review did not select the authored node.");
  const renderedAsset = await waitForRenderedAsset(reviewWindow);
  invariant(renderedAsset.alt === "Accepted detail status illustration", "Rendered visual asset lost its accessible label.");
  const expectedControls = [
    ["Open implementation notes", "navigate-action", false],
    ["Open referenced evidence", "navigate-action", false],
    ["Open fixture documentation", "link", false],
    ["Investigate follow-up", "invoke-action", true],
    ["Review note", "input-action", true],
  ];
  for (const [name, kind, disabled] of expectedControls) {
    const control = controlByName(state, name, kind);
    invariant(control && control.disabled === disabled, `Unexpected review control ${name}: ${JSON.stringify(control)}`);
  }
  const screenshot = await session.screenshot({
    target: { kind: "element", elementRef: "node-detail" },
    mode: "full",
    label: "Accepted visual Node Detail in read-only Product workspace",
  });
  invariant(screenshot.screenshot.tileCount >= 1, "Full Node Detail screenshot produced no tiles.");
  const screenshotDirectory = session.artifactDirectoryFor(screenshot.screenshot.screenshotId);
  invariant(screenshotDirectory, "ReviewSession did not retain the screenshot artifact directory.");

  const expand = controlByName(state, "Open implementation notes", "navigate-action");
  await session.interact({ elementRef: expand.elementRef, activate: true });
  let expanded = await session.state();
  invariant(expanded.navigationPath.some((entry) => String(entry.viaActionId) === String(expand.actionId)), "Expand action is absent from the review path.");
  await session.history({ delta: -1 });
  state = await session.state();
  invariant(String(state.layerId) === String(rootLayer.layer.id), "Back history did not restore the root layer.");
  const reference = controlByName(state, "Open referenced evidence", "navigate-action");
  await session.interact({ elementRef: reference.elementRef, activate: true });
  const referenced = await session.state();
  invariant(referenced.navigationPath.some((entry) => String(entry.viaActionId) === String(reference.actionId)), "Reference action is absent from the review path.");
  await session.history({ delta: -1 });

  const readOnlySession = { ...productSession, cookie: productSession.readOnlyCookie };
  let rejected;
  try {
    await productRequest(readOnlySession, `/api/threads/${encodeURIComponent(threadId)}/interactions`, {
      method: "POST",
      body: JSON.stringify({ text: "Attempt a forbidden review mutation." }),
    });
  } catch (error) {
    rejected = error;
  }
  invariant(rejected?.status === 403 && rejected?.code === "read_only_session", "Read-only server authority accepted a mutation.");

  const beforeReopen = await session.state();
  reviewWindow.destroy();
  reviewWindow = undefined;
  const reopened = await openReview({ execution, threadId, turnId: turn.id, rootLayerId: rootLayer.layer.id });
  reviewWindow = reopened.window;
  session = reopened.session;
  state = reopened.state;
  invariant(String(state.layerId) === String(rootLayer.layer.id), "Reopened review did not restore accepted root state.");
  invariant(state.threadRevision === beforeReopen.threadRevision, "Reopened review observed a different immutable thread revision.");
  const reopenedNodeControl = controlByName(state, "Open Accepted Visual Node Detail", "node");
  await session.interact({ elementRef: reopenedNodeControl.elementRef, activate: true });
  const reopenedAsset = await waitForRenderedAsset(reviewWindow);

  const exportPath = join(artifactDirectory, "conversation.jsonl");
  await writeFile(exportPath, await product.exportConversation(threadId), { mode: 0o600 });
  const importedRun = await evalService.importConversation(exportPath);
  const importedExecution = importedRun.executions[0];
  const importedThreadId = importedExecution.threadIds[0];
  const importedThread = await productRequest(productSession, `/api/threads/${encodeURIComponent(importedThreadId)}`);
  const importedTurn = importedThread.interactions.find((interaction) => interaction.completionStatus === "accepted");
  const importedRoot = importedTurn?.completionOutput?.rootLayer;
  const importedNode = importedRoot?.nodes.find((node) => node.title === "Accepted Visual Node Detail");
  invariant(importedNode?.authoredDetail?.assets?.[0]?.digestSha256 === acceptedAsset.digestSha256,
    "Conversation import did not preserve the accepted visual asset pin.");
  reviewWindow.destroy();
  reviewWindow = undefined;
  const importedReview = await openReview({
    execution: importedExecution,
    threadId: importedThreadId,
    turnId: importedTurn.id,
    rootLayerId: importedRoot.layer.id,
  });
  reviewWindow = importedReview.window;
  session = importedReview.session;
  state = importedReview.state;
  const importedNodeControl = controlByName(state, "Open Accepted Visual Node Detail", "node");
  await session.interact({ elementRef: importedNodeControl.elementRef, activate: true });
  const importedAsset = await waitForRenderedAsset(reviewWindow);
  const importedScreenshot = await session.screenshot({
    target: { kind: "element", elementRef: "node-detail" },
    mode: "full",
    label: "Imported accepted visual Node Detail with portable image bytes",
  });
  const importedScreenshotDirectory = session.artifactDirectoryFor(importedScreenshot.screenshot.screenshotId);
  invariant(importedScreenshotDirectory && importedScreenshot.screenshot.tileCount >= 1,
    "Imported image evidence was not retained by ReviewSession.");

  const manifest = {
    schemaVersion: 1,
    paidInferenceCalls: 0,
    runId: completed.id,
    executionId: execution.id,
    threadId,
    turnId: turn.id,
    acceptedPackageIntegrity: authoredNode.authoredDetail.integritySha256,
    screenshot: screenshot.screenshot,
    screenshotDirectory,
    assertions: {
      ordinaryEvalProductState: true,
      authoredLayoutMounted: true,
      controlsDiscovered: expectedControls.map(([name]) => name),
      expandAndReferenceNavigation: true,
      historyRestoration: true,
      invokeAndInputDisabled: true,
      serverMutationRejected: { status: rejected.status, code: rejected.code },
      reopened: true,
      visualAsset: { id: acceptedAsset.id, digestSha256: acceptedAsset.digestSha256, renderedAsset },
      visualAssetReopened: reopenedAsset,
      visualAssetExportImport: {
        exportPath,
        importedRunId: importedRun.id,
        importedExecutionId: importedExecution.id,
        importedThreadId,
        pinPreserved: true,
        renderedAsset: importedAsset,
        portabilityPending: false,
        screenshot: importedScreenshot.screenshot,
        screenshotDirectory: importedScreenshotDirectory,
      },
    },
  };
  const manifestPath = join(artifactDirectory, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const persisted = JSON.parse(await readFile(manifestPath, "utf8"));
  persisted.manifestSha256 = createHash("sha256").update(JSON.stringify(persisted)).digest("hex");
  persisted.manifestPath = manifestPath;
  process.stdout.write(`${JSON.stringify(persisted, null, 2)}\n`);
  return {
    passed: true,
    paidInferenceCalls: 0,
    manifestPath,
    screenshotId: screenshot.screenshot.screenshotId,
    screenshotDirectory,
  };
}

async function stop() {
  ipcMain.removeHandler("relayer-eval:review-context");
  if (reviewWindow && !reviewWindow.isDestroyed()) reviewWindow.destroy();
  if (keepaliveWindow && !keepaliveWindow.isDestroyed()) keepaliveWindow.destroy();
  for (const service of services.reverse()) await service.close().catch(() => undefined);
  await rm(dataDirectory, { recursive: true, force: true });
}

app.whenReady().then(run).then(async (result) => {
  if (resultFile) await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await stop();
  app.exit(0);
}).catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  if (resultFile) {
    await writeFile(resultFile, `${JSON.stringify({ passed: false, error: error?.stack || String(error) }, null, 2)}\n`, { mode: 0o600 })
      .catch(() => undefined);
  }
  await stop();
  app.exit(1);
});
