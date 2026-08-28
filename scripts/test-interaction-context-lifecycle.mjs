import { app, BrowserWindow, ipcMain } from "electron";
import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";

import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";
import { createElectronWorkspaceDriver } from "./electron-workspace-driver.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-interaction-context-lifecycle-"));
const configurationPath = join(repositoryRoot, "harnesses", "fixture-task-system.yaml");
const graphServerBinary = join(repositoryRoot, "target", "debug", "relayer-graph-server");
const appServerBinary = join(repositoryRoot, "target", "debug", "relayer-app-server");
const EDITOR_VALUE = "Queue order controls which task is claimed next.";
const EDITOR_SELECTION = { start: 6, end: 31, direction: "backward" };
const SUCCESS_MESSAGE = "Use the attached queue context for this follow-up.";
const FAILED_MESSAGE = "Keep this exact message available for retry.";
const FAILED_ANNOTATION = "This context must survive a rejected send.";
const resultFile = process.env.RELAYER_INTERACTION_CONTEXT_RESULT_FILE;

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
app.setPath("userData", join(dataDirectory, "electron-profile"));
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
      if (fixtureCompletionCount === 2) await pendingFixtureGate;
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
  ipcMain.handle("relayer:folder-choose", () => null);
  ipcMain.handle("relayer:tutorial-read", () => ({
    status: "dismissed",
    automaticEligible: false,
  }));
  ipcMain.handle("relayer:provider-status", () => null);
}

function unregisterIpc() {
  for (const channel of [
    "relayer:account-read",
    "relayer:appearance-read",
    "relayer:update-status",
    "relayer:folder-choose",
    "relayer:tutorial-read",
    "relayer:provider-status",
  ]) ipcMain.removeHandler(channel);
}

function assertEditorSnapshot(snapshot, label) {
  const expected = {
    sameElement: true,
    connected: true,
    active: true,
    value: EDITOR_VALUE,
    selectionStart: EDITOR_SELECTION.start,
    selectionEnd: EDITOR_SELECTION.end,
    selectionDirection: EDITOR_SELECTION.direction,
  };
  if (JSON.stringify(snapshot) !== JSON.stringify(expected)) {
    throw new Error(`${label} replaced or disturbed the active interaction-context editor: ${JSON.stringify({ expected, actual: snapshot })}`);
  }
}

async function captureEditorSnapshot() {
  return evaluate(`(() => {
    const editor = document.querySelector('#contextAnnotationEditor');
    return {
      sameElement: editor === window.__relayerInteractionContextEditor,
      connected: Boolean(editor?.isConnected),
      active: document.activeElement === editor,
      value: editor?.value ?? null,
      selectionStart: editor?.selectionStart ?? null,
      selectionEnd: editor?.selectionEnd ?? null,
      selectionDirection: editor?.selectionDirection ?? null,
    };
  })()`);
}

async function refreshRendererState(threadId) {
  await evaluate(`(async () => {
    const threads = await import('./src/threads.js');
    await threads.refreshState(${JSON.stringify(threadId)});
    await new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)));
  })()`);
}

async function startControlledEnvironmentRefreshSchedule() {
  await evaluate(`(async () => {
    const threads = await import('./src/threads.js');
    await threads.refreshCurrentEnvironment({ force: true });
    await new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)));
  })()`);
}

async function runControlledTimerEnvironmentRefreshes() {
  return evaluate(`(async () => {
    const { createEnvironmentRefreshScheduler, ENVIRONMENT_REFRESH_INTERVAL_MS } = await import('./src/environment-context.js');
    const threads = await import('./src/threads.js');
    const timers = [];
    let now = 100_000;
    let completion = Promise.resolve();
    const scheduler = createEnvironmentRefreshScheduler({
      setTimer(callback, delayMs) {
        const timer = { callback, delayMs };
        timers.push(timer);
        return timer;
      },
      clearTimer(timer) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      },
    });
    const scheduleNext = () => scheduler.schedule({
      eligible: true,
      projectId: 'controlled-renderer-proof',
      lastRequestedAt: now,
      nextAttemptAt: 0,
      now,
      refresh() {
        completion = (async () => {
          now += ENVIRONMENT_REFRESH_INTERVAL_MS;
          await threads.refreshCurrentEnvironment({ force: true });
          scheduleNext();
          await new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)));
        })();
      },
    });
    scheduleNext();
    const cycles = [];
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const timer = timers.shift();
      if (!timer) throw new Error('Controlled environment timer was not armed.');
      timer.callback();
      await completion;
      const editor = document.querySelector('#contextAnnotationEditor');
      cycles.push({
        delayMs: timer.delayMs,
        snapshot: {
          sameElement: editor === window.__relayerInteractionContextEditor,
          connected: Boolean(editor?.isConnected),
          active: document.activeElement === editor,
          value: editor?.value ?? null,
          selectionStart: editor?.selectionStart ?? null,
          selectionEnd: editor?.selectionEnd ?? null,
          selectionDirection: editor?.selectionDirection ?? null,
        },
      });
    }
    scheduler.clear();
    return cycles;
  })()`);
}

