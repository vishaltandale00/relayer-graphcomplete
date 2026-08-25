import { app, BrowserWindow, ipcMain } from "electron";
import { execFile as execFileCallback } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";

import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(import.meta.dirname, "..");
const evidenceDirectory = join(repositoryRoot, "docs", "prd", "assets", "evidence", "environment-rail");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-environment-rail-"));
const services = [];
const windows = [];
let exitCode = 1;
let reviewContext = {
  selectedExecutionId: "environment-rail-evidence",
  harnessConfigurationName: "fixture-task-system",
  readOnly: true,
  cases: [],
};

app.setName("Relayer Environment Rail Evidence");
const electronProfileDirectory = join(dataDirectory, "electron-profile");
mkdirSync(electronProfileDirectory, { recursive: true });
app.setPath("userData", electronProfileDirectory);
app.commandLine.appendSwitch("disable-gpu");

function registerTestIpc() {
  ipcMain.handle("relayer:account-read", () => ({
    status: "connected",
    account: { email: "zero-inference@relayer.test", planType: "Fixture" },
  }));
  ipcMain.handle("relayer:appearance-read", () => ({ appearance: "dark" }));
  ipcMain.handle("relayer:update-status", () => ({
    phase: "development",
    channel: "stable",
    version: "evidence",
    availableVersion: null,
    percent: null,
    error: null,
  }));
  ipcMain.handle("relayer-eval:review-context", () => reviewContext);
}

function unregisterTestIpc() {
  for (const channel of [
    "relayer:account-read",
    "relayer:appearance-read",
    "relayer:update-status",
    "relayer-eval:review-context",
  ]) ipcMain.removeHandler(channel);
}

async function waitFor(label, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForPaint(webContents) {
  await webContents.executeJavaScript(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
  );
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
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(value)}`);
  return value;
}

async function gitCommand(arguments_) {
  return (await execFile("git", ["-C", repositoryRoot, ...arguments_], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 5_000,
  })).stdout;
}

function parseShortstat(value) {
  return {
    additions: Number(value.match(/(\d+) insertion/)?.[1] || 0),
    deletions: Number(value.match(/(\d+) deletion/)?.[1] || 0),
  };
}

async function independentGitSnapshot() {
  let branch = null;
  let detached = false;
  try {
    branch = (await gitCommand(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  } catch (error) {
    if (error.code !== 1) throw error;
    detached = true;
  }
  const baseline = (await gitCommand(["rev-parse", "--verify", "HEAD"])).trim();
  const changes = parseShortstat(await gitCommand([
    "diff", "--shortstat", "--no-ext-diff", "--no-textconv", baseline, "--",
  ]));
  const untracked = await gitCommand(["ls-files", "--others", "--exclude-standard", "-z"]);
  const trackedChangedFiles = (await gitCommand(["diff", "--name-only", baseline, "--"]))
    .split("\n")
    .filter(Boolean).length;
  return {
    worktreeLabel: basename(repositoryRoot),
    branch,
    detached,
    changes: {
      ...changes,
      untrackedFiles: untracked.split("\0").filter(Boolean).length,
      trackedChangedFiles,
    },
  };
}

function roundedRect(rect) {
  if (!rect) return null;
  return Object.fromEntries(["left", "right", "top", "bottom", "width", "height"]
    .map((key) => [key, Math.round(rect[key] * 100) / 100]));
}

async function presentation(webContents) {
  return webContents.executeJavaScript(`(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      return element && !element.classList.contains("hidden") ? element.getBoundingClientRect().toJSON() : null;
    };
    const style = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const computed = getComputedStyle(element);
      return {
        borderTopWidth: computed.borderTopWidth,
        borderRightWidth: computed.borderRightWidth,
        borderBottomWidth: computed.borderBottomWidth,
        borderLeftWidth: computed.borderLeftWidth,
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      header: rect("#threadView .thread-header"),
      banner: rect("#interactionBanner"),
      environment: rect("#environmentPanel"),
      inspector: rect("#inspector"),
      graph: rect("#graphStage"),
      borders: {
        header: style("#threadView .thread-header"),
        banner: style("#interactionBanner"),
        environment: style("#environmentPanel"),
        inspector: style("#inspector"),
      },
      environmentVisible: Boolean(document.querySelector("#environmentPanel")?.offsetParent),
      inspectorVisible: !document.querySelector("#inspector")?.classList.contains("hidden"),
      selectedNodeId: document.querySelector(".graph-node.selected")?.dataset.node || null,
      detailTitle: document.querySelector("#detailTitle")?.textContent || null,
      activeElement: document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName,
      displayed: {
        worktreeLabel: document.querySelector("#environmentWorktree")?.textContent || null,
        branch: document.querySelector("#environmentBranch")?.textContent || null,
        additions: document.querySelector("#environmentAdditions")?.textContent || null,
        deletions: document.querySelector("#environmentDeletions")?.textContent || null,
        trackedFilesFallback: document.querySelector("#environmentTracked")?.textContent || null,
        untrackedFiles: document.querySelector("#environmentUntracked")?.textContent || null,
        interactionStatus: document.querySelector("#interactionStatus")?.textContent || null,
      },
    };
  })()`);
}

function requireNear(label, actual, expected, tolerance = 1) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected} ± ${tolerance}, received ${actual}`);
  }
}

