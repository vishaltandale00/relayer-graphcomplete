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
import { registerComposerDraftIpc } from "../desktop/main/ipc/register-ipc.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-project-new-thread-"));
const evidenceDirectory = process.env.RELAYER_PROJECT_NEW_THREAD_EVIDENCE_DIR
  || join(repositoryRoot, ".relayer", "evidence", "project-new-thread");
const services = [];
let window;
let keepaliveWindow;
let exitCode = 1;
let desktopSettings = createSettingsStore(dataDirectory);

app.setName("Relayer Project New Thread Test");
const electronProfileDirectory = join(dataDirectory, "electron-profile");
mkdirSync(electronProfileDirectory, { recursive: true });
app.setPath("userData", electronProfileDirectory);
app.commandLine.appendSwitch("disable-gpu");

function registerTestIpc() {
  ipcMain.handle("relayer:account-read", () => ({
    status: "signed-in",
    channel: "stable",
    subject: "fixture|project-new-thread",
  }));
  ipcMain.handle("relayer:appearance-read", () => ({ appearance: "dark" }));
  registerComposerDraftIpc({ ipcMain, settings: desktopSettings });
  ipcMain.handle("relayer:folder-choose", () => null);
  ipcMain.handle("relayer:provider-status", () => ({
    adapters: [],
    definitions: [],
    hasCompletedOnboarding: true,
  }));
  ipcMain.handle("relayer:tutorial-read", () => ({
    status: "dismissed",
    automaticEligible: false,
  }));
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
  for (const channel of [
    "relayer:account-read",
    "relayer:appearance-read",
    "relayer:composer-drafts-read",
    "relayer:composer-drafts-write",
    "relayer:folder-choose",
    "relayer:provider-status",
    "relayer:tutorial-read",
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
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [configurationPath],
    additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory },
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
    refresh: () => product.publishProviderCatalog(catalogSnapshot),
  });
  services.push(modelCatalogRefreshServer);
  let productSession;
  const startProduct = async () => {
    product = new RelayerAppServerService({
      userDataDirectory: dataDirectory,
      binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
      webDirectory: join(repositoryRoot, "desktop", "renderer"),
      permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
      runtimeSession,
      providerCatalogRefreshSession: modelCatalogRefreshServer.session,
      defaultHarnessConfiguration: "fixture-task-system",
    });
    services.push(product);
    productSession = await product.start();
    await product.publishProviderCatalog(catalogSnapshot);
  };
  await startProduct();
  await productRequest(productSession, "/api/model-families", {
    method: "POST",
    body: JSON.stringify({
      name: "Fixture models",
      enabled: true,
      members: [{ providerId: "codex", modelId: "fixture-model" }],
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
    BrowserWindow,
    desktopDirectory: join(repositoryRoot, "desktop"),
    getAppearance: () => "dark",
    updater: { status: () => ({ phase: "development" }) },
    openExternal: async () => undefined,
  });
  let webContents;
  const openWindow = async () => {
    window = await createWindow(productSession);
    webContents = window.webContents;
    window.show();
    await waitFor("the desktop workspace", () => webContents.executeJavaScript(`(
      !document.querySelector('#appShell')?.classList.contains('hidden')
      && !document.body.classList.contains('desktop-account-pending')
    )`));
  };
  const evaluate = (source) => webContents.executeJavaScript(source);
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  const clickProjectAction = async (projectId) => {
    const selector = `[data-project-new-thread="${projectId}"]`;
    const point = await evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
    })()`);
    if (!point) throw new Error(`Missing project action ${projectId}.`);
    webContents.sendInputEvent({ type: "mouseMove", ...point });
    await waitFor(`project action ${projectId} to reveal`, () => evaluate(`(
      getComputedStyle(document.querySelector(${JSON.stringify(selector)})).opacity === '1'
    )`));
    webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
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

  const rejectedDraftLimits = await evaluate(`Promise.all([
    window.relayerDesktop.drafts.write({
      pendingNewThread: { text: "x".repeat(1024 * 1024), scope: null },
      threadFollowups: {},
    }).then(() => false, (error) => error?.message?.includes("persistence limit")),
    window.relayerDesktop.drafts.write({
      pendingNewThread: null,
      threadFollowups: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [String(index), "draft"])),
    }).then(() => false, (error) => error?.message?.includes("persistence limit")),
  ])`);
  if (!rejectedDraftLimits.every(Boolean)) {
    throw new Error(`The production draft IPC did not enforce both persistence limits: ${JSON.stringify(rejectedDraftLimits)}`);
  }

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
  webContents.sendInputEvent({ type: "mouseMove", ...hoverPoint });
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
  evidence.hover = await captureEvidence("02-hover");
  webContents.sendInputEvent({ type: "mouseMove", x: 800, y: 400 });
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
      return result.active && result.opacity === "1" ? result : false;
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

  await clickProjectAction(secondProject.id);
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
  await click("#createThread");
  const firstThread = await waitFor("the first project thread", async () => {
    const state = await productRequest(productSession, "/api/state");
    if (state.threads.length !== 1) return false;
    const thread = state.threads[0];
    return String(thread.projectId) === String(project.id) ? thread : false;
  });

  const followupPrompt = "Keep this unsent follow-up with the saved thread.";
  await waitFor("the saved-thread composer", () => evaluate(`(
    !document.querySelector('#threadView')?.classList.contains('hidden')
      && document.querySelector('#threadPrompt')?.disabled === false
  )`));
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
  const previousOrigin = productSession.origin;
  window.destroy();
  window = undefined;
  services.splice(services.indexOf(product), 1);
  await product.close();
  desktopSettings = createSettingsStore(dataDirectory);
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
  await click(`[data-thread="${firstThread.id}"]`);
  await waitFor("the follow-up draft after app restart", () => evaluate(`(
    document.querySelector('#threadPrompt')?.value === ${JSON.stringify(followupPrompt)}
  )`));
  await waitFor("the saved follow-up Send action", () => evaluate(`(
    document.querySelector('#sendInteraction')?.disabled === false
  )`));
  await click("#sendInteraction");
  await waitFor("the saved follow-up draft to clear after Send", () => evaluate(`(
    document.querySelector('#threadPrompt')?.value === ''
  )`), 20_000);
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
  await clickProjectAction(project.id);
  await click(`[data-thread="${firstThread.id}"]`);
  await waitFor("the explicitly cleared saved-thread draft", () => evaluate(`(
    document.querySelector('#threadPrompt')?.value === ''
  )`));

  process.stdout.write(`RELAYER_PROJECT_NEW_THREAD ${JSON.stringify({
    passed: true,
    projectId: project.id,
    threads: 2,
    restartPersistence: true,
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