async function installRendererRequestLog() {
  await evaluate(`(() => {
    const originalFetch = window.fetch.bind(window);
    window.__relayerInteractionContextRequests = [];
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const url = String(args[0]);
      if (url.includes('/api/state') || url.includes('/environment')) {
        const body = url.includes('/api/state')
          ? await response.clone().json().catch(() => null)
          : null;
        window.__relayerInteractionContextRequests.push({
          url,
          at: Date.now(),
          statuses: (body?.interactions || []).map((interaction) => interaction.completionStatus),
        });
      }
      return response;
    };
  })()`);
}

async function rendererRequests() {
  return evaluate(`window.__relayerInteractionContextRequests || []`);
}

async function startServices() {
  runtime = new GraphCompleteRuntimeService({
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
    refresh: () => product.publishProviderCatalog(catalogSnapshot),
  });
  product = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: appServerBinary,
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    providerCatalogRefreshSession: catalogRefreshServer.session,
    defaultHarnessConfiguration: "fixture-task-system",
  });
  productSession = await product.start();
  await product.publishProviderCatalog(catalogSnapshot);
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
  });
  window = await createWindow(productSession);
  window.setSize(1280, 820);
  await window.loadURL(`${productSession.origin}/?threadId=${encodeURIComponent(threadId)}`);
  await waitFor("production thread workspace", () => evaluate(`(() => (
    !document.querySelector('#threadView')?.classList.contains('hidden')
      && document.querySelectorAll('.graph-node').length === 3
      && !document.querySelector('#threadPrompt')?.disabled
  ))()`));
  await waitForPaint();
}

async function restartStack(threadId) {
  if (window && !window.isDestroyed()) window.destroy();
  window = undefined;
  await stopServices();
  await startServices();
  await openThreadWindow(threadId);
}

async function openContextEditor() {
  await clickNode("Incoming queue");
  await waitFor("Incoming queue details", () => evaluate(`
    document.querySelector('#detailTitle')?.textContent === 'Incoming queue'
      && !document.querySelector('#attachNodeContext')?.classList.contains('hidden')
  `));
  await click("#attachNodeContext");
  await waitFor("interaction-context editor", () => evaluate(`Boolean(document.querySelector('#contextAnnotationEditor'))`));
}

async function stageContext(annotation) {
  await openContextEditor();
  await setValue("#contextAnnotationEditor", annotation);
}

async function assertCollapsedPill(annotationCount = "1 annotation") {
  const expected = {
    editor: false,
    pills: 1,
    expanded: "false",
    count: annotationCount,
    preview: false,
    historicalPopoverHidden: true,
  };
  await waitFor("one collapsed context pill", () => evaluate(`(() => {
    const state = {
      editor: Boolean(document.querySelector('#contextAnnotationEditor')),
      pills: document.querySelectorAll('.composer-context-pill-wrap').length,
      expanded: document.querySelector('.composer-context-pill')?.getAttribute('aria-expanded'),
      count: document.querySelector('.composer-context-pill span')?.textContent,
      preview: Boolean(document.querySelector('.composer-context-preview')),
      historicalPopoverHidden: document.querySelector('#interactionContextPopover')?.classList.contains('hidden'),
    };
    return JSON.stringify(state) === ${JSON.stringify(JSON.stringify(expected))} ? state : false;
  })()`));
}

