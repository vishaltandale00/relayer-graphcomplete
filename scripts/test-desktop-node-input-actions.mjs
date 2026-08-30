import { app, BrowserWindow, ipcMain } from "electron";
import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  LayerLayoutObject,
  LayerObject,
  NodeObject,
  NodePlacementObject,
  RelayerGraphClient,
} from "@relayer/graph-client";

import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";
import { createElectronWorkspaceDriver } from "./electron-workspace-driver.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-node-input-actions-"));
const resultFile = process.env.RELAYER_NODE_INPUT_RESULT_FILE;
let runtime;
let catalogRefreshServer;
let product;
let productSession;
let window;
let keepaliveWindow;
let completionCount = 0;
let releaseSecondCompletion;
const secondCompletionGate = new Promise((resolveGate) => { releaseSecondCompletion = resolveGate; });

app.setName("Relayer Node Input Actions Test");
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

function nodeInputFixtureFactory() {
  return {
    traceSupport: () => ({
      prompt: "full",
      messages: "full",
      reasoningSummaries: "none",
      modelCalls: "none",
      toolCalls: "summary",
      usage: "none",
      childStreams: "none",
      nativeArtifacts: "none",
    }),
    state: () => ({}),
    async complete(context) {
      try {
        completionCount += 1;
        if (completionCount === 2) await secondCompletionGate;
        const graph = new RelayerGraphClient(context.graph.acquireCapability());
        const interaction = context.inputGraph;
      const node = new NodeObject(
        "settings",
        "Input grammar",
        "These authored inputs belong directly to this Node Details page.",
        "concept",
        `input-grammar-${completionCount}`,
      );
      await graph.submitNode(node);
      const layer = new LayerObject(
        [node],
        [],
        new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)]),
        `input-layer-${completionCount}`,
      );
      await graph.submitLayer(layer);
      await graph.addAction(node, {
        kind: "input",
        sourceLayer: layer,
        label: "Constraint",
        control: "text",
        prompt: "Name the governing constraint",
        clientKey: `constraint-${completionCount}`,
      });
      const options = Array.from({ length: 8 }, (_, index) => ({
        key: `route-${index + 1}`,
        label: `Route ${index + 1} with a deliberately long label`,
      }));
      await graph.addAction(node, {
        kind: "input",
        sourceLayer: layer,
        label: "Route",
        control: "single_select",
        prompt: "Choose the primary route",
        options,
        clientKey: `route-${completionCount}`,
      });
      await graph.addAction(node, {
        kind: "input",
        sourceLayer: layer,
        label: "Evidence",
        control: "multi_select",
        prompt: "Choose supporting evidence",
        options: [
          { key: "health-metrics", label: "Health metrics" },
          { key: "logs", label: "Logs" },
          { key: "synthetic-checks", label: "Synthetic checks" },
        ],
        minimumSelections: 2,
        clientKey: `evidence-${completionCount}`,
      });
      await graph.addAction(interaction.id, {
        kind: "navigate",
        relation: "expand",
        label: "Response",
        target: layer,
        clientKey: `response-${completionCount}`,
      });
      await graph.submit(interaction.id);
        context.trace.emit({ type: "message", data: { role: "assistant", text: "Accepted deterministic node-input fixture." } });
      } catch (error) {
        console.error("Node-input fixture harness failed", error);
        throw error;
      }
    },
  };
}

const driver = createElectronWorkspaceDriver({
  getWindow: () => window,
  getProductSession: () => productSession,
});
const { click, clickNode, evaluate, productRequest, setValue, waitFor, waitForAcceptedInteractions, waitForPaint } = driver;

function registerIpc() {
  ipcMain.handle("relayer:account-read", () => ({ status: "signed-in", channel: "stable", subject: "fixture|node-input" }));
  ipcMain.handle("relayer:appearance-read", () => ({ appearance: "dark" }));
  ipcMain.handle("relayer:update-status", () => ({ phase: "development", channel: "stable", version: "test" }));
  ipcMain.handle("relayer:folder-choose", () => null);
  ipcMain.handle("relayer:tutorial-read", () => ({ status: "dismissed", automaticEligible: false }));
  ipcMain.handle("relayer:provider-status", () => ({ adapters: [], definitions: [], hasCompletedOnboarding: true }));
}

