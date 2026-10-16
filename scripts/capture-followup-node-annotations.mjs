import { execFileSync } from "node:child_process";
import { interactionPositionCondition } from "./interaction-navigator-driver.mjs";
import { createSettingsStore } from "../desktop/main/services/settings-store.mjs";
import { registerComposerDraftIpc, registerLayerSelectionIpc, registerWorkspaceLayoutIpc } from "../desktop/main/ipc/register-ipc.mjs";
import { app, BrowserWindow, ipcMain } from "electron";
import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";

import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";
import { createElectronWorkspaceDriver } from "./electron-workspace-driver.mjs";

// Keep Electron alive while service and temporary-directory cleanup settles.
app.on("window-all-closed", () => {});

const repositoryRoot = resolve(import.meta.dirname, "..");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-interaction-context-lifecycle-"));
const projectDirectory = join(dataDirectory, "project");
const configurationPath = join(repositoryRoot, "harnesses", "fixture-task-system.yaml");
const graphServerBinary = join(repositoryRoot, "target", "debug", "relayer-graph-server");
const appServerBinary = join(repositoryRoot, "target", "debug", "relayer-app-server");
const SECOND_DRAFT_VALUE = "Keep worker capacity visible while prioritizing work.";
const outputDirectory = resolve(process.env.RELAYER_ANNOTATION_EVIDENCE_DIRECTORY || '.relayer/evidence/followup-node-annotations');
const baselineCommit = execFileSync('git', ['rev-parse', process.env.RELAYER_ANNOTATION_BASELINE || '70d2d5fad590b75c7903358a0f4805026647cd76'], { encoding: 'utf8' }).trim();
const rendererRelativePath = 'desktop/renderer/src/product-workspace/workspace.js';
const rendererDirectory = join(dataDirectory, 'renderer');
const baselineRenderer = execFileSync('git', ['show', `${baselineCommit}:${rendererRelativePath}`]);
const currentRenderer = readFileSync(join(repositoryRoot, rendererRelativePath));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const receipt = { schemaVersion: 1, captureScriptSha256: sha256(readFileSync(import.meta.filename)), paidInferenceCalls: 0, baselineCommit, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), renderer: { path: rendererRelativePath, baselineSha256: sha256(baselineRenderer), fixedSha256: sha256(currentRenderer) }, binaries: Object.fromEntries([graphServerBinary, appServerBinary].map(path => [path.replace(repositoryRoot + '/', ''), sha256(readFileSync(path))])), checkpoints: [] };

let runtime;
let catalogRefreshServer;
let product;
let productSession;
let window;
let keepaliveWindow;
let fixtureCompletionCount = 0;
let releasePendingFixture;
const pendingFixtureGate = new Promise((resolveGate) => { releasePendingFixture = resolveGate; });

app.setName("Relayer Interaction Context Lifecycle Test");
// A proof parent can retain Chromium storage until the Electron process exits.
app.setPath("userData", process.env.RELAYER_ANNOTATION_EVIDENCE_PROFILE || join(dataDirectory, "electron-profile"));
app.commandLine.appendSwitch("disable-gpu");

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

function controlledTaskSystemFixtureFactory(...args) {
  const harness = taskSystemFixtureFactory(...args);
  return {
    traceSupport: (...methodArgs) => harness.traceSupport(...methodArgs),
    state: (...methodArgs) => harness.state(...methodArgs),
    async complete(context) {
      fixtureCompletionCount += 1;
      if (fixtureCompletionCount === 3) await pendingFixtureGate;
      return harness.complete(context);
    },
  };
}

const {
  click,
  clickNode,
  evaluate,
  productRequest,
  setValue,
  waitFor,
  waitForAcceptedInteractions,
  waitForPaint,
} = createElectronWorkspaceDriver({
  getWindow: () => window,
  getProductSession: () => productSession,
});