async function assertOpenPill(annotation) {
  await waitFor("one explicitly open context pill", () => evaluate(`(() => (
    document.querySelector('.composer-context-pill')?.getAttribute('aria-expanded') === 'true'
      && document.querySelector('.composer-context-annotations li > span')?.textContent === ${JSON.stringify(annotation)}
      && Boolean(document.querySelector('.composer-context-preview'))
  ))()`));
}

async function run() {
  process.stdout.write("Running real-Electron zero-inference interaction-context lifecycle smoke.\n");
  registerIpc();
  keepaliveWindow = new BrowserWindow({ width: 1, height: 1, show: false });
  await startServices();

  const project = await productRequest("/api/projects", {
    method: "POST",
    body: JSON.stringify({ path: repositoryRoot }),
  });
  const fixtureFamily = await productRequest("/api/model-families", {
    method: "POST",
    body: JSON.stringify({
      name: "Fixture models",
      enabled: true,
      members: [{ providerId: "codex", modelId: "fixture-model" }],
    }),
  });
  const modelSelection = {
    familyId: fixtureFamily.id,
    providerId: "codex",
    modelId: "fixture-model",
  };
  const thread = await productRequest("/api/threads", {
    method: "POST",
    body: JSON.stringify({
      title: "Interaction context lifecycle",
      initialMessage: "Show the deterministic task system.",
      projectId: project.id,
      harnessId: "fixture-task-system",
      modelSelection,
    }),
  });
  await waitForAcceptedInteractions(thread.id, 1);
  await openThreadWindow(thread.id);

  await stageContext(EDITOR_VALUE);
  const initialEditor = await evaluate(`(() => {
    const editor = document.querySelector('#contextAnnotationEditor');
    editor.focus();
    editor.setSelectionRange(
      ${EDITOR_SELECTION.start},
      ${EDITOR_SELECTION.end},
      ${JSON.stringify(EDITOR_SELECTION.direction)},
    );
    window.__relayerInteractionContextEditor = editor;
    return {
      active: document.activeElement === editor,
      selectionStart: editor.selectionStart,
      selectionEnd: editor.selectionEnd,
      selectionDirection: editor.selectionDirection,
    };
  })()`);
  if (!initialEditor.active
    || initialEditor.selectionStart !== EDITOR_SELECTION.start
    || initialEditor.selectionEnd !== EDITOR_SELECTION.end
    || initialEditor.selectionDirection !== EDITOR_SELECTION.direction) {
    throw new Error(`Could not establish the initial editor focus and backward selection: ${JSON.stringify(initialEditor)}`);
  }

  const controlledTimerCycles = await runControlledTimerEnvironmentRefreshes();
  controlledTimerCycles.forEach((cycle, index) => {
    if (cycle.delayMs !== 5_000) {
      throw new Error(`Controlled renderer refresh ${index + 1} did not use a five-second timer: ${JSON.stringify(cycle)}`);
    }
    assertEditorSnapshot(cycle.snapshot, `Controlled-timer environment reconciliation ${index + 1} of 3`);
  });

  await installRendererRequestLog();
  await startControlledEnvironmentRefreshSchedule();
  assertEditorSnapshot(
    await captureEditorSnapshot(),
    "Initial environment refresh reconciliation",
  );
  await productRequest(`/api/threads/${thread.id}/interactions`, {
    method: "POST",
    body: JSON.stringify({ text: "Hold one deterministic interaction pending.", modelSelection }),
  });
  await refreshRendererState(thread.id);
  assertEditorSnapshot(
    await captureEditorSnapshot(),
    "Pending interaction discovery reconciliation",
  );
  const pendingPollRequests = await waitFor("a genuine pending interaction polling cycle", async () => {
    const requests = (await rendererRequests()).filter((request) => request.url.includes("/api/state"));
    return requests.length >= 2
      && requests.every((request) => request.statuses.some((status) => (
        ["not_started", "running", "submitted", "waiting_for_approval"].includes(status)
      )))
      ? requests
      : false;
  }, 2_000);
  if (pendingPollRequests.length < 2) {
    throw new Error(`Pending interaction did not drive renderer polling: ${JSON.stringify(pendingPollRequests)}`);
  }
  const pendingPollDelayMs = pendingPollRequests.at(-1).at - pendingPollRequests.at(-2).at;
  if (pendingPollDelayMs < 400) {
    throw new Error(`Pending interaction polling did not use its 500ms schedule: ${JSON.stringify({ pendingPollDelayMs, pendingPollRequests })}`);
  }
  assertEditorSnapshot(
    await captureEditorSnapshot(),
    "Scheduled pending-interaction polling reconciliation",
  );
  const pendingDetail = await productRequest(`/api/threads/${thread.id}`);
  const pendingInteraction = pendingDetail.interactions.at(-1);
  if (!["not_started", "running", "submitted", "waiting_for_approval"]
    .includes(pendingInteraction?.completionStatus)) {
    throw new Error(`Pending polling cycle settled before the DOM identity assertion: ${JSON.stringify(pendingInteraction?.completionStatus)}`);
  }

  let environmentRequests;
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    environmentRequests = await waitFor(`five-second environment refresh ${cycle} of 3`, async () => {
      const requests = (await rendererRequests()).filter((request) => request.url.includes("/environment"));
      return requests.length >= cycle + 1 ? requests : false;
    }, 7_000);
    const scheduledDelayMs = environmentRequests.at(-1).at - environmentRequests.at(-2).at;
    if (scheduledDelayMs < 4_500) {
      throw new Error(`Environment refresh ${cycle} did not use the five-second schedule: ${JSON.stringify({ scheduledDelayMs, environmentRequests })}`);
    }
    assertEditorSnapshot(
      await captureEditorSnapshot(),
      `Scheduled five-second environment reconciliation ${cycle} of 3`,
    );
  }

  releasePendingFixture();
  await waitForAcceptedInteractions(thread.id, 2);
  const savedDraft = await waitFor("saved interaction-context draft", async () => {
    const response = await productRequest(`/api/threads/${thread.id}/context-drafts`);
    const draft = response.drafts?.[0];
    return response.drafts?.length === 1
      && draft.text === EDITOR_VALUE
      && draft.revision >= 1
      ? draft
      : false;
  });
  await restartStack(thread.id);
  await waitForAcceptedInteractions(thread.id, 2);
  const restoredDraft = await productRequest(`/api/threads/${thread.id}/context-drafts`);
  if (JSON.stringify(restoredDraft.drafts) !== JSON.stringify([savedDraft])) {
    throw new Error(`Restart did not preserve the exact saved draft: ${JSON.stringify({ savedDraft, restoredDraft })}`);
  }
  await click("#previousTurn");
  await waitFor("saved draft source turn", () => evaluate(`
    document.querySelector('#turnPickerButton')?.textContent === 'Turn 1 of 2'
  `));
  await openContextEditor();
  const restoredEditor = await waitFor("saved draft restoration in the editor", () => evaluate(`(() => {
    const editor = document.querySelector('#contextAnnotationEditor');
    const status = document.querySelector('.composer-context-draft-status')?.textContent;
    return status === 'Saved' ? { value: editor?.value, status } : false;
  })()`));
  if (restoredEditor.value !== EDITOR_VALUE) {
    throw new Error(`Restart restored the wrong draft text: ${JSON.stringify(restoredEditor)}`);
  }

  await click("[aria-label='Confirm annotation']");
  await assertCollapsedPill();
  const confirmedState = await productRequest(`/api/threads/${thread.id}/context-drafts`);
  if (confirmedState.drafts?.length !== 0
    || confirmedState.confirmations?.length !== 1
    || confirmedState.confirmations[0].draftId !== savedDraft.id
    || confirmedState.confirmations[0].annotation !== EDITOR_VALUE
    || JSON.stringify(confirmedState.confirmations[0].target) !== JSON.stringify(savedDraft.target)) {
    throw new Error(`Confirmation was not durably restorable: ${JSON.stringify(confirmedState)}`);
  }
  await restartStack(thread.id);
  await waitForAcceptedInteractions(thread.id, 2);
  await assertCollapsedPill();
  await clickNode("Incoming queue");
  await waitFor("Incoming queue actions after restart", () => evaluate(`
    document.querySelector('#detailTitle')?.textContent === 'Incoming queue'
      && Boolean(document.querySelector('#detailActions .action-control'))
  `));
  await click(".composer-context-pill");
  const explicitlyOpened = await evaluate(`(() => ({
    expanded: document.querySelector('.composer-context-pill')?.getAttribute('aria-expanded'),
    preview: Boolean(document.querySelector('.composer-context-preview')),
    annotation: document.querySelector('.composer-context-annotations li > span')?.textContent,
  }))()`);
  if (JSON.stringify(explicitlyOpened) !== JSON.stringify({
    expanded: "true",
    preview: true,
    annotation: EDITOR_VALUE,
  })) throw new Error(`Explicit pill activation did not open the exact preview: ${JSON.stringify(explicitlyOpened)}`);

  await click("#detailActions .action-control");
  await waitFor("same-turn child layer navigation", () => evaluate(`
    document.querySelectorAll('.graph-node').length === 2
  `));
  await assertOpenPill(EDITOR_VALUE);
  await click("#historyBack");
  await waitFor("same-turn history back to root", () => evaluate(`
    document.querySelectorAll('.graph-node').length === 3
  `));
  await assertOpenPill(EDITOR_VALUE);
  await click("#historyForward");
  await waitFor("same-turn history forward to child", () => evaluate(`
    document.querySelectorAll('.graph-node').length === 2
  `));
  await assertOpenPill(EDITOR_VALUE);
  await click("#historyBack");
  await waitFor("same-turn history return to root", () => evaluate(`
    document.querySelectorAll('.graph-node').length === 3
  `));
  await assertOpenPill(EDITOR_VALUE);
  await click("[aria-label='Close Incoming queue annotations']");
  await assertCollapsedPill();

  await click(".composer-context-pill");
  await click("#previousTurn");
  await waitFor("previous turn navigation", () => evaluate(`
    document.querySelector('#turnPickerButton')?.textContent === 'Turn 1 of 2'
  `));
  await assertCollapsedPill();
  await click("#nextTurn");
  await waitFor("latest turn restoration", () => evaluate(`
    document.querySelector('#turnPickerButton')?.textContent === 'Turn 2 of 2'
  `));
  await assertCollapsedPill();

  await click(".composer-context-pill");
  await click("#turnPickerButton");
  await click(`#turnPopover [data-turn-id='${pendingDetail.interactions[0].id}']`);
  await waitFor("turn-picker navigation", () => evaluate(`
    document.querySelector('#turnPickerButton')?.textContent === 'Turn 1 of 2'
  `));
  await assertCollapsedPill();
  await click("#nextTurn");
  await waitFor("latest turn after picker navigation", () => evaluate(`
    document.querySelector('#turnPickerButton')?.textContent === 'Turn 2 of 2'
  `));
  await assertCollapsedPill();

  await click(".composer-context-pill");
  await evaluate(`(() => {
    const stage = document.querySelector('#graphStage');
    stage.focus();
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  })()`);
  await waitFor("graph-keyboard turn navigation", () => evaluate(`
    document.querySelector('#turnPickerButton')?.textContent === 'Turn 1 of 2'
  `));
  await assertCollapsedPill();
  await click("#nextTurn");
  await waitFor("latest turn after keyboard navigation", () => evaluate(`
    document.querySelector('#turnPickerButton')?.textContent === 'Turn 2 of 2'
  `));
  await assertCollapsedPill();

  await click(".composer-context-pill");
  await click("#historyBack");
  await waitFor("history-back turn navigation", () => evaluate(`
    document.querySelector('#turnPickerButton')?.textContent === 'Turn 1 of 2'
  `));
  await assertCollapsedPill();
  await click("#historyForward");
  await waitFor("history-forward turn restoration", () => evaluate(`
    document.querySelector('#turnPickerButton')?.textContent === 'Turn 2 of 2'
  `));
  await assertCollapsedPill();

  await setValue("#threadPrompt", SUCCESS_MESSAGE);
  await click("#sendInteraction");
  await waitForAcceptedInteractions(thread.id, 3);
  await waitFor("next composer to become available", () => evaluate(`
    !document.querySelector('#threadPrompt')?.disabled
  `));
  const successfulCleanup = await evaluate(`(() => ({
    message: document.querySelector('#threadPrompt')?.value,
    composerPills: document.querySelectorAll('.composer-context-pill-wrap').length,
    historicalPillVisible: !document.querySelector('#interactionContextPill')?.classList.contains('hidden'),
    historicalCount: document.querySelector('#interactionContextCount')?.textContent,
  }))()`);
  if (JSON.stringify(successfulCleanup) !== JSON.stringify({
    message: "",
    composerPills: 0,
    historicalPillVisible: true,
    historicalCount: "1",
  })) throw new Error(`Successful send cleanup was not exact: ${JSON.stringify(successfulCleanup)}`);

  await restartStack(thread.id);
  await waitForAcceptedInteractions(thread.id, 3);
  const restartedContext = await evaluate(`(() => ({
    composerPills: document.querySelectorAll('.composer-context-pill-wrap').length,
    composerPreview: Boolean(document.querySelector('.composer-context-preview')),
    historicalPillVisible: !document.querySelector('#interactionContextPill')?.classList.contains('hidden'),
    historicalCount: document.querySelector('#interactionContextCount')?.textContent,
    historicalPopoverHidden: document.querySelector('#interactionContextPopover')?.classList.contains('hidden'),
  }))()`);
  if (JSON.stringify(restartedContext) !== JSON.stringify({
    composerPills: 0,
    composerPreview: false,
    historicalPillVisible: true,
    historicalCount: "1",
    historicalPopoverHidden: true,
  })) throw new Error(`Restart reopened context UI or lost historical context: ${JSON.stringify(restartedContext)}`);

  await stageContext(FAILED_ANNOTATION);
  await click("[aria-label='Confirm annotation']");
  await assertCollapsedPill();
  await setValue("#threadPrompt", FAILED_MESSAGE);
  let rejected = false;
  const requestFilter = { urls: ["<all_urls>"] };
  window.webContents.session.webRequest.onBeforeRequest(requestFilter, (details, callback) => {
    const url = new URL(details.url);
    const matching = !rejected
      && details.method === "POST"
      && url.origin === productSession.origin
      && new RegExp(`^/api/threads/${thread.id}/interactions$`).test(url.pathname);
    if (matching) rejected = true;
    callback(matching ? { cancel: true } : {});
  });
  await click("#sendInteraction");
  await waitFor("failed send to restore composition", () => evaluate(`(() => (
    !document.querySelector('#threadPrompt')?.disabled
      && document.querySelector('#toast')?.textContent
  ))()`));
  window.webContents.session.webRequest.onBeforeRequest(requestFilter, null);
  if (!rejected) throw new Error("The one-shot failed-send interceptor did not reject the interaction request.");
  await assertCollapsedPill();
  const preserved = await evaluate(`(() => ({
    message: document.querySelector('#threadPrompt')?.value,
    count: document.querySelector('.composer-context-pill span')?.textContent,
  }))()`);
  if (JSON.stringify(preserved) !== JSON.stringify({
    message: FAILED_MESSAGE,
    count: "1 annotation",
  })) throw new Error(`Failed send did not preserve the exact composer draft: ${JSON.stringify(preserved)}`);
  await click(".composer-context-pill");
  const preservedAnnotation = await evaluate(`document.querySelector('.composer-context-annotations li > span')?.textContent`);
  if (preservedAnnotation !== FAILED_ANNOTATION) {
    throw new Error(`Failed send changed the confirmed annotation: ${JSON.stringify(preservedAnnotation)}`);
  }
  await click("[aria-label='Close Incoming queue annotations']");

  process.stdout.write("Interaction-context lifecycle smoke passed with 0 paid inference calls.\n");
}

async function stop() {
  if (window && !window.isDestroyed()) window.destroy();
  if (keepaliveWindow && !keepaliveWindow.isDestroyed()) keepaliveWindow.destroy();
  await stopServices();
  unregisterIpc();
  await rm(dataDirectory, { recursive: true, force: true });
}

async function writeResult(result) {
  if (resultFile) await writeFile(resultFile, `${JSON.stringify(result)}\n`);
}

app.whenReady().then(run).then(async () => {
  await writeResult({ passed: true });
  await stop();
  app.exit(0);
}).catch(async (error) => {
  console.error(error);
  await writeResult({ passed: false, error: error?.stack || error?.message || String(error) })
    .catch(() => undefined);
  await stop();
  app.exit(0);
});
