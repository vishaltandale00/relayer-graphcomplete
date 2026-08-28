import { app, BrowserWindow, ipcMain } from "electron";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";

import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-context-draft-warning-"));
const configurationPath = join(repositoryRoot, "harnesses", "fixture-task-system.yaml");
const graphServerBinary = join(repositoryRoot, "target", "debug", "relayer-graph-server");
const appServerBinary = join(repositoryRoot, "target", "debug", "relayer-app-server");
const draftFixtures = Array.from({ length: 12 }, (_, index) => ({
  id: `draft-send-warning-fixture-${String(index + 1).padStart(2, "0")}`,
  text: `Unconfirmed annotation ${index + 1} must remain byte-identical.`,
}));
const confirmedAnnotation = "Use this confirmed worker-pool context in the answer.";
const services = [];

let product;
let productSession;
let mainWindow;
let keepaliveWindow;
let exitCode = 1;

app.setName("Relayer Context Draft Warning Smoke");
const electronProfileDirectory = join(dataDirectory, "electron-profile");
mkdirSync(electronProfileDirectory, { recursive: true });
app.setPath("userData", electronProfileDirectory);
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

function registerIpc() {
  ipcMain.handle("relayer:account-read", () => ({
    status: "connected",
    account: { email: "zero-inference@relayer.test", planType: "Fixture" },
  }));
  ipcMain.handle("relayer:appearance-read", () => ({ appearance: "dark" }));
  ipcMain.handle("relayer:provider-status", () => ({
    adapters: [],
    definitions: [],
    hasCompletedOnboarding: true,
  }));
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
}

function unregisterIpc() {
  for (const channel of [
    "relayer:account-read",
    "relayer:appearance-read",
    "relayer:provider-status",
    "relayer:update-status",
    "relayer:folder-choose",
    "relayer:tutorial-read",
  ]) ipcMain.removeHandler(channel);
}

function sleep(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function waitFor(label, check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(25);
  }
  const diagnostic = mainWindow && !mainWindow.isDestroyed()
    ? await mainWindow.webContents.executeJavaScript(`({
      url: location.href,
      activeElement: document.activeElement?.id,
      warningOpen: document.querySelector('#contextDraftSendWarning')?.open,
      prompt: document.querySelector('#threadPrompt')?.value,
      toast: document.querySelector('#toast')?.textContent,
      body: document.body?.innerText?.slice(0, 2500),
      probe: window.__contextDraftWarningFetchProbe,
    })`).catch(() => null)
    : null;
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
}

async function productRequest(path, options = {}) {
  const response = await fetch(new URL(path, productSession.origin), {
    ...options,
    headers: {
      Accept: "application/json",
      Cookie: `${productSession.cookie.name}=${productSession.cookie.value}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  const value = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.error || JSON.stringify(value));
  return value;
}

async function evaluate(expression) {
  try {
    return await mainWindow.webContents.executeJavaScript(expression);
  } catch (error) {
    throw new Error(`Renderer evaluation failed for ${expression.slice(0, 160)}: ${error.message}`);
  }
}

async function setPrompt(value, { waitForSend = true } = {}) {
  const updated = await evaluate(`(() => {
    const prompt = document.querySelector('#threadPrompt');
    if (!prompt) return false;
    prompt.value = ${JSON.stringify(value)};
    prompt.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: ${JSON.stringify(value)},
    }));
    prompt.focus();
    return true;
  })()`);
  if (!updated) throw new Error("The ongoing prompt was not mounted.");
  if (waitForSend) {
    await waitFor("enabled ongoing send", () => evaluate(
      `document.querySelector('#sendInteraction')?.disabled === false`,
    ));
  }
}

async function setField(selector, value) {
  const updated = await evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    if (!field) return false;
    field.value = ${JSON.stringify(value)};
    field.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: ${JSON.stringify(value)},
    }));
    field.focus();
    return true;
  })()`);
  if (!updated) throw new Error(`Cannot update missing field ${selector}.`);
}

async function clickNode(title) {
  const clicked = await evaluate(`(() => {
    const node = [...document.querySelectorAll('.graph-node')]
      .find((candidate) => candidate.querySelector('b')?.textContent === ${JSON.stringify(title)});
    node?.click();
    return Boolean(node);
  })()`);
  if (!clicked) throw new Error(`Cannot find graph node ${title}.`);
}

async function sendKey(keyCode, modifiers = []) {
  mainWindow.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  if (keyCode === "Enter") {
    mainWindow.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
  }
  mainWindow.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
}

