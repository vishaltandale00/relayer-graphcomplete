import { app, BrowserWindow, ipcMain } from "electron";
import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";

import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createSettingsStore } from "../desktop/main/services/settings-store.mjs";
import { registerComposerDraftIpc, registerLayerSelectionIpc, registerWorktreeIpc, registerProjectSidebarIpc } from "../desktop/main/ipc/register-ipc.mjs";
import { createWorktreeService } from "../desktop/main/services/worktree-service.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";

import { createProjectSidebarDemoVideo } from "./project-sidebar-demo-video.mjs";

const demoVideo = process.env.RELAYER_PROJECT_SIDEBAR_VIDEO ? createProjectSidebarDemoVideo(resolve(process.env.RELAYER_PROJECT_SIDEBAR_VIDEO)) : null;

const repositoryRoot = resolve(import.meta.dirname, "..");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-project-new-thread-"));
const evidenceDirectory = process.env.RELAYER_PROJECT_NEW_THREAD_EVIDENCE_DIR
  || join(repositoryRoot, ".relayer", "evidence", "project-new-thread");
const services = [];
const nativeTargetDirectory = process.env.CARGO_TARGET_DIR || join(repositoryRoot, "target");
const worktrees = createWorktreeService({ worktreeRoot: join(dataDirectory, "worktrees"), storeDirectory: join(dataDirectory, "worktree-plans") });
let window;
let keepaliveWindow;
let exitCode = 1;
let desktopSettings = createSettingsStore(dataDirectory);
let tutorialState = {
  status: "dismissed",
  automaticEligible: false,
};
let automaticTutorialBegins = 0;

app.setName("Relayer Project New Thread Test");
const electronProfileDirectory = join(dataDirectory, "electron-profile");
mkdirSync(electronProfileDirectory, { recursive: true });
app.setPath("userData", electronProfileDirectory);
app.commandLine.appendSwitch("disable-gpu");

function registerTestIpc() {
  registerWorktreeIpc({ ipcMain, worktrees });
  ipcMain.handle("relayer:account-read", () => ({
    status: "signed-in",
    channel: "stable",
    subject: "fixture|project-new-thread",
  }));
  ipcMain.handle("relayer:appearance-read", () => ({ appearance: "dark" }));
  registerComposerDraftIpc({ ipcMain, settings: desktopSettings });
  registerProjectSidebarIpc({ ipcMain, settings: desktopSettings });
  registerLayerSelectionIpc({ ipcMain, settings: { read: () => desktopSettings.read(), update: (fn) => desktopSettings.update(fn) } });
  ipcMain.handle("relayer:folder-choose", () => null);
  ipcMain.handle("relayer:provider-status", () => ({
    adapters: [],
    definitions: [],
    hasCompletedOnboarding: true,
  }));
  ipcMain.handle("relayer:model-catalog-settings-open", () => null);
  ipcMain.handle("relayer:tutorial-read", () => tutorialState);
  ipcMain.handle("relayer:tutorial-begin-automatic", () => {
    automaticTutorialBegins += 1;
    return { started: true };
  });
  ipcMain.handle("relayer:update-status", () => ({
    phase: "development",
    channel: "stable",
    version: "test",
    availableVersion: null,
    percent: null,
    error: null,
  }));
}

function unregisterTestIpc() {
  for (const method of ["inspect", "validateSelection", "plan", "create", "reconcile", "readPlan"]) ipcMain.removeHandler(`relayer:worktrees-${method}`);
  for (const channel of [
    "relayer:account-read",
    "relayer:appearance-read",
    "relayer:project-sidebar-read",
    "relayer:project-sidebar-set",
    "relayer:composer-drafts-read",
    "relayer:composer-drafts-write",
    "relayer:layer-selections-read",
    "relayer:layer-selections-remember",
    "relayer:folder-choose",
    "relayer:provider-status",
    "relayer:model-catalog-settings-open",
    "relayer:tutorial-read",
    "relayer:tutorial-begin-automatic",
    "relayer:update-status",
  ]) ipcMain.removeHandler(channel);
}