function registerIpc() {
  const settings = createSettingsStore(dataDirectory);
  registerComposerDraftIpc({ ipcMain, settings });
  registerLayerSelectionIpc({ ipcMain, settings });
  registerWorkspaceLayoutIpc({ ipcMain, settings });
  ipcMain.handle('relayer:share-pending', () => null);
  ipcMain.handle("relayer:account-read", () => ({
    status: "signed-in",
    channel: "stable",
    subject: "fixture|node-details-lifecycle",
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
  ipcMain.handle("relayer:folder-choose", () => null);
  ipcMain.handle("relayer:tutorial-read", () => ({
    status: "dismissed",
    automaticEligible: false,
  }));
  ipcMain.handle("relayer:provider-status", () => ({
    adapters: [],
    definitions: [],
    hasCompletedOnboarding: true,
  }));
}

function unregisterIpc() {
  for (const channel of [
    "relayer:layer-selections-read",
    "relayer:layer-selections-remember",
    "relayer:workspace-layout-read",
    "relayer:workspace-layout-set",
    "relayer:share-pending",
    "relayer:composer-drafts-read",
    "relayer:composer-drafts-write",
    "relayer:account-read",
    "relayer:appearance-read",
    "relayer:update-status",
    "relayer:folder-choose",
    "relayer:tutorial-read",
    "relayer:provider-status",
  ]) ipcMain.removeHandler(channel);
}

async function startServices() {
  runtime = new GraphCompleteRuntimeService({
    // Capture infrastructure allowance; this proof does not measure startup latency.
    startupTimeoutMs: 60_000,
    userDataDirectory: dataDirectory,
    graphServerBinary,
    configurationPaths: [configurationPath],
    additionalImplementations: { "fixture.task-system": controlledTaskSystemFixtureFactory },
    acquireProviderExecution: async (providerId) => ({
      definition: {
        id: providerId,
        adapterId: "codex-subscription",
        accessContract: "managed-runtime@1",
      },
      descriptor: {
        adapterId: "codex-subscription",
        accessContract: "managed-runtime@1",
        implementationVersion: "1",
      },
      runtime: {
        async executionAccess() {
          return { kind: "managed-runtime", environment: {} };
        },
      },
      async release() {},
    }),
  });
  const runtimeSession = await runtime.start();
  catalogRefreshServer = await startModelCatalogRefreshServer({
    refresh: () => product.seedProviderCatalog(catalogSnapshot),
  });
  product = new RelayerAppServerService({
    startupTimeoutMs: 60_000,
    userDataDirectory: dataDirectory,
    binaryPath: appServerBinary,
    webDirectory: rendererDirectory,
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    providerCatalogRefreshSession: catalogRefreshServer.session,
    defaultHarnessConfiguration: "fixture-task-system",
  });
  productSession = await product.start();
  await product.seedProviderCatalog(catalogSnapshot);
}

async function stopServices() {
  if (product) await product.close().catch(() => undefined);
  if (catalogRefreshServer) await catalogRefreshServer.close().catch(() => undefined);
  if (runtime) await runtime.close().catch(() => undefined);
  product = undefined;
  catalogRefreshServer = undefined;
  runtime = undefined;
  productSession = undefined;
}

async function openThreadWindow(threadId) {
  function LifecycleBrowserWindow(options) {
    return new BrowserWindow({
      ...options,
      show: false,
      webPreferences: {
        ...options.webPreferences,
        backgroundThrottling: false,
      },
    });
  }
  const createWindow = createWindowFactory({
    BrowserWindow: LifecycleBrowserWindow,
    desktopDirectory: join(repositoryRoot, "desktop"),
    getAppearance: () => "dark",
    updater: { status: () => ({ phase: "development" }) },
    openExternal: async () => undefined,
  });
  window = await createWindow(productSession);
  window.setSize(1280, 820);
  // Real environment timers are eligible only in a visible, focused workspace.
  window.show();
  app.focus({ steal: true });
  window.focus();
  await window.loadURL(`${productSession.origin}/?threadId=${encodeURIComponent(threadId)}`);
  await waitFor("production thread workspace", () => evaluate(`(() => (
    document.querySelector('#desktopAccountOnboarding')?.classList.contains('hidden')
      && !document.body.classList.contains('desktop-account-pending')
      && !document.querySelector('#appShell')?.classList.contains('hidden')
      && getComputedStyle(document.querySelector('#appShell')).visibility !== 'hidden'
      && !document.querySelector('#threadView')?.classList.contains('hidden')
      && document.querySelectorAll('.graph-node').length === 3
      && !document.querySelector('#threadPrompt')?.disabled
  ))()`));
  app.focus({ steal: true });
  window.focus();
  window.webContents.focus();
  await waitFor("focused workspace for environment timers", () => evaluate(
    "document.visibilityState !== 'hidden' && document.hasFocus()",
  ));
  await waitForPaint();
}

async function capture(name, checkpoint) {
  await waitForPaint();
  const image = await window.webContents.capturePage();
  const bytes = image.toPNG();
  await writeFile(join(outputDirectory, `${name}.png`), bytes);
  receipt.checkpoints.push({ name, imageSha256: sha256(bytes), ...checkpoint });
}

async function run() {
  registerIpc();
  keepaliveWindow = new BrowserWindow({ width: 1, height: 1, show: false });
  await mkdir(outputDirectory, { recursive: true });
  await cp(join(repositoryRoot, 'desktop', 'renderer'), rendererDirectory, { recursive: true });
  await writeFile(join(rendererDirectory, 'src/product-workspace/workspace.js'), baselineRenderer);
  await startServices();
  await mkdir(projectDirectory);
  execFileSync('git', ['init', '--quiet', projectDirectory]);
  const project = await productRequest('/api/projects', { method: 'POST', body: JSON.stringify({ path: projectDirectory }) });
  const family = await productRequest('/api/model-families', { method: 'POST', body: JSON.stringify({ name: 'Fixture models', enabled: true, members: [{ providerId: 'codex', modelId: 'fixture-model' }] }) });
  const modelSelection = { familyId: family.id, providerId: 'codex', modelId: 'fixture-model' };
  const thread = await productRequest('/api/threads', { method: 'POST', body: JSON.stringify({ title: 'Follow-up node annotations', initialMessage: 'Show the deterministic task system.', projectId: project.id, harnessId: 'fixture-task-system', modelSelection }) });
  await waitForAcceptedInteractions(thread.id, 1);
  await productRequest(`/api/threads/${thread.id}/interactions`, { method: 'POST', body: JSON.stringify({ text: 'Refine the queue ordering.', modelSelection }) });
  await waitForAcceptedInteractions(thread.id, 2);
  await openThreadWindow(thread.id);
  await productRequest(`/api/threads/${thread.id}/interactions`, { method: 'POST', body: JSON.stringify({ text: 'Consider worker capacity next.', modelSelection }) });
  await evaluate(`(async () => { const threads = await import('./src/threads.js'); await threads.refreshState(${JSON.stringify(thread.id)}); })()`);
  await clickNode('Incoming queue');
  const pending = await productRequest(`/api/threads/${thread.id}`);
  const source = pending.interactions[1];
  const active = pending.interactions[2];
  if (!['not_started', 'running', 'submitted', 'waiting_for_approval'].includes(active.completionStatus)) throw new Error('Follow-up was not pending');
  const before = await evaluate(`(() => ({ title: document.querySelector('#detailTitle')?.textContent, hidden: document.querySelector('#attachNodeContext')?.classList.contains('hidden'), position: ${interactionPositionCondition(2, 3)} }))()`);
  if (before.title !== 'Incoming queue' || !before.hidden || !before.position) throw new Error('Baseline did not reproduce missing +: ' + JSON.stringify(before));
  receipt.fixture = { mode: 'accepted-followup-while-next-followup-running', explanation: 'Deterministic native fixture authors and submits two real accepted response graphs, then holds the next follow-up before graph authoring. The selected graph is the accepted second interaction (a follow-up). Baseline comparison overlays only the pre-fix workspace renderer into a temporary copied renderer; both captures use identical real Rust backend state.' };
  receipt.sourceOccurrence = { interactionId: source.id, interactionNodeId: source.graphNodeId, acceptedRootLayerId: source.completionOutput?.rootLayer?.layer?.id };
  receipt.state = { threadId: thread.id, selectedFollowupInteractionId: source.id, pendingInteractionId: active.id, pendingStatus: active.completionStatus };
  await capture('A-before-missing-plus', { renderer: 'baseline', ...before });
  await writeFile(join(rendererDirectory, 'src/product-workspace/workspace.js'), currentRenderer);
  await window.webContents.session.clearCache();
  await window.loadURL(window.webContents.getURL());
  await waitFor('fixed workspace graph', () => evaluate(`document.querySelectorAll('.graph-node').length === 3`));
  await clickNode('Incoming queue');
  receipt.servedRendererSha256 = await evaluate(`(async () => {
    const response = await fetch('./src/product-workspace/workspace.js', { cache: 'no-store' });
    const bytes = await response.arrayBuffer();
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
  })()`);
  if (receipt.servedRendererSha256 !== receipt.renderer.fixedSha256) {
    throw new Error('Fixed renderer served bytes do not match the current renderer');
  }
  await waitFor('fixed + visible', () => evaluate(`!document.querySelector('#attachNodeContext')?.classList.contains('hidden') && !document.querySelector('#attachNodeContext')?.disabled`));
  const after = await evaluate(`({ title: document.querySelector('#detailTitle')?.textContent, hidden: document.querySelector('#attachNodeContext')?.classList.contains('hidden'), position: ${interactionPositionCondition(2, 3)} })`);
  if (!after.position) throw new Error('Fixed renderer changed selected interaction');
  await capture('B-after-plus-visible', { renderer: 'fixed', ...after });
  await click('#attachNodeContext');
  await waitFor('editable annotation', () => evaluate(`Boolean(document.querySelector('#contextAnnotationEditor'))`));
  await setValue('#contextAnnotationEditor', 'Keep worker capacity visible while prioritizing work.');
  const savedDraft = await waitFor('durable annotation draft', async () => { const draft = (await productRequest(`/api/threads/${thread.id}/context-drafts`)).drafts?.[0]; return draft?.text === SECOND_DRAFT_VALUE ? draft : false; });
  await capture('C-after-editor', { renderer: 'fixed', editableDuringGeneration: true });
  await click('[aria-label="Confirm annotation"]');
  await waitFor('confirmed annotation pill', () => evaluate(`document.querySelector('.composer-context-pill span')?.textContent === '1 annotation' && !document.querySelector('#contextAnnotationEditor')`));
  const confirmed = await productRequest(`/api/threads/${thread.id}/context-drafts`);
  if (confirmed.drafts?.length !== 0 || confirmed.confirmations?.length !== 1 || confirmed.confirmations[0].annotation !== SECOND_DRAFT_VALUE || JSON.stringify(confirmed.confirmations[0].target) !== JSON.stringify(savedDraft.target)) throw new Error('Canonical confirmation mismatch: ' + JSON.stringify(confirmed));
  if (receipt.sourceOccurrence.interactionNodeId == null || receipt.sourceOccurrence.acceptedRootLayerId == null
    || confirmed.confirmations[0].target.sourceInteractionNodeId !== receipt.sourceOccurrence.interactionNodeId
    || confirmed.confirmations[0].target.sourceLayerId !== receipt.sourceOccurrence.acceptedRootLayerId) throw new Error('Confirmed target escaped selected follow-up occurrence');
  receipt.confirmedState = confirmed;
  await capture('D-after-confirmed', { renderer: 'fixed', durableCanonicalConfirmation: true });
  await window.loadURL(window.webContents.getURL());
  await waitFor('durable restored confirmed pill', () => evaluate(`document.querySelector('.composer-context-pill span')?.textContent === '1 annotation'`));
  const stillPending = (await productRequest(`/api/threads/${thread.id}` )).interactions[2];
  if (stillPending.completionStatus !== active.completionStatus) throw new Error('Fixture completed during proof');
  receipt.checkpoints.push({ name: 'reload-restores-confirmation', passed: true });
  receipt.passed = true;
  await writeFile(join(outputDirectory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write('Follow-up annotation A→B proof passed with 0 paid inference calls.\n');
}

async function stop() {
  releasePendingFixture();
  if (window && !window.isDestroyed()) window.destroy();
  if (keepaliveWindow && !keepaliveWindow.isDestroyed()) keepaliveWindow.destroy();
  await stopServices();
  unregisterIpc();
  await rm(dataDirectory, { recursive: true, force: true });
}

app.whenReady().then(run).then(async () => {
  await stop();
  if (process.env.RELAYER_ANNOTATION_EVIDENCE_RESULT) {
    await writeFile(process.env.RELAYER_ANNOTATION_EVIDENCE_RESULT, JSON.stringify({ passed: true }) + "\n");
  }
  app.exit(0);
}).catch(async (error) => {
  console.error(error);
  receipt.passed = false;
  receipt.error = error?.stack || String(error);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await stop();
  app.exit(1);
});