async function click(selector, { focus = false, twice = false } = {}) {
  const clicked = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    if (${focus}) element.focus();
    element.click();
    if (${twice}) element.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Cannot click missing element ${selector}.`);
}

async function waitForAcceptedInteractions(threadId, count) {
  return waitFor(`${count} accepted interactions for thread ${threadId}`, async () => {
    const detail = await productRequest(`/api/threads/${threadId}`);
    return detail.interactions.length === count
      && detail.interactions.every((interaction) => interaction.completionStatus === "accepted")
      ? detail
      : false;
  }, 30_000);
}

async function createFixtureThread(projectId, modelSelection, title) {
  const thread = await productRequest("/api/threads", {
    method: "POST",
    body: JSON.stringify({
      title,
      initialMessage: "Show the deterministic task system.",
      projectId,
      permissionProfileId: "auto",
      harnessId: "fixture-task-system",
      modelSelection,
    }),
  });
  return { thread, detail: await waitForAcceptedInteractions(thread.id, 1) };
}

async function addFixtureInteraction(threadId, modelSelection, sequence) {
  await productRequest(`/api/threads/${threadId}/interactions`, {
    method: "POST",
    body: JSON.stringify({
      text: `Create deterministic draft targets for warning page ${sequence}.`,
      modelSelection,
      contexts: [],
    }),
  });
  return waitForAcceptedInteractions(threadId, sequence);
}

async function openThreadWindow(threadId) {
  const productOrigin = new URL(productSession.origin).origin;
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      titleBarStyle: "hiddenInset",
      backgroundColor: "#0b0c0d",
      webPreferences: {
        preload: join(repositoryRoot, "desktop", "preload", "index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const preventUntrustedNavigation = (event, target) => {
      try {
        if (new URL(target).origin === productOrigin) return;
      } catch {}
      event.preventDefault();
    };
    mainWindow.webContents.on("will-navigate", preventUntrustedNavigation);
    mainWindow.webContents.on("will-redirect", preventUntrustedNavigation);
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await mainWindow.webContents.session.cookies.set({
      url: productSession.origin,
      name: productSession.cookie.name,
      value: productSession.cookie.value,
      httpOnly: true,
      sameSite: "strict",
      secure: false,
    });
  }
  await mainWindow.loadURL(
    `${productSession.origin}/?threadId=${encodeURIComponent(threadId)}`,
  ).catch((error) => {
    if (error.code !== "ERR_FAILED") throw error;
  });
  mainWindow.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  mainWindow.focus();
  mainWindow.webContents.focus();
  await waitFor("interactive production workspace", () => evaluate(`(() => (
    !document.querySelector('#threadView')?.classList.contains('hidden')
      && document.querySelectorAll('.graph-node').length === 3
      && document.querySelector('#threadPrompt')?.disabled === false
      && document.querySelector('#sendInteraction')
  ))()`));
}

async function installFetchProbe() {
  await evaluate(`(() => {
    const originalFetch = window.fetch.bind(window);
    window.__contextDraftWarningFetchProbe = {
      failNextInteraction: false,
      remainingDraftLoadFailures: 0,
      holdNextDraftLoad: false,
      draftLoadHeld: false,
      draftLoadResponseReady: false,
      releaseDraftLoad: false,
      draftLoadDelivered: false,
      holdNextDraftSave: false,
      draftSaveHeld: false,
      releaseDraftSave: false,
      interactionRequests: [],
      warningOpenTransitions: 0,
    };
    const warning = document.querySelector('#contextDraftSendWarning');
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName === 'open' && warning.open) {
          window.__contextDraftWarningFetchProbe.warningOpenTransitions += 1;
        }
      }
    }).observe(warning, { attributes: true, attributeFilter: ['open'] });
    window.fetch = async (input, init = {}) => {
      const requestUrl = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = String(init.method || (typeof input === 'string' ? 'GET' : input.method) || 'GET').toUpperCase();
      if (method === 'GET'
        && /^\\/api\\/threads\\/[^/]+\\/context-drafts$/.test(requestUrl.pathname)
        && window.__contextDraftWarningFetchProbe.remainingDraftLoadFailures > 0) {
        window.__contextDraftWarningFetchProbe.remainingDraftLoadFailures -= 1;
        return new Response(JSON.stringify({ error: 'transient context load failure' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'GET'
        && /^\\/api\\/threads\\/[^/]+\\/context-drafts$/.test(requestUrl.pathname)
        && window.__contextDraftWarningFetchProbe.holdNextDraftLoad) {
        window.__contextDraftWarningFetchProbe.holdNextDraftLoad = false;
        window.__contextDraftWarningFetchProbe.draftLoadHeld = true;
        const response = await originalFetch(input, init);
        const responseBody = await response.arrayBuffer();
        const bufferedResponse = new Response(responseBody, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        window.__contextDraftWarningFetchProbe.draftLoadResponseReady = true;
        await new Promise((resolve) => {
          const interval = setInterval(() => {
            if (!window.__contextDraftWarningFetchProbe.releaseDraftLoad) return;
            clearInterval(interval);
            window.__contextDraftWarningFetchProbe.releaseDraftLoad = false;
            window.__contextDraftWarningFetchProbe.draftLoadHeld = false;
            window.__contextDraftWarningFetchProbe.draftLoadDelivered = true;
            resolve();
          }, 10);
        });
        return bufferedResponse;
      }
      if (method === 'PUT'
        && /^\\/api\\/threads\\/[^/]+\\/context-drafts\\/[^/]+$/.test(requestUrl.pathname)
        && window.__contextDraftWarningFetchProbe.holdNextDraftSave) {
        window.__contextDraftWarningFetchProbe.holdNextDraftSave = false;
        window.__contextDraftWarningFetchProbe.draftSaveHeld = true;
        await new Promise((resolve) => {
          const interval = setInterval(() => {
            if (!window.__contextDraftWarningFetchProbe.releaseDraftSave) return;
            clearInterval(interval);
            window.__contextDraftWarningFetchProbe.releaseDraftSave = false;
            window.__contextDraftWarningFetchProbe.draftSaveHeld = false;
            resolve();
          }, 10);
        });
      }
      if (method === 'POST' && /^\\/api\\/threads\\/[^/]+\\/interactions$/.test(requestUrl.pathname)) {
        let body = null;
        try { body = JSON.parse(init.body); } catch {}
        window.__contextDraftWarningFetchProbe.interactionRequests.push({
          path: requestUrl.pathname,
          body,
        });
        if (window.__contextDraftWarningFetchProbe.failNextInteraction) {
          window.__contextDraftWarningFetchProbe.failNextInteraction = false;
          return new Response(JSON.stringify({
            error: 'Deterministic interaction submission failure.',
            code: 'fixture_submission_failure',
          }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return originalFetch(input, init);
    };
  })()`);
}

async function recreateInteractiveWorkspace(label) {
  const result = await evaluate(`(async () => {
    try {
      const { query } = await import('./src/state.js');
      const { renderThread } = await import('./src/graph.js');
      query.set('review', '1');
      renderThread();
      query.delete('review');
      renderThread();
      return 'ok';
    } catch (error) {
      return String(error?.stack || error);
    }
  })()`);
  if (result !== "ok") throw new Error(`${label}: ${result}`);
}

async function exactDrafts(threadId) {
  const response = await productRequest(`/api/threads/${threadId}/context-drafts`);
  if (response.drafts.length !== draftFixtures.length) {
    throw new Error(`Expected ${draftFixtures.length} preserved drafts: ${JSON.stringify(response)}`);
  }
  const identities = response.drafts.map((draft) => ({
    id: draft.id,
    revision: draft.revision,
    text: draft.text,
  }));
  const expected = draftFixtures.map((draft) => ({
    id: draft.id,
    revision: 1,
    text: draft.text,
  }));
  if (JSON.stringify(identities) !== JSON.stringify(expected)) {
    throw new Error(`Draft identities changed: ${JSON.stringify({ expected, identities })}`);
  }
  return identities;
}

async function warningSnapshot() {
  return evaluate(`(() => {
    const warning = document.querySelector('#contextDraftSendWarning');
    return {
      open: warning?.open === true,
      role: warning?.getAttribute('role'),
      modal: warning?.getAttribute('aria-modal'),
      count: document.querySelector('#contextDraftSendWarningCount')?.textContent,
      listLabel: document.querySelector('[data-context-draft-warning-list]')?.getAttribute('aria-label'),
      titles: [...document.querySelectorAll('[data-context-draft-warning-list] strong')].map((element) => element.textContent),
      activeElement: document.activeElement?.id,
      requests: window.__contextDraftWarningFetchProbe?.interactionRequests.length,
      openTransitions: window.__contextDraftWarningFetchProbe?.warningOpenTransitions,
    };
  })()`);
}

async function run() {
  process.stdout.write("Starting isolated Electron context-draft warning smoke test.\n");
  registerIpc();
  keepaliveWindow = new BrowserWindow({ width: 1, height: 1, show: false });

  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary,
    configurationPaths: [configurationPath],
    additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory },
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
  services.push(runtime);
  const runtimeSession = await runtime.start();
  const catalogRefreshServer = await startModelCatalogRefreshServer({
    refresh: () => product.publishProviderCatalog(catalogSnapshot),
  });
  services.push(catalogRefreshServer);
  product = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: appServerBinary,
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    providerCatalogRefreshSession: catalogRefreshServer.session,
    defaultHarnessConfiguration: "fixture-task-system",
  });
  services.push(product);
  productSession = await product.start();
  await product.publishProviderCatalog(catalogSnapshot);

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
  const withDraft = await createFixtureThread(
    project.id,
    modelSelection,
    "Context draft warning",
  );
  let withDraftDetail = withDraft.detail;
  for (let interactionCount = 2; interactionCount <= 5; interactionCount += 1) {
    withDraftDetail = await addFixtureInteraction(
      withDraft.thread.id,
      modelSelection,
      interactionCount,
    );
  }
  const withoutDraft = await createFixtureThread(
    project.id,
    modelSelection,
    "No context draft warning",
  );
  const targetOccurrences = withDraftDetail.interactions.flatMap((interaction) => {
    const rootLayer = interaction.completionOutput?.rootLayer;
    if (!interaction.graphNodeId || !rootLayer?.layer?.id) return [];
    return (rootLayer.nodes || []).map((node) => ({
      interactionNodeId: interaction.graphNodeId,
      layerId: rootLayer.layer.id,
      node,
    }));
  });
  if (targetOccurrences.length < draftFixtures.length + 1) {
    throw new Error(`The fixture graph exposed only ${targetOccurrences.length} draft targets.`);
  }
  for (const [index, fixture] of draftFixtures.entries()) {
    const occurrence = targetOccurrences[index];
    await productRequest(
      `/api/threads/${withDraft.thread.id}/context-drafts/${fixture.id}`,
      {
        method: "PUT",
        body: JSON.stringify({
          target: {
            nodeId: occurrence.node.id,
            sourceInteractionNodeId: occurrence.interactionNodeId,
            sourceLayerId: occurrence.layerId,
          },
          targetNode: {
            id: occurrence.node.id,
            kind: occurrence.node.kind,
            icon: occurrence.node.icon,
            title: occurrence.node.title,
            detail: occurrence.node.detail,
            state: occurrence.node.state || "accepted",
          },
          text: fixture.text,
          expectedRevision: null,
        }),
      },
    );
  }
  await exactDrafts(withDraft.thread.id);

  await openThreadWindow(withDraft.thread.id);
  await installFetchProbe();
  const confirmedOccurrence = targetOccurrences[draftFixtures.length];
  await clickNode(confirmedOccurrence.node.title);
  await click("#attachNodeContext");
  await waitFor("confirmed-context editor", () => evaluate(
    `Boolean(document.querySelector('#contextAnnotationEditor'))`,
  ));
  await setField("#contextAnnotationEditor", confirmedAnnotation);
  await click("[aria-label='Confirm annotation']");
  await waitFor("confirmed context pill", () => evaluate(`(() => (
    document.querySelectorAll('.composer-context-pill-wrap').length === 1
      && document.querySelector('.composer-context-pill')?.getAttribute('aria-expanded') === 'false'
      && document.querySelector('.composer-context-pill span')?.textContent === '1 annotation'
      && !document.querySelector('.composer-context-preview')
  ))()`));
  await exactDrafts(withDraft.thread.id);
  const promptValue = "Explain how the queue handles backpressure.";
  await setPrompt(promptValue);
  mainWindow.webContents.setZoomFactor(1.35);
  const expectedDraftTitles = targetOccurrences
    .slice(0, draftFixtures.length)
    .map((occurrence) => occurrence.node.title);

  await click("#sendInteraction", { focus: true, twice: true });
  const initialWarning = await waitFor("one warning after duplicate activation", async () => {
    const snapshot = await warningSnapshot();
    return snapshot.open && snapshot.openTransitions === 1 ? snapshot : false;
  });
  if (JSON.stringify(initialWarning) !== JSON.stringify({
    open: true,
    role: "dialog",
    modal: "true",
    count: "12 unconfirmed drafts",
    listLabel: "12 unconfirmed drafts",
    titles: expectedDraftTitles,
    activeElement: "cancelContextDraftSend",
    requests: 0,
    openTransitions: 1,
  })) throw new Error(`Unexpected warning presentation: ${JSON.stringify(initialWarning)}`);

  mainWindow.setSize(900, 600);
  mainWindow.webContents.setZoomFactor(2);
  await waitFor("warning layout after extreme zoom", () => evaluate(`(() => {
    const dialog = document.querySelector('#contextDraftSendWarning');
    const bounds = dialog.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= innerHeight
      && bounds.left >= 0 && bounds.right <= innerWidth;
  })()`));
  const extremeZoomLayout = await evaluate(`(() => {
    const dialog = document.querySelector('#contextDraftSendWarning');
    const heading = document.querySelector('#contextDraftSendWarningTitle');
    const actions = document.querySelector('.context-draft-send-warning-actions');
    const inViewport = (element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top >= 0 && bounds.bottom <= innerHeight
        && bounds.left >= 0 && bounds.right <= innerWidth;
    };
    const initialHeadingVisible = inViewport(heading);
    const initialActionsVisible = inViewport(actions);
    dialog.scrollTop = dialog.scrollHeight;
    return {
      overflowY: getComputedStyle(dialog).overflowY,
      dialogInViewport: inViewport(dialog),
      noHorizontalOverflow: dialog.scrollWidth <= dialog.clientWidth,
      initialHeadingVisible,
      actionsReachable: initialActionsVisible || inViewport(actions),
    };
  })()`);
  if (JSON.stringify(extremeZoomLayout) !== JSON.stringify({
    overflowY: "auto",
    dialogInViewport: true,
    noHorizontalOverflow: true,
    initialHeadingVisible: true,
    actionsReachable: true,
  })) throw new Error(`Warning is clipped at extreme zoom: ${JSON.stringify(extremeZoomLayout)}`);
  mainWindow.setSize(1280, 860);
  mainWindow.webContents.setZoomFactor(1.35);
  await evaluate(`document.querySelector('#contextDraftSendWarning').scrollTop = 0`);

  const mountedManyDraftLayout = await evaluate(`(() => {
    const dialog = document.querySelector('#contextDraftSendWarning');
    const list = document.querySelector('[data-context-draft-warning-list]');
    const actions = document.querySelector('.context-draft-send-warning-actions');
    const dialogBounds = dialog.getBoundingClientRect();
    const actionBounds = actions.getBoundingClientRect();
    const initialScrollTop = list.scrollTop;
    list.focus();
    list.scrollTop = list.scrollHeight;
    return {
      listOverflowY: getComputedStyle(list).overflowY,
      listScrollable: list.scrollHeight > list.clientHeight,
      listScrolled: list.scrollTop > initialScrollTop,
      dialogInViewport: dialogBounds.top >= 0 && dialogBounds.bottom <= innerHeight
        && dialogBounds.left >= 0 && dialogBounds.right <= innerWidth,
      actionsInViewport: actionBounds.top >= 0 && actionBounds.bottom <= innerHeight
        && actionBounds.left >= 0 && actionBounds.right <= innerWidth,
      noHorizontalOverflow: dialog.scrollWidth <= dialog.clientWidth,
    };
  })()`);
  if (JSON.stringify(mountedManyDraftLayout) !== JSON.stringify({
    listOverflowY: "auto",
    listScrollable: true,
    listScrolled: true,
    dialogInViewport: true,
    actionsInViewport: true,
    noHorizontalOverflow: true,
  })) throw new Error(`Many-draft layout is not usable at large zoom: ${JSON.stringify(mountedManyDraftLayout)}`);
  await evaluate(`document.querySelector('[data-context-draft-warning-list]').scrollTop = 0`);
  await sendKey("PageDown");
  await waitFor("keyboard scrolling in many-draft list", () => evaluate(
    `document.querySelector('[data-context-draft-warning-list]')?.scrollTop > 0`,
  ));
  await evaluate(`document.querySelector('#cancelContextDraftSend').focus()`);

  await sendKey("Tab", ["shift"]);
  await waitFor("backward focus reaches draft list", () => evaluate(
    `document.activeElement?.matches('[data-context-draft-warning-list]') === true`,
  ));
  await sendKey("Tab", ["shift"]);
  await waitFor("backward focus wraps to override", () => evaluate(
    `document.activeElement?.id === 'confirmContextDraftSend'`,
  ));
  await sendKey("Tab");
  await waitFor("forward focus wraps to draft list", () => evaluate(
    `document.activeElement?.matches('[data-context-draft-warning-list]') === true`,
  ));

  await click("[data-context-draft-warning-action='cancel']");
  await waitFor("cancel focus restoration", () => evaluate(`(() => (
    !document.querySelector('#contextDraftSendWarning')?.open
      && document.activeElement?.id === 'sendInteraction'
      && document.querySelector('#threadPrompt')?.value === ${JSON.stringify(promptValue)}
  ))()`));
  await exactDrafts(withDraft.thread.id);
  if ((await evaluate(`window.__contextDraftWarningFetchProbe.interactionRequests.length`)) !== 0) {
    throw new Error("Cancel submitted an interaction.");
  }

  await click("#sendInteraction", { focus: true });
  await waitFor("warning before keyboard cancellation", () => evaluate(
    `document.querySelector('#contextDraftSendWarning')?.open === true`,
  ));
  await sendKey("Enter");
  await waitFor("keyboard cancellation focus restoration", () => evaluate(`(() => (
    !document.querySelector('#contextDraftSendWarning')?.open
      && document.activeElement?.id === 'sendInteraction'
      && document.querySelector('#threadPrompt')?.value === ${JSON.stringify(promptValue)}
  ))()`));
  await exactDrafts(withDraft.thread.id);

  await evaluate(`window.__contextDraftWarningFetchProbe.failNextInteraction = true`);
  await click("#sendInteraction", { focus: true });
  await waitFor("warning before failed override", () => evaluate(
    `document.querySelector('#contextDraftSendWarning')?.open === true`,
  ));
  await click("[data-context-draft-warning-action='send']", { twice: true });
  await waitFor("failed override recovery", () => evaluate(`(() => (
    window.__contextDraftWarningFetchProbe.interactionRequests.length === 1
      && !document.querySelector('#contextDraftSendWarning')?.open
      && document.querySelector('#toast')?.textContent === 'Deterministic interaction submission failure.'
      && document.querySelector('#threadPrompt')?.disabled === false
      && document.querySelector('#threadPrompt')?.value === ${JSON.stringify(promptValue)}
  ))()`));
  const afterFailure = await productRequest(`/api/threads/${withDraft.thread.id}`);
  if (afterFailure.interactions.length !== 5) {
    throw new Error("Failed submission created an interaction.");
  }
  await exactDrafts(withDraft.thread.id);

  const pendingCancelNodeTitle = ["Incoming queue", "Two-worker pool", "Results store"]
    .find((title) => title !== confirmedOccurrence.node.title);
  await clickNode(pendingCancelNodeTitle);
  const pendingCancelNodeId = await evaluate(
    `document.querySelector('.graph-node.selected')?.dataset.node`,
  );
  if (!pendingCancelNodeId) throw new Error("Pending-cancellation target did not become selected.");
  await click("#attachNodeContext");
  await waitFor("new durable draft editor", () => evaluate(
    `Boolean(document.querySelector('#contextAnnotationEditor'))`,
  ));
  await evaluate(`window.__contextDraftWarningFetchProbe.holdNextDraftSave = true`);
  const heldDraftText = "This draft save is intentionally held while the override is cancelled.";
  await setField("#contextAnnotationEditor", heldDraftText);
  await click("#closeInspector");
  await waitFor("draft dock hidden after Node Details closed", () => evaluate(
    `document.querySelector('#inspector')?.classList.contains('hidden')
      && !document.querySelector('#contextAnnotationEditor')`,
  ));
  await setPrompt("Do not send after I cancel the pending draft-save override.");
  await click("#sendInteraction", { focus: true });
  await waitFor("warning before held draft persistence", () => evaluate(
    `document.querySelector('#contextDraftSendWarning')?.open === true`,
  ));
  await click("[data-context-draft-warning-action='send']");
  await waitFor("held draft persistence", () => evaluate(
    `window.__contextDraftWarningFetchProbe.draftSaveHeld === true
      && document.querySelector('#confirmContextDraftSend')?.disabled === true`,
  ));
  await click("[data-context-draft-warning-action='cancel']");
  await waitFor("pending override cancellation", () => evaluate(`(() => (
    !document.querySelector('#contextDraftSendWarning')?.open
      && document.activeElement?.id === 'sendInteraction'
      && document.querySelector('#confirmContextDraftSend')?.disabled === false
  ))()`));
  await evaluate(`window.__contextDraftWarningFetchProbe.releaseDraftSave = true`);
  await waitFor("held draft save release", () => evaluate(
    `window.__contextDraftWarningFetchProbe.draftSaveHeld === false`,
  ));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const requestsAfterPendingCancel = await evaluate(
    `window.__contextDraftWarningFetchProbe.interactionRequests.length`,
  );
  if (requestsAfterPendingCancel !== 1) {
    throw new Error(`Cancelled pending persistence submitted an interaction: ${requestsAfterPendingCancel}`);
  }
  const draftsAfterPendingCancel = await productRequest(
    `/api/threads/${withDraft.thread.id}/context-drafts`,
  );
  const heldDraft = draftsAfterPendingCancel.drafts.find(
    (draft) => String(draft.target.nodeId) === String(pendingCancelNodeId),
  );
  if (!heldDraft
    || heldDraft.text !== heldDraftText
    || heldDraft.revision !== 1
    || !heldDraft.id
    || !heldDraft.createdAt
    || !heldDraft.updatedAt) {
    throw new Error(`Cancelled persistence did not preserve the held draft: ${JSON.stringify(heldDraft)}`);
  }
  await clickNode(pendingCancelNodeTitle);
  await waitFor("persisted cancellation-test draft editor", () => evaluate(`(() => (
    document.querySelector('#contextAnnotationEditor')?.value === ${JSON.stringify(heldDraftText)}
  ))()`));
  const draftsAfterReopen = await productRequest(`/api/threads/${withDraft.thread.id}/context-drafts`);
  const reopenedHeldDraft = draftsAfterReopen.drafts.find(
    (draft) => String(draft.target.nodeId) === String(pendingCancelNodeId),
  );
  if (reopenedHeldDraft?.id !== heldDraft.id || reopenedHeldDraft.revision !== heldDraft.revision) {
    throw new Error(`Reopened draft identity changed: ${JSON.stringify({ heldDraft, reopenedHeldDraft })}`);
  }
  await click("[aria-label^='Discard annotation draft']");
  await waitFor("cancellation-test draft discard", () => evaluate(
    `!document.querySelector('#contextAnnotationEditor')`,
  ));
  await exactDrafts(withDraft.thread.id);
  await setPrompt(promptValue);

  await click("#sendInteraction", { focus: true });
  await waitFor("warning reactivation after failure", () => evaluate(
    `document.querySelector('#contextDraftSendWarning')?.open === true`,
  ));
  await evaluate(`document.querySelector('[data-context-draft-warning-action="send"]').focus()`);
  await sendKey("Enter");
  await sendKey("Enter");
  await waitFor("single successful override request", () => evaluate(
    `window.__contextDraftWarningFetchProbe.interactionRequests.length === 2`,
  ));
  const acceptedOverride = await waitForAcceptedInteractions(withDraft.thread.id, 6);
  await waitFor("successful override composer settlement", () => evaluate(`(() => (
    !document.querySelector('#contextDraftSendWarning')?.open
      && document.querySelector('#threadPrompt')?.value === ''
  ))()`));
  const requests = await evaluate(`window.__contextDraftWarningFetchProbe.interactionRequests`);
  const expectedConfirmedContext = [{
    target: {
      nodeId: confirmedOccurrence.node.id,
      sourceInteractionNodeId: confirmedOccurrence.interactionNodeId,
      sourceLayerId: confirmedOccurrence.layerId,
    },
    annotations: [confirmedAnnotation],
  }];
  if (requests.length !== 2
    || requests[1].body?.text !== promptValue
    || JSON.stringify(requests[1].body?.contexts) !== JSON.stringify(expectedConfirmedContext)) {
    throw new Error(`Override did not preserve only confirmed context: ${JSON.stringify(requests)}`);
  }
  const acceptedContext = acceptedOverride.interactions[5].contexts || [];
  if (acceptedContext.length !== 1
    || acceptedContext[0].targetNode?.id !== confirmedOccurrence.node.id
    || JSON.stringify(acceptedContext[0].annotations) !== JSON.stringify([confirmedAnnotation])) {
    throw new Error(`Accepted override did not preserve only confirmed context: ${JSON.stringify(acceptedContext)}`);
  }
  const preservedDrafts = await exactDrafts(withDraft.thread.id);

  await openThreadWindow(withoutDraft.thread.id);
  await installFetchProbe();
  await evaluate(`window.__contextDraftWarningFetchProbe.remainingDraftLoadFailures = 2`);
  await recreateInteractiveWorkspace("Could not recreate workspace for transient load recovery");
  await setPrompt("Enable Send after one transient context restoration failure.");
  if (await evaluate(`document.querySelector('#sendInteraction')?.disabled`) !== false) {
    throw new Error("Send did not recover after the context restoration retry succeeded.");
  }
  const disposeRacePrompt = "Do not send after this workspace is disposed during draft loading.";
  await evaluate(`Object.assign(window.__contextDraftWarningFetchProbe, {
    remainingDraftLoadFailures: 1,
    holdNextDraftLoad: true,
  })`);
  await recreateInteractiveWorkspace("Could not recreate workspace for held load");
  await waitFor("completed no-draft response held from recreated workspace", () => evaluate(
    `window.__contextDraftWarningFetchProbe.draftLoadHeld === true
      && window.__contextDraftWarningFetchProbe.draftLoadResponseReady === true`,
  ));
  await setPrompt(disposeRacePrompt, { waitForSend: false });
  if (await evaluate(`document.querySelector('#sendInteraction')?.disabled`) !== true) {
    throw new Error("Send became actionable before initial context restoration completed.");
  }
  await click("#sendInteraction", { focus: true });
  await recreateInteractiveWorkspace("Could not dispose workspace during held send");
  await evaluate(`window.__contextDraftWarningFetchProbe.releaseDraftLoad = true`);
  await waitFor("disposed workspace no-draft response delivery", () => evaluate(
    `window.__contextDraftWarningFetchProbe.draftLoadHeld === false
      && window.__contextDraftWarningFetchProbe.draftLoadDelivered === true`,
  ));
  await evaluate(`Promise.resolve().then(() => Promise.resolve()).then(() => true)`);
  const requestsAfterWorkspaceDisposal = await evaluate(
    `window.__contextDraftWarningFetchProbe.interactionRequests.length`,
  );
  if (requestsAfterWorkspaceDisposal !== 0) {
    throw new Error(`Disposed workspace submitted an interaction: ${requestsAfterWorkspaceDisposal}`);
  }
  const detailAfterWorkspaceDisposal = await productRequest(`/api/threads/${withoutDraft.thread.id}`);
  if (detailAfterWorkspaceDisposal.interactions.length !== 1) {
    throw new Error("Disposed workspace created an interaction after draft loading resumed.");
  }
  const newThreadInteraction = withoutDraft.detail.interactions[0];
  const newThreadRoot = newThreadInteraction.completionOutput?.rootLayer;
  const newThreadNode = newThreadRoot?.nodes?.[0];
  if (!newThreadInteraction.graphNodeId || !newThreadRoot?.layer?.id || !newThreadNode) {
    throw new Error("The no-draft fixture did not expose a context target for New Thread restoration.");
  }
  const newThreadConfirmationId = "new-thread-restored-confirmation";
  const newThreadAnnotation = "Restore this confirmation after returning from New Thread.";
  const newThreadDraftUri = `/api/threads/${withoutDraft.thread.id}/context-drafts/${newThreadConfirmationId}`;
  await productRequest(newThreadDraftUri, {
    method: "PUT",
    body: JSON.stringify({
      target: {
        nodeId: newThreadNode.id,
        sourceInteractionNodeId: newThreadInteraction.graphNodeId,
        sourceLayerId: newThreadRoot.layer.id,
      },
      targetNode: {
        id: newThreadNode.id,
        kind: newThreadNode.kind,
        icon: newThreadNode.icon,
        title: newThreadNode.title,
        detail: newThreadNode.detail,
        state: newThreadNode.state || "accepted",
      },
      text: newThreadAnnotation,
      expectedRevision: null,
    }),
  });
  await productRequest(`${newThreadDraftUri}/confirm?expectedRevision=1`, { method: "POST" });
  await evaluate(`Object.assign(window.__contextDraftWarningFetchProbe, {
    holdNextDraftLoad: true,
    draftLoadHeld: false,
    draftLoadResponseReady: false,
    releaseDraftLoad: false,
    draftLoadDelivered: false,
  })`);
  await recreateInteractiveWorkspace("Could not recreate workspace for New Thread race");
  await waitFor("completed no-draft response held before New Thread", () => evaluate(
    `window.__contextDraftWarningFetchProbe.draftLoadHeld === true
      && window.__contextDraftWarningFetchProbe.draftLoadResponseReady === true`,
  ));
  await setPrompt("Do not send after entering New Thread during draft loading.", { waitForSend: false });
  if (await evaluate(`document.querySelector('#sendInteraction')?.disabled`) !== true) {
    throw new Error("New Thread race exposed Send before initial context restoration completed.");
  }
  await click("#sendInteraction", { focus: true });
  const enterNewThread = await evaluate(`(async () => {
    try {
      const { appState, viewState } = await import('./src/state.js');
      const { renderThread } = await import('./src/graph.js');
      window.__contextDraftWarningNewThreadReturn = {
        threadId: viewState.currentThreadId,
        activeStates: appState.threads.map((thread) => thread.active),
      };
      viewState.currentThreadId = null;
      appState.threads.forEach((thread) => { thread.active = false; });
      renderThread();
      return 'ok';
    } catch (error) {
      return String(error?.stack || error);
    }
  })()`);
  if (enterNewThread !== "ok") {
    throw new Error(`Could not enter New Thread: ${enterNewThread}`);
  }
  await evaluate(`window.__contextDraftWarningFetchProbe.releaseDraftLoad = true`);
  await waitFor("New Thread-cancelled draft response delivery", () => evaluate(
    `window.__contextDraftWarningFetchProbe.draftLoadHeld === false
      && window.__contextDraftWarningFetchProbe.draftLoadDelivered === true`,
  ));
  await evaluate(`Promise.resolve().then(() => Promise.resolve()).then(() => true)`);
  const returnFromNewThread = await evaluate(`(async () => {
    try {
      const { appState, viewState } = await import('./src/state.js');
      const { renderThread } = await import('./src/graph.js');
      const saved = window.__contextDraftWarningNewThreadReturn;
      viewState.currentThreadId = saved.threadId;
      appState.threads.forEach((thread, index) => { thread.active = saved.activeStates[index]; });
      renderThread();
      return 'ok';
    } catch (error) {
      return String(error?.stack || error);
    }
  })()`);
  if (returnFromNewThread !== "ok") {
    throw new Error(`Could not return from New Thread: ${returnFromNewThread}`);
  }
  await waitFor("confirmation restored after off-thread load", () => evaluate(`(() => (
    document.querySelectorAll('.composer-context-pill-wrap').length === 1
      && document.querySelector('.composer-context-pill')?.getAttribute('aria-expanded') === 'false'
      && document.querySelector('.composer-context-pill span')?.textContent === '1 annotation'
      && !document.querySelector('.composer-context-preview')
  ))()`));
  await click(".composer-context-pill");
  const restoredNewThreadAnnotation = await evaluate(
    `document.querySelector('.composer-context-annotations li > span')?.textContent`,
  );
  if (restoredNewThreadAnnotation !== newThreadAnnotation) {
    throw new Error(`New Thread restored the wrong confirmation: ${JSON.stringify(restoredNewThreadAnnotation)}`);
  }
  await click(".composer-context-annotations [aria-label^='Delete annotation 1 for ']");
  await waitFor("restored New Thread annotation dismissal", () => evaluate(
    `document.querySelector('.composer-context-pill span')?.textContent === '0 annotations'`,
  ));
  await click(".composer-context-pill-remove");
  await waitFor("restored New Thread context detachment", () => evaluate(
    `document.querySelectorAll('.composer-context-pill-wrap').length === 0`,
  ));
  const requestsAfterNewThread = await evaluate(
    `window.__contextDraftWarningFetchProbe.interactionRequests.length`,
  );
  if (requestsAfterNewThread !== 0) {
    throw new Error(`New Thread navigation submitted a stale interaction: ${requestsAfterNewThread}`);
  }
  const detailAfterNewThread = await productRequest(`/api/threads/${withoutDraft.thread.id}`);
  if (detailAfterNewThread.interactions.length !== 1) {
    throw new Error("New Thread navigation created an interaction after draft loading resumed.");
  }
  const directPrompt = "Send directly when no unconfirmed draft exists.";
  await setPrompt(directPrompt);
  await click("#sendInteraction", { focus: true });
  await waitFor("direct no-draft request", () => evaluate(
    `window.__contextDraftWarningFetchProbe.interactionRequests.length === 1`,
  ));
  const acceptedDirect = await waitForAcceptedInteractions(withoutDraft.thread.id, 2);
  const directState = await evaluate(`({
    warningOpen: document.querySelector('#contextDraftSendWarning')?.open,
    warningOpenTransitions: window.__contextDraftWarningFetchProbe.warningOpenTransitions,
    request: window.__contextDraftWarningFetchProbe.interactionRequests[0],
    prompt: document.querySelector('#threadPrompt')?.value,
  })`);
  if (directState.warningOpen
    || directState.warningOpenTransitions !== 0
    || directState.request?.body?.text !== directPrompt
    || JSON.stringify(directState.request?.body?.contexts) !== "[]"
    || directState.prompt !== ""
    || (acceptedDirect.interactions[1].contexts || []).length !== 0) {
    throw new Error(`No-draft send did not submit directly: ${JSON.stringify(directState)}`);
  }
  const noDrafts = await productRequest(`/api/threads/${withoutDraft.thread.id}/context-drafts`);
  if (noDrafts.drafts.length !== 0) throw new Error("The no-draft fixture unexpectedly gained a draft.");

  process.stdout.write(`RELAYER_CONTEXT_DRAFT_WARNING_SMOKE ${JSON.stringify({
    passed: true,
    harness: "fixture-task-system",
    inferenceCalls: 0,
    duplicateActivationRequests: initialWarning.requests,
    cancelPreserved: true,
    keyboardCancelRestoredFocus: true,
    pendingPersistenceCancelPassed: true,
    workspaceDisposalCancelPassed: true,
    newThreadCancelPassed: true,
    newThreadRestorationPassed: true,
    failureRecovered: true,
    repeatActivationPassed: true,
    overrideContexts: requests[1].body.contexts,
    directContexts: directState.request.body.contexts,
    preservedDraftCount: preservedDrafts.length,
  })}\n`);
  exitCode = 0;
}

async function shutdown() {
  mainWindow?.destroy();
  keepaliveWindow?.destroy();
  unregisterIpc();
  for (const service of services.reverse()) {
    try {
      await service.close();
    } catch (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      exitCode = 1;
    }
  }
  await rm(dataDirectory, { recursive: true, force: true });
  process.exit(exitCode);
}

void app.whenReady()
  .then(run)
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    exitCode = 1;
  })
  .finally(shutdown);
