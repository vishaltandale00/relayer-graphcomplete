import { app, BrowserWindow, ipcMain } from "electron";
import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  EdgeObject,
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
import {
  closeNodeInputProofResources,
  completeNodeInputProof,
} from "./node-input-actions-proof-result.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-node-input-actions-"));
const resultFile = process.env.RELAYER_NODE_INPUT_RESULT_FILE;
const submittedTextValue = `Preserve occurrence identity: ${"full submitted text remains inspectable. ".repeat(6)}`;
let runtime;
let catalogRefreshServer;
let product;
let productSession;
let window;
let keepaliveWindow;
let completionCount = 0;
let releaseFourthCompletion;
const fourthCompletionGate = new Promise((resolveGate) => { releaseFourthCompletion = resolveGate; });

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
        if (completionCount === 4) await fourthCompletionGate;
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
      const selectionGuardNode = new NodeObject(
        "shield-check",
        "Selection guard",
        "This node has no input actions and exposes stale input repaint after a selection change.",
        "concept",
        `selection-guard-${completionCount}`,
      );
      await graph.submitNode(selectionGuardNode);
      const selectionGuardEdge = new EdgeObject(
        [node, selectionGuardNode],
        `selection-guard-edge-${completionCount}`,
      );
      await graph.createEdge(selectionGuardEdge);
      const layer = new LayerObject(
        [node, selectionGuardNode],
        [selectionGuardEdge],
        new LayerLayoutObject([
          new NodePlacementObject(node, 0.35, 0.5),
          new NodePlacementObject(selectionGuardNode, 0.65, 0.5),
        ]),
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
  const idleThread = await productRequest("/api/threads", {
    method: "POST",
    body: JSON.stringify({
      title: "Idle input actions",
      initialMessage: "Author a second deterministic input surface.",
      projectId: project.id,
      harnessId: "fixture-task-system",
      modelSelection: { familyId: family.id, providerId: "codex", modelId: "fixture-model" },
    }),
  });
  await waitForAcceptedInteractions(idleThread.id, 1);
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
      && document.querySelectorAll('.graph-node').length === 2
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
  const detailViewportBeforeAnnotation = await evaluate(`(() => {
    const detail = document.querySelector('#inspectorContent');
    detail.scrollTop = Math.min(80, detail.scrollHeight - detail.clientHeight);
    return {
      clientHeight: detail.clientHeight,
      scrollTop: detail.scrollTop,
      inputAnchorTop: document.querySelector('#nodeInputActions').getBoundingClientRect().top,
    };
  })()`);
  if (detailViewportBeforeAnnotation.scrollTop <= 0) {
    throw new Error("Node Details fixture did not provide a nonzero pre-annotation scroll position.");
  }

  await click("#attachNodeContext");
  await waitFor("annotation editor alongside node inputs", () => evaluate(`(() => (
    !document.querySelector('#nodeContextDock')?.classList.contains('hidden')
      && Boolean(document.querySelector("[aria-label='Annotation for Input grammar']"))
      && document.querySelectorAll('#nodeInputActions .node-input-editor').length === 3
  ))()`));
  const detailViewportWithAnnotation = await evaluate(`(() => {
    const detail = document.querySelector('#inspectorContent');
    return {
      clientHeight: detail.clientHeight,
      scrollTop: detail.scrollTop,
      inputAnchorTop: document.querySelector('#nodeInputActions').getBoundingClientRect().top,
    };
  })()`);
  if (Math.abs(detailViewportWithAnnotation.clientHeight - detailViewportBeforeAnnotation.clientHeight) > 1
    || Math.abs(detailViewportWithAnnotation.scrollTop - detailViewportBeforeAnnotation.scrollTop) > 1
    || Math.abs(detailViewportWithAnnotation.inputAnchorTop - detailViewportBeforeAnnotation.inputAnchorTop) > 1) {
    throw new Error(`Opening an annotation shifted the Node Details viewport: ${JSON.stringify({ detailViewportBeforeAnnotation, detailViewportWithAnnotation })}`);
  }
  const annotationScrollReach = await evaluate(`(() => {
    const detail = document.querySelector('#inspectorContent');
    const dock = document.querySelector('#nodeContextDock');
    const inspector = document.querySelector('#inspector');
    const lastInput = document.querySelector('#nodeInputActions .node-input-editor:last-child');
    const maximumScroll = detail.scrollHeight - detail.clientHeight;
    const dockBoundsBefore = dock.getBoundingClientRect();
    detail.scrollTop = detail.scrollHeight;
    const detailBounds = detail.getBoundingClientRect();
    const lastInputBounds = lastInput.getBoundingClientRect();
    const dockBoundsAfter = dock.getBoundingClientRect();
    const inspectorBounds = inspector.getBoundingClientRect();
    return {
      scrolledToBottom: maximumScroll > 1 && detail.scrollTop > 1
        && Math.abs(detail.scrollTop - maximumScroll) <= 1,
      lastInputContained: lastInputBounds.top >= detailBounds.top - 1
        && lastInputBounds.bottom <= detailBounds.bottom + 1,
      annotationContained: !dock.classList.contains('hidden')
        && dockBoundsAfter.height > 0
        && dockBoundsAfter.top >= inspectorBounds.top - 1
        && dockBoundsAfter.bottom <= inspectorBounds.bottom + 1,
      annotationStayedPut: Math.abs(dockBoundsAfter.top - dockBoundsBefore.top) <= 1
        && Math.abs(dockBoundsAfter.bottom - dockBoundsBefore.bottom) <= 1,
    };
  })()`);
  if (!annotationScrollReach.scrolledToBottom || !annotationScrollReach.lastInputContained
    || !annotationScrollReach.annotationContained || !annotationScrollReach.annotationStayedPut) {
    throw new Error(`Node Details cannot scroll fully while annotating: ${JSON.stringify(annotationScrollReach)}`);
  }
  await setValue("[aria-label='Annotation for Input grammar']", "Keep this note alongside the input actions.");
  await click("[aria-label='Confirm annotation']");
  await waitFor("confirmed annotation attached without hiding node inputs", () => evaluate(`(() => (
    Boolean(document.querySelector("[aria-label='Show Input grammar annotations']"))
      && document.querySelectorAll('#nodeInputActions .node-input-editor').length === 3
  ))()`));
  await click("[aria-label='Show Input grammar annotations']");
  await click("[aria-label='Delete annotation 1 for Input grammar']");
  await waitFor("annotation removed", () => evaluate(`(
    !document.querySelector("[aria-label='Delete annotation 1 for Input grammar']")
  )`));
  await click("[aria-label='Detach Input grammar']");
  await waitFor("temporary annotation context detached", () => evaluate(`(
    !document.querySelector("[aria-label='Show Input grammar annotations']")
  )`));

  await evaluate(`(() => {
    const option = document.querySelectorAll('.node-input-option-rail')[0].querySelector('.node-input-option');
    option.focus();
    option.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  })()`);
  await waitFor("single-select arrow keyboard selection", () => evaluate(`(() => {
    const selected = document.querySelectorAll('.node-input-option-rail')[0].querySelector('[aria-checked="true"]');
    return selected?.dataset.optionKey === 'route-2' && document.activeElement === selected;
  })()`));

  let releaseDelayedCommit;
  let delayedCommitObserved = false;
  const delayedCommitFilter = { urls: [`${productSession.origin}/api/threads/*/input-draft/attachments`] };
  window.webContents.session.webRequest.onBeforeRequest(delayedCommitFilter, (details, callback) => {
    if (!delayedCommitObserved && details.method === "PUT") {
      delayedCommitObserved = true;
      releaseDelayedCommit = () => callback({});
      return;
    }
    callback({});
  });
  await setValue(".node-input-text", "Commit while selecting another node");
  await click("[aria-label='Commit Name the governing constraint']");
  await waitFor("input commit request held in flight", () => delayedCommitObserved);
  await clickNode("Selection guard");
  releaseDelayedCommit();
  await waitFor("settled commit does not repaint the stale input node", async () => (
    (await productRequest(`/api/threads/${thread.id}/input-draft`)).attachments?.some(
      (attachment) => attachment.value?.text === "Commit while selecting another node",
    )
    && await evaluate(`(() => (
      document.querySelector('#detailTitle')?.textContent === 'Selection guard'
        && document.querySelector('#nodeInputActions')?.classList.contains('hidden')
        && document.querySelectorAll('#nodeInputActions .node-input-editor').length === 0
    ))()`)
  ));
  window.webContents.session.webRequest.onBeforeRequest(delayedCommitFilter, null);
  await clickNode("Input grammar");

  await setValue(".node-input-text", submittedTextValue);
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
      && document.querySelectorAll('.graph-node').length === 2
      && document.querySelectorAll('.composer-input-pill').length === 3
  ))()`));
  await clickNode("Input grammar");
  await waitFor("Node Details restores committed values", () => evaluate(`(() => (
    document.querySelector('.node-input-text')?.value === ${JSON.stringify(submittedTextValue)}
      && document.querySelectorAll('.node-input-option[aria-checked="true"]').length === 3
  ))()`));
  await click(".composer-input-pill");
  await waitFor("explicit composer input inspection", () => evaluate(`Boolean(document.querySelector('.composer-input-preview'))`));
  await click("[aria-label='Close Name the governing constraint input details']");
  await setValue(".node-input-text", "Local replacement");
  await click("[aria-label='Undo Name the governing constraint']");
  const undone = await evaluate(`document.querySelector('.node-input-text')?.value`);
  if (undone !== submittedTextValue) throw new Error(`Undo did not restore committed text: ${JSON.stringify(undone)}`);

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
  if (afterRejectedCommit.attachments.find((item) => item.action.prompt === "Name the governing constraint")?.value?.text !== submittedTextValue) {
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

  let pendingThreadSendHeld = false;
  let cancelPendingThreadSend;
  const pendingThreadSendFilter = {
    urls: [`${productSession.origin}/api/threads/${thread.id}/interactions`],
  };
  window.webContents.session.webRequest.onBeforeRequest(
    pendingThreadSendFilter,
    (details, callback) => {
      if (!pendingThreadSendHeld && details.method === "POST") {
        pendingThreadSendHeld = true;
        cancelPendingThreadSend = () => callback({ cancel: true });
        return;
      }
      callback({});
    },
  );
  await setValue("#threadPrompt", "Hold the owning thread Send while editing another thread.");
  await click("#sendInteraction");
  await waitFor("thread A Send held in flight", () => pendingThreadSendHeld);
  await click(`[data-thread='${idleThread.id}']`);
  await waitFor("idle thread B remains composable while A Send is pending", () => evaluate(`(() => (
    document.querySelector("[data-thread='${idleThread.id}']")?.classList.contains('active')
      && document.querySelectorAll('.graph-node').length === 2
      && document.querySelector('#threadPrompt')?.disabled === false
  ))()`));
  await clickNode("Input grammar");
  await click("#attachNodeContext");
  await waitFor("thread B context staging remains usable", () => evaluate(`Boolean(
    document.querySelector("[aria-label='Annotation for Input grammar']")
  )`));
  await click("[aria-label='Discard annotation draft for Input grammar']");
  await waitFor("thread B context draft discarded", () => evaluate(`(
    !document.querySelector("[aria-label='Annotation for Input grammar']")
  )`));
  await setValue(".node-input-text", "Thread B remains independently editable.");
  await waitFor("thread B input commit remains enabled", () => evaluate(`(
    document.querySelector("[aria-label='Commit Name the governing constraint']")?.disabled === false
  )`));
  await click("[aria-label='Commit Name the governing constraint']");
  await waitFor("thread B input committed", async () => (
    (await productRequest(`/api/threads/${idleThread.id}/input-draft`)).attachments?.some(
      (attachment) => attachment.value?.text === "Thread B remains independently editable.",
    )
  ));
  await click("[aria-label='Detach Name the governing constraint']");
  await waitFor("thread B input detached", async () => (
    (await productRequest(`/api/threads/${idleThread.id}/input-draft`)).attachments?.length === 0
  ));

  await click(`[data-thread='${thread.id}']`);
  await waitFor("pending thread A restored", () => evaluate(`(() => (
    document.querySelector("[data-thread='${thread.id}']")?.classList.contains('active')
      && document.querySelectorAll('.graph-node').length === 2
  ))()`));
  await clickNode("Input grammar");
  await waitFor("pending thread A input staging remains locked", () => evaluate(`(() => {
    const controls = [...document.querySelectorAll('#nodeInputActions button, #nodeInputActions textarea')];
    return controls.length > 0 && controls.every((control) => control.disabled);
  })()`));
  await evaluate(`document.querySelector('#attachNodeContext')?.click()`);
  await waitForPaint();
  if (await evaluate(`Boolean(document.querySelector("[aria-label='Annotation for Input grammar']"))`)) {
    throw new Error("Pending thread A opened context staging while its Send was in flight.");
  }
  cancelPendingThreadSend();
  window.webContents.session.webRequest.onBeforeRequest(pendingThreadSendFilter, null);
  await waitFor("thread A staging unlocks after its Send settles", () => evaluate(`(() => (
    document.querySelector('.node-input-text')?.disabled === false
      && document.querySelector("[aria-label='Detach Name the governing constraint']")?.disabled === false
      && document.querySelector('#threadPrompt')?.disabled === false
  ))()`));

  await click("#attachNodeContext");
  await waitFor("replay snapshot annotation editor", () => evaluate(`Boolean(
    document.querySelector("[aria-label='Annotation for Input grammar']")
  )`));
  await setValue(
    "[aria-label='Annotation for Input grammar']",
    "Preserve this click-time context through reconciliation.",
  );
  await click("[aria-label='Confirm annotation']");
  await waitFor("replay snapshot context confirmed", () => evaluate(`(
    document.querySelectorAll('.composer-context-pill:not(.composer-input-pill)').length === 1
  )`));
  await setValue("#threadPrompt", "Preserve this click-time prompt through reconciliation.");
  const draftAtClick = await productRequest(`/api/threads/${thread.id}/input-draft`);

  await evaluate(`(() => {
    const originalFetch = window.fetch.bind(window);
    window.__nodeInputInteractionAttempts = [];
    window.__nodeInputLoseNextInteraction = true;
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = init.method || (typeof input === 'object' ? input.method : 'GET') || 'GET';
      if (method === 'POST' && new URL(url, location.href).pathname.endsWith('/interactions')) {
        window.__nodeInputInteractionAttempts.push(JSON.parse(init.body));
        if (window.__nodeInputLoseNextInteraction) {
          window.__nodeInputLoseNextInteraction = false;
          await originalFetch(input, init);
          throw new TypeError('Injected lost interaction response');
        }
      }
      return originalFetch(input, init);
    };
  })()`);
  let reconciliationHeld = false;
  let releaseReconciliation;
  const reconciliationFilter = { urls: [`${productSession.origin}/api/threads/*/input-draft`] };
  window.webContents.session.webRequest.onBeforeRequest(reconciliationFilter, (details, callback) => {
    if (!reconciliationHeld && details.method === "GET") {
      reconciliationHeld = true;
      releaseReconciliation = () => callback({});
      return;
    }
    callback({});
  });

  await click("#sendInteraction");
  await waitFor("ambiguous Send queues forced input reconciliation", async () => (
    reconciliationHeld
      && await evaluate(`(
        window.__nodeInputInteractionAttempts.length === 1
          && document.querySelector('#sendInteraction')?.disabled === true
      )`)
  ));
  await evaluate(`document.querySelector('#sendInteraction').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await waitForPaint();
  const prematureAttempts = await evaluate(`window.__nodeInputInteractionAttempts.length`);
  const prematureThread = await productRequest(`/api/threads/${thread.id}`);
  if (prematureAttempts !== 1 || prematureThread.interactions.length !== 2
    || prematureThread.interactions.at(-1)?.submittedInputs?.length !== 3) {
    throw new Error(`Send escaped pending input reconciliation: ${JSON.stringify({ prematureAttempts, interactions: prematureThread.interactions.length, latest: prematureThread.interactions.at(-1) })}`);
  }

  const draftBeforeReconciliation = await productRequest(`/api/threads/${thread.id}/input-draft`);
  const committedForReconciliation = draftAtClick.attachments.find(
    (attachment) => attachment.action.prompt === "Name the governing constraint",
  );
  const detachedForReconciliation = draftAtClick.attachments.find(
    (attachment) => attachment.action.prompt === "Choose supporting evidence",
  );
  const committedDraft = await productRequest(
    `/api/threads/${thread.id}/input-draft/attachments`,
    {
      method: "PUT",
      body: JSON.stringify({
        occurrence: committedForReconciliation.occurrence,
        value: committedForReconciliation.value,
        expectedRevision: draftBeforeReconciliation.revision,
      }),
    },
  );
  const detachableDraft = await productRequest(
    `/api/threads/${thread.id}/input-draft/attachments`,
    {
      method: "PUT",
      body: JSON.stringify({
        occurrence: detachedForReconciliation.occurrence,
        value: detachedForReconciliation.value,
        expectedRevision: committedDraft.revision,
      }),
    },
  );
  const detachedOccurrence = detachedForReconciliation.occurrence;
  let reconciledDraft = await productRequest(
    `/api/threads/${thread.id}/input-draft/attachments/${encodeURIComponent(detachedOccurrence.presentingInteractionNodeId)}/${encodeURIComponent(detachedOccurrence.presentingLayerId)}/${encodeURIComponent(detachedOccurrence.actionId)}?expectedRevision=${encodeURIComponent(detachableDraft.revision)}`,
    { method: "DELETE" },
  );
  releaseReconciliation();
  await waitFor("advanced input revision adopted before retry", async () => {
    const authoritative = await productRequest(`/api/threads/${thread.id}/input-draft`);
    return authoritative.revision === reconciledDraft.revision
      && await evaluate(`document.querySelector('#sendInteraction')?.disabled === false`);
  });
  const revisionBeforeUiMutation = reconciledDraft.revision;
  await click("[aria-label='Detach Name the governing constraint']");
  reconciledDraft = await waitFor("UI detach advances reconciled input composition", async () => {
    const draft = await productRequest(`/api/threads/${thread.id}/input-draft`);
    return draft.revision > revisionBeforeUiMutation
      && !draft.attachments.some((attachment) => (
        attachment.action.prompt === "Name the governing constraint"
      ))
      ? draft
      : false;
  });
  await setValue(".node-input-text", submittedTextValue);
  await waitFor("UI commit ready after response-loss reconciliation", () => evaluate(`(
    document.querySelector("[aria-label='Commit Name the governing constraint']")?.disabled === false
  )`));
  await click("[aria-label='Commit Name the governing constraint']");
  const revisionBeforeUiCommit = reconciledDraft.revision;
  reconciledDraft = await waitFor("UI commit advances reconciled input composition", async () => {
    const draft = await productRequest(`/api/threads/${thread.id}/input-draft`);
    return draft.revision > revisionBeforeUiCommit
      && draft.attachments.some((attachment) => (
        attachment.action.prompt === "Name the governing constraint"
          && attachment.value?.text === submittedTextValue
      ))
      ? draft
      : false;
  });

  await click("#sendInteraction");
  await waitFor("retry request dispatched", () => evaluate(`window.__nodeInputInteractionAttempts.length === 2`));
  const [originalAttempt, retryAttempt] = await evaluate(`window.__nodeInputInteractionAttempts`);
  const retryPreservedSnapshot = originalAttempt.text
      === "Preserve this click-time prompt through reconciliation."
    && originalAttempt.inputDraftRevision === draftAtClick.revision
    && originalAttempt.contexts?.[0]?.annotations?.[0]
      === "Preserve this click-time context through reconciliation."
    && originalAttempt.contextConfirmationIds?.length === 1
    && originalAttempt.modelSelection?.providerId === "codex"
    && originalAttempt.modelSelection?.modelId === "fixture-model"
    && retryAttempt.inputId !== originalAttempt.inputId
    && retryAttempt.text === originalAttempt.text
    && retryAttempt.inputDraftRevision === reconciledDraft.revision
    && retryAttempt.contexts?.[0]?.annotations?.[0]
      === originalAttempt.contexts[0].annotations[0]
    && retryAttempt.contextConfirmationIds?.length === 0
    && retryAttempt.modelSelection?.providerId === originalAttempt.modelSelection.providerId
    && retryAttempt.modelSelection?.modelId === originalAttempt.modelSelection.modelId;
  if (!retryPreservedSnapshot) {
    releaseFourthCompletion();
    throw new Error(`Post-commit response-loss retry did not rotate identity and preserve the click-time snapshot: ${JSON.stringify({ originalAttempt, retryAttempt, reconciledRevision: reconciledDraft.revision })}`);
  }
  window.webContents.session.webRequest.onBeforeRequest(reconciliationFilter, null);

  await waitFor("input controls locked during send", () => evaluate(`(() => (
    document.querySelectorAll('#nodeInputActions button:not(:disabled), #nodeInputActions textarea:not(:disabled)').length === 0
  ))()`));
  releaseFourthCompletion();
  const acceptedThread = await waitForAcceptedInteractions(thread.id, 3);
  await waitFor("submitted inputs rendered read-only", () => evaluate(`(() => (
    document.querySelectorAll('#interactionInputHistory .interaction-input-history-item').length === 1
      && document.querySelectorAll('.composer-input-pill').length === 0
  ))()`));
  const historyDisclosure = await evaluate(`(() => {
    const details = document.querySelector('#interactionInputHistory .interaction-input-history-disclosure');
    const summary = details?.querySelector('summary');
    const full = details?.querySelector('p');
    return {
      tagName: details?.tagName,
      open: details?.open,
      summaryTagName: summary?.tagName,
      summaryText: summary?.textContent,
      summaryName: summary?.getAttribute('aria-label'),
      summaryWidth: summary?.getBoundingClientRect().width,
      fullValue: full?.textContent,
    };
  })()`);
  if (historyDisclosure.tagName !== "DETAILS"
    || historyDisclosure.summaryTagName !== "SUMMARY"
    || historyDisclosure.open !== false
    || [...historyDisclosure.summaryText].length !== 80
    || historyDisclosure.summaryWidth > 241
    || historyDisclosure.summaryName !== "Show full submitted value for Name the governing constraint"
    || historyDisclosure.fullValue !== submittedTextValue) {
    throw new Error(`Submitted text history disclosure is invalid: ${JSON.stringify(historyDisclosure)}`);
  }
  await evaluate(`document.querySelector('#interactionInputHistory .interaction-input-history-disclosure>summary').click()`);
  await waitFor("submitted text history opens through native summary activation", () => evaluate(`(
    document.querySelector('#interactionInputHistory .interaction-input-history-disclosure')?.open === true
  )`));

  const authoredTurnId = acceptedThread.interactions[0].id;
  await window.loadURL(`${productSession.origin}/?threadId=${encodeURIComponent(thread.id)}&interactionId=${encodeURIComponent(authoredTurnId)}&review=1`);
  await waitFor("read-only review workspace", () => evaluate(`(() => (
    !document.body.classList.contains('desktop-account-pending')
      && document.querySelectorAll('.graph-node').length === 2
  ))()`));
  await clickNode("Input grammar");
  await waitFor("accepted input controls render without mutation authority", () => evaluate(`(() => {
    const editors = [...document.querySelectorAll('#nodeInputActions .node-input-editor')];
    const controls = editors.flatMap((editor) => [...editor.querySelectorAll('button, textarea')]);
    return editors.length === 3
      && controls.length > 0
      && controls.every((control) => control.disabled)
      && !document.querySelector('.node-input-operator-send');
  })()`));

  await window.loadURL(`${productSession.origin}/?threadId=${encodeURIComponent(thread.id)}&interactionId=${encodeURIComponent(authoredTurnId)}&review=1&inputOperator=1`);
  await waitFor("operator-capable review workspace", () => evaluate(`(() => (
    !document.body.classList.contains('desktop-account-pending')
      && document.querySelectorAll('.graph-node').length === 2
  ))()`));
  await clickNode("Input grammar");
  await waitFor("operator Send starts disabled while accepted inputs remain read-only", () => evaluate(`(() => {
    const send = document.querySelector('.node-input-operator-send');
    const controls = [...document.querySelectorAll('#nodeInputActions .node-input-editor button, #nodeInputActions .node-input-editor textarea')];
    return Boolean(send?.disabled) && controls.length > 0 && controls.every((control) => control.disabled);
  })()`));
  process.stdout.write("Node-input Electron proof passed with 0 paid inference calls.\n");
}

async function stop() {
  const failures = [];
  releaseFourthCompletion();
  try {
    if (window && !window.isDestroyed()) window.destroy();
  } catch (error) {
    failures.push(error);
  }
  try {
    await closeNodeInputProofResources([
      { name: "product", close: async () => { if (product) await product.close(); } },
      { name: "catalog", close: async () => { if (catalogRefreshServer) await catalogRefreshServer.close(); } },
      { name: "runtime", close: async () => { if (runtime) await runtime.close(); } },
    ]);
  } catch (error) {
    failures.push(error);
  }
  try {
    for (const channel of ["relayer:account-read", "relayer:appearance-read", "relayer:update-status", "relayer:folder-choose", "relayer:tutorial-read", "relayer:provider-status"]) ipcMain.removeHandler(channel);
  } catch (error) {
    failures.push(error);
  }
  try {
    await rm(dataDirectory, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw new AggregateError(failures, "Node-input Electron proof reset failed.");
}

app.whenReady().then(() => completeNodeInputProof({
  runScenario: run,
  cleanup: stop,
  recordResult: async (result) => {
    if (resultFile) await writeFile(resultFile, `${JSON.stringify(result)}\n`);
  },
})).then(({ result, exitCode }) => {
  if (!result.passed) console.error(result.error);
  if (keepaliveWindow && !keepaliveWindow.isDestroyed()) keepaliveWindow.destroy();
  app.exit(exitCode);
}).catch(async (error) => {
  console.error(error);
  if (resultFile) {
    await writeFile(resultFile, `${JSON.stringify({ passed: false, error: error?.stack || String(error) })}\n`)
      .catch(() => undefined);
  }
  if (keepaliveWindow && !keepaliveWindow.isDestroyed()) keepaliveWindow.destroy();
  app.exit(1);
});
