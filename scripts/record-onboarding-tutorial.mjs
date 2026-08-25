import { app, BrowserWindow, ipcMain, screen } from "electron";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  EdgeObject,
  LayerLayoutObject,
  LayerObject,
  NodeObject,
  NodePlacementObject,
  RelayerGraphClient,
} from "@relayer/graph-client";

import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
import { CodexCredentialAdapter } from "../desktop/main/credentials/codex-credential-adapter.mjs";
import { CodexModelCatalogAdapter } from "../desktop/main/models/codex-model-catalog-adapter.mjs";
import { toProductCatalogSnapshot } from "../desktop/main/models/model-catalog-adapter.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createSettingsStore } from "../desktop/main/services/settings-store.mjs";
import { createTutorialLifecycle } from "../desktop/main/services/tutorial-lifecycle.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const liveInference = process.env.RELAYER_TUTORIAL_LIVE_INFERENCE === "1";
const outputPath = resolve(
  process.env.RELAYER_TUTORIAL_VIDEO
    || join(
      repositoryRoot,
      ".relayer",
      "evidence",
      "onboarding-tutorial",
      liveInference ? "interactive-tutorial-live.mp4" : "interactive-tutorial.mp4",
    ),
);
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-tutorial-video-"));
const ffmpegLogPath = join(dataDirectory, "ffmpeg.log");
const services = [];
let mainWindow;
let recorder;
let exitCode = 1;

app.setName(liveInference ? "Relayer Live Tutorial Proof" : "Relayer Tutorial Proof");
const electronProfileDirectory = join(dataDirectory, "electron-profile");
mkdirSync(electronProfileDirectory, { recursive: true });
app.setPath("userData", electronProfileDirectory);
app.commandLine.appendSwitch("disable-gpu");

class TutorialFixtureHarness {
  traceSupport() {
    return {
      prompt: "full",
      messages: "full",
      reasoningSummaries: "none",
      modelCalls: "none",
      toolCalls: "summary",
      usage: "none",
      childStreams: "none",
      nativeArtifacts: "none",
    };
  }

  state() {
    return {};
  }

  async complete(context) {
    const graph = new RelayerGraphClient(context.graph.acquireCapability());
    const novelty = new NodeObject(
      "star",
      "Novelty and routine",
      "New experiences create distinctive memories. Repeated routines are easier for memory to compress, which can make a stretch of time feel shorter in retrospect.",
      "concept",
      "novelty",
    );
    const attention = new NodeObject(
      "compass",
      "Attention",
      "Our sense of duration changes with what occupies our attention. Time can feel slow in the moment while an uneventful period later feels brief in memory.",
      "concept",
      "attention",
    );
    const memory = new NodeObject(
      "brain",
      "Memory",
      "Looking back, periods with more distinct remembered events can feel longer than equally long periods that blur together.",
      "concept",
      "memory",
    );
    const distinct = new NodeObject(
      "list",
      "Distinct events",
      "A week containing a new place, conversation, or skill leaves more retrieval cues than a week of repeated routines.",
      "detail",
      "distinct-events",
    );
    const patterns = new NodeObject(
      "rotate-ccw",
      "Repeated patterns",
      "Familiar days still take the same clock time, but fewer unique landmarks may remain when we reconstruct the period later.",
      "detail",
      "repeated-patterns",
    );
    for (const node of [novelty, attention, memory, distinct, patterns]) await graph.submitNode(node);
    const noveltyAttention = new EdgeObject([novelty, attention], "novelty-attention");
    const attentionMemory = new EdgeObject([attention, memory], "attention-memory");
    const distinctPatterns = new EdgeObject([distinct, patterns], "distinct-patterns");
    for (const edge of [noveltyAttention, attentionMemory, distinctPatterns]) await graph.createEdge(edge);
    const detailLayer = new LayerObject(
      [distinct, patterns],
      [distinctPatterns],
      new LayerLayoutObject([
        new NodePlacementObject(distinct, 0.5, 0.25),
        new NodePlacementObject(patterns, 0.5, 0.75),
      ]),
      "memory-detail-layer",
    );
    const rootLayer = new LayerObject(
      [novelty, attention, memory],
      [noveltyAttention, attentionMemory],
      new LayerLayoutObject([
        new NodePlacementObject(novelty, 0.2, 0.65),
        new NodePlacementObject(attention, 0.5, 0.5),
        new NodePlacementObject(memory, 0.8, 0.35),
      ]),
      "time-perception-layer",
    );
    await graph.submitLayer(detailLayer);
    await graph.submitLayer(rootLayer);
    await graph.addAction(memory, {
      kind: "navigate",
      relation: "expand",
      sourceLayer: rootLayer,
      label: "Explore memory",
      target: detailLayer,
      clientKey: "memory-detail",
    });
    await graph.addAction(context.inputGraph.id, {
      kind: "navigate",
      relation: "expand",
      label: "Response",
      target: rootLayer,
      clientKey: "response",
    });
    await graph.submit(context.inputGraph.id);
  }
}

