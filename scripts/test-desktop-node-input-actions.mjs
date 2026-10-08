import { createSettingsStore } from "../desktop/main/services/settings-store.mjs";
import { registerComposerDraftIpc, registerLayerSelectionIpc, registerWorkspaceLayoutIpc } from "../desktop/main/ipc/register-ipc.mjs";
import { app, BrowserWindow, ipcMain } from "electron";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
        "These authored inputs belong directly to this Node Details page.\n\n" + "Review the governing constraint, primary route, and supporting evidence before sending the answers.\n\n".repeat(8),
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
      const navigationNode = new NodeObject(
        "route",
        "Navigation destination",
        "Opening this accepted child layer preserves pending input answers in this workspace.",
        "concept",
        `navigation-destination-${completionCount}`,
      );
      await graph.submitNode(navigationNode);
      const navigationLayer = new LayerObject(
        [navigationNode],
        [],
        new LayerLayoutObject([
          new NodePlacementObject(navigationNode, 0.5, 0.5),
        ], "default"),
        `navigation-layer-${completionCount}`,
        navigationNode,
      );
      await graph.submitLayer(navigationLayer);
      const layer = new LayerObject(
        [node, selectionGuardNode],
        [selectionGuardEdge],
        new LayerLayoutObject([
          new NodePlacementObject(node, 0.35, 0.5),
          new NodePlacementObject(selectionGuardNode, 0.65, 0.5),
        ], "default"),
        `input-layer-${completionCount}`,
        selectionGuardNode,
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
      await graph.addAction(node, {
        kind: "navigate",
        relation: "expand",
        sourceLayer: layer,
        label: "Open navigation destination",
        target: navigationLayer,
        clientKey: `navigate-away-${completionCount}`,
      });
      await graph.addAction(interaction.id, {
        kind: "navigate",
        relation: "expand",
        label: "Response",
        target: layer,
        clientKey: `response-${completionCount}`,
      });
      const contract = await graph.getContract();
      for (const requirement of contract?.returnRequirements ?? []) {
        if (requirement.kind === "navigate.response") await graph.addAction(requirement.nodeId, {
          kind: "navigate", relation: "reference", label: "See the new response", target: layer,
          clientKey: `attached-response-${interaction.id}-${requirement.nodeId}`,
        });
      }
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
  const settings = createSettingsStore(dataDirectory);
  registerComposerDraftIpc({ ipcMain, settings });
  registerLayerSelectionIpc({ ipcMain, settings });
  registerWorkspaceLayoutIpc({ ipcMain, settings });
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
  catalogRefreshServer = await startModelCatalogRefreshServer({ refresh: () => product.seedProviderCatalog(catalogSnapshot) });
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
  await product.seedProviderCatalog(catalogSnapshot);
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
    openExternal: async () => undefined,
    onWindowCreated: (created) => {
      const contents = created.webContents;
      let navigation = 0;
      const diagnostic = (kind, details = {}) => process.stderr.write(`${JSON.stringify({
        fixture: "node-input", diagnostic: kind, navigation,
        time: new Date().toISOString(),
        url: contents.isDestroyed() ? null : contents.getURL(), ...details,
      })}\n`);
      contents.on("did-start-navigation", (_event, url, inPlace, isMainFrame) => {
        if (isMainFrame) { navigation += 1; diagnostic("navigation-start", { target: url, inPlace }); }
      });
      contents.on("did-navigate", (_event, url, httpResponseCode, httpStatusText) => {
        diagnostic("navigation-committed", { target: url, httpResponseCode, httpStatusText });
      });
      contents.on("console-message", (event, level, message, line, sourceId) => {
        // Electron's current event contains structured details; the positional
        // arguments retain compatibility with older verified desktop runtimes.
        const record = typeof level === "number" ? { level, message, line, sourceId }
          : { level: event.level, message: event.message, line: event.lineNumber, sourceId: event.sourceId };
        if (record.level === "error" || record.level === "warning" || record.level >= 2) diagnostic("renderer-console", record);
      });
      contents.on("did-fail-load", (_event, code, description, validatedURL, isMainFrame) => {
        diagnostic("load-failed", { code, description, validatedURL, isMainFrame });
      });
      contents.on("render-process-gone", (_event, details) => diagnostic("renderer-process-gone", details));
      contents.on("unresponsive", () => diagnostic("renderer-unresponsive"));
      contents.on("did-finish-load", () => {
        diagnostic("load-finished");
        void contents.executeJavaScript(`({ readyState: document.readyState, title: document.title,
          bodyChildren: document.body?.children.length, bodyLength: document.body?.innerHTML.length,
          scriptSources: [...document.scripts].map(script => script.src) })`)
          .then(state => diagnostic("loaded-document", state), error => diagnostic("document-probe-failed", { error: String(error) }));
      });
    },
  });
  window = await createWindow(productSession);
  const nativeMinimumSize = window.getMinimumSize();
  if (nativeMinimumSize[0] !== 375 || nativeMinimumSize[1] !== 640) {
    throw new Error(`Node input layout proof must use the production 375×640 native minimum: ${JSON.stringify(nativeMinimumSize)}`);
  }
  window.setSize(1280, 820);
  let initialDraftLoadRequests = 0;
  const initialDraftLoadFilter = {
    urls: [`${productSession.origin}/api/threads/${thread.id}/input-draft`],
  };
  window.webContents.session.webRequest.onBeforeRequest(
    initialDraftLoadFilter,
    (details, callback) => {
      if (details.method !== "GET") return callback({});
      initialDraftLoadRequests += 1;
      callback(initialDraftLoadRequests <= 6 ? { cancel: true } : {});
    },
  );
  await window.loadURL(`${productSession.origin}/?threadId=${thread.id}`);
  await waitFor("production node-input workspace", () => evaluate(`(() => (
    !document.body.classList.contains('desktop-account-pending')
      && document.querySelectorAll('.graph-node').length === 2
  ))()`));
  await waitFor("agent-chosen second node opens automatically", () => evaluate(`(
    document.querySelector('#detailTitle')?.textContent === 'Selection guard'
      && !document.querySelector('#inspector')?.classList.contains('hidden')
  )`));
  await clickNode("Input grammar");
  await waitFor("initial input-draft GET and five retries exhaust", () => (
    initialDraftLoadRequests === 6
  ));
  await new Promise((resolve) => setTimeout(resolve, 5_250));
  if (initialDraftLoadRequests !== 6) {
    throw new Error(`Exhausted input-draft retry cycle issued another GET: ${initialDraftLoadRequests}`);
  }
  await waitFor("exhausted input authority keeps composition locked", () => evaluate(`(() => (
    document.querySelector('#nodeInputActions .node-input-status')?.textContent === 'Loading committed inputs…'
      && document.querySelector('#sendInteraction')?.disabled === true
  ))()`));
  await click(`[data-thread='${idleThread.id}']`);
  await waitFor("leaves exhausted input-draft eligibility", () => evaluate(`(
    document.querySelector("[data-thread='${idleThread.id}']")?.classList.contains('active')
  )`));
  await click(`[data-thread='${thread.id}']`);
  await waitFor("seventh input-draft GET succeeds after re-entering eligibility", () => (
    initialDraftLoadRequests === 7
  ));
  await clickNode("Input grammar");
  await waitFor("authoritative input draft restores controls", () => evaluate(`(() => (
    document.querySelector("[data-thread='${thread.id}']")?.classList.contains('active')
      && document.querySelectorAll('#nodeInputActions .node-input-editor').length === 3
      && document.querySelectorAll('#nodeInputActions .node-input-option-rail').length === 2
      && document.querySelector('#detailActions .action-control')?.textContent.includes('Open navigation destination')
      && !document.querySelector('#threadPrompt')?.disabled
  ))()`));
  window.webContents.session.webRequest.onBeforeRequest(initialDraftLoadFilter, null);
  await setValue(".node-input-text", "Recovered after initial draft load retry");
  await waitFor("recovered authority accepts the current stage without confirmation", () => evaluate("!document.querySelector('#sendInteraction').disabled"));
  const grammar = await evaluate(`(() => ({
    attachedToDetails: document.querySelector('#inspectorContent')?.contains(document.querySelector('#nodeInputActions')),
    prompts: [...document.querySelectorAll('.node-input-editor legend')].map((item) => item.textContent),
    symbols: [...document.querySelectorAll('.node-input-symbol')].map((button) => ({ text: button.textContent, label: button.getAttribute('aria-label'), width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
    forbiddenCopy: document.body.innerText.includes('Not attached to the composer'),
  }))()`);
  if (!grammar.attachedToDetails || grammar.prompts.length !== 3 || grammar.forbiddenCopy
    || grammar.symbols.some(({ text, label, width, height }) => text !== "↶" || !label || width > 30 || height > 30)) {
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

  if (process.env.RELAYER_NODE_DETAIL_EVIDENCE_DIR) {
    await mkdir(process.env.RELAYER_NODE_DETAIL_EVIDENCE_DIR, { recursive: true });
    window.showInactive();
    await waitForPaint();
    await writeFile(join(process.env.RELAYER_NODE_DETAIL_EVIDENCE_DIR, "node-detail-full-pane.png"), (await window.webContents.capturePage()).toPNG());
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
  if (process.env.RELAYER_NODE_DETAIL_EVIDENCE_DIR) {
    await waitForPaint();
    await writeFile(join(process.env.RELAYER_NODE_DETAIL_EVIDENCE_DIR, "node-detail-annotation-overlay.png"), (await window.webContents.capturePage()).toPNG());
  }
  const readSidebarGeometry = () => evaluate(`(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    const sidebar = box('.sidebar');
    const inspector = box('#inspector');
    const graph = box('#graphStage');
    const dock = box('#nodeContextDock');
    const environment = box('.environment-panel');
    const turn = box('.interaction-banner');
    const heading = box('.thread-header');
    const workspace = box('.workspace-layout');
    const logo = box('.sidebar-title .brand-lockup');
    const newThread = box('#newThread');
    const plus = box('#newThread span');
    return { sidebarWidth: sidebar.width, detailWidth: inspector.width, graphWidth: graph.width,
      environmentWidth: environment.width, turnWidth: turn.width,
      sidebarIconsCentered: Math.abs(logo.left + logo.width / 2 - sidebar.left - sidebar.width / 2) <= 1
        && Math.abs(plus.left + plus.width / 2 - newThread.left - newThread.width / 2) <= 1,
      headingWidth: heading.width, detailTop: inspector.top, detailBottom: inspector.bottom,
      collapsedStructure: environment.width === 0 && environment.height === 0
        && Math.abs(turn.left - graph.left) <= 1 && Math.abs(turn.right - graph.right) <= 1
        && Math.abs(heading.left - graph.left) <= 1 && Math.abs(heading.right - inspector.right) <= 1
        && Math.abs(inspector.top - turn.top) <= 1 && inspector.top >= heading.bottom
        && Math.abs(inspector.bottom - workspace.bottom) <= 1,
      overlayContained: dock.left >= inspector.left && dock.right <= inspector.right,
      pageFits: document.documentElement.scrollWidth <= innerWidth };
  })()`);
  const expandedSidebarGeometry = await readSidebarGeometry();
  await click('#collapseSidebar');
  await waitForPaint();
  const collapsedSidebarGeometry = await readSidebarGeometry();
  const freedSidebarWidth = expandedSidebarGeometry.sidebarWidth - collapsedSidebarGeometry.sidebarWidth;
  if (freedSidebarWidth <= 0
    || Math.abs(collapsedSidebarGeometry.detailWidth - collapsedSidebarGeometry.graphWidth) > 1
    || !collapsedSidebarGeometry.collapsedStructure || !collapsedSidebarGeometry.sidebarIconsCentered
    || !collapsedSidebarGeometry.overlayContained || !collapsedSidebarGeometry.pageFits) {
    throw new Error(`Sidebar collapse did not create the full-height detail layout: ${JSON.stringify({ expandedSidebarGeometry, collapsedSidebarGeometry })}`);
  }
  await evaluate("document.querySelector('#newThread').focus()");
  if (!(await readSidebarGeometry()).sidebarIconsCentered) throw new Error('Collapsed sidebar icons shift on keyboard focus.');
  await evaluate("document.querySelector('#newThread').blur()");
  if (process.env.RELAYER_NODE_DETAIL_EVIDENCE_DIR) {
    await writeFile(join(process.env.RELAYER_NODE_DETAIL_EVIDENCE_DIR, "node-detail-sidebar-collapsed.png"), (await window.webContents.capturePage()).toPNG());
  }
  // Exercise the production narrow layout at 720px without overriding the native minimum.
  window.setSize(720, 820);
  const readNarrowEnvironmentAndSidebar = () => evaluate(`(() => {
    const box = (element) => element.getBoundingClientRect();
    const sidebar = box(document.querySelector('.sidebar'));
    const toggleElement = document.querySelector('#collapseSidebar');
    const toggle = box(toggleElement);
    const environmentElement = document.querySelector('.environment-panel');
    const environment = box(environmentElement);
    const titleElement = document.querySelector('#environmentTitle');
    const title = box(titleElement);
    const facts = document.querySelector('#environmentFacts');
    const message = document.querySelector('#environmentMessage');
    const visible = (element) => Boolean(element?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    const settledEnvironment = (visible(facts) && [...facts.querySelectorAll('dd')]
      .some((value) => value.textContent.trim().length > 0))
      || (visible(message) && message.textContent.trim().length > 0);
    return {
      width: innerWidth,
      collapsed: document.body.classList.contains('sidebar-collapsed'),
      sidebar: { left: sidebar.left, right: sidebar.right, width: sidebar.width },
      toggle: { left: toggle.left, right: toggle.right, top: toggle.top, bottom: toggle.bottom, width: toggle.width, height: toggle.height },
      toggleVisible: visible(toggleElement),
      ariaExpanded: toggleElement.getAttribute('aria-expanded'),
      environment: { left: environment.left, right: environment.right, top: environment.top, bottom: environment.bottom, width: environment.width, height: environment.height },
      environmentVisible: visible(environmentElement),
      inspectorVisible: visible(document.querySelector('#inspector')),
      environmentToggleVisible: visible(document.querySelector('#environmentToggle')),
      title: { left: title.left, right: title.right, top: title.top, bottom: title.bottom, width: title.width, height: title.height },
      titleVisible: visible(titleElement),
      environmentReady: document.querySelector('#environmentBody').getAttribute('aria-busy') === 'false' && settledEnvironment,
      pageFits: document.documentElement.scrollWidth <= innerWidth,
    };
  })()`);
  const narrowDefault = await waitFor("Environment stays hidden at 720px", async () => {
    const value = await readNarrowEnvironmentAndSidebar();
    return value.width === 720 && !value.environmentVisible ? value : false;
  });
  if (!narrowDefault.environmentToggleVisible || !narrowDefault.inspectorVisible) {
    throw new Error(`Environment control or selected details disappeared at 720px: ${JSON.stringify(narrowDefault)}`);
  }
  await click('#environmentToggle');
  const narrowCollapsed = await waitFor("requested Environment and collapsed rail at 720px", async () => {
    const value = await readNarrowEnvironmentAndSidebar();
    return value.width === 720 && value.collapsed && value.sidebar.width === 58
      && value.ariaExpanded === 'false' && value.environmentReady ? value : false;
  });
  const isContainedInViewport = (rect, width, height) => rect.left >= -0.5 && rect.top >= -0.5
    && rect.right <= width + 0.5 && rect.bottom <= height + 0.5 && rect.width > 0 && rect.height > 0;
  if (!narrowCollapsed.toggleVisible || !isContainedInViewport(narrowCollapsed.toggle, 720, 820)
    || narrowCollapsed.toggle.left < narrowCollapsed.sidebar.left
    || narrowCollapsed.toggle.right > narrowCollapsed.sidebar.right + 0.5
    || !narrowCollapsed.environmentVisible || !narrowCollapsed.titleVisible
    || !isContainedInViewport(narrowCollapsed.environment, 720, 820)
    || !isContainedInViewport(narrowCollapsed.title, 720, 820)
    || !narrowCollapsed.pageFits) {
    throw new Error(`The persistent 720px sidebar rail or Environment is not fully reachable: ${JSON.stringify(narrowCollapsed)}`);
  }
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  const afterEnvironmentEscape = await readNarrowEnvironmentAndSidebar();
  if (afterEnvironmentEscape.environmentVisible || !afterEnvironmentEscape.inspectorVisible) {
    throw new Error(`Escape must dismiss Environment while preserving details: ${JSON.stringify(afterEnvironmentEscape)}`);
  }
  await click('#collapseSidebar');
  await click('#environmentToggle');
  const narrowExpanded = await waitFor("sidebar expands in normal flow at 720px", async () => {
    const value = await readNarrowEnvironmentAndSidebar();
    return !value.collapsed && value.sidebar.width >= 209 && value.ariaExpanded === 'true'
      && value.environmentReady ? value : false;
  });
  if (!narrowExpanded.toggleVisible || narrowExpanded.sidebar.left !== 0
    || !isContainedInViewport(narrowExpanded.toggle, 720, 820)
    || narrowExpanded.toggle.right > narrowExpanded.sidebar.right + 0.5
    || !narrowExpanded.environmentVisible || !narrowExpanded.titleVisible
    || !isContainedInViewport(narrowExpanded.environment, 720, 820)
    || !isContainedInViewport(narrowExpanded.title, 720, 820)
    || !narrowExpanded.pageFits) {
    throw new Error(`The expanded 720px sidebar displaced or clipped Environment: ${JSON.stringify(narrowExpanded)}`);
  }
  await click('#closeEnvironment');
  const afterEnvironmentClose = await readNarrowEnvironmentAndSidebar();
  if (afterEnvironmentClose.environmentVisible || !afterEnvironmentClose.inspectorVisible) {
    throw new Error(`Closing Environment must preserve details: ${JSON.stringify(afterEnvironmentClose)}`);
  }
  await click('#collapseSidebar');
  await waitFor("persistent rail collapses again at 720px", async () => {
    const value = await readNarrowEnvironmentAndSidebar();
    return value.collapsed && value.sidebar.width === 58 && value.ariaExpanded === 'false';
  });
  window.setSize(1280, 820);
  await waitFor("collapsed desktop layout returns after resizing", async () => (await readSidebarGeometry()).collapsedStructure);
  await click('#collapseSidebar');
  await waitForPaint();
  const restoredSidebarGeometry = await readSidebarGeometry();
  if (Math.abs(restoredSidebarGeometry.detailWidth - expandedSidebarGeometry.detailWidth) > 1
    || Math.abs(restoredSidebarGeometry.graphWidth - expandedSidebarGeometry.graphWidth) > 1
    || Math.abs(restoredSidebarGeometry.environmentWidth - expandedSidebarGeometry.environmentWidth) > 1
    || Math.abs(restoredSidebarGeometry.turnWidth - expandedSidebarGeometry.turnWidth) > 1
    || Math.abs(restoredSidebarGeometry.headingWidth - expandedSidebarGeometry.headingWidth) > 1
    || Math.abs(restoredSidebarGeometry.detailTop - expandedSidebarGeometry.detailTop) > 1) {
    throw new Error(`Expanding the sidebar did not restore pane widths: ${JSON.stringify({ expandedSidebarGeometry, restoredSidebarGeometry })}`);
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
        && lastInputBounds.bottom <= dockBoundsAfter.top - 1,
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
  const reviewCaptureScroll = await evaluate(`(async () => {
    const { createReviewPresentationAdapter } = await import('./src/review-tools.js');
    const detail = document.querySelector('#inspectorContent');
    const lastInput = document.querySelector('#nodeInputActions .node-input-editor:last-child');
    const maximumScroll = detail.scrollHeight - detail.clientHeight;
    detail.scrollTop = Math.min(47, maximumScroll);
    const originalScrollTop = detail.scrollTop;
    const adapter = createReviewPresentationAdapter({
      executionId: 'real-electron-node-input-capture',
      getPresentationState: () => ({
        threadId: '${thread.id}',
        turnId: 'accepted-input-turn',
        layerId: 'input-layer',
        selectedNodeId: 'input-grammar',
        navigationPath: [{ layerId: 'input-layer', viaActionId: null }],
      }),
      navigateHistory: async () => {},
    });
    const plan = await adapter.capturePlan({
      target: { kind: 'element', elementRef: 'node-detail' },
      mode: 'full',
    });
    const lastTile = plan.tiles.at(-1);
    await adapter.prepareCaptureTile(lastTile);
    const detailBounds = detail.getBoundingClientRect();
    const lastInputBounds = lastInput.getBoundingClientRect();
    const lowerSentinelVisible = lastInputBounds.top >= detailBounds.top - 1
      && lastInputBounds.bottom <= detailBounds.bottom + 1;
    const preparedScrollTop = detail.scrollTop;
    await adapter.restoreCapture();
    return {
      captureOwnerId: document.querySelector('[data-review-capture="node-detail"]')?.id,
      tileCount: plan.tiles.length,
      lastTileScrollY: lastTile.scrollY,
      preparedScrollTop,
      lowerSentinelVisible,
      originalScrollTop,
      restoredScrollTop: detail.scrollTop,
    };
  })()`);
  if (reviewCaptureScroll.captureOwnerId !== "inspectorContent"
    || reviewCaptureScroll.tileCount < 2
    || reviewCaptureScroll.lastTileScrollY <= 0
    || reviewCaptureScroll.preparedScrollTop <= reviewCaptureScroll.originalScrollTop
    || !reviewCaptureScroll.lowerSentinelVisible
    || Math.abs(reviewCaptureScroll.restoredScrollTop - reviewCaptureScroll.originalScrollTop) > 1) {
    throw new Error(`Full Node Details review capture did not tile lower content and restore scroll: ${JSON.stringify(reviewCaptureScroll)}`);
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

  await evaluate(`(() => {
    const rail = document.querySelectorAll('.node-input-option-rail')[0];
    rail.scrollLeft = 0;
    const first = rail.querySelector('.node-input-option');
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  })()`);
  await waitFor("replacement single-select option scrolls into view", () => evaluate(`(() => {
    const rail = document.querySelectorAll('.node-input-option-rail')[0];
    const selected = rail.querySelector('[aria-checked="true"]');
    if (selected?.dataset.optionKey !== 'route-8' || document.activeElement !== selected) return false;
    const railBounds = rail.getBoundingClientRect();
    const selectedBounds = selected.getBoundingClientRect();
    return rail.scrollLeft > 0 && selectedBounds.left >= railBounds.left - 1
      && selectedBounds.right <= railBounds.right + 1;
  })()`));

  await setValue(".node-input-text", "Preserve this staged value on navigation");
  await evaluate(`(() => {
    const action = [...document.querySelectorAll('#detailActions .action-control')]
      .find((button) => button.textContent.includes('Open navigation destination'));
    action?.click();
  })()`);
  await waitFor("navigation opens the destination detail and clears source inputs", () => evaluate(`(() => (
    document.querySelectorAll('.graph-node').length === 1
      && document.querySelector('.graph-node b')?.textContent === 'Navigation destination'
      && !document.querySelector('#inspector')?.classList.contains('hidden')
      && document.querySelector('#detailTitle')?.textContent === 'Navigation destination'
      && document.querySelector('#nodeInputActions')?.classList.contains('hidden')
  ))()`));
  const breadcrumbLegibility = await evaluate(`(() => {
    const path = document.querySelector('#workspaceBreadcrumb');
    const segments = [...path.querySelectorAll('.breadcrumb-segment')];
    const buttons = [...path.querySelectorAll('button.breadcrumb-segment')];
    return !path.classList.contains('hidden') && segments.length > 0 && buttons.length > 0
      && segments.every((item) => parseFloat(getComputedStyle(item).fontSize) >= 13)
      && buttons.every((item) => item.getBoundingClientRect().height >= 34)
      && [...path.querySelectorAll('.breadcrumb-icon')].every((item) => item.getBoundingClientRect().width >= 16)
      && getComputedStyle(path).overflowX === 'auto';
  })()`);
  if (!breadcrumbLegibility) throw new Error('Breadcrumb labels or navigation controls are too small.');
  if (process.env.RELAYER_NODE_DETAIL_EVIDENCE_DIR) {
    await click('#collapseSidebar');
    await waitForPaint();
    await writeFile(join(process.env.RELAYER_NODE_DETAIL_EVIDENCE_DIR, "breadcrumb-readable.png"), (await window.webContents.capturePage()).toPNG());
    await click('#collapseSidebar');
    await waitForPaint();
  }
  await click("[aria-label='Go to Response']");
  await waitFor("root input layer restored after navigation", () => evaluate(`document.querySelectorAll('.graph-node').length === 2`));
  await clickNode("Input grammar");
  await waitFor("navigation preserves renderer-local staged input", () => evaluate(`(
    document.querySelector('.node-input-text')?.value === 'Preserve this staged value on navigation'
  )`));

  // Implicit acceptance replaces the old per-field Commit UI. Keep the same
  // assembled persistence, conflict, response-loss, thread and layout boundaries.
  await setValue(".node-input-text", submittedTextValue);
  await evaluate(`(() => {
    const rails = document.querySelectorAll('.node-input-option-rail');
    rails[0].querySelectorAll('.node-input-option')[5].click();
    rails[1].querySelectorAll('.node-input-option')[2].click();
  })()`);
  await waitForPaint();
  await evaluate(`document.querySelectorAll('.node-input-option-rail')[0].scrollLeft = 160`);
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

  const beforeInvalid = await productRequest(`/api/threads/${thread.id}/input-draft`);
  await click("#sendInteraction");
  await waitFor("invalid implicit selection refuses Send", () => evaluate(`document.querySelector('#toast')?.textContent.includes('minimum')`));
  if ((await productRequest(`/api/threads/${thread.id}`)).interactions.length !== 1
    || (await productRequest(`/api/threads/${thread.id}/input-draft`)).revision !== beforeInvalid.revision) {
    throw new Error("Invalid multi-select performed a write before boundary validation.");
  }
  await evaluate(`document.querySelectorAll('.node-input-option-rail')[1].querySelectorAll('.node-input-option')[1].click()`);
  await waitFor("valid staged inputs enable Send without confirmation", () => evaluate(`!document.querySelector('#sendInteraction').disabled`));

  await evaluate(`(() => {
    const original = window.fetch.bind(window);
    window.__implicitAttempts = []; window.__implicitCancelPosts = true;
    window.fetch = async (input, init = {}) => {
      if (init.method === 'POST' && new URL(typeof input === 'string' ? input : input.url, location.href).pathname.endsWith('/interactions')) {
        window.__implicitAttempts.push(JSON.parse(init.body));
        if (window.__implicitCancelPosts) throw new TypeError('Injected refused Send transport');
      }
      return original(input, init);
    };
  })()`);
  let heldSave, releaseSave;
  const saveFilter = { urls: [`${productSession.origin}/api/threads/${thread.id}/input-draft/attachments`] };
  window.webContents.session.webRequest.onBeforeRequest(saveFilter, (details, callback) => {
    if (!heldSave && details.method === "PUT") { heldSave = true; releaseSave = () => callback({}); return; }
    callback({});
  });
  await click("#sendInteraction");
  await waitFor("implicit Send holds its first actual input save", () => heldSave);
  if (await evaluate("window.__implicitAttempts.length")) throw new Error("Send posted before its inputs settled.");
  await clickNode("Selection guard");
  await click(`[data-thread='${idleThread.id}']`);
  await waitFor("thread B remains editable during A save", () => evaluate(`document.querySelector("[data-thread='${idleThread.id}']")?.classList.contains('active') && !document.querySelector('#threadPrompt').disabled`));
  await clickNode("Input grammar");
  await setValue(".node-input-text", "Thread B independent stage");
  await click("[aria-label='Undo Name the governing constraint']");
  await click(`[data-thread='${thread.id}']`);
  await waitFor("thread A restored", () => evaluate(`document.querySelector("[data-thread='${thread.id}']")?.classList.contains('active')`));
  await clickNode("Selection guard");
  releaseSave();
  await waitFor("held save settles without stale node repaint", () => evaluate(`document.querySelector('#detailTitle').textContent === 'Selection guard' && document.querySelector('#nodeInputActions').classList.contains('hidden') && !document.querySelector('#threadPrompt').disabled`));
  window.webContents.session.webRequest.onBeforeRequest(saveFilter, null);
  await clickNode("Input grammar");
  await waitFor("owning Send becomes available after interrupted boundary", () => evaluate("!document.querySelector('#sendInteraction').disabled"));
  await click("#sendInteraction");
  await waitFor("retained answers post only after explicit Send in owning thread", () => evaluate("window.__implicitAttempts.length === 1 && !document.querySelector('#threadPrompt').disabled"));
  const saved = await productRequest(`/api/threads/${thread.id}/input-draft`);
  if (saved.attachments.length !== 3 || new Set(saved.attachments.map(a => JSON.stringify(a.occurrence))).size !== 3) throw new Error("Implicit save did not persist three exact answers.");
  if ((await evaluate("window.__implicitAttempts"))[0].inputDraftRevision !== saved.revision) throw new Error("Send did not name the settled input revision.");
  window.webContents.reload();
  await waitFor("committed inputs survive renderer reopen", () => evaluate(`document.querySelectorAll('.composer-input-pill').length === 3`));
  await clickNode("Input grammar");
  await waitFor("reopen restores authoritative saved text", () => evaluate(`document.querySelector('.node-input-text')?.value === ${JSON.stringify(submittedTextValue)}`));
  await setValue(".node-input-text", "Undo local replacement");
  await click("[aria-label='Undo Name the governing constraint']");
  if (await evaluate("document.querySelector('.node-input-text').value") !== submittedTextValue) throw new Error("Undo did not restore the saved baseline.");

  // Renderer reload intentionally removes the old transport injection.
  const textAttachment = saved.attachments.find(a => a.action.prompt === "Name the governing constraint");
  await productRequest(`/api/threads/${thread.id}/input-draft/attachments`, { method: "PUT", body: JSON.stringify({ occurrence: textAttachment.occurrence, value: { text: "Concurrent server value" }, expectedRevision: saved.revision }) });
  await setValue(".node-input-text", "Local value survives a revision conflict");
  await click("#sendInteraction");
  await waitFor("implicit save conflict preserves current answer", () => evaluate(`document.querySelector('#toast')?.textContent && document.querySelector('.node-input-text')?.value === 'Local value survives a revision conflict' && !document.querySelector('#threadPrompt').disabled`));
  if ((await productRequest(`/api/threads/${thread.id}`)).interactions.length !== 1) throw new Error("Conflict escaped into a completion.");

  let refusedSave = false;
  window.webContents.session.webRequest.onBeforeRequest(saveFilter, (details, callback) => {
    if (!refusedSave && details.method === "PUT") { refusedSave = true; callback({ cancel: true }); return; }
    callback({});
  });
  await setValue(".node-input-text", "Unsaved replacement");
  await click("#sendInteraction");
  await waitFor("failed implicit save retains stage and prevents dispatch", () => evaluate(`document.querySelector('#toast')?.textContent && document.querySelector('.node-input-text')?.value === 'Unsaved replacement' && !document.querySelector('#threadPrompt').disabled`));
  window.webContents.session.webRequest.onBeforeRequest(saveFilter, null);
  if (!refusedSave || (await productRequest(`/api/threads/${thread.id}`)).interactions.length !== 1) throw new Error("Failed implicit save was not exercised or dispatched work.");
  await click("[aria-label='Undo Name the governing constraint']");
  if (await evaluate("document.querySelector('.node-input-text').value") !== "Concurrent server value") throw new Error("Failed save changed Undo's authoritative baseline.");
  await click("[aria-label='Detach Choose supporting evidence']");
  await waitFor("detach removes authoritative occurrence", async () => (await productRequest(`/api/threads/${thread.id}/input-draft`)).attachments.length === 2);
  await evaluate(`(() => { const options = document.querySelectorAll('.node-input-option-rail')[1].querySelectorAll('.node-input-option'); options[0].click(); options[1].click(); })()`);
  await setValue(".node-input-text", submittedTextValue);

  await click("#attachNodeContext");
  await waitFor("response-loss annotation editor", () => evaluate(`Boolean(document.querySelector("[aria-label='Annotation for Input grammar']"))`));
  await setValue("[aria-label='Annotation for Input grammar']", "Preserve this click-time context through reconciliation.");
  await click("[aria-label='Confirm annotation']");
  await waitFor("annotation confirmed", () => evaluate(`document.querySelectorAll('.composer-context-pill:not(.composer-input-pill)').length === 1`));
  await setValue("#threadPrompt", "Preserve this click-time prompt through reconciliation.");
  await evaluate(`(() => {
    const original = window.fetch.bind(window); window.__implicitAttempts = []; window.__loseImplicitResponse = true;
    window.fetch = async (input, init = {}) => {
      if (init.method === 'POST' && new URL(typeof input === 'string' ? input : input.url, location.href).pathname.endsWith('/interactions')) {
        window.__implicitAttempts.push(JSON.parse(init.body));
        if (window.__loseImplicitResponse) { window.__loseImplicitResponse = false; await original(input, init); throw new TypeError('Injected lost interaction response'); }
        if (window.__recordImplicitPostedDraft) {
          const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
          window.__implicitPostedDraft = await (await original(path.slice(0, -'/interactions'.length) + '/input-draft')).json();
        }
      }
      return original(input, init);
    };
  })()`);
  let heldReconciliation, releaseReconciliation;
  const reloadFilter = { urls: [`${productSession.origin}/api/threads/${thread.id}/input-draft`] };
  window.webContents.session.webRequest.onBeforeRequest(reloadFilter, (details, callback) => {
    if (!heldReconciliation && details.method === "GET") { heldReconciliation = true; releaseReconciliation = () => callback({}); return; }
    callback({});
  });
  await click("#sendInteraction");
  await waitFor("lost response holds authoritative reconciliation", () => heldReconciliation);
  await evaluate("document.querySelector('#sendInteraction').dispatchEvent(new MouseEvent('click', { bubbles: true }))");
  if (await evaluate("window.__implicitAttempts.length") !== 1) throw new Error("Reentry escaped pending input reconciliation.");
  // Reconciliation must adopt storage authority even when another client
  // advances and then detaches occurrences while the renderer's GET is held.
  const draftBeforeReconciliation = await productRequest(`/api/threads/${thread.id}/input-draft`);
  const createdDuringLoss = (await productRequest(`/api/threads/${thread.id}`)).interactions.at(-1);
  const evidenceAtClick = { selectedKeys: createdDuringLoss.submittedInputs.find(input => input.action.prompt === "Choose supporting evidence").value.selected.map(option => String(option.key)) };
  const textAdvanced = await productRequest(`/api/threads/${thread.id}/input-draft/attachments`, {
    method: "PUT", body: JSON.stringify({ occurrence: textAttachment.occurrence, value: { text: submittedTextValue }, expectedRevision: draftBeforeReconciliation.revision }),
  });
  const evidenceOccurrence = saved.attachments.find(input => input.action.prompt === "Choose supporting evidence").occurrence;
  const evidenceAdvanced = await productRequest(`/api/threads/${thread.id}/input-draft/attachments`, {
    method: "PUT", body: JSON.stringify({ occurrence: evidenceOccurrence, value: evidenceAtClick, expectedRevision: textAdvanced.revision }),
  });
  const reconciledDraft = await productRequest(`/api/threads/${thread.id}/input-draft/attachments/${encodeURIComponent(evidenceOccurrence.presentingInteractionNodeId)}/${encodeURIComponent(evidenceOccurrence.presentingLayerId)}/${encodeURIComponent(evidenceOccurrence.actionId)}?expectedRevision=${encodeURIComponent(evidenceAdvanced.revision)}`, { method: "DELETE" });
  releaseReconciliation();
  window.webContents.session.webRequest.onBeforeRequest(reloadFilter, null);
  const lostThread = await waitForAcceptedInteractions(thread.id, 2);
  await waitFor("failed transport unlocks preserved input stage", () => evaluate("!document.querySelector('#threadPrompt').disabled"));
  const originalAttempt = (await evaluate("window.__implicitAttempts"))[0];
  if (lostThread.interactions.at(-1).submittedInputs.length !== 3
    || originalAttempt.contexts?.[0]?.annotations?.[0] !== "Preserve this click-time context through reconciliation."
    || originalAttempt.contextConfirmationIds?.length !== 1
    || originalAttempt.modelSelection?.providerId !== "codex" || originalAttempt.modelSelection?.modelId !== "fixture-model") throw new Error("Lost response did not retain exact input/context/model submission.");
  await clickNode("Input grammar");
  await waitFor("reconciliation exposes externally retained text", () => evaluate("Boolean(document.querySelector('[aria-label=\"Detach Name the governing constraint\"]'))"));
  await click("[aria-label='Detach Name the governing constraint']");
  const detachedDraft = await waitFor("UI detach advances reconciled composition", async () => {
    const current = await productRequest(`/api/threads/${thread.id}/input-draft`);
    return current.revision > reconciledDraft.revision && !current.attachments.some(input => input.action.prompt === "Name the governing constraint") ? current : false;
  });
  // A new edit, even to the same text, is a new input generation. It must not
  // reuse the earlier consumed Send identity or change its frozen record.
  await setValue(".node-input-text", submittedTextValue);
  await evaluate("window.__recordImplicitPostedDraft = true");
  await click("#sendInteraction");
  await waitFor("new-generation retry dispatches", () => evaluate("window.__implicitAttempts.length === 2"));
  await waitFor("retry observes settled authoritative draft", () => evaluate("Boolean(window.__implicitPostedDraft)"));
  const retryAttempt = (await evaluate("window.__implicitAttempts"))[1];
  const postedDraft = await evaluate("window.__implicitPostedDraft");
  if (retryAttempt.inputId === originalAttempt.inputId || retryAttempt.text !== originalAttempt.text
    || retryAttempt.inputDraftRevision !== postedDraft?.revision || postedDraft.revision <= detachedDraft.revision
    || retryAttempt.contexts?.[0]?.annotations?.[0] !== originalAttempt.contexts[0].annotations[0]
    || retryAttempt.contextConfirmationIds?.length !== 0
    || retryAttempt.modelSelection?.providerId !== originalAttempt.modelSelection.providerId
    || retryAttempt.modelSelection?.modelId !== originalAttempt.modelSelection.modelId) throw new Error(`Changed input generation lost the exact replay payload: ${JSON.stringify({ originalAttempt, retryAttempt, postedDraft })}`);
  await waitFor("running response preserves accepted reading", () => evaluate(`!document.querySelector('#pendingTurnNotice').classList.contains('hidden')`));
  await clickNode("Selection guard");
  releaseFourthCompletion();
  const acceptedThread = await waitForAcceptedInteractions(thread.id, 3);
  await waitFor("ready response preserves explicit browsing", () => evaluate(`!document.querySelector('#openReadyResult').classList.contains('hidden') && document.querySelector('#detailTitle').textContent === 'Selection guard'`));
  await click("#openReadyResult");
  await waitFor("accepted Send clears composer inputs", () => evaluate("document.querySelectorAll('.composer-input-pill').length === 0 && document.querySelectorAll('#interactionInputHistory .interaction-input-history-item').length >= 1"));
  const disclosure = await evaluate(`(() => { const d = document.querySelector('.interaction-input-history-disclosure'); const summary = d?.querySelector('summary'); return { tag: d?.tagName, open: d?.open, summaryTag: summary?.tagName, summary: summary?.textContent, summaryName: summary?.getAttribute('aria-label'), summaryWidth: summary?.getBoundingClientRect().width, full: d?.querySelector('p')?.textContent }; })()`);
  if (disclosure.tag !== "DETAILS" || disclosure.open || disclosure.summaryTag !== "SUMMARY"
    || [...disclosure.summary].length !== 80 || disclosure.full !== submittedTextValue
    || disclosure.summaryName !== "Show full submitted value for Name the governing constraint"
    || disclosure.summaryWidth > 241) throw new Error(`Submitted long input disclosure is wrong: ${JSON.stringify(disclosure)}`);
  await evaluate("document.querySelector('.interaction-input-history-disclosure>summary').click()");
  await waitFor("submitted input full text opens", () => evaluate("document.querySelector('.interaction-input-history-disclosure').open"));

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
  // Same production workspace, now exercise the new saved split using real pointer input.
  const readingUrl = `${productSession.origin}/?threadId=${encodeURIComponent(thread.id)}&interactionId=${encodeURIComponent(authoredTurnId)}`;
  await window.loadURL(readingUrl);
  window.setSize(1280, 820);
  await waitFor("interactive reading workspace", () => evaluate("document.querySelectorAll('.graph-node').length === 2"));
  await clickNode("Input grammar");
  const readSplit = () => evaluate(`(() => {
    const rect = selector => { const value = document.querySelector(selector).getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height }; };
    return { graph: rect('#graphStage'), detail: rect('#inspector'), divider: rect('#workspaceDivider'),
      title: document.querySelector('#detailTitle').textContent,
      ratio: Number(document.querySelector('#workspaceDivider').getAttribute('aria-valuenow')),
      preference: Number(document.querySelector('.workspace-layout').style.getPropertyValue('--graph-share').replace('%', '')) };
  })()`);
  const beforeResize = await readSplit();
  if (Math.abs(beforeResize.graph.width - beforeResize.detail.width) > 1) {
    throw new Error(`Default graph/details split is not equal: ${JSON.stringify(beforeResize)}`);
  }
  const dividerX = Math.round(beforeResize.divider.x + beforeResize.divider.width / 2);
  const dividerY = Math.round(beforeResize.divider.y + beforeResize.divider.height / 2);
  window.webContents.sendInputEvent({ type: "mouseMove", x: dividerX, y: dividerY });
  window.webContents.sendInputEvent({ type: "mouseDown", x: dividerX, y: dividerY, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseMove", x: dividerX + 90, y: dividerY });
  window.webContents.sendInputEvent({ type: "mouseUp", x: dividerX + 90, y: dividerY, button: "left", clickCount: 1 });
  const resized = await waitFor("drag changes both rendered pane widths", async () => {
    const value = await readSplit();
    return value.graph.width > beforeResize.graph.width + 50
      && value.detail.width < beforeResize.detail.width - 50 ? value : false;
  });
  let persistedRatio;
  try {
    await waitFor("desktop durable ratio is written", async () => {
      persistedRatio = await evaluate("window.relayerDesktop.workspaceLayout.read()");
      return Math.abs(persistedRatio * 100 - resized.preference) < 0.001;
    });
  } catch (error) {
    throw new Error(`Split persistence mismatch: ${JSON.stringify({ resized, persistedRatio, current: await readSplit() })}`, { cause: error });
  }
  if (process.env.RELAYER_NODE_DETAIL_EVIDENCE_DIR) {
    await waitForPaint();
    await writeFile(join(process.env.RELAYER_NODE_DETAIL_EVIDENCE_DIR, "workspace-resized.png"), (await window.webContents.capturePage()).toPNG());
  }
  await click('#closeInspector');
  await waitFor("closing details expands graph", async () => (await readSplit()).graph.width > resized.graph.width + 200);
  await clickNode("Input grammar");
  await waitFor("selecting node restores saved split", async () => Math.abs((await readSplit()).graph.width - resized.graph.width) < 1);
  await window.loadURL(readingUrl);
  await waitFor("reloaded graph", () => evaluate("document.querySelectorAll('.graph-node').length === 2"));
  await waitFor("reloaded workspace restores saved split and node", async () => {
    const value = await readSplit();
    return value.title === 'Input grammar' && value.ratio === resized.ratio
      && Math.abs(value.graph.width - resized.graph.width) < 1;
  });
  await click('#environmentToggle');
  await waitFor("Environment overlay opens without shifting resized panes", async () => {
    const value = await readSplit();
    return Math.abs(value.graph.width - resized.graph.width) < 1
      && await evaluate("!document.querySelector('#environmentPanel').classList.contains('hidden')");
  });
  await waitFor("Environment content settles after reload", () => evaluate("document.querySelector('#environmentBody')?.getAttribute('aria-busy') === 'false'"));
  if (process.env.RELAYER_NODE_DETAIL_EVIDENCE_DIR) {
    await waitForPaint();
    await writeFile(join(process.env.RELAYER_NODE_DETAIL_EVIDENCE_DIR, "workspace-environment-open.png"), (await window.webContents.capturePage()).toPNG());
  }
  await click('#closeEnvironment');
  process.stdout.write("Node-input Electron proof passed with 0 paid inference calls.\n");
  if (process.env.RELAYER_WORKSPACE_HUMAN_REVIEW === "1") {
    window.show();
    window.focus();
    app.focus({ steal: true });
    process.stdout.write(`Visual human gate ready in the interactive Relayer window: ${readingUrl}\n`);
    await new Promise(resolveClose => window.once("closed", resolveClose));
  }
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
