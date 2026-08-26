import { app, BrowserWindow, ipcMain } from "electron";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createApprovalFixtureFactory } from "@relayer/eval-runner";

import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-approval-smoke-"));
const services = [];
const observations = [];
let window;
let exitCode = 1;

app.setName("Relayer Approval Smoke");
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
  ipcMain.handle("relayer:provider-status", () => ({
    adapters: [],
    definitions: [],
    hasCompletedOnboarding: true,
  }));
  ipcMain.handle("relayer:tutorial-read", () => ({ status: "never-shown", automaticEligible: false }));
  ipcMain.handle("relayer:tutorial-begin-automatic", () => ({ started: false }));
  ipcMain.handle("relayer:tutorial-begin-manual", () => ({ started: false }));
  ipcMain.handle("relayer:tutorial-dismiss", () => ({ status: "dismissed" }));
  ipcMain.handle("relayer:tutorial-complete", () => ({ status: "completed" }));
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
    "relayer:provider-status",
    "relayer:tutorial-read",
    "relayer:tutorial-begin-automatic",
    "relayer:tutorial-begin-manual",
    "relayer:tutorial-dismiss",
    "relayer:tutorial-complete",
    "relayer:update-status",
  ]) {
    ipcMain.removeHandler(channel);
  }
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

async function threadDetail(session, threadId) {
  return productRequest(session, `/api/threads/${threadId}`);
}

async function waitForThread(session, threadId, check, label) {
  return waitFor(label, async () => {
    const detail = await threadDetail(session, threadId);
    return check(detail) ? detail : false;
  });
}

async function openThread(productSession, threadId) {
  await window.loadURL(`${productSession.origin}/?threadId=${encodeURIComponent(threadId)}`);
  try {
    await waitFor("the ordinary product workspace", () => window.webContents.executeJavaScript(`(() => (
      !document.querySelector("#threadView")?.classList.contains("hidden")
      && Boolean(document.querySelector("#threadComposer"))
      && Boolean(document.querySelector("#turnPickerButton"))
    ))()`));
  } catch (error) {
    const state = await window.webContents.executeJavaScript(`(() => ({
      appHidden: document.querySelector("#appShell")?.classList.contains("hidden"),
      authHidden: document.querySelector("#authScreen")?.classList.contains("hidden"),
      threadHidden: document.querySelector("#threadView")?.classList.contains("hidden"),
      threadHtml: document.querySelector("#threadView")?.innerHTML,
      toast: document.querySelector("#toast")?.textContent,
    }))()`);
    throw new Error(`${error.message} state=${JSON.stringify(state)}`);
  }
}

async function approvalDockState() {
  return window.webContents.executeJavaScript(`(() => {
    const dock = document.querySelector("#approvalDock");
    if (!dock || dock.classList.contains("hidden") || dock.classList.contains("history-only")) return false;
    return {
      requestId: dock.dataset.requestId,
      activeElement: document.activeElement?.id,
      title: document.querySelector("#approvalTitle")?.textContent,
      action: document.querySelector("#approvalActionValue")?.textContent,
      scope: document.querySelector("#approvalScopeDescription")?.textContent,
      queue: document.querySelector("#approvalQueuePosition")?.textContent,
      queueLive: document.querySelector("#approvalQueuePosition")?.getAttribute("aria-live"),
      settingsLabel: document.querySelector("#conversationSettingsButton")?.getAttribute("aria-label"),
      runStateRemoved: !document.querySelector("#runState"),
      composerHidden: document.querySelector("#threadComposerShell")?.classList.contains("hidden"),
      buttons: ["denyApproval", "approveOnce", "approveAlways"].map((id) => ({
        id,
        text: document.getElementById(id)?.textContent?.replace(/\\s+/g, " ").trim(),
        disabled: document.getElementById(id)?.disabled,
      })),
    };
  })()`);
}