function registerTestIpc(tutorial, { readAccount = () => ({
  status: "connected",
  account: { email: "tutorial@relayer.test", planType: "Fixture" },
}) } = {}) {
  ipcMain.handle("relayer:account-read", readAccount);
  ipcMain.handle("relayer:model-catalog-settings-open", () => ({ refreshed: true }));
  ipcMain.handle("relayer:model-catalog-refresh", () => ({ refreshed: true }));
  ipcMain.handle("relayer:appearance-read", () => ({ appearance: "dark" }));
  ipcMain.handle("relayer:appearance-set", () => ({ appearance: "dark" }));
  ipcMain.handle("relayer:update-status", () => ({
    phase: "development",
    channel: "stable",
    version: "test",
    availableVersion: null,
    percent: null,
    error: null,
  }));
  ipcMain.handle("relayer:tutorial-read", (_event, context) => tutorial.read(context));
  ipcMain.handle("relayer:tutorial-begin-automatic", (_event, context) => tutorial.beginAutomatic(context));
  ipcMain.handle("relayer:tutorial-begin-manual", () => tutorial.beginManual());
  ipcMain.handle("relayer:tutorial-dismiss", () => tutorial.dismiss());
  ipcMain.handle("relayer:tutorial-complete", () => tutorial.complete());
}

function unregisterTestIpc() {
  for (const channel of [
    "relayer:account-read",
    "relayer:model-catalog-settings-open",
    "relayer:model-catalog-refresh",
    "relayer:appearance-read",
    "relayer:appearance-set",
    "relayer:update-status",
    "relayer:tutorial-read",
    "relayer:tutorial-begin-automatic",
    "relayer:tutorial-begin-manual",
    "relayer:tutorial-dismiss",
    "relayer:tutorial-complete",
  ]) ipcMain.removeHandler(channel);
}

