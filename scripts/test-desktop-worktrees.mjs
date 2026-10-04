import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { app, BrowserWindow, ipcMain } from "electron";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";

import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createSettingsStore } from "../desktop/main/services/settings-store.mjs";
import { registerComposerDraftIpc, registerLayerSelectionIpc, registerWorktreeIpc } from "../desktop/main/ipc/register-ipc.mjs";
import { createWorktreeService } from "../desktop/main/services/worktree-service.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-worktrees-"));
const evidenceDirectory = process.env.RELAYER_WORKTREES_EVIDENCE_DIR
  || join(repositoryRoot, ".relayer", "evidence", "worktrees");
const services = [];
const nativeTargetDirectory = process.env.CARGO_TARGET_DIR || join(repositoryRoot, "target");
let worktrees = createWorktreeService({ worktreeRoot: join(dataDirectory, "worktrees"), storeDirectory: join(dataDirectory, "worktree-plans") });
let loseNextCreateReply = true;
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
  registerWorktreeIpc({ ipcMain, worktrees: { ...worktrees, create: async (input) => { const result = await worktrees.create(input); if (loseNextCreateReply) { loseNextCreateReply = false; throw new Error("Injected lost reply after completed Git mutation."); } return result; } } });
  ipcMain.handle("relayer:account-read", () => ({
    status: "signed-in",
    channel: "stable",
    subject: "fixture|project-new-thread",
  }));
  ipcMain.handle("relayer:appearance-read", () => ({ appearance: "dark" }));
  registerComposerDraftIpc({ ipcMain, settings: desktopSettings });
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
  const admittedDirectories = new Map();
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(nativeTargetDirectory, "debug", "relayer-graph-server"),
    configurationPaths: [configurationPath],
    additionalImplementations: { "fixture.task-system": (context) => { admittedDirectories.set(String(context.threadId), context.workingDirectory); return taskSystemFixtureFactory(context); } },
    acquireProviderExecution: async (providerId) => {
      providerAttempts += 1;
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
      members: [{ providerId: "codex", modelId: "fixture-model" }],
    }),
  });

  const projectDirectory = join(dataDirectory, "relayer-graphcomplete");
  await mkdir(projectDirectory, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", projectDirectory, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Worktree fixture");
  await writeFile(join(projectDirectory, "tracked.txt"), "committed fixture\n");
  git("add", "."); git("commit", "-m", "fixture");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  for (let index = 0; index < 100; index++) git("update-ref", `refs/heads/search-fixture-${index}`, "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const initialCommit = git("rev-parse", "HEAD");
  const linkedDirectory = join(dataDirectory, "external-linked");
  git("worktree", "add", "-b", "external-branch", linkedDirectory, "HEAD");
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
    webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  };
  const setValue = (selector, value) => evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  })()`);
  const environmentReady = (threadId, branch) => evaluate(`(async () => {
    const {appState,viewState}=await import('/src/state.js');
    return String(viewState.currentThreadId) === ${JSON.stringify(String(threadId))}
      && String(appState.environment?.threadId) === ${JSON.stringify(String(threadId))}
      && appState.environment?.status === 'ready'
      && !document.querySelector('#environmentFacts')?.classList.contains('hidden')
      && document.querySelector('#environmentLoading')?.classList.contains('hidden')
      && document.querySelector('#environmentBranch')?.textContent === ${JSON.stringify(branch)};
  })()`);
  const captureEvidence = async (name) => {
    await mkdir(evidenceDirectory, { recursive: true });
    const path = join(evidenceDirectory, `${name}.png`);
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await writeFile(path, (await webContents.capturePage()).toPNG());
    return path;
  };
  const scrollingWorktrees = Array.from({ length: 12 }, (_, index) => join(dataDirectory, `scroll-checkout-${String(index).padStart(2, "0")}`));
  for (const path of scrollingWorktrees) git("worktree", "add", "--detach", path, "HEAD");
  await openWindow();

  const evidence = {};
  const inventory = () => git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "));
  await clickProjectAction(project.id);
  await waitFor("checkout discovery", () => evaluate(`!document.querySelector('#checkoutControl')?.classList.contains('hidden') && document.querySelector('[data-checkout-index]') && document.querySelector('#checkoutButton')?.disabled === false`));
  await setValue("#newThreadPrompt", "Build a deterministic worktree fixture response.");
  await click("#checkoutButton");
  const scrollingList = await evaluate(`(() => {
    const list = document.querySelector('.checkout-list');
    const footer = document.querySelector('#newWorktree').closest('label');
    const last = list.lastElementChild;
    const before = footer.getBoundingClientRect().toJSON();
    list.focus();
    list.scrollTop = list.scrollHeight;
    const bounds = list.getBoundingClientRect();
    const row = last.getBoundingClientRect();
    const after = footer.getBoundingClientRect().toJSON();
    return { count: list.children.length, focusable: document.activeElement === list,
      bounded: list.clientHeight <= 320 && list.clientHeight <= innerHeight - 260,
      overflow: getComputedStyle(list).overflowY === 'auto' && list.scrollHeight > list.clientHeight,
      reachedLast: list.scrollTop > 0 && row.top >= bounds.top && row.bottom <= bounds.bottom + 1,
      footerVisible: !list.contains(footer) && after.top >= 0 && after.bottom <= innerHeight,
      footerFixed: before.top === after.top && before.bottom === after.bottom };
  })()`);
  if (scrollingList.count !== 14 || Object.entries(scrollingList).some(([key, value]) => key !== 'count' && value !== true)) throw new Error('Registered checkout scrolling failed: ' + JSON.stringify(scrollingList));
  evidence.scrollingCheckouts = await captureEvidence('07-many-registered-checkouts');
  await evaluate(`void(document.querySelector('.checkout-list').scrollTop = 0)`);
  const linkedIndex = await evaluate(`Array.from(document.querySelectorAll('[data-checkout-index]')).find(button => button.textContent.includes('external-branch'))?.dataset.checkoutIndex`);
  if (linkedIndex === undefined) throw new Error("External registered worktree is missing from Checkout.");
  await click(`[data-checkout-index="${linkedIndex}"]`);
  await waitFor("selected external checkout", () => evaluate(`document.querySelector('#folderSummary')?.textContent.includes('external-linked') && document.querySelector('#checkoutButton')?.disabled === false`));
  const selectedDraft = (await desktopSettings.read()).composerDrafts.pendingNewThread;
  if (selectedDraft.scope.path !== realpathSync(linkedDirectory)) throw new Error("Existing worktree selection did not bind exact path.");
  await click("#checkoutButton");
  const mainIndex = await evaluate(`Array.from(document.querySelectorAll('[data-checkout-index]')).find(button => button.querySelector('span')?.textContent === 'main')?.dataset.checkoutIndex`);
  for (const path of scrollingWorktrees) git("worktree", "remove", path);
  await click(`[data-checkout-index="${mainIndex}"]`);
  await waitFor("returned main checkout", () => evaluate(`document.querySelector('#folderSummary')?.textContent.includes('relayer-graphcomplete') && document.querySelector('#checkoutButton')?.disabled === false`));
  await click("#checkoutButton");
  await click("#newWorktree");
  await waitFor("new-worktree returns focus to prompt", () => evaluate(`document.activeElement?.id === 'newThreadPrompt' && !document.querySelector('#checkoutMenu')?.classList.contains('hidden') && document.querySelector('#worktreeBasePicker')?.classList.contains('hidden')`));
  await waitFor("New worktree base control", () => evaluate(`Boolean(document.querySelector('#worktreeBase'))`));
  await click("#worktreeBaseButton");
  const compactPicker = await evaluate(`(() => {
    const trigger = document.querySelector('#worktreeBaseButton').getBoundingClientRect();
    const picker = document.querySelector('#worktreeBasePicker').getBoundingClientRect();
    const list = document.querySelector('#worktreeBaseList');
    const refs = Array.from(list.querySelectorAll('[data-base-ref]')).map(item => item.dataset.baseRef);
    return { right: picker.left >= trigger.right, bounded: list.clientHeight <= 180, scrollable: list.scrollHeight > list.clientHeight, overflow: getComputedStyle(list).overflowY === 'auto', pinned: refs[0] === 'refs/remotes/origin/main' && refs[1] === 'checkout', searchFocused: document.activeElement.id === 'worktreeBaseSearch', triggerRight: trigger.right, pickerLeft: picker.left };
  })()`);
  if (["right", "bounded", "scrollable", "overflow", "pinned", "searchFocused"].some(key => !compactPicker[key])) throw new Error("Compact branch flyout placement, scroll or pinned ordering failed: " + JSON.stringify(compactPicker));
  const defaultBase = await evaluate(`document.querySelector('#worktreeBase')?.value`);
  if (defaultBase !== "refs/remotes/origin/main") throw new Error(`Unexpected default base ${defaultBase}`);
  const cachedRemote = await evaluate(`Array.from(document.querySelector('#worktreeBase').options).some(option => option.value === 'refs/remotes/origin/main' && option.textContent.includes('cached'))`);
  if (!cachedRemote) throw new Error("Cached remote branch is not selectable.");
  const bounded = await evaluate(`document.querySelector('#worktreeBase').options.length <= 24`);
  if (!bounded) throw new Error("Branch results are unbounded.");
  await evaluate(`document.querySelector('#worktreeBaseSearch').value = 'search-fixture-99'; document.querySelector('#worktreeBaseSearch').dispatchEvent(new Event('input', { bubbles: true }))`);
  const searchable = await evaluate(`(() => { const values = Array.from(document.querySelector('#worktreeBase').options).map(option => option.value); return values.includes('checkout') && values.includes('refs/remotes/origin/main') && values.includes('refs/heads/search-fixture-99') && !values.includes('refs/heads/search-fixture-1'); })()`);
  if (!searchable) throw new Error("Branch search lost pinned bases or did not narrow results.");
  await evaluate(`document.querySelector('#worktreeBaseSearch').value = ''; document.querySelector('#worktreeBaseSearch').dispatchEvent(new Event('input', { bubbles: true }))`);
  if (inventory().length !== 2 || (await productRequest(productSession, "/api/state")).threads.length !== 0) throw new Error("Menu choice mutated Git or created a thread before Send.");
  await waitFor("visible New worktree menu", () => evaluate("document.querySelector('#checkoutMenu')?.classList.contains('hidden') === false && document.querySelector('#newWorktree')?.checked === true"));
  evidence.menu = await captureEvidence("01-checkout-menu");
  await evaluate(`document.querySelector('[data-base-ref="refs/remotes/origin/main"]').focus()`);
  webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  await waitFor("base selection returns to prompt", () => evaluate(`document.activeElement?.id === 'newThreadPrompt'`));
  await waitFor("Send enabled", () => evaluate(`document.querySelector('#createThread')?.disabled === false`));
  webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  await waitFor("lost-create-reply retained draft", () => evaluate(`document.querySelector('#checkoutNotice')?.textContent.includes('Injected lost reply')`));
  if (inventory().length !== 3 || (await productRequest(productSession, "/api/state")).threads.length !== 0) throw new Error("Lost reply did not retain exact partial Git success.");
  const pending = (await desktopSettings.read()).composerDrafts.pendingNewThread;
  const planId = pending.scope.checkout.planId;
  if (!planId || !pending.scope.checkout.planRequest?.planId) throw new Error("Durable plan receipt missing.");
  const plan = await worktrees.readPlan(planId);
  evidence.retry = await captureEvidence("02-retry-after-create");
  window.destroy(); window = null;
  unregisterTestIpc();
  desktopSettings = createSettingsStore(dataDirectory);
  worktrees = createWorktreeService({ worktreeRoot: join(dataDirectory, "worktrees"), storeDirectory: join(dataDirectory, "worktree-plans") });
  registerTestIpc();
  await openWindow();
  await waitFor("reopened draft and checkout", () => evaluate(`document.querySelector('#newThreadPrompt')?.value === ${JSON.stringify(pending.text)} && document.querySelector('#checkoutLabel')?.textContent === 'Checkout' && document.querySelector('#createThread')?.disabled === false`));
  const reopened = (await desktopSettings.read()).composerDrafts.pendingNewThread;
  if (reopened.scope.checkout.planId !== planId) throw new Error("Reopen replaced the known creation receipt.");
  await click("#checkoutButton");
  const retainedChoice = await evaluate(`document.querySelector('#newWorktree')?.checked === true && document.querySelector('#worktreeBase')?.value === 'refs/remotes/origin/main'`);
  if (!retainedChoice) throw new Error("Reopen lost New worktree/base choice.");
  await click("#checkoutButton");
  await evaluate(`document.querySelector('#newThreadPrompt').focus()`);
  webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  const thread = await waitFor("created exact-location thread", async () => {
    const state = await productRequest(productSession, "/api/state");
    return state.threads.length === 1 ? state.threads[0] : false;
  });
  if (thread.workingDirectory !== realpathSync(plan.path) || inventory().length !== 3) throw new Error(`Retry duplicated checkout or changed cwd: ${JSON.stringify(thread)}`);
  const accepted = await waitFor("accepted fixture graph", async () => {
    const detail = await productRequest(productSession, `/api/threads/${thread.id}`);
    return detail.interactions.some(turn => turn.completionStatus === "accepted") ? detail : false;
  }, 30000);
  await waitFor("production graph rendered", () => evaluate(`document.querySelectorAll('.graph-node').length > 0`));
  evidence.graph = await captureEvidence("03-accepted-worktree-thread");
  if (admittedDirectories.get(String(thread.id)) !== thread.workingDirectory) throw new Error("Fixture harness received a different execution cwd from the saved thread binding.");
  // Seed only a realistic pre-consolidation project record. All thread admission,
  // graph authoring, consolidation and layer reads use production boundaries.
  const legacyProjectId = 80000;
  const seedStore = new DatabaseSync(join(dataDirectory, "product-data", "product.sqlite3"));
  try {
    seedStore.prepare("INSERT INTO projects(id,name,path,created_at,updated_at) VALUES(?,'Legacy linked project',?,'2020-01-01','2020-01-01')").run(legacyProjectId, realpathSync(linkedDirectory));
  } finally { seedStore.close(); }
  const legacyThread = await productRequest(productSession, "/api/threads", { method: "POST", body: JSON.stringify({ title: "Legacy checkout history", initialMessage: "Author an accepted graph in the original legacy scope.", permissionProfileId: "auto", harnessId: "fixture-task-system", modelSelection: accepted.interactions[0].modelSelection, projectId: legacyProjectId, workingDirectory: realpathSync(linkedDirectory), creationRequestId: "legacy-worktree-graph-fixture" }) });
  const legacyDetail = await waitFor("accepted legacy graph before grouping", async () => {
    const detail = await productRequest(productSession, `/api/threads/${legacyThread.id}`);
    return detail.interactions.some(turn => turn.completionStatus === "accepted") ? detail : false;
  }, 30000);
  const legacyTurn = legacyDetail.interactions.find(turn => turn.completionStatus === "accepted");
  const legacyLayerId = legacyTurn.completionOutput.rootLayer.layer.id;
  const legacyLayerPath = `/api/threads/${legacyThread.id}/interactions/${legacyTurn.id}/layers/${legacyLayerId}`;
  const beforeGrouping = await productRequest(productSession, legacyLayerPath);
  await productRequest(productSession, "/api/projects/consolidate", { method: "POST" });
  const groupedLegacy = await productRequest(productSession, `/api/threads/${legacyThread.id}`);
  const afterGrouping = await productRequest(productSession, legacyLayerPath);
  if (groupedLegacy.thread.projectId !== legacyProjectId || groupedLegacy.thread.groupedProjectId !== project.id || groupedLegacy.thread.workingDirectory !== realpathSync(linkedDirectory) || JSON.stringify(beforeGrouping) !== JSON.stringify(afterGrouping)) throw new Error("Root consolidation rewrote legacy provenance/cwd or changed accepted layer visibility.");
  if (admittedDirectories.get(String(legacyThread.id)) !== realpathSync(linkedDirectory)) throw new Error("Legacy harness ran in a different checkout before consolidation.");
  const createdBranch = execFileSync("git", ["-C", plan.path, "branch", "--show-current"], { encoding: "utf8" }).trim();
  const createdCommit = execFileSync("git", ["-C", plan.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^relayer\/[a-f0-9]{32}$/.test(createdBranch) || createdCommit !== initialCommit) throw new Error("Managed automatic branch did not retain selected committed base.");
  const comparisonThread = await productRequest(productSession, "/api/threads", { method: "POST", body: JSON.stringify({ title: "Main checkout comparison", initialMessage: "Author a main-checkout comparison graph.", permissionProfileId: "auto", harnessId: "fixture-task-system", modelSelection: accepted.interactions[0].modelSelection, projectId: project.id, workingDirectory: realpathSync(projectDirectory), creationRequestId: "main-checkout-comparison-fixture" }) });
  await waitFor("accepted main checkout comparison", async () => (await productRequest(productSession, `/api/threads/${comparisonThread.id}`)).interactions.some(turn => turn.completionStatus === "accepted"), 30000);
  window.destroy(); window = null;
  await product.close(); await startProduct();
  await openWindow();
  await click(`[data-thread="${thread.id}"]`);
  await waitFor("accepted graph after server reopen", () => evaluate(`document.querySelectorAll('.graph-node').length > 0`));
  const restored = await productRequest(productSession, `/api/threads/${thread.id}`);
  if (restored.thread.workingDirectory !== thread.workingDirectory || !restored.interactions.some(turn => turn.completionStatus === "accepted")) throw new Error(`Reopen changed binding or accepted history: ${JSON.stringify(restored)}`);
  evidence.reopened = await captureEvidence("04-reopened-exact-thread");
  const projectEnvironment = await productRequest(productSession, `/api/projects/${project.id}/environment`);
  const threadEnvironment = await productRequest(productSession, `/api/projects/${project.id}/environment?threadId=${thread.id}`);
  if (projectEnvironment.branch !== "main" || threadEnvironment.branch !== createdBranch) throw new Error("Thread Environment substituted project checkout facts.");
  for (const [requestedProject, requestedThread] of [[secondProject.id, thread.id], [project.id, legacyThread.id]]) {
    const rejected = await fetch(new URL(`/api/projects/${requestedProject}/environment?threadId=${requestedThread}`, productSession.origin), { headers: { Cookie: `${productSession.cookie.name}=${productSession.cookie.value}`, Accept: "application/json" } });
    if (rejected.status !== 404) throw new Error(`Foreign thread Environment was not rejected: ${rejected.status}`);
  }
  await waitFor("selected worktree Environment in renderer", () => environmentReady(thread.id, createdBranch));
  await click("#environmentToggle");
  evidence.environment = await captureEvidence("06-selected-worktree-environment");
  await click(`[data-thread="${comparisonThread.id}"]`);
  await waitFor("same-project main checkout Environment", () => environmentReady(comparisonThread.id, 'main'));
  await click(`[data-thread="${legacyThread.id}"]`);
  await waitFor("grouped alias Environment retains original checkout", async () => await environmentReady(legacyThread.id, 'external-branch') && await evaluate(`document.querySelector('#threadScope')?.textContent.startsWith('relayer-graphcomplete')`));
  // Delay one real HTTP response to ensure same-project thread navigation
  // rejects stale facts rather than displaying the late checkout's branch.
  await click(`[data-thread="${comparisonThread.id}"]`);
  await waitFor("comparison Environment before deferred response", () => environmentReady(comparisonThread.id, 'main'));
  await evaluate(`(() => {
    window.__originalFixtureFetch = window.fetch;
    window.__environmentHeld = false;
    window.__environmentDelivered = false;
    window.fetch = async (...args) => {
      const response = await window.__originalFixtureFetch(...args);
      if (!window.__environmentHeld && String(args[0]).includes('/environment?threadId=${thread.id}')) {
        window.__environmentHeld = true;
        await new Promise(resolve => { window.__releaseFixtureEnvironment = resolve; });
        const originalJson = response.json.bind(response);
        response.json = async () => { const value = await originalJson(); window.__environmentDelivered = true; return value; };
      }
      return response;
    };
  })()`);
  await click(`[data-thread="${thread.id}"]`);
  await waitFor("real worktree Environment response held", () => evaluate(`Boolean(window.__releaseFixtureEnvironment)`));
  const waitingEnvironment = await evaluate(`document.querySelector('#environmentFacts')?.classList.contains('hidden') && !document.querySelector('#environmentLoading')?.classList.contains('hidden')`);
  if (!waitingEnvironment) throw new Error("Previous same-project checkout facts remained visible while the selected thread's Environment was loading.");
  await click(`[data-thread="${comparisonThread.id}"]`);
  await waitFor("newer same-project Environment wins", () => environmentReady(comparisonThread.id, 'main'));
  await evaluate(`window.__releaseFixtureEnvironment()`);
  await waitFor("held real response consumed", () => evaluate(`window.__environmentDelivered === true`));
  if (!await environmentReady(comparisonThread.id, 'main')) throw new Error("Late Environment response replaced a newer thread's checkout facts.");
  await evaluate(`void (window.fetch = window.__originalFixtureFetch)`);
  await click(`[data-thread="${thread.id}"]`);
  await waitFor("returned worktree Environment", () => environmentReady(thread.id, createdBranch)).catch(async (error) => {
    const diagnostic = await evaluate(`(async () => { const {appState,viewState}=await import('/src/state.js'); return {
      currentThreadId: viewState.currentThreadId, mainView:viewState.mainView,
      environment:appState.environment, threads:appState.threads.map(thread=>({id:thread.id,projectId:thread.projectId,workingDirectory:thread.workingDirectory})),
      selectedThread:document.querySelector('[data-thread].active')?.dataset.thread,
      branchText:document.querySelector('#environmentBranch')?.textContent,
      loadingHidden:document.querySelector('#environmentLoading')?.classList.contains('hidden'),
      factsHidden:document.querySelector('#environmentFacts')?.classList.contains('hidden'),
      environmentHeld:window.__environmentHeld, environmentDelivered:window.__environmentDelivered,
    }; })()`);
    process.stderr.write(`Environment return diagnostic: ${JSON.stringify(diagnostic)}\n`);
    evidence.failure = await captureEvidence("environment-return-failure");
    throw error;
  });
  // Removing the temporary saved checkout must block execution without
  // replacing its immutable cwd or destroying the existing accepted graph.
  const executionsBeforeRemoval = providerAttempts;
  await rm(plan.path, { recursive: true, force: true });
  let admissionError = null;
  try {
    await productRequest(productSession, `/api/threads/${thread.id}/interactions`, {
      method: "POST", body: JSON.stringify({ text: "Must not run in a fallback directory.", inputId: "missing-worktree-fixture", modelSelection: accepted.interactions[0].modelSelection }),
    });
  } catch (error) { admissionError = error.message; }
  const missingDetail = await waitFor("missing saved cwd blocks admission", async () => {
    const detail = await productRequest(productSession, `/api/threads/${thread.id}`);
    return admissionError || detail.interactions.some(turn => turn.completionStatus === "failed") ? detail : false;
  });
  const missingEnvironment = await productRequest(productSession, `/api/projects/${project.id}/environment?threadId=${thread.id}`);
  if (missingEnvironment.kind !== "unavailable") throw new Error("Missing saved cwd Environment silently inspected another checkout.");
  if (providerAttempts !== executionsBeforeRemoval || existsSync(plan.path) || missingDetail.thread.workingDirectory !== thread.workingDirectory || !missingDetail.interactions.some(turn => turn.completionStatus === "accepted")) throw new Error("Missing saved cwd ran, fell back, recreated files, or lost accepted history.");
  await clickProjectAction(secondProject.id);
  await click(`[data-thread="${thread.id}"]`);
  await waitFor("history readable despite absent cwd", () => evaluate(`document.querySelectorAll('.graph-node').length > 0`));
  evidence.missingHistory = await captureEvidence("05-missing-location-readable-history");
  const checkpoints = {
    boundedBranchSearchPinnedBases: true, enterCreatesAndStartsTask: true,
    registeredCheckoutListScroll: true,
    externalCheckoutSelection: true, cachedRemoteDefaultBase: true,
    sendOnlyMutation: true, interruptedCreateDurableReopenReuse: true,
    exactThreadWorkingDirectory: true, selectedCommittedBase: true,
    acceptedGraphAfterServerReopen: true, missingSavedCwdBlocksExecution: true,
    missingSavedCwdHistoryReadable: true,
    rootConsolidationAcceptedLayerVisibility: true, harnessReceivesExactCwd: true,
    environmentSelectedCheckout: true, environmentRejectsForeignThread: true, environmentIgnoresStaleThreadResponse: true,
  };
  const sources = ["scripts/test-desktop-worktrees.mjs", "scripts/run-worktree-test.mjs", "desktop/main/services/worktree-service.mjs", "desktop/main/ipc/register-ipc.mjs", "desktop/preload/index.cjs", "desktop/renderer/src/checkout.js", "desktop/renderer/styles.css", "desktop/renderer/src/worktree-controller.js", "desktop/renderer/src/threads.js", "desktop/renderer/src/composer-drafts.js", "desktop/renderer/src/environment-context.js", "desktop/renderer/src/product-workspace/workspace.js", "crates/relayer-app-server/src/api/environment.rs"];
  const sourceHashes = Object.fromEntries(sources.map(path => [path, createHash("sha256").update(readFileSync(join(repositoryRoot, path))).digest("hex")]));
  const binaryHashes = Object.fromEntries(["relayer-app-server", "relayer-graph-server"].map(name => [name, createHash("sha256").update(readFileSync(join(nativeTargetDirectory, "debug", name))).digest("hex")]));
  await writeFile(join(evidenceDirectory, "result.json"), JSON.stringify({ passed: true, restartPersistence: true, checkpoints, sourceHashes, binaryHashes, planId, workingDirectory: thread.workingDirectory, acceptedInteractions: accepted.interactions.length, evidence }, null, 2));
  process.stdout.write(`RELAYER_WORKTREES ${JSON.stringify({ passed: true, restartPersistence: true, checkpoints, evidence })}\n`);
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

process.stdout.write("Starting isolated production worktree test...\n");
void app.whenReady()
  .then(run)
  .catch((error) => {
    exitCode = 1;
    process.exitCode = 1;
    process.stderr.write(`${error.stack || error.message}\n`);
  })
  .finally(shutdown);