function requireDesktopGeometry(label, value, { inspector = false } = {}) {
  if (!value.header || !value.banner || !value.environment) {
    throw new Error(`${label}: missing required workspace geometry.`);
  }
  requireNear(`${label} Environment top`, value.environment.top, value.header.top);
  requireNear(`${label} Environment bottom`, value.environment.bottom, value.banner.bottom);
  requireNear(`${label} Environment width`, value.environment.width, 340);
  requireNear(`${label} right inset`, value.viewport.width - value.environment.right, 12);
  requireNear(`${label} interaction gutter`, value.environment.left - value.banner.right, 12);
  if (inspector) {
    if (!value.inspector) throw new Error(`${label}: Node Details is not visible.`);
    requireNear(`${label} Node Details left`, value.inspector.left, value.environment.left);
    requireNear(`${label} Node Details width`, value.inspector.width, value.environment.width);
    requireNear(`${label} Node Details gap`, value.inspector.top - value.environment.bottom, 12);
  }
}

function requireVisibleBorders(label, borders) {
  for (const [surface, sides] of Object.entries(borders)) {
    if (!sides) continue;
    for (const [side, width] of Object.entries(sides)) {
      if (Number.parseFloat(width) < 1) throw new Error(`${label}: ${surface} ${side} is not visible.`);
    }
  }
}

function requireStackedGeometry(label, value) {
  if (!value.header || !value.banner || !value.environment || !value.inspector) {
    throw new Error(`${label}: missing required stacked workspace geometry.`);
  }
  if (!(value.header.bottom <= value.banner.top + 1
      && value.banner.bottom <= value.environment.top + 1
      && value.environment.bottom <= value.graph.top + 1
      && value.graph.bottom <= value.inspector.top + 1)) {
    throw new Error(`${label}: surfaces are not ordered header, banner, Environment, graph, Node Details.`);
  }
  if (value.environment.right > value.viewport.width + 1
      || value.inspector.right > value.viewport.width + 1) {
    throw new Error(`${label}: stacked rail overflowed the viewport.`);
  }
}

function comparableSnapshot(snapshot) {
  return {
    worktreeLabel: snapshot.worktreeLabel,
    branch: snapshot.branch,
    detached: snapshot.detached,
    changes: {
      additions: snapshot.changes.additions,
      deletions: snapshot.changes.deletions,
      trackedFiles: snapshot.changes.trackedFiles,
      untrackedFiles: snapshot.changes.untrackedFiles,
    },
  };
}