async function waitFor(label, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function pause(milliseconds = 850) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function productRequest(session, path) {
  const response = await fetch(new URL(path, session.origin), {
    headers: {
      Accept: "application/json",
      Cookie: `${session.cookie.name}=${session.cookie.value}`,
    },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}

async function selectorCenter(webContents, selector) {
  return webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
}

async function click(webContents, selector) {
  const point = await waitFor(selector, () => selectorCenter(webContents, selector));
  webContents.sendInputEvent({ type: "mouseMove", ...point });
  await pause(200);
  webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
}

async function typeText(webContents, selector, value) {
  await click(webContents, selector);
  webContents.insertText(value);
  await waitFor(`text in ${selector}`, () => webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)})?.value?.includes(${JSON.stringify(value)})`,
  ));
}

async function coachmark(webContents, heading) {
  return waitFor(`the ${heading} coach mark`, () => webContents.executeJavaScript(`(() => {
    const mark = document.querySelector(".tutorial-coachmark");
    if (mark?.querySelector("h2")?.textContent !== ${JSON.stringify(heading)}) return false;
    const target = document.querySelector(".tutorial-target");
    return {
      text: mark.textContent,
      targetId: target?.id || null,
      targetNode: target?.dataset?.node || null,
      targetAction: target?.dataset?.actionId || null,
      targetClass: target?.className || null,
    };
  })()`), 20_000);
}

async function startRecorder(webContents) {
  const ffmpeg = process.env.RELAYER_FFMPEG || "/opt/homebrew/bin/ffmpeg";
  await mkdir(dirname(outputPath), { recursive: true });
  const firstFrame = await webContents.capturePage();
  const { width, height } = firstFrame.getSize();
  const log = createWriteStream(ffmpegLogPath, { flags: "a" });
  const child = spawn(ffmpeg, [
    "-hide_banner",
    "-loglevel", "warning",
    "-f", "rawvideo",
    "-pixel_format", "bgra",
    "-video_size", `${width}x${height}`,
    "-framerate", "15",
    "-i", "pipe:0",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-an",
    "-y", outputPath,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  child.stderr.pipe(log);
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code) => code === 0
      ? resolveExit()
      : rejectExit(new Error(`ffmpeg exited with ${code}. See ${ffmpegLogPath}.`)));
  });
  let active = true;
  let frames = 0;
  const recordingStartedAt = Date.now();
  async function writeFrame(image) {
    if (!child.stdin.write(image.toBitmap())) {
      await new Promise((resolveDrain) => child.stdin.once("drain", resolveDrain));
    }
    frames += 1;
  }
  await writeFrame(firstFrame);
  const loop = (async () => {
    while (active) {
      const started = Date.now();
      const image = await webContents.capturePage();
      if (image.getSize().width !== width || image.getSize().height !== height) {
        throw new Error("The Electron content size changed while recording.");
      }
      const targetFrameCount = Math.max(
        frames + 1,
        Math.floor((Date.now() - recordingStartedAt) * 15 / 1_000) + 1,
      );
      while (frames < targetFrameCount) await writeFrame(image);
      await pause(Math.max(0, 40 - (Date.now() - started)));
    }
  })();
  return {
    child,
    log,
    loop,
    exit,
    frameCount: () => frames,
    stop: () => { active = false; },
  };
}

async function stopRecorder() {
  if (!recorder) return;
  const { child, log, loop, exit, stop } = recorder;
  stop();
  await loop;
  child.stdin.end();
  await exit;
  log.end();
  recorder = null;
}

async function run() {
  let credentials;
  let configurationPaths;
  let additionalImplementations;
  let defaultHarnessConfiguration;
  let catalogSnapshot;
  let discoverLiveCatalog;
  if (liveInference) {
    credentials = new CodexCredentialAdapter();
    services.push(credentials);
    const catalogAdapter = new CodexModelCatalogAdapter({ credentials });
    discoverLiveCatalog = async () => {
      const discoveredCatalog = await catalogAdapter.discover();
      if (discoveredCatalog.provider.status !== "available") {
        throw new Error(discoveredCatalog.provider.unavailableReason || "Codex is not connected.");
      }
      if (!discoveredCatalog.models.some((model) => (
        model.visible && model.availability === "available"
      ))) {
        throw new Error("The connected Codex account has no available visible model.");
      }
      return toProductCatalogSnapshot(discoveredCatalog);
    };
    catalogSnapshot = await discoverLiveCatalog();
    configurationPaths = [join(repositoryRoot, "harnesses", "codex-basic.yaml")];
    additionalImplementations = {};
    defaultHarnessConfiguration = "codex-basic";
  } else {
    const configurationPath = join(dataDirectory, "fixture-tutorial.yaml");
    await writeFile(configurationPath, [
      "schemaVersion: 1",
      "name: fixture-tutorial",
      "implementation: fixture.tutorial",
      "implementationVersion: 1",
      "permissionBindings:",
      "  ask: {}",
      "  auto: {}",
      "  full: {}",
      "modelCompatibility:",
      "  - providerId: codex",
      "settings: {}",
      "",
    ].join("\n"));
    configurationPaths = [configurationPath];
    additionalImplementations = { "fixture.tutorial": () => new TutorialFixtureHarness() };
    defaultHarnessConfiguration = "fixture-tutorial";
    catalogSnapshot = {
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
  }
  const settings = createSettingsStore(dataDirectory);
  const tutorial = createTutorialLifecycle({ settings });
  registerTestIpc(tutorial, {
    readAccount: credentials ? () => credentials.account() : undefined,
  });

  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths,
    additionalImplementations,
  });
  services.push(runtime);
  const runtimeSession = await runtime.start();
  let product;
  const modelCatalogRefreshServer = await startModelCatalogRefreshServer({
    refresh: async () => {
      if (discoverLiveCatalog) catalogSnapshot = await discoverLiveCatalog();
      return product.publishProviderCatalog(catalogSnapshot);
    },
  });
  services.push(modelCatalogRefreshServer);
  product = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    providerCatalogRefreshSession: modelCatalogRefreshServer.session,
    defaultHarnessConfiguration,
  });
  services.push(product);
  const productSession = await product.start();
  await product.publishProviderCatalog(catalogSnapshot);

  const createWindow = createWindowFactory({
    BrowserWindow,
    desktopDirectory: join(repositoryRoot, "desktop"),
    getAppearance: () => "dark",
    updater: { status: () => ({ phase: "development" }) },
  });
  mainWindow = await createWindow(productSession);
  const workArea = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  mainWindow.setBounds({
    x: workArea.x + Math.max(0, Math.floor((workArea.width - 1420) / 2)),
    y: workArea.y + Math.max(0, Math.floor((workArea.height - 900) / 2)),
    width: Math.min(1420, workArea.width),
    height: Math.min(900, workArea.height),
  });
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  app.focus({ steal: true });
  mainWindow.focus();
  mainWindow.moveTop();
  await waitFor("the visible Electron window", () => mainWindow.isVisible());
  await pause(500);
  mainWindow.setAlwaysOnTop(false);
  const webContents = mainWindow.webContents;

  const initial = await coachmark(webContents, "Start a thread");
  if (!initial.targetClass?.includes("new-composer")) {
    throw new Error(`Unexpected initial target: ${JSON.stringify(initial)}`);
  }
  const initialPrompt = await webContents.executeJavaScript(`document.querySelector("#newThreadPrompt")?.value`);
  if (initialPrompt !== "Why can time seem to pass faster as we get older?") {
    throw new Error(`Unexpected tutorial prompt: ${JSON.stringify(initialPrompt)}`);
  }

  recorder = await startRecorder(webContents);
  await pause(1_400);
  await typeText(webContents, "#newThreadPrompt", " In everyday life");
  await pause(900);
  await click(webContents, "#createThread");

  const accepted = await waitFor("the accepted tutorial graph", async () => {
    const state = await productRequest(productSession, "/api/state");
    if (state.threads.length !== 1) return false;
    const detail = await productRequest(productSession, `/api/threads/${state.threads[0].id}`);
    return detail.interactions[0]?.completionStatus === "accepted" ? detail : false;
  }, liveInference ? 180_000 : 20_000);
  const initialInteraction = accepted.interactions[0];
  if (liveInference) {
    if (accepted.thread.harnessId !== "codex-basic") {
      throw new Error(`Live tutorial used unexpected harness ${accepted.thread.harnessId}.`);
    }
    if (
      initialInteraction.modelSelection?.providerId !== "codex"
      || initialInteraction.modelSelection?.modelId === "fixture-model"
    ) {
      throw new Error(`Live tutorial has invalid model provenance: ${JSON.stringify(initialInteraction.modelSelection)}`);
    }
  }
  const selectMark = await coachmark(webContents, "Select a node");
  if (!selectMark.targetNode) throw new Error("The node-selection coach mark has no visible target.");
  await pause(1_200);
  await click(webContents, ".graph-node.tutorial-target");
  await coachmark(webContents, "Use an action");
  await pause(1_000);
  await click(webContents, ".action-control.tutorial-target");
  const followupMark = await coachmark(webContents, "Ask a follow-up");
  if (followupMark.targetId !== "threadComposer") {
    throw new Error(`Unexpected follow-up target: ${JSON.stringify(followupMark)}`);
  }
  const emptyFollowup = await webContents.executeJavaScript(`document.querySelector("#threadPrompt")?.value`);
  if (emptyFollowup !== "") throw new Error("The tutorial prefilled the follow-up composer.");
  await pause(1_100);
  await typeText(webContents, "#threadPrompt", "What is one small way to make next week feel more memorable?");
  await pause(1_000);
  await click(webContents, "#sendInteraction");
  await coachmark(webContents, "Tutorial complete.");
  await pause(1_200);
  await click(webContents, ".tutorial-done");
  await pause(900);

  await click(webContents, "#settingsButton");
  await waitFor("Settings", () => webContents.executeJavaScript(
    `document.querySelector("#settingsView")?.classList.contains("hidden") === false`,
  ));
  await click(webContents, '[data-settings-tab="advanced"]');
  await waitFor("Advanced settings", () => webContents.executeJavaScript(
    `document.querySelector("#advancedSettingsPanel")?.classList.contains("hidden") === false`,
  ));
  await pause(1_000);
  await click(webContents, "#startTutorial");
  await coachmark(webContents, "Start a thread");
  const replayPrompt = await webContents.executeJavaScript(`document.querySelector("#newThreadPrompt")?.value`);
  if (replayPrompt !== "Why can time seem to pass faster as we get older?") {
    throw new Error(`Manual replay did not restore the prompt: ${JSON.stringify(replayPrompt)}`);
  }
  await pause(1_500);

  const frameCount = recorder.frameCount();
  await stopRecorder();
  const settingsState = await settings.read();
  const result = {
    passed: true,
    liveInference,
    harness: accepted.thread.harnessId,
    modelSelection: initialInteraction.modelSelection,
    threadId: accepted.thread.id,
    completionStatus: initialInteraction.completionStatus,
    tutorialStatusAfterReplay: settingsState.tutorial?.status,
    frameCount,
    outputPath,
  };
  process.stdout.write(`RELAYER_TUTORIAL_VIDEO ${JSON.stringify(result)}\n`);
  exitCode = 0;
}

async function shutdown() {
  try {
    await stopRecorder();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
  }
  mainWindow?.destroy();
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

process.stdout.write("Starting isolated Electron tutorial video proof...\n");
void app.whenReady()
  .then(run)
  .catch((error) => process.stderr.write(`${error.stack || error.message}\n`))
  .finally(shutdown);