async function waitFor(label, check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function productRequest(session, path, init = {}) {
  const response = await fetch(new URL(path, session.origin), {
    ...init,
    headers: {
      Accept: "application/json",
      Cookie: `${session.cookie.name}=${session.cookie.value}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}

async function run() {
  registerTestIpc();
  keepaliveWindow = new BrowserWindow({ width: 1, height: 1, show: false });
  const configurationPath = join(repositoryRoot, "harnesses", "fixture-task-system.yaml");
  let providerAttempts = 0;
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(nativeTargetDirectory, "debug", "relayer-graph-server"),
    configurationPaths: [configurationPath],
    additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory },
    acquireProviderExecution: async (providerId) => {
      // Author the first graph for selection persistence; later attempts retain
      // the original runner's failed-prompt draft/tombstone coverage.
      if (++providerAttempts > 1) throw new Error("Deterministic provider admission failure.");
      return {
        definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
        descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
        runtime: { executionAccess: async () => ({ kind: "managed-runtime", environment: {} }) },
        async release() {},
      };
    },
  });
  services.push(runtime);
  const runtimeSession = await runtime.start();
  let product;
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
  const modelCatalogRefreshServer = await startModelCatalogRefreshServer({
    refresh: () => product.seedProviderCatalog(catalogSnapshot),
  });
  services.push(modelCatalogRefreshServer);
  let productSession;
  const startProduct = async () => {
    product = new RelayerAppServerService({
      userDataDirectory: dataDirectory,
      binaryPath: join(nativeTargetDirectory, "debug", "relayer-app-server"),
      webDirectory: join(repositoryRoot, "desktop", "renderer"),
      permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
      runtimeSession,
      providerCatalogRefreshSession: modelCatalogRefreshServer.session,
      defaultHarnessConfiguration: "fixture-task-system",
    });
    services.push(product);
    productSession = await product.start();
    await product.seedProviderCatalog(catalogSnapshot);
  };
  await startProduct();
  await productRequest(productSession, "/api/model-families", {
    method: "POST",
    body: JSON.stringify({
      name: "Fixture models",
      enabled: true,
      members: [{ providerId: "codex", modelId: "fixture-model", roles: [{ name: "orchestrator" }] }],
    }),
  });

  const projectDirectory = join(dataDirectory, "relayer-graphcomplete");
  await mkdir(projectDirectory, { recursive: true });
  const project = await productRequest(productSession, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ path: projectDirectory, name: "relayer-graphcomplete" }),
  });
  const secondProjectDirectory = join(dataDirectory, "second-project");
  await mkdir(secondProjectDirectory, { recursive: true });
  const secondProject = await productRequest(productSession, "/api/projects", {
    method: "POST",
    body: JSON.stringify({
      path: secondProjectDirectory,
      name: 'A long empty project name for planning & "research"',
    }),
  });

  const createWindow = createWindowFactory({
    BrowserWindow: class extends BrowserWindow {
      constructor(options) { super({ ...options, show: false }); }
    },
    desktopDirectory: join(repositoryRoot, "desktop"),
    getAppearance: () => "dark",
    updater: { status: () => ({ phase: "development" }) },
    openExternal: async () => undefined,
  });
  let webContents;
  const openWindow = async () => {
    window = await createWindow(productSession);
    window.on("close", () => process.stderr.write("Project fixture window received a native close event.\n"));
    webContents = window.webContents;
    window.hide();
    await waitFor("the desktop workspace", () => webContents.executeJavaScript(`(
      !document.querySelector('#appShell')?.classList.contains('hidden')
      && !document.body.classList.contains('desktop-account-pending')
    )`));
  };
  const evaluate = (source) => webContents.executeJavaScript(source);
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  // Chromium input preserves hit-testing and CSS hover without taking the user's
  // native keyboard focus during the persistence/restart fixture.
  const movePointer = async (point) => {
    if (!webContents.debugger.isAttached()) webContents.debugger.attach("1.3");
    await webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  };
  const clickProjectAction = async (projectId) => {
    const selector = `[data-project-new-thread="${projectId}"]`;
    const point = await evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)})?.closest("[data-project-row]")?.getBoundingClientRect();
      return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
    })()`);
    if (!point) throw new Error(`Missing project action ${projectId}.`);
    await movePointer({ x: 800, y: 400 });
    await movePointer(point);
    await waitFor(`project action ${projectId} to reveal`, () => evaluate(`(
      getComputedStyle(document.querySelector(${JSON.stringify(selector)})).opacity === '1'
    )`)).catch(async (error) => {
      try {
        process.stderr.write(`Project hover failure: ${await evaluate(`JSON.stringify((() => {
          const action = document.querySelector(${JSON.stringify(selector)});
          const row = action?.closest('[data-project-row]');
          const rect = action?.getBoundingClientRect();
          return { point: ${JSON.stringify(point)}, rect: rect?.toJSON(), opacity: action ? getComputedStyle(action).opacity : null,
            rowHover: row?.matches(':hover'), actionHover: action?.matches(':hover'),
            hit: document.elementFromPoint(${point.x}, ${point.y})?.outerHTML,
            viewport: [innerWidth, innerHeight], scroll: [scrollX, scrollY] };
        })())`)}\n`);
      } finally {
        throw error;
      }
    });
    const actionPoint = await evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    await movePointer(actionPoint);
    await webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...actionPoint });
    await webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...actionPoint });
  };
  const setValue = (selector, value) => evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  })()`);
  const captureEvidence = async (name) => {
    await mkdir(evidenceDirectory, { recursive: true });
    const path = join(evidenceDirectory, `${name}.png`);
    await writeFile(path, (await webContents.capturePage()).toPNG());
    return path;
  };
  await openWindow();

  const draftLimits = await evaluate(`Promise.all([
    window.relayerDesktop.drafts.write({
      pendingNewThread: { text: "x".repeat(1024 * 1024), scope: null },
      threadFollowups: {},
    }).then(() => false, (error) => error?.message?.includes("persistence limit")),
    window.relayerDesktop.drafts.write({
      pendingNewThread: null,
      threadFollowups: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [String(index), "draft"])),
    }).then((value) => ({
      count: Object.keys(value.threadFollowups).length,
      first: Object.keys(value.threadFollowups)[0],
      last: Object.keys(value.threadFollowups).at(-1),
    })),
  ])`);
  if (draftLimits[0] !== true
    || draftLimits[1]?.count !== 256
    || draftLimits[1]?.first !== "1"
    || draftLimits[1]?.last !== "256") {
    throw new Error(`The production draft IPC did not enforce both persistence limits: ${JSON.stringify(draftLimits)}`);
  }
  const persistedBoundedDrafts = await desktopSettings.read();
  const persistedFollowupKeys = Object.keys(persistedBoundedDrafts.composerDrafts?.threadFollowups || {});
  if (persistedFollowupKeys.length !== 256
    || persistedFollowupKeys[0] !== "1"
    || persistedFollowupKeys.at(-1) !== "256") {
    throw new Error(`The bounded follow-up set did not reach the main-process store: ${JSON.stringify(persistedFollowupKeys)}`);
  }
  await evaluate(`window.relayerDesktop.drafts.write({ pendingNewThread: null, threadFollowups: {} })`);

  const resting = await waitFor("the project-row compose action", () => webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-project-row="${project.id}"]');
    const action = document.querySelector('[data-project-new-thread="${project.id}"]');
    if (!row || !action) return false;
    return {
      rowText: row.textContent.replace(/\\s+/g, " ").trim(),
      accessibleName: action.getAttribute("aria-label"),
      opacity: getComputedStyle(action).opacity,
      pointerEvents: getComputedStyle(action).pointerEvents,
      draftIndicators: row.querySelectorAll('[data-draft-indicator]').length,
      actionCount: row.querySelectorAll('[data-project-new-thread]').length,
      rect: (() => {
        const value = row.getBoundingClientRect();
        return { x: value.x, y: value.y, width: value.width, height: value.height };
      })(),
      containment: (() => {
        const rowRect = row.getBoundingClientRect();
        const actionRect = action.getBoundingClientRect();
        const sidebarRect = document.querySelector('.sidebar').getBoundingClientRect();
        return {
          rowRight: rowRect.right,
          actionRight: actionRect.right,
          sidebarRight: sidebarRect.right,
        };
      })(),
    };
  })()`));
  if (resting.rowText !== "relayer-graphcomplete") {
    throw new Error(`The idle project row contained extra metadata: ${JSON.stringify(resting)}`);
  }
  if (resting.accessibleName !== "New thread in relayer-graphcomplete") {
    throw new Error(`The project action had the wrong accessible name: ${JSON.stringify(resting)}`);
  }
  if (resting.opacity !== "0" || resting.pointerEvents !== "none") {
    throw new Error(`The project action was visible before hover or focus: ${JSON.stringify(resting)}`);
  }
  if (resting.draftIndicators !== 0) {
    throw new Error(`The project row exposed a draft indicator: ${JSON.stringify(resting)}`);
  }
  if (resting.actionCount !== 1) {
    throw new Error(`The project row did not expose exactly one compose target: ${JSON.stringify(resting)}`);
  }
  if (resting.containment.rowRight > resting.containment.sidebarRight
    || resting.containment.actionRight > resting.containment.sidebarRight) {
    throw new Error(`The project row action escaped the sidebar: ${JSON.stringify(resting.containment)}`);
  }
  const longEmptyProject = await evaluate(`(() => {
    const row = document.querySelector('[data-project-row="${secondProject.id}"]');
    const action = document.querySelector('[data-project-new-thread="${secondProject.id}"]');
    return {
      rowText: row?.textContent.replace(/\\s+/g, " ").trim(),
      accessibleName: action?.getAttribute("aria-label"),
      threadRows: row?.nextElementSibling?.querySelectorAll('[data-thread]').length,
    };
  })()`);
  if (longEmptyProject.rowText !== secondProject.name
    || longEmptyProject.accessibleName !== `New thread in ${secondProject.name}`
    || longEmptyProject.threadRows !== 0) {
    throw new Error(`The long empty project row was not stable: ${JSON.stringify(longEmptyProject)}`);
  }
  const evidence = { resting: await captureEvidence("01-resting") };

  const hoverPoint = await evaluate(`(() => {
    const rect = document.querySelector('[data-project-row="${project.id}"]').getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  await movePointer({ x: 800, y: 400 });
  await movePointer(hoverPoint);
  await waitFor("the hovered project action to be visible", () => evaluate(`(
    getComputedStyle(document.querySelector('[data-project-new-thread="${project.id}"]')).opacity === '1'
  )`));
  const hoveredRect = await evaluate(`(() => {
    const value = document.querySelector('[data-project-row="${project.id}"]').getBoundingClientRect();
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  })()`);
  if (JSON.stringify(hoveredRect) !== JSON.stringify(resting.rect)) {
    throw new Error(`Hover moved the project row layout: ${JSON.stringify({ resting: resting.rect, hovered: hoveredRect })}`);
  }
  const lightModeColors = await evaluate(`(() => {
    document.documentElement.dataset.theme = "light";
    const row = document.querySelector('[data-project-row="${project.id}"]');
    const action = document.querySelector('[data-project-new-thread="${project.id}"]');
    const result = {
      row: getComputedStyle(row).color,
      action: getComputedStyle(action).color,
      text: getComputedStyle(document.documentElement).color,
    };
    document.documentElement.dataset.theme = "dark";
    return result;
  })()`);
  if (lightModeColors.row !== lightModeColors.action
    || lightModeColors.action !== lightModeColors.text) {
    throw new Error(`The project action lost the light-mode row color: ${JSON.stringify(lightModeColors)}`);
  }
  evidence.hover = await captureEvidence("02-hover");
  await movePointer({ x: 800, y: 400 });
  await waitFor("the project action to hide after pointer exit", () => evaluate(`(
    getComputedStyle(document.querySelector('[data-project-new-thread="${project.id}"]')).opacity === '0'
  )`));

  await webContents.executeJavaScript(`document.querySelector('[data-project-new-thread="${project.id}"]').focus()`);
  const focused = await waitFor("the focused project action to be visible", () => (
    webContents.executeJavaScript(`(() => {
      const action = document.querySelector('[data-project-new-thread="${project.id}"]');
      const result = {
        active: document.activeElement === action,
        opacity: getComputedStyle(action).opacity,
        pointerEvents: getComputedStyle(action).pointerEvents,
      };
      return result.active && result.opacity === "1" && result.pointerEvents === "auto" ? result : false;
    })()`)
  ));
  if (!focused.active || focused.opacity !== "1" || focused.pointerEvents !== "auto") {
    throw new Error(`Keyboard focus did not reveal the project action: ${JSON.stringify(focused)}`);
  }

  const pendingPrompt = "Keep this pending New Thread draft.";
  await setValue("#newThreadPrompt", pendingPrompt);
  await clickProjectAction(project.id);
  await waitFor("the first project-scoped composer", () => evaluate(`(
    !document.querySelector('#newThreadView')?.classList.contains('hidden')
      && document.querySelector('#newThreadPrompt')?.value === ${JSON.stringify(pendingPrompt)}
      && document.querySelector('#scopeLabel')?.textContent === ${JSON.stringify(project.name)}
      && document.activeElement?.id === 'newThreadPrompt'
  )`));
  const firstScope = await evaluate(`({
    visible: !document.querySelector('#newThreadView')?.classList.contains('hidden'),
    prompt: document.querySelector('#newThreadPrompt')?.value,
    scope: document.querySelector('#scopeLabel')?.textContent,
    focused: document.activeElement?.id === 'newThreadPrompt',
  })`);
  if (!firstScope.visible || firstScope.prompt !== pendingPrompt
    || firstScope.scope !== project.name || !firstScope.focused) {
    throw new Error(`The project action did not scope and preserve the pending draft: ${JSON.stringify(firstScope)}`);
  }
  await evaluate(`document.querySelector('#newThreadPrompt').blur()`);
  await clickProjectAction(project.id);
  await waitFor("same-project activation to restore focus only", () => evaluate(`(
    document.activeElement?.id === 'newThreadPrompt'
      && document.querySelector('#newThreadPrompt')?.value === ${JSON.stringify(pendingPrompt)}
      && document.querySelector('#scopeLabel')?.textContent === ${JSON.stringify(project.name)}
  )`));
  evidence.activated = await captureEvidence("03-activated");
  if ((await productRequest(productSession, "/api/state")).threads.length !== 0) {
    throw new Error("Opening a project-scoped composer created a thread before Send.");
  }

  const programmaticPrompt = "Preserve a prompt populated without an input event.";
  await evaluate(`document.querySelector('#newThreadPrompt').value = ${JSON.stringify(programmaticPrompt)}`);
  await clickProjectAction(secondProject.id);
  await waitFor("the programmatically populated prompt to survive rescoping", () => evaluate(`(
    document.querySelector('#scopeLabel')?.textContent === ${JSON.stringify(secondProject.name)}
      && document.querySelector('#newThreadPrompt')?.value === ${JSON.stringify(programmaticPrompt)}
  )`));
  await waitFor("the programmatically populated prompt to reach the main-process store", async () => {
    const saved = await desktopSettings.read();
    return saved.composerDrafts?.pendingNewThread?.text === programmaticPrompt
      && String(saved.composerDrafts?.pendingNewThread?.scope?.projectId) === String(secondProject.id);
  });
  await setValue("#newThreadPrompt", pendingPrompt);
  await evaluate(`(() => {
    document.querySelector('[data-project-new-thread="${project.id}"]').click();
    document.querySelector('[data-project-new-thread="${secondProject.id}"]').click();
  })()`);
  await waitFor("the cross-project scope change", () => evaluate(`(
    document.querySelector('#scopeLabel')?.textContent === ${JSON.stringify(secondProject.name)}
      && document.querySelector('#newThreadPrompt')?.value === ${JSON.stringify(pendingPrompt)}
  )`));
  await click(`[data-project-row="${project.id}"] .project-button`);
  const rowClickScope = await evaluate(`document.querySelector('#scopeLabel')?.textContent`);
  if (rowClickScope !== secondProject.name) {
    throw new Error("Clicking the project row itself unexpectedly opened or rescoped the composer.");
  }
  await clickProjectAction(project.id);
  await waitFor("the original project scope to return", () => evaluate(`(
    document.querySelector('#scopeLabel')?.textContent === ${JSON.stringify(project.name)}
      && document.querySelector('#newThreadPrompt')?.value === ${JSON.stringify(pendingPrompt)}
  )`));
  await waitFor("the first-message Send action", () => evaluate(`document.querySelector('#createThread')?.disabled === false`));
  await evaluate(`(() => {
    document.querySelector('[data-project-new-thread="${secondProject.id}"]').click();
    document.querySelector('#createThread').click();
  })()`);
  const firstThread = await waitFor("the first project thread", async () => {
    const state = await productRequest(productSession, "/api/state");
    if (state.threads.length !== 1) return false;
    const thread = state.threads[0];
    return String(thread.projectId) === String(project.id) ? thread : false;
  });

  await waitFor("new chat creation expands its project", () => evaluate(`document.querySelector('[data-project-toggle="${project.id}"]')?.getAttribute('aria-expanded') === 'true'`));
  // Native keyboard activation exercises the production header without changing the open chat.
  await evaluate(`document.querySelector('[data-project-toggle="${project.id}"]').focus()`);
  webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
  webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
  await waitFor("keyboard project collapse", () => evaluate(`document.querySelector('[data-project-toggle="${project.id}"]')?.getAttribute('aria-expanded') === 'false'`));
  if (!await evaluate(`import('./src/state.js').then(m => String(m.viewState.currentThreadId) === '${firstThread.id}' && !document.querySelector('#threadView').classList.contains('hidden') && !document.querySelector('#project-threads-${project.id}').checkVisibility())`)) throw new Error("Collapsing the active project changed its open chat or left the chat list visible.");
  evidence.collapsedProject = await captureEvidence("04-collapsed-project");
  if (demoVideo) {
    await demoVideo.scene(webContents, "Collapse a project; the current chat stays open");
    await demoVideo.scene(webContents, "Expand the project to reveal its chats", () => click(`[data-project-toggle="${project.id}"]`));
    await demoVideo.scene(webContents, "Collapse it again without leaving the chat", () => click(`[data-project-toggle="${project.id}"]`));
  }
  await clickProjectAction(project.id);
  await waitFor("real compose action expands collapsed project", () => evaluate(`document.querySelector('[data-project-toggle="${project.id}"]')?.getAttribute('aria-expanded') === 'true' && !document.querySelector('#newThreadView').classList.contains('hidden')`));
  if (demoVideo) await demoVideo.scene(webContents, "Compose independently: New Thread opens in this project");
  await click(`[data-thread="${firstThread.id}"]`);
  if (demoVideo) {
    await demoVideo.scene(webContents, "The whole sidebar can still collapse into its icon rail", () => click("#collapseSidebar"));
    await demoVideo.scene(webContents, "Select a project icon to reopen the sidebar", () => click(`[data-project-toggle="${project.id}"]`));
    if (await evaluate("document.body.classList.contains('sidebar-collapsed')")) throw new Error("Demo rail project selection did not expand the sidebar.");
  }

  const followupPrompt = "Keep this unsent follow-up with the saved thread.";
  await waitFor("the saved-thread composer", () => evaluate(`(
    !document.querySelector('#threadView')?.classList.contains('hidden')
      && document.querySelector('#threadPrompt')?.disabled === false
  )`));
  await evaluate(`(() => {
    document.querySelector('[data-project-new-thread="${project.id}"]').click();
    document.querySelector('#settingsButton').click();
  })()`);
  await waitFor("later Settings navigation to win over project activation", () => evaluate(`(
    !document.querySelector('#settingsView')?.classList.contains('hidden')
  )`));
  await click("#settingsBackButton");
  await waitFor("the saved thread after leaving Settings", () => evaluate(`(
    !document.querySelector('#threadView')?.classList.contains('hidden')
      && document.querySelector('[data-thread="${firstThread.id}"]')?.classList.contains('active')
  )`));
  await evaluate(`(() => {
    document.querySelector('[data-project-new-thread="${project.id}"]').click();
    document.querySelector('[data-thread="${firstThread.id}"]').click();
  })()`);
  await waitFor("later saved-thread navigation to win over project activation", () => evaluate(`(
    !document.querySelector('#threadView')?.classList.contains('hidden')
      && document.querySelector('[data-thread="${firstThread.id}"]')?.classList.contains('active')
  )`));
  await waitFor("the accepted graph for selection restart", async () => {
    const thread = await productRequest(productSession, `/api/threads/${firstThread.id}`);
    if (thread.interactions.some((turn) => ["failed", "stopped"].includes(turn.completionStatus))) {
      throw new Error(`Selection restart fixture did not accept its graph: ${JSON.stringify(thread)}`);
    }
    return thread.interactions.some((turn) => turn.completionStatus === "accepted");
  });
  const rememberedNodeId = await waitFor("a non-default node to remember", () => evaluate(`(() => {
    const node = document.querySelector('.graph-node:not(.selected)');
    if (!node) return false;
    node.click();
    return node.dataset.node;
  })()`));
  await waitFor("node choice persisted outside the renderer origin", async () => (
    (await desktopSettings.read()).layerSelections?.some(([, nodeId]) => nodeId === rememberedNodeId)
  ));
  await setValue("#threadPrompt", followupPrompt);
  await clickProjectAction(project.id);
  await waitFor("the separate empty pending composer", () => evaluate(`(
    !document.querySelector('#newThreadView')?.classList.contains('hidden')
      && document.querySelector('#newThreadPrompt')?.value === ''
      && document.querySelector('#scopeLabel')?.textContent === ${JSON.stringify(project.name)}
  )`));
  const separatePendingPrompt = "This is a separate pending project thread.";
  await setValue("#newThreadPrompt", separatePendingPrompt);
  await click(`[data-thread="${firstThread.id}"]`);
  await waitFor("the saved follow-up draft to return", () => evaluate(`(
    !document.querySelector('#threadView')?.classList.contains('hidden')
      && document.querySelector('#threadPrompt')?.value === ${JSON.stringify(followupPrompt)}
  )`));
  await clickProjectAction(project.id);
  await waitFor("the pending project draft to return", () => evaluate(`(
    document.querySelector('#newThreadPrompt')?.value === ${JSON.stringify(separatePendingPrompt)}
      && document.querySelector('#scopeLabel')?.textContent === ${JSON.stringify(project.name)}
  )`));
  if ((await productRequest(productSession, "/api/state")).threads.length !== 1) {
    throw new Error("Draft navigation created a thread before Send.");
  }

  await waitFor("both drafts to reach the main-process store", async () => {
    const saved = await desktopSettings.read();
    return saved.composerDrafts?.pendingNewThread?.text === separatePendingPrompt
      && Object.values(saved.composerDrafts?.threadFollowups || {}).includes(followupPrompt);
  });
  await click(`[data-project-toggle="${project.id}"]`);
  await waitFor("collapse reaches durable settings before restart", async () => (await desktopSettings.read()).collapsedProjectIds?.includes(String(project.id)));
  const previousOrigin = productSession.origin;
  window.destroy();
  window = undefined;
  services.splice(services.indexOf(product), 1);
  await product.close();
  await desktopSettings.flush();
  desktopSettings = createSettingsStore(dataDirectory);
  ipcMain.removeHandler("relayer:composer-drafts-read");
  ipcMain.removeHandler("relayer:composer-drafts-write");
  registerComposerDraftIpc({ ipcMain, settings: desktopSettings });
  ipcMain.removeHandler("relayer:project-sidebar-read");
  ipcMain.removeHandler("relayer:project-sidebar-set");
  registerProjectSidebarIpc({ ipcMain, settings: desktopSettings });
  await startProduct();
  if (productSession.origin === previousOrigin) {
    throw new Error("The restart scenario did not move to a new product origin.");
  }
  await openWindow();
  await waitFor("the pending draft after app restart", () => evaluate(`(
    !document.querySelector('#newThreadView')?.classList.contains('hidden')
      && document.querySelector('#newThreadPrompt')?.value === ${JSON.stringify(separatePendingPrompt)}
      && document.querySelector('#scopeLabel')?.textContent === ${JSON.stringify(project.name)}
  )`));
  await waitFor("collapsed project after changed-origin restart", () => evaluate(`document.querySelector('[data-project-toggle="${project.id}"]')?.getAttribute('aria-expanded') === 'false'`));
  if (demoVideo) await demoVideo.scene(webContents, "Collapsed preference survives renderer and server restart");
  // Explicit load uses the real navigation seam even while its sidebar entry is hidden.
  await evaluate(`import('./src/threads.js').then(m => m.loadThread(${JSON.stringify(firstThread.id)}))`);
  await waitFor("explicit navigation expands restored project", () => evaluate(`document.querySelector('[data-project-toggle="${project.id}"]')?.getAttribute('aria-expanded') === 'true'`));
  if (demoVideo) await demoVideo.scene(webContents, "Explicit chat navigation expands its project again");
  await waitFor("the remembered detail after restart on a different origin", () => evaluate(`(
    document.querySelector('.graph-node.selected')?.dataset.node === ${JSON.stringify(rememberedNodeId)}
      && !document.querySelector('#inspector')?.classList.contains('hidden')
  )`));
  await waitFor("the follow-up draft after app restart", () => evaluate(`(
    document.querySelector('#threadPrompt')?.value === ${JSON.stringify(followupPrompt)}
  )`));
  await waitFor("the saved follow-up Send action", () => evaluate(`(
    document.querySelector('#sendInteraction')?.disabled === false
  )`));
  await evaluate(`(() => {
    document.querySelector('[data-project-new-thread="${project.id}"]').click();
    document.querySelector('#sendInteraction').click();
  })()`);
  await waitFor("the saved follow-up draft to clear after Send", () => evaluate(`(
    document.querySelector('#threadPrompt')?.value === ''
  )`), 20_000);
  await waitFor("the saved follow-up draft to clear from the main-process store", async () => {
    const saved = await desktopSettings.read();
    return saved.composerDrafts?.pendingNewThread?.text === separatePendingPrompt
      && Object.keys(saved.composerDrafts?.threadFollowups || {}).length === 0;
  });
  await clickProjectAction(project.id);
  await waitFor("the pending draft before Send", () => evaluate(`(
    document.querySelector('#newThreadPrompt')?.value === ${JSON.stringify(separatePendingPrompt)}
      && document.querySelector('#createThread')?.disabled === false
  )`));
  await click(`[data-thread="${firstThread.id}"]`);
  const replacementFollowupPrompt = "Keep this replacement follow-up through pending Send.";
  await setValue("#threadPrompt", replacementFollowupPrompt);
  await clickProjectAction(project.id);
  await waitFor("the pending draft after saved follow-up Send", () => evaluate(`(
    document.querySelector('#newThreadPrompt')?.value === ${JSON.stringify(separatePendingPrompt)}
      && document.querySelector('#createThread')?.disabled === false
  )`));
  await click("#createThread");
  const secondThread = await waitFor("the second project thread", async () => {
    const state = await productRequest(productSession, "/api/state");
    return state.threads.length === 2
      && state.threads.every((thread) => String(thread.projectId) === String(project.id))
      ? state.threads.find((thread) => String(thread.id) !== String(firstThread.id))
      : false;
  }, 20_000);
  await waitFor("the second thread workspace", () => evaluate(`(
    !document.querySelector('#threadView')?.classList.contains('hidden')
      && document.querySelector('[data-thread="${secondThread.id}"]')?.classList.contains('active')
      && document.querySelector('#threadPrompt')?.disabled === false
  )`), 20_000);
  await clickProjectAction(project.id);
  await waitFor("the cleared pending draft after Send", () => evaluate(`(
    !document.querySelector('#newThreadView')?.classList.contains('hidden')
      && document.querySelector('#newThreadPrompt')?.value === ''
      && document.querySelector('#scopeLabel')?.textContent === ${JSON.stringify(project.name)}
  )`));
  await click(`[data-thread="${firstThread.id}"]`);
  try {
    await waitFor("the untouched saved-thread draft after the pending Send", () => evaluate(`(
      document.querySelector('#threadPrompt')?.value === ${JSON.stringify(replacementFollowupPrompt)}
    )`));
  } catch (error) {
    const draftState = await evaluate(`({
      prompt: document.querySelector('#threadPrompt')?.value,
      stored: localStorage.getItem('relayerComposerDraftsV1'),
    })`);
    throw new Error(`${error.message} ${JSON.stringify(draftState)}`);
  }
  await setValue("#threadPrompt", "");
  await waitFor("clearing the overriding draft reveals its failed-send retry", () => evaluate(`(
    document.querySelector('#threadPrompt')?.value === ${JSON.stringify(followupPrompt)}
  )`));
  await setValue("#threadPrompt", "");
  await clickProjectAction(project.id);
  await click(`[data-thread="${firstThread.id}"]`);
  await waitFor("the explicitly cleared saved-thread draft", () => evaluate(`(
    document.querySelector('#threadPrompt')?.value === ''
  )`));
  await waitFor("the failed-prompt clear tombstone in the main-process store", async () => {
    const saved = await desktopSettings.read();
    return Object.values(saved.composerDrafts?.threadFollowups || {}).includes("");
  });

  await clickProjectAction(project.id);
  await setValue("#newThreadPrompt", "Clear this pending draft with global New Thread.");
  await click("#newThread");
  await waitFor("global New Thread to clear the pending draft", async () => {
    const saved = await desktopSettings.read();
    return await evaluate(`(
      document.querySelector('#newThreadPrompt')?.value === ''
        && document.querySelector('#scopeLabel')?.textContent === 'No folder'
    )`) && saved.composerDrafts?.pendingNewThread == null;
  });

  // Acknowledge renderer writes before seeding the restart fixture through the same store.
  await evaluate("window.relayerDesktop.drafts.read()");
  window.destroy();
  window = undefined;
  await desktopSettings.flush();
  const folderDraft = {
    text: "Restore this exact folder-scoped draft.",
    scope: {
      kind: "folder",
      label: "unregistered-worktree",
      path: join(dataDirectory, "unregistered-worktree"),
      git: true,
      branch: "codex/folder-draft",
    },
  };
  await desktopSettings.flush();
  await desktopSettings.update((saved) => ({
    ...saved,
    composerDrafts: {
      ...(saved.composerDrafts || {}),
      pendingNewThread: folderDraft,
    },
  }));
  tutorialState = {
    status: "never-shown",
    automaticEligible: true,
  };
  automaticTutorialBegins = 0;
  await openWindow();
  await waitFor("the exact folder-scoped draft after restart", () => evaluate(`(
    document.querySelector('#newThreadPrompt')?.value === ${JSON.stringify(folderDraft.text)}
      && document.querySelector('#scopeLabel')?.textContent === ${JSON.stringify(folderDraft.scope.label)}
      && document.querySelector('#folderSummary')?.textContent.includes(${JSON.stringify(folderDraft.scope.path)})
  )`));
  if (automaticTutorialBegins !== 0) {
    throw new Error("A restored pending draft was replaced by automatic onboarding.");
  }

  if (demoVideo) await demoVideo.finish();
  process.stdout.write(`RELAYER_PROJECT_NEW_THREAD ${JSON.stringify({
    passed: true,
    projectId: project.id,
    threads: 2,
    restartPersistence: true,
    projectCollapse: true,
    layerSelectionRestartPersistence: true,
    evidence,
  })}\n`);
  exitCode = 0;
}

async function shutdown() {
  window?.destroy();
  keepaliveWindow?.destroy();
  unregisterTestIpc();
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

process.stdout.write("Starting isolated project-row New Thread test...\n");
void app.whenReady()
  .then(run)
  .catch((error) => {
    exitCode = 1;
    process.exitCode = 1;
    process.stderr.write(`${error.stack || error.message}\n`);
  })
  .finally(shutdown);