function requireGitParity(apiSnapshot, independent, displayed) {
  const expected = {
    worktreeLabel: independent.worktreeLabel,
    branch: independent.branch,
    detached: independent.detached,
    changes: {
      additions: independent.changes.additions,
      deletions: independent.changes.deletions,
      trackedFiles: independent.changes.trackedChangedFiles,
      untrackedFiles: independent.changes.untrackedFiles,
    },
  };
  const actual = comparableSnapshot(apiSnapshot);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Environment API does not match independent Git: ${JSON.stringify({ expected, actual })}`);
  }
  const expectedDisplay = {
    worktreeLabel: expected.worktreeLabel,
    branch: expected.detached ? "Detached HEAD" : expected.branch,
    additions: `+${expected.changes.additions}`,
    deletions: `−${expected.changes.deletions}`,
    untrackedFiles: `${expected.changes.untrackedFiles} files`,
  };
  for (const [key, expectedValue] of Object.entries(expectedDisplay)) {
    if (displayed[key] !== expectedValue) {
      throw new Error(`Displayed ${key} does not match Git: ${JSON.stringify({ expectedValue, actual: displayed[key] })}`);
    }
  }
  return expectedDisplay;
}

async function capture(webContents, filename) {
  await waitForPaint(webContents);
  const path = join(evidenceDirectory, filename);
  await writeFile(path, (await webContents.capturePage()).toPNG());
  return path;
}

async function setViewport(window, webContents, width, height = 920) {
  window.setContentSize(width, height);
  return waitFor(`the ${width}px viewport`, async () => {
    await waitForPaint(webContents);
    return await webContents.executeJavaScript(`innerWidth === ${width} && innerHeight === ${height}`);
  });
}

async function selectFirstNode(webContents) {
  await webContents.executeJavaScript(`document.querySelector("[data-node]")?.click()`);
  return waitFor("selected node details", async () => {
    const value = await presentation(webContents);
    return value.inspectorVisible && value.selectedNodeId && value.detailTitle ? value : false;
  });
}

async function run() {
  process.stdout.write("Starting isolated Environment rail evidence capture.\n");
  await mkdir(evidenceDirectory, { recursive: true });
  for (const filename of [
    "01-normal-environment.png",
    "02-normal-node-detail.png",
    "03-ultrawide-node-detail.png",
    "04-narrow-stacked-node-detail.png",
    "05-eval-node-detail.png",
    "manifest.json",
  ]) {
    const path = join(evidenceDirectory, filename);
    try {
      await access(path);
    } catch {
      await writeFile(path, "");
    }
  }
  registerTestIpc();

  const graphServerBinary = join(repositoryRoot, "target", "debug", "relayer-graph-server");
  const appServerBinary = join(repositoryRoot, "target", "debug", "relayer-app-server");
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary,
    configurationPaths: [join(repositoryRoot, "harnesses", "fixture-task-system.yaml")],
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
  product = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: appServerBinary,
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    providerCatalogRefreshSession: modelCatalogRefreshServer.session,
    defaultHarnessConfiguration: "fixture-task-system",
    enableReadOnlySession: true,
  });
  services.push(product);
  const productSession = await product.start();
  await product.publishProviderCatalog(catalogSnapshot);

  const project = await productRequest(productSession, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ path: repositoryRoot }),
  });
  const modelSettings = await productRequest(productSession, "/api/model-settings");
  const modelSelection = {
    familyId: modelSettings.families[0].id,
    providerId: "codex",
    modelId: "fixture-model",
  };
  const thread = await productRequest(productSession, "/api/threads", {
    method: "POST",
    body: JSON.stringify({
      title: "Environment rail verification",
      initialMessage: "Show the deterministic task system for Environment rail verification.",
      projectId: project.id,
      permissionProfileId: "auto",
      harnessId: "fixture-task-system",
      modelSelection,
    }),
  });
  const detail = await waitFor("the accepted fixture graph", async () => {
    const value = await productRequest(productSession, `/api/threads/${thread.id}`);
    return value.interactions[0]?.completionStatus === "accepted" ? value : false;
  });

  const createWindow = createWindowFactory({
    BrowserWindow,
    desktopDirectory: join(repositoryRoot, "desktop"),
    getAppearance: () => "dark",
    updater: { status: () => ({ phase: "development" }) },
  });
  const productWindow = await createWindow(productSession);
  windows.push(productWindow);
  productWindow.show();
  const productContents = productWindow.webContents;
  await productWindow.loadURL(`${productSession.origin}/?threadId=${encodeURIComponent(thread.id)}`);
  await setViewport(productWindow, productContents, 1480);
  await waitFor("the production Environment and graph", () => productContents.executeJavaScript(`(() => (
    document.querySelectorAll("[data-node]").length === 3
    && !document.querySelector("#environmentFacts")?.classList.contains("hidden")
    && document.querySelector("#interactionStatus")?.textContent === "Complete"
  ))()`));

  const independentGit = await independentGitSnapshot();
  const apiSnapshot = await productRequest(productSession, `/api/projects/${project.id}/environment`);
  const normalEnvironment = await presentation(productContents);
  requireDesktopGeometry("normal Environment-only", normalEnvironment);
  requireVisibleBorders("normal Environment-only", normalEnvironment.borders);
  const expectedDisplay = requireGitParity(apiSnapshot, independentGit, normalEnvironment.displayed);
  await capture(productContents, "01-normal-environment.png");

  const normalSelected = await selectFirstNode(productContents);
  requireDesktopGeometry("normal selected", normalSelected, { inspector: true });
  await capture(productContents, "02-normal-node-detail.png");

  await productContents.executeJavaScript(`document.querySelector("#closeInspector")?.click()`);
  const afterClose = await waitFor("Node Details close with Environment preserved", async () => {
    const value = await presentation(productContents);
    return !value.inspectorVisible && value.environmentVisible ? value : false;
  });
  await selectFirstNode(productContents);
  productContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  productContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  const afterEscape = await waitFor("Escape close with Environment preserved", async () => {
    const value = await presentation(productContents);
    return !value.inspectorVisible && value.environmentVisible && value.activeElement === "graphStage" ? value : false;
  });

  await setViewport(productWindow, productContents, 2998);
  const ultrawideSelected = await selectFirstNode(productContents);
  requireDesktopGeometry("ultrawide selected", ultrawideSelected, { inspector: true });
  await capture(productContents, "03-ultrawide-node-detail.png");

  await setViewport(productWindow, productContents, 1101);
  const responsiveDesktopSelected = await waitFor("1101px desktop rail", async () => {
    const value = await presentation(productContents);
    return value.inspectorVisible && value.environmentVisible ? value : false;
  });
  requireDesktopGeometry("1101px desktop selected", responsiveDesktopSelected, { inspector: true });

  await setViewport(productWindow, productContents, 1100);
  const responsiveStackedSelected = await waitFor("1100px stacked rail", async () => {
    const value = await presentation(productContents);
    return value.inspectorVisible && value.environmentVisible ? value : false;
  });
  requireStackedGeometry("1100px stacked selected", responsiveStackedSelected);

  // The shipped window currently has a 960px native minimum. Lower it only in
  // this evidence process so the production renderer's responsive breakpoint
  // can be exercised without substituting a browser mock.
  productWindow.setMinimumSize(600, 640);
  await setViewport(productWindow, productContents, 760);
  const narrowSelected = await waitFor("narrow stacked Node Details", async () => {
    const value = await presentation(productContents);
    return value.inspectorVisible && value.environmentVisible ? value : false;
  });
  requireStackedGeometry("760px stacked selected", narrowSelected);
  await capture(productContents, "04-narrow-stacked-node-detail.png");

  reviewContext = {
    ...reviewContext,
    cases: [{
      executionId: "environment-rail-evidence",
      name: "Environment rail evidence",
      status: "passed",
      threadIds: [thread.id],
      threads: [{ id: thread.id, name: detail.thread.title }],
    }],
  };
  const evalWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    show: false,
    backgroundColor: "#0b0c0d",
    webPreferences: {
      preload: join(repositoryRoot, "desktop", "preload", "eval-review.cjs"),
      additionalArguments: ["--relayer-eval-execution=environment-rail-evidence"],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windows.push(evalWindow);
  await evalWindow.webContents.session.cookies.set({
    url: productSession.origin,
    name: productSession.readOnlyCookie.name,
    value: productSession.readOnlyCookie.value,
    httpOnly: true,
    sameSite: "strict",
    secure: false,
  });
  await evalWindow.loadURL(`${productSession.origin}/?threadId=${encodeURIComponent(thread.id)}&review=1`);
  await setViewport(evalWindow, evalWindow.webContents, 1480);
  await waitFor("the read-only Eval Environment", () => evalWindow.webContents.executeJavaScript(`(() => (
    document.querySelector("#threadView")?.dataset.workspaceMode === "review"
    && document.querySelectorAll("[data-node]").length === 3
    && !document.querySelector("#environmentFacts")?.classList.contains("hidden")
  ))()`));
  const evalSelected = await selectFirstNode(evalWindow.webContents);
  requireDesktopGeometry("read-only Eval selected", evalSelected, { inspector: true });
  requireGitParity(apiSnapshot, independentGit, evalSelected.displayed);
  await capture(evalWindow.webContents, "05-eval-node-detail.png");

  const manifest = {
    passed: true,
    generatedAt: new Date().toISOString(),
      source: {
      runtime: "real Electron + production renderer + Rust app/graph servers",
      harness: "fixture-task-system",
      inferenceCalls: 0,
      projectPath: "[repository-root]",
      threadId: thread.id,
      interactionStatus: detail.interactions[0].completionStatus,
      narrowCapture: "Production renderer in real Electron with the evidence window minimum lowered to exercise 760px CSS.",
    },
    gitTruth: {
      independent: independentGit,
      api: apiSnapshot,
      displayed: normalEnvironment.displayed,
      expectedDisplay,
      matched: true,
    },
    interactionProof: {
      closeButton: {
        inspectorClosed: !afterClose.inspectorVisible,
        environmentPreserved: afterClose.environmentVisible,
      },
      escape: {
        inspectorClosed: !afterEscape.inspectorVisible,
        environmentPreserved: afterEscape.environmentVisible,
        focusRestoredTo: afterEscape.activeElement,
      },
      evalReadOnly: evalSelected.environmentVisible && evalSelected.inspectorVisible,
    },
    geometry: {
      normalEnvironment: {
        ...Object.fromEntries(["header", "banner", "environment", "inspector", "graph"]
          .map((key) => [key, roundedRect(normalEnvironment[key])])),
        viewport: normalEnvironment.viewport,
        borders: normalEnvironment.borders,
      },
      normalSelected: {
        ...Object.fromEntries(["header", "banner", "environment", "inspector", "graph"]
          .map((key) => [key, roundedRect(normalSelected[key])])),
        viewport: normalSelected.viewport,
      },
      ultrawideSelected: {
        ...Object.fromEntries(["header", "banner", "environment", "inspector", "graph"]
          .map((key) => [key, roundedRect(ultrawideSelected[key])])),
        viewport: ultrawideSelected.viewport,
      },
      responsiveDesktopSelected: {
        ...Object.fromEntries(["header", "banner", "environment", "inspector", "graph"]
          .map((key) => [key, roundedRect(responsiveDesktopSelected[key])])),
        viewport: responsiveDesktopSelected.viewport,
      },
      responsiveStackedSelected: {
        ...Object.fromEntries(["header", "banner", "environment", "inspector", "graph"]
          .map((key) => [key, roundedRect(responsiveStackedSelected[key])])),
        viewport: responsiveStackedSelected.viewport,
      },
      narrowSelected: {
        ...Object.fromEntries(["header", "banner", "environment", "inspector", "graph"]
          .map((key) => [key, roundedRect(narrowSelected[key])])),
        viewport: narrowSelected.viewport,
      },
      evalSelected: {
        ...Object.fromEntries(["header", "banner", "environment", "inspector", "graph"]
          .map((key) => [key, roundedRect(evalSelected[key])])),
        viewport: evalSelected.viewport,
      },
    },
    captures: [
      "01-normal-environment.png",
      "02-normal-node-detail.png",
      "03-ultrawide-node-detail.png",
      "04-narrow-stacked-node-detail.png",
      "05-eval-node-detail.png",
    ],
  };
  await writeFile(join(evidenceDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`RELAYER_ENVIRONMENT_RAIL_EVIDENCE ${JSON.stringify(manifest)}\n`);
  exitCode = 0;
}

async function shutdown() {
  for (const window of windows.reverse()) window?.destroy();
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
  app.exit(exitCode);
}

void app.whenReady()
  .then(run)
  .catch((error) => {
    exitCode = 1;
    process.exitCode = 1;
    process.stderr.write(`${error.stack || error.message}\n`);
  })
  .finally(shutdown);