async function click(selector) {
  await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.click()`);
}

async function holdNextDecision() {
  await window.webContents.executeJavaScript(`(() => {
    const original = window.fetch.bind(window);
    let held = false;
    window.__releaseApprovalDecision = null;
    window.fetch = (input, init) => {
      const target = typeof input === "string" ? input : input?.url || String(input);
      if (!held && target.includes("/approvals/") && target.endsWith("/decision")) {
        held = true;
        return new Promise((resolve, reject) => {
          window.__releaseApprovalDecision = () => original(input, init).then(resolve, reject);
        });
      }
      return original(input, init);
    };
  })()`);
}

async function releaseHeldDecision() {
  await window.webContents.executeJavaScript(`window.__releaseApprovalDecision?.()`);
}

async function createInteraction(productSession, threadId, text) {
  return productRequest(productSession, `/api/threads/${threadId}/interactions`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

async function run() {
  process.stdout.write("Electron application ready.\n");
  registerTestIpc();
  const configurationPath = join(repositoryRoot, "harnesses", "fixture-approval.yaml");
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [configurationPath],
    additionalImplementations: {
      "fixture.approval": createApprovalFixtureFactory({
        observe: (observation) => observations.push(observation),
      }),
    },
  });
  services.push(runtime);
  const runtimeSession = await runtime.start();
  const modelCatalogRefreshServer = await startModelCatalogRefreshServer({
    refresh: async () => undefined,
  });
  services.push(modelCatalogRefreshServer);
  const product = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    providerCatalogRefreshSession: modelCatalogRefreshServer.session,
    defaultHarnessConfiguration: "fixture-approval",
    allowHarnessOverride: true,
  });
  services.push(product);
  const productSession = await product.start();
  const createWindow = createWindowFactory({
    BrowserWindow,
    desktopDirectory: join(repositoryRoot, "desktop"),
    getAppearance: () => "dark",
    updater: { status: () => ({ phase: "development" }) },
  });
  window = await createWindow(productSession);
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.error(`Renderer console: ${message}`);
  });
  window.show();

  const created = await productRequest(productSession, "/api/threads", {
    method: "POST",
    body: JSON.stringify({
      initialMessage: "Create the deterministic approval baseline.",
      permissionProfileId: "ask",
    }),
  });
  const threadId = created.id;
  await waitForThread(
    productSession,
    threadId,
    (detail) => detail.interactions[0]?.completionStatus === "accepted",
    "the baseline graph",
  );
  await openThread(productSession, threadId);

  const onceInteraction = await createInteraction(productSession, threadId, "Exercise approve once and denial adaptation.");
  await waitForThread(
    productSession,
    threadId,
    (detail) => detail.approvals?.filter((receipt) => receipt.resolution == null).length === 1,
    "the first approve-once request",
  );
  await openThread(productSession, threadId);
  const firstDock = await waitFor("the focused approval dock", async () => {
    const state = await approvalDockState();
    return state?.activeElement === "approvalDock" ? state : false;
  });
  if (firstDock.action !== "npm test" || !firstDock.scope?.includes("this live harness session")) {
    throw new Error(`The dock did not show exact normalized authority: ${JSON.stringify(firstDock)}`);
  }
  if (!firstDock.composerHidden || firstDock.settingsLabel !== "Conversation settings" || !firstDock.runStateRemoved || firstDock.queueLive !== "polite") {
    throw new Error(`The approval waiting presentation was incomplete: ${JSON.stringify(firstDock)}`);
  }
  if (firstDock.buttons.map(({ text }) => text).join("|") !== "Deny|Approve once|Approve alwaysthis session") {
    throw new Error(`The three decisions were not discoverable: ${JSON.stringify(firstDock.buttons)}`);
  }

  await click("#previousTurn");
  const graphVisibleWhileWaiting = await waitFor("the prior graph while approval remains pending", () => (
    window.webContents.executeJavaScript(`(() => (
      !document.querySelector("#graphStage")?.classList.contains("hidden")
      && document.querySelectorAll(".graph-node").length > 0
      && !document.querySelector("#approvalDock")?.classList.contains("hidden")
    ))()`)
  ));

  await holdNextDecision();
  await click("#approveOnce");
  await waitFor("disabled approval buttons", () => window.webContents.executeJavaScript(`(() => (
    document.querySelector("#approvalDock")?.getAttribute("aria-busy") === "true"
    && ["denyApproval", "approveOnce", "approveAlways"].every((id) => document.getElementById(id)?.disabled)
  ))()`));
  await releaseHeldDecision();
  const repeatedDock = await waitFor("the repeated exact request after approve once", async () => {
    const state = await approvalDockState();
    return state && state.requestId !== firstDock.requestId && state.action === "npm test" ? state : false;
  });
  await click("#denyApproval");
  let onceAccepted;
  try {
    onceAccepted = await waitForThread(
      productSession,
      threadId,
      (detail) => detail.interactions.find((interaction) => String(interaction.id) === String(onceInteraction.id))?.completionStatus === "accepted",
      "the denial-adapted completion",
    );
  } catch (error) {
    const detail = await threadDetail(productSession, threadId);
    throw new Error(`${error.message} detail=${JSON.stringify(detail)}`);
  }
  await openThread(productSession, threadId);
  const resolvedPresentation = await waitFor("the restored composer and compact receipts", () => (
    window.webContents.executeJavaScript(`(() => {
      const dock = document.querySelector("#approvalDock");
      const composer = document.querySelector("#threadComposer");
      const history = [...document.querySelectorAll("#approvalHistoryList > li")].map((item) => item.textContent);
      const historyElement = document.querySelector("#approvalHistory");
      return dock?.classList.contains("history-only") && !composer?.classList.contains("hidden") && historyElement?.open && history.length >= 2
        ? { history, historyOpen: historyElement.open, focus: document.activeElement?.id }
        : false;
    })()`)
  ));

  const alwaysInteraction = await createInteraction(productSession, threadId, "Exercise session approval and an isolated near match.");
  await waitForThread(
    productSession,
    threadId,
    (detail) => detail.approvals?.filter((receipt) => receipt.resolution == null).length === 3,
    "three concurrent approval requests",
  );
  await openThread(productSession, threadId);
  const queuedDock = await waitFor("the three-request approval queue", async () => {
    const state = await approvalDockState();
    return state?.queue === "1 of 3" && state.action === "npm run build" ? state : false;
  });
  await click("#approveAlways");
  let nearDock;
  try {
    nearDock = await waitFor("the unmatched request after approve always", async () => {
      const state = await approvalDockState();
      return state?.action === "npm run deploy" && state.queue === "1 of 1" ? state : false;
    });
  } catch (error) {
    const dock = await approvalDockState();
    const detail = await threadDetail(productSession, threadId);
    throw new Error(`${error.message} dock=${JSON.stringify(dock)} approvals=${JSON.stringify(detail.approvals)}`);
  }
  await click("#denyApproval");
  await waitForThread(
    productSession,
    threadId,
    (detail) => detail.interactions.find((interaction) => String(interaction.id) === String(alwaysInteraction.id))?.completionStatus === "accepted",
    "the approve-always completion",
  );

  const futureInteraction = await createInteraction(productSession, threadId, "Consume the exact live-session grant in a later completion.");
  let futureAccepted;
  try {
    futureAccepted = await waitForThread(
      productSession,
      threadId,
      (detail) => detail.interactions.find((interaction) => String(interaction.id) === String(futureInteraction.id))?.completionStatus === "accepted",
      "the future exact request to auto-resolve",
    );
  } catch (error) {
    const detail = await threadDetail(productSession, threadId);
    throw new Error(`${error.message} detail=${JSON.stringify(detail)}`);
  }
  const futureReceipt = futureAccepted.approvals.find((receipt) => (
    String(receipt.request.correlation.interactionId) === String(futureInteraction.id)
  ));
  if (futureReceipt?.resolution?.actor !== "session_grant" || futureReceipt.resolution.decision !== "approve_once") {
    throw new Error(`The later completion did not consume the live-session grant: ${JSON.stringify(futureReceipt)}`);
  }
  await openThread(productSession, threadId);
  const scrollableHistory = await waitFor("fixed scrollable approval history", () => (
    window.webContents.executeJavaScript(`(() => {
      const list = document.querySelector("#approvalHistoryList");
      const history = document.querySelector("#approvalHistory");
      const dock = document.querySelector("#approvalDock");
      const initialHeight = list?.clientHeight;
      const initialDockRect = dock?.getBoundingClientRect();
      if (!history?.open || initialHeight !== 64 || list.scrollHeight <= initialHeight || getComputedStyle(list).overflowY !== "auto" || !initialDockRect) return false;
      list.scrollTop = list.scrollHeight;
      const scrolledDockRect = dock.getBoundingClientRect();
      return list.scrollTop > 0
        && list.clientHeight === initialHeight
        && scrolledDockRect.top === initialDockRect.top
        && scrolledDockRect.height === initialDockRect.height
        ? { clientHeight: list.clientHeight, scrollHeight: list.scrollHeight, scrollTop: list.scrollTop, dockTop: scrolledDockRect.top, dockHeight: scrolledDockRect.height }
        : false;
    })()`)
  ));

  const expectedObservations = [
    [2, "once-first", "approve_once", "user", true],
    [2, "once-repeated", "deny", "user", false],
    [3, "always-source", "approve_always", "user", true],
    [3, "always-exact-pending", "approve_once", "session_grant", true],
    [3, "always-near-pending", "deny", "user", false],
    [4, "always-exact-future", "approve_once", "session_grant", true],
  ];
  const observed = observations.map((entry) => [
    entry.completion,
    entry.step,
    entry.decision,
    entry.actor,
    entry.protectedActionExecuted,
  ]);
  if (JSON.stringify(observed) !== JSON.stringify(expectedObservations)) {
    throw new Error(`Unexpected provider observations: ${JSON.stringify(observed)}`);
  }

  process.stdout.write(`RELAYER_APPROVAL_SMOKE ${JSON.stringify({
    passed: true,
    harness: "fixture-approval",
    inferenceCalls: 0,
    threadId,
    graphVisibleWhileWaiting,
    onceRequestIds: [firstDock.requestId, repeatedDock.requestId],
    queue: queuedDock.queue,
    unmatchedAction: nearDock.action,
    resolvedReceipts: resolvedPresentation.history.length,
    approvalHistoryOpen: resolvedPresentation.historyOpen,
    approvalHistoryViewport: scrollableHistory,
    finalStatus: futureAccepted.interactions.at(-1)?.completionStatus,
    observations: observed,
    approvalCount: onceAccepted.approvals.length,
  })}\n`);
  exitCode = 0;
}

async function shutdown() {
  window?.destroy();
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
  process.exitCode = exitCode;
  app.exit(exitCode);
}

process.stdout.write("Starting isolated Electron approval smoke test...\n");
void app.whenReady()
  .then(run)
  .catch((error) => process.stderr.write(`${error.stack || error.message}\n`))
  .finally(shutdown);