async function startServices() {
  runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [join(repositoryRoot, "harnesses", "fixture-task-system.yaml")],
    additionalImplementations: { "fixture.task-system": nodeInputFixtureFactory },
    acquireProviderExecution: async (providerId) => ({
      definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
      descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
      runtime: { executionAccess: async () => ({ kind: "managed-runtime", environment: {} }) },
      async release() {},
    }),
  });
  const runtimeSession = await runtime.start();
  catalogRefreshServer = await startModelCatalogRefreshServer({ refresh: () => product.publishProviderCatalog(catalogSnapshot) });
  product = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    providerCatalogRefreshSession: catalogRefreshServer.session,
    defaultHarnessConfiguration: "fixture-task-system",
  });
  productSession = await product.start();
  await product.publishProviderCatalog(catalogSnapshot);
}

async function run() {
  process.stdout.write("Running real-Electron zero-inference node-input proof.\n");
  registerIpc();
  keepaliveWindow = new BrowserWindow({ width: 1, height: 1, show: false });
  await startServices();
  const project = await productRequest("/api/projects", { method: "POST", body: JSON.stringify({ path: repositoryRoot }) });
  const family = await productRequest("/api/model-families", {
    method: "POST",
    body: JSON.stringify({ name: "Fixture", enabled: true, members: [{ providerId: "codex", modelId: "fixture-model" }] }),
  });
  const thread = await productRequest("/api/threads", {
    method: "POST",
    body: JSON.stringify({
      title: "Node input actions",
      initialMessage: "Author deterministic input controls.",
      projectId: project.id,
      harnessId: "fixture-task-system",
      modelSelection: { familyId: family.id, providerId: "codex", modelId: "fixture-model" },
    }),
  });
  await waitForAcceptedInteractions(thread.id, 1);
  const createWindow = createWindowFactory({
    BrowserWindow: function TestWindow(options) {
      return new BrowserWindow({ ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
    },
    desktopDirectory: join(repositoryRoot, "desktop"),
    getAppearance: () => "dark",
    updater: { status: () => ({ phase: "development" }) },
  });
  window = await createWindow(productSession);
  window.setSize(1280, 820);
  await window.loadURL(`${productSession.origin}/?threadId=${thread.id}`);
  await waitFor("production node-input workspace", () => evaluate(`(() => (
    !document.body.classList.contains('desktop-account-pending')
      && document.querySelectorAll('.graph-node').length === 1
      && !document.querySelector('#threadPrompt')?.disabled
  ))()`));
  await clickNode("Input grammar");
  await waitFor("three embedded Node Details inputs", () => evaluate(`(() => (
    document.querySelectorAll('#nodeInputActions .node-input-editor').length === 3
      && document.querySelectorAll('#nodeInputActions .node-input-option-rail').length === 2
      && document.querySelector('#detailActions')?.classList.contains('hidden')
  ))()`));
  const grammar = await evaluate(`(() => ({
    attachedToDetails: document.querySelector('#inspectorContent')?.contains(document.querySelector('#nodeInputActions')),
    prompts: [...document.querySelectorAll('.node-input-editor legend')].map((item) => item.textContent),
    symbols: [...document.querySelectorAll('.node-input-symbol')].map((button) => ({ text: button.textContent, label: button.getAttribute('aria-label'), width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
    forbiddenCopy: document.body.innerText.includes('Not attached to the composer'),
  }))()`);
  if (!grammar.attachedToDetails || grammar.prompts.length !== 3 || grammar.forbiddenCopy
    || grammar.symbols.some(({ text, label, width, height }) => !["✓", "↶"].includes(text) || !label || width > 30 || height > 30)) {
    throw new Error(`Node Details input grammar is wrong: ${JSON.stringify(grammar)}`);
  }

  await evaluate(`(() => {
    const option = document.querySelectorAll('.node-input-option-rail')[0].querySelector('.node-input-option');
    option.focus();
    option.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  })()`);
  await waitFor("single-select arrow keyboard selection", () => evaluate(`(() => {
    const selected = document.querySelectorAll('.node-input-option-rail')[0].querySelector('[aria-checked="true"]');
    return selected?.dataset.optionKey === 'route-2' && document.activeElement === selected;
  })()`));

  await setValue(".node-input-text", "Preserve occurrence identity");
  await evaluate(`(() => { const rails = document.querySelectorAll('.node-input-option-rail'); rails[0].scrollLeft = 160; rails[1].querySelectorAll('.node-input-option')[2].click(); })()`);
  await waitForPaint();
  const stacked = await evaluate(`(() => { const rails = document.querySelectorAll('.node-input-option-rail'); return { count: rails.length, firstScroll: rails[0].scrollLeft, secondSelected: rails[1].querySelectorAll('[aria-checked="true"]').length }; })()`);
  if (stacked.count !== 2 || stacked.firstScroll < 100 || stacked.secondSelected !== 1) {
    throw new Error(`Stacked horizontal rails lost independent state: ${JSON.stringify(stacked)}`);
  }
  const compactFits = await evaluate(`(() => {
    const rail = document.querySelectorAll('.node-input-option-rail')[1];
    rail.scrollLeft = 0;
    const bounds = rail.getBoundingClientRect();
    return rail.scrollWidth <= rail.clientWidth + 1
      && [...rail.querySelectorAll('.node-input-option')].every((option) => {
        const optionBounds = option.getBoundingClientRect();
        return optionBounds.left >= bounds.left - 1 && optionBounds.right <= bounds.right + 1;
      });
  })()`);
  if (!compactFits) throw new Error("Three ordinary input choices require horizontal discovery.");
  await evaluate(`document.querySelectorAll('.node-input-option-rail')[0].querySelectorAll('.node-input-option')[5].click()`);
  for (const prompt of ["Name the governing constraint", "Choose the primary route"]) {
    await click(`[aria-label='Commit ${prompt}']`);
    await waitFor(`${prompt} committed`, async () => {
      const draft = await productRequest(`/api/threads/${thread.id}/input-draft`);
      return draft.attachments?.some((attachment) => attachment.action.prompt === prompt);
    });
  }
  await waitFor("multi-select minimum error", () => evaluate(`(() => (
    document.querySelector("[aria-label='Input action: Choose supporting evidence'] .node-input-error")?.textContent.includes('minimum')
      && document.querySelector("[aria-label='Commit Choose supporting evidence']")?.disabled
      && document.querySelectorAll('.composer-input-pill').length === 2
  ))()`));
  await evaluate(`document.querySelectorAll('.node-input-option-rail')[1].querySelectorAll('.node-input-option')[1].click()`);
  await click("[aria-label='Commit Choose supporting evidence']");
  await waitFor("Choose supporting evidence committed", async () => {
    const draft = await productRequest(`/api/threads/${thread.id}/input-draft`);
    return draft.attachments?.some((attachment) => attachment.action.prompt === "Choose supporting evidence");
  });
  await waitFor("three exact committed attachments", async () => {
    const draft = await productRequest(`/api/threads/${thread.id}/input-draft`);
    return draft.attachments?.length === 3 && new Set(draft.attachments.map((item) => JSON.stringify(item.occurrence))).size === 3;
  });
  await waitFor("three composer input pills and input-only Send", () => evaluate(`(() => (
    document.querySelectorAll('.composer-input-pill').length === 3
      && document.querySelector('#threadPrompt')?.value === ''
      && !document.querySelector('#sendInteraction')?.disabled
  ))()`));
  window.webContents.reload();
  await waitFor("committed inputs after renderer reopen", () => evaluate(`(() => (
    !document.body.classList.contains('desktop-account-pending')
      && document.querySelectorAll('.graph-node').length === 1
      && document.querySelectorAll('.composer-input-pill').length === 3
  ))()`));
  await clickNode("Input grammar");
  await waitFor("Node Details restores committed values", () => evaluate(`(() => (
    document.querySelector('.node-input-text')?.value === 'Preserve occurrence identity'
      && document.querySelectorAll('.node-input-option[aria-checked="true"]').length === 3
  ))()`));
  await click(".composer-input-pill");
  await waitFor("explicit composer input inspection", () => evaluate(`Boolean(document.querySelector('.composer-input-preview'))`));
  await click("[aria-label='Close Name the governing constraint input details']");
  await setValue(".node-input-text", "Local replacement");
  await click("[aria-label='Undo Name the governing constraint']");
  const undone = await evaluate(`document.querySelector('.node-input-text')?.value`);
  if (undone !== "Preserve occurrence identity") throw new Error(`Undo did not restore committed text: ${JSON.stringify(undone)}`);

  let rejectedCommit = false;
  const commitFilter = { urls: [`${productSession.origin}/api/threads/*/input-draft/attachments`] };
  window.webContents.session.webRequest.onBeforeRequest(commitFilter, (details, callback) => {
    if (!rejectedCommit && details.method === "PUT") {
      rejectedCommit = true;
      callback({ cancel: true });
      return;
    }
    callback({});
  });
  await setValue(".node-input-text", "Unsaved replacement");
  await click("[aria-label='Commit Name the governing constraint']");
  await waitFor("inline input persistence failure", () => evaluate(`(() => (
    document.querySelector('.node-input-error')?.textContent
      && document.querySelector('.node-input-text')?.value === 'Unsaved replacement'
  ))()`));
  window.webContents.session.webRequest.onBeforeRequest(commitFilter, null);
  if (!rejectedCommit) throw new Error("The input persistence failure interceptor was not exercised.");
  const afterRejectedCommit = await productRequest(`/api/threads/${thread.id}/input-draft`);
  if (afterRejectedCommit.attachments.find((item) => item.action.prompt === "Name the governing constraint")?.value?.text !== "Preserve occurrence identity") {
    throw new Error("A rejected input commit changed the authoritative attachment.");
  }
  await click("[aria-label='Undo Name the governing constraint']");

  await click("[aria-label='Detach Choose supporting evidence']");
  await waitFor("composer input detached", async () => {
    const draft = await productRequest(`/api/threads/${thread.id}/input-draft`);
    return draft.attachments?.length === 2
      && !draft.attachments.some((item) => item.action.prompt === "Choose supporting evidence")
      && await evaluate(`document.querySelectorAll('.composer-input-pill').length === 2`);
  });
  await evaluate(`(() => {
    const options = document.querySelectorAll('.node-input-option-rail')[1].querySelectorAll('.node-input-option');
    options[0].click();
    document.querySelectorAll('.node-input-option-rail')[1].querySelectorAll('.node-input-option')[1].click();
  })()`);
  await click("[aria-label='Commit Choose supporting evidence']");
  await waitFor("detached input recommitted", async () => (
    (await productRequest(`/api/threads/${thread.id}/input-draft`)).attachments?.length === 3
  ));

  window.webContents.setZoomFactor(1.5);
  await waitForPaint();
  const largeTextFits = await evaluate(`(() => [...document.querySelectorAll('.node-input-editor')].every((editor) => {
    const bounds = editor.getBoundingClientRect();
    return bounds.width > 0 && [...editor.querySelectorAll('button,textarea')].every((control) => control.getBoundingClientRect().width > 0);
  }) && (() => {
    const rail = document.querySelectorAll('.node-input-option-rail')[1];
    rail.scrollLeft = 0;
    const bounds = rail.getBoundingClientRect();
    return rail.scrollWidth <= rail.clientWidth + 1
      && [...rail.querySelectorAll('.node-input-option')].every((option) => {
        const optionBounds = option.getBoundingClientRect();
        return optionBounds.left >= bounds.left - 1 && optionBounds.right <= bounds.right + 1;
      });
  })())()`);
  if (!largeTextFits) throw new Error("Large-text scaling clipped a node input control.");
  window.webContents.setZoomFactor(1);
  await waitForPaint();

  await click("#sendInteraction");
  await waitFor("input controls locked during send", () => evaluate(`(() => (
    document.querySelectorAll('#nodeInputActions button:not(:disabled), #nodeInputActions textarea:not(:disabled)').length === 0
  ))()`));
  releaseSecondCompletion();
  await waitForAcceptedInteractions(thread.id, 2);
  await waitFor("submitted inputs rendered read-only", () => evaluate(`(() => (
    document.querySelectorAll('#interactionInputHistory .interaction-input-history-item').length === 3
      && document.querySelectorAll('.composer-input-pill').length === 0
  ))()`));
  process.stdout.write("Node-input Electron proof passed with 0 paid inference calls.\n");
}

async function stop() {
  if (window && !window.isDestroyed()) window.destroy();
  if (keepaliveWindow && !keepaliveWindow.isDestroyed()) keepaliveWindow.destroy();
  if (product) await product.close().catch(() => undefined);
  if (catalogRefreshServer) await catalogRefreshServer.close().catch(() => undefined);
  if (runtime) await runtime.close().catch(() => undefined);
  for (const channel of ["relayer:account-read", "relayer:appearance-read", "relayer:update-status", "relayer:folder-choose", "relayer:tutorial-read", "relayer:provider-status"]) ipcMain.removeHandler(channel);
  await rm(dataDirectory, { recursive: true, force: true });
}

app.whenReady().then(run).then(async () => {
  if (resultFile) await writeFile(resultFile, `${JSON.stringify({ passed: true })}\n`);
  await stop();
  app.exit(0);
}).catch(async (error) => {
  console.error(error);
  if (resultFile) await writeFile(resultFile, `${JSON.stringify({ passed: false, error: error?.stack || String(error) })}\n`).catch(() => undefined);
  await stop();
  app.exit(0);
});
