import { app, BrowserWindow, ipcMain } from "electron";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";

import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";
import { createElectronWorkspaceDriver } from "./electron-workspace-driver.mjs";
import { validateTerminalFrameCoverage, validateVisibleBoundaryHold } from "./lib/interaction-context-capture-proof.mjs";

const OPT_IN = "RELAYER_CAPTURE_INTERACTION_CONTEXT_EVIDENCE";
const repositoryRoot = resolve(import.meta.dirname, "..");
const outputDirectory = join(
  repositoryRoot,
  "docs",
  "prd",
  "assets",
  "evidence",
  "interaction-context",
);
const historicalMontageFile = join(outputDirectory, "interaction-context-still-montage-historical.mp4");
const beforeRestartVideoFile = join(outputDirectory, "interaction-context-before-restart.mp4");
const afterRestartVideoFile = join(outputDirectory, "interaction-context-after-restart.mp4");
const beforeTerminalScreenshotFile = join(outputDirectory, "interaction-context-before-restart-terminal.png");
const afterTerminalScreenshotFile = join(outputDirectory, "interaction-context-after-restart-terminal.png");
const composerScreenshotFile = join(outputDirectory, "grouped-composer.png");
const restartedScreenshotFile = join(outputDirectory, "restarted-context.png");
const twoDraftsScreenshotFile = join(outputDirectory, "two-drafts-restored.png");
const secondDraftScreenshotFile = join(outputDirectory, "second-draft-restored.png");
const confirmedDraftScreenshotFile = join(outputDirectory, "confirmed-draft-with-other-draft.png");
const warningScreenshotFile = join(outputDirectory, "draft-omission-warning.png");
const overrideScreenshotFile = join(outputDirectory, "draft-after-override.png");
const manifestFile = join(outputDirectory, "manifest.json");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-interaction-context-evidence-"));
const framesDirectory = join(dataDirectory, "checkpoints");
const continuousFramesDirectory = join(dataDirectory, "continuous-frames");
const continuousFrameIntervalMs = 100;
const maximumContinuousFrameGapMs = 500;
const defaultBoundaryHoldMs = 1_400;
const criticalBoundaryHoldMs = 1_800;
const terminalFrameHoldMs = 200;
const textRecognizerPath = join(repositoryRoot, "scripts", "recognize-desktop-capture-frame.swift");
const configurationPath = join(repositoryRoot, "harnesses", "fixture-task-system.yaml");
const graphServerBinary = join(repositoryRoot, "target", "debug", "relayer-graph-server");
const appServerBinary = join(repositoryRoot, "target", "debug", "relayer-app-server");
const frames = [];
const recordingSegments = [];
let activeRecordingSegment;

let runtime;
let catalogRefreshServer;
let product;
let productSession;
let mainWindow;
let keepaliveWindow;
let composerDraftState = { pendingNewThread: null, threadFollowups: {} };
let captureTextRecognizer;

const {
  click,
  clickNode,
  evaluate,
  productRequest,
  setValue,
  sleep,
  waitFor,
  waitForAcceptedInteractions,
  waitForPaint,
} = createElectronWorkspaceDriver({
  getWindow: () => mainWindow,
  getProductSession: () => productSession,
  diagnosticBodyLength: 3_500,
});

if (process.env[OPT_IN] !== "1") {
  throw new Error(`Evidence capture is opt-in. Set ${OPT_IN}=1.`);
}

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const sourceProofFiles = [
  "scripts/test-interaction-context-lifecycle.mjs",
  "scripts/test-desktop-context-draft-warning.mjs",
  "scripts/capture-interaction-context-evidence.mjs",
  "scripts/lib/interaction-context-capture-proof.mjs",
  "scripts/recognize-desktop-capture-frame.swift",
  "scripts/electron-workspace-driver.mjs",
];
const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
async function sourceFingerprints() {
  return Promise.all(sourceProofFiles.map(async (file) => ({
    file,
    sha256: createHash("sha256").update(await readFile(join(repositoryRoot, file))).digest("hex"),
  })));
}
const sourceHashesBeforeCapture = await sourceFingerprints();
const workingTreeDirty = Boolean(execFileSync("git", ["status", "--porcelain"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim());

app.setName("Relayer Interaction Context Evidence");
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
    status: "signed-in",
    channel: "stable",
    subject: "fixture|node-details-evidence",
  }));
  ipcMain.handle("relayer:appearance-read", () => ({ appearance: "dark" }));
  ipcMain.handle("relayer:composer-drafts-read", () => composerDraftState);
  ipcMain.handle("relayer:composer-drafts-write", (_event, value) => {
    composerDraftState = value;
    return composerDraftState;
  });
  ipcMain.handle("relayer:update-status", () => ({
    phase: "development",
    channel: "stable",
    version: "evidence",
    availableVersion: null,
    percent: null,
    error: null,
  }));
  ipcMain.handle("relayer:folder-choose", () => null);
  ipcMain.handle("relayer:tutorial-read", () => ({
    status: "dismissed",
    automaticEligible: false,
  }));
  ipcMain.handle("relayer:provider-status", () => ({
    adapters: [],
    definitions: [],
    hasCompletedOnboarding: true,
  }));
}

function unregisterIpc() {
  for (const channel of [
    "relayer:account-read",
    "relayer:appearance-read",
    "relayer:composer-drafts-read",
    "relayer:composer-drafts-write",
    "relayer:update-status",
    "relayer:folder-choose",
    "relayer:tutorial-read",
    "relayer:provider-status",
  ]) ipcMain.removeHandler(channel);
}

async function refreshCaptureSurface() {
  if (process.platform === "darwin") app.focus({ steal: true });
  mainWindow.focus();
  mainWindow.webContents.focus();
  mainWindow.webContents.invalidate();
  await sleep(120);
  mainWindow.webContents.invalidate();
  await waitForPaint();
  await sleep(120);
}

async function capturePagePng(label, timeoutMs = 10_000) {
  let timeout;
  try {
    const image = await Promise.race([
      mainWindow.webContents.capturePage(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(
          `Timed out after ${timeoutMs}ms while capturing ${label}.`,
        )), timeoutMs);
      }),
    ]);
    return image.toPNG();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label}: ${JSON.stringify({ expected, actual })}`);
  }
}

function interactionIds(thread) {
  return thread.interactions.map((interaction) => interaction.id);
}

function createCaptureTextRecognizer() {
  const worker = spawn("swift", [textRecognizerPath], { stdio: ["pipe", "pipe", "inherit"] });
  const responses = new Map();
  const lines = createInterface({ input: worker.stdout });
  let nextId = 0;
  let exited = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  const fail = (error) => {
    if (exited) return;
    exited = true;
    readyReject(error);
    for (const pending of responses.values()) pending.reject(error);
    responses.clear();
  };
  lines.on("line", (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch (error) {
      fail(new Error(`Capture frame text recognizer returned invalid JSON: ${error.message}`));
      return;
    }
    if (response.ready === true) {
      readyResolve();
      return;
    }
    const pending = responses.get(response.id);
    if (!pending) return;
    responses.delete(response.id);
    if (response.error) pending.reject(new Error(`Capture frame text recognition failed: ${response.error}`));
    else pending.resolve(response.text || "");
  });
  worker.once("error", fail);
  worker.once("exit", (code, signal) => {
    if (!exited && code !== 0) fail(new Error(`Capture frame text recognizer exited (${code ?? signal ?? "unknown"}).`));
    exited = true;
  });
  return {
    ready,
    async recognize(file) {
      await ready;
      if (exited) throw new Error("Capture frame text recognizer is no longer running.");
      const id = ++nextId;
      const result = new Promise((resolveResult, rejectResult) => {
        responses.set(id, { resolve: resolveResult, reject: rejectResult });
      });
      worker.stdin.write(`${JSON.stringify({ id, file })}\n`);
      return result;
    },
    async close() {
      if (exited) return;
      worker.stdin.end();
      await new Promise((resolveExit, rejectExit) => {
        worker.once("exit", (code) => code === 0
          ? resolveExit()
          : rejectExit(new Error(`Capture frame text recognizer exited with ${code}.`)));
        worker.once("error", rejectExit);
      });
      exited = true;
    },
  };
}

async function recognizeRecordingFrame(recorder, frame) {
  if (!captureTextRecognizer) throw new Error("The captured-frame recognizer has not started.");
  const file = join(recorder.directory, `frame-${String(frame.frameNumber).padStart(5, "0")}.png`);
  return { ...frame, recognizedText: await captureTextRecognizer.recognize(file) };
}

async function startContinuousRecording(name) {
  if (activeRecordingSegment) throw new Error("A continuous interaction-context segment is already active.");
  const directory = join(continuousFramesDirectory, name);
  await mkdir(directory, { recursive: true });
  const outputFile = {
    "before-restart": beforeRestartVideoFile,
    "after-restart": afterRestartVideoFile,
  }[name];
  if (!outputFile) throw new Error(`Unknown interaction-context recording segment: ${name}`);
  const recordingStartedAtMs = Date.now();
  const frameTimestamps = [];
  let capturedPixelDimensions;
  let previousCaptureAtMs = recordingStartedAtMs;
  let captureQueue = Promise.resolve();

  const captureFrame = () => {
    const capture = captureQueue.then(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new Error(`The Electron window ended during the ${name} recording segment.`);
      }
      const image = await mainWindow.webContents.capturePage();
      const dimensions = image.getSize();
      if (!capturedPixelDimensions) {
        capturedPixelDimensions = dimensions;
      } else if (!isDeepStrictEqual(dimensions, capturedPixelDimensions)) {
        throw new Error(`The ${name} recording pixel dimensions changed: ${JSON.stringify(dimensions)}`);
      }
      const capturedAtMs = Date.now();
      const frameNumber = frameTimestamps.length;
      const png = image.toPNG();
      const file = join(directory, `frame-${String(frameNumber).padStart(5, "0")}.png`);
      await writeFile(file, png);
      const frame = {
        frameNumber,
        capturedAtUtc: new Date(capturedAtMs).toISOString(),
        elapsedMs: capturedAtMs - recordingStartedAtMs,
        sha256: createHash("sha256").update(png).digest("hex"),
      };
      frameTimestamps.push(frame);
      previousCaptureAtMs = capturedAtMs;
      return frame;
    });
    captureQueue = capture.catch(() => {});
    return capture;
  };

  await captureFrame();
  const recorder = {
    name,
    directory,
    outputFile,
    pixelDimensions: capturedPixelDimensions,
    events: [],
    frameTimestamps,
    recordingStartedAtMs,
    capturing: true,
    error: undefined,
    loop: undefined,
  };
  recorder.loop = (async () => {
    try {
      while (recorder.capturing) {
        await sleep(Math.max(0, previousCaptureAtMs + continuousFrameIntervalMs - Date.now()));
        if (!recorder.capturing) break;
        await captureFrame();
      }
    } catch (error) {
      recorder.error = error;
      recorder.capturing = false;
    }
  })();
  recorder.captureBoundary = async (eventName, expectedVisibleText, holdMs = defaultBoundaryHoldMs) => {
    if (!Array.isArray(expectedVisibleText) || expectedVisibleText.length === 0) {
      throw new Error(`Visual boundary ${eventName} has no required captured-screen content.`);
    }
    mainWindow.webContents.invalidate();
    await waitForPaint();
    const frame = await captureFrame();
    const startFrame = await recognizeRecordingFrame(recorder, frame);
    await sleep(holdMs);
    mainWindow.webContents.invalidate();
    await waitForPaint();
    const endFrame = await captureFrame();
    const endFrameWithText = await recognizeRecordingFrame(recorder, endFrame);
    const holdFrames = recorder.frameTimestamps.slice(frame.frameNumber, endFrame.frameNumber + 1);
    const holdFrameGaps = holdFrames.slice(1).map((captured, index) => (
      captured.elapsedMs - holdFrames[index].elapsedMs
    ));
    const maximumHoldCaptureGapMs = holdFrameGaps.length ? Math.max(...holdFrameGaps) : 0;
    const observedHoldMs = validateVisibleBoundaryHold({
      startFrame,
      endFrame: { ...endFrameWithText, maximumCaptureGapMs: maximumHoldCaptureGapMs },
      expectedText: expectedVisibleText,
      minimumHoldMs: Math.max(defaultBoundaryHoldMs, holdMs),
      maximumCaptureGapMs: maximumContinuousFrameGapMs,
    });
    const event = {
      name: eventName,
      recordedAtUtc: new Date().toISOString(),
      elapsedMs: Date.now() - recorder.recordingStartedAtMs,
      framesCapturedBeforeEvent: frame.frameNumber,
      capturedFrameNumber: frame.frameNumber,
      capturedFramePresentationMs: frame.elapsedMs - recorder.frameTimestamps[0].elapsedMs,
      capturedFrameAtUtc: frame.capturedAtUtc,
      capturedFrameSha256: frame.sha256,
      paintSynchronized: "webContents.invalidate followed by two renderer animation frames before capture",
      expectedVisibleText,
      visibleContentAccepted: true,
      recognizedTextAtStart: startFrame.recognizedText,
      holdEndFrameNumber: endFrame.frameNumber,
      holdEndFrameAtUtc: endFrame.capturedAtUtc,
      holdEndFrameSha256: endFrame.sha256,
      recognizedTextAtHoldEnd: endFrameWithText.recognizedText,
      requestedHoldMs: holdMs,
      observedHoldMs,
      maximumHoldCaptureGapMs,
    };
    recorder.events.push(event);
    return event;
  };
  activeRecordingSegment = recorder;
  recordingSegments.push(recorder);
  return recorder;
}

async function captureRecordingBoundary(recorder, name, expectedVisibleText, holdMs = defaultBoundaryHoldMs) {
  return recorder.captureBoundary(name, expectedVisibleText, holdMs);
}

async function stopContinuousRecording(recorder) {
  if (activeRecordingSegment !== recorder) throw new Error("The requested recording segment is not active.");
  recorder.capturing = false;
  await recorder.loop;
  activeRecordingSegment = undefined;
  if (recorder.error) throw recorder.error;
  if (recorder.frameTimestamps.length < 2) {
    throw new Error(`The ${recorder.name} continuous segment captured fewer than two renderer frames.`);
  }
  const frameGapsMs = recorder.frameTimestamps.slice(1).map((frame, index) => (
    frame.elapsedMs - recorder.frameTimestamps[index].elapsedMs
  ));
  const maximumFrameGapMs = Math.max(...frameGapsMs);
  if (maximumFrameGapMs > maximumContinuousFrameGapMs) {
    throw new Error(`The ${recorder.name} recording lost continuous frame sampling for ${maximumFrameGapMs}ms.`);
  }
  const recordingEndedAtMs = Date.now();
  const frameListFile = join(recorder.directory, "frames.ffconcat");
  const frameList = ["ffconcat version 1.0"];
  for (let index = 0; index < recorder.frameTimestamps.length; index += 1) {
    const frame = recorder.frameTimestamps[index];
    const framePath = join(recorder.directory, `frame-${String(frame.frameNumber).padStart(5, "0")}.png`);
    frameList.push(`file '${framePath.replaceAll("'", "'\\''")}'`);
    frameList.push("option framerate 1000");
    const next = recorder.frameTimestamps[index + 1];
    if (next) {
      frameList.push(`duration ${((next.elapsedMs - frame.elapsedMs) / 1000).toFixed(6)}`);
    } else {
      frameList.push(`duration ${(terminalFrameHoldMs / 1000).toFixed(6)}`);
    }
  }
  const finalFrame = recorder.frameTimestamps.at(-1);
  const finalFramePath = join(recorder.directory, `frame-${String(finalFrame.frameNumber).padStart(5, "0")}.png`);
  frameList.push(`file '${finalFramePath.replaceAll("'", "'\\''")}'`);
  frameList.push("option framerate 1000");
  frameList.push(`duration ${(terminalFrameHoldMs / 1000).toFixed(6)}`);
  frameList.push(`file '${finalFramePath.replaceAll("'", "'\\''")}'`);
  frameList.push("option framerate 1000");
  await writeFile(frameListFile, `${frameList.join("\n")}\n`);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", frameListFile,
    "-fps_mode", "vfr", "-enc_time_base", "1:1000",
    "-vf", "format=yuv420p",
    "-an", "-c:v", "libx264", "-bf", "0", "-preset", "veryfast", "-crf", "18",
    "-video_track_timescale", "1000", "-movflags", "+faststart", recorder.outputFile,
  ], { cwd: repositoryRoot, stdio: "inherit" });
  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_name,width,height,pix_fmt:frame=best_effort_timestamp_time",
    "-show_frames",
    "-of", "json",
    recorder.outputFile,
  ], { cwd: repositoryRoot, encoding: "utf8" }));
  const decodeValidation = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning", "-i", recorder.outputFile, "-f", "null", "-",
  ], { cwd: repositoryRoot, stdio: ["ignore", "ignore", "pipe"] });
  let decoderDiagnostics = "";
  decodeValidation.stderr.setEncoding("utf8");
  decodeValidation.stderr.on("data", (chunk) => { decoderDiagnostics += chunk; });
  const decodeExit = await new Promise((resolveDecode, rejectDecode) => {
    decodeValidation.once("error", rejectDecode);
    decodeValidation.once("close", (code, signal) => resolveDecode({ code, signal }));
  });
  if (decodeExit.code !== 0) {
    throw new Error(`VFR decode-to-null failed (${decodeExit.code ?? decodeExit.signal}): ${decoderDiagnostics}`);
  }
  const encodedFrameTimestampsMs = (probe.frames || []).map((frame) => (
    Math.round(Number(frame.best_effort_timestamp_time) * 1000)
  ));
  const expectedFrameTimestampsMs = recorder.frameTimestamps.map((frame) => (
    frame.elapsedMs - recorder.frameTimestamps[0].elapsedMs
  ));
  const maximumPresentationTimingErrorMs = Math.max(...expectedFrameTimestampsMs.map((timestamp, index) => (
    Math.abs(encodedFrameTimestampsMs[index] - timestamp)
  )));
  if (maximumPresentationTimingErrorMs > 5) {
    throw new Error(`${recorder.name} playback timing differs from renderer capture by up to ${maximumPresentationTimingErrorMs}ms.`);
  }
  const terminalFrameCoverage = validateTerminalFrameCoverage({
    capturedPresentationMs: expectedFrameTimestampsMs,
    encodedPresentationMs: encodedFrameTimestampsMs,
    containerDurationMs: Number(probe.format.duration) * 1000,
    terminalFrameHoldMs,
  });
  const capturedSpanMs = recorder.frameTimestamps.at(-1).elapsedMs - recorder.frameTimestamps[0].elapsedMs;
  const encodedDurationMs = Number(probe.format.duration) * 1000;
  const encodedTerminalPtsMs = encodedFrameTimestampsMs.at(-1);
  const encodedSpanMs = encodedTerminalPtsMs - encodedFrameTimestampsMs[0];
  const terminalScreenshotFile = recorder.name === "before-restart"
    ? beforeTerminalScreenshotFile
    : afterTerminalScreenshotFile;
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", recorder.outputFile,
    "-vf", `select=eq(n\\,${encodedFrameTimestampsMs.length - 1})`,
    "-fps_mode", "passthrough", "-frames:v", "1", terminalScreenshotFile,
  ], { cwd: repositoryRoot, stdio: "inherit" });
  const terminalFrameText = await captureTextRecognizer.recognize(terminalScreenshotFile);
  const terminalExpectedText = recorder.events.at(-1)?.expectedVisibleText || [];
  const normalizeText = (value) => String(value).toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  if (terminalExpectedText.some((text) => !normalizeText(terminalFrameText).includes(normalizeText(text)))) {
    throw new Error(`${recorder.name} terminal frame did not show its expected state: ${JSON.stringify({ terminalExpectedText, terminalFrameText })}`);
  }
  if (decoderDiagnostics.trim()) process.stderr.write(decoderDiagnostics);
  const segment = {
    file: recorder.outputFile.split("/").at(-1),
    sha256: createHash("sha256").update(await readFile(recorder.outputFile)).digest("hex"),
    capture: "Continuous sampled frames directly from the real Electron BrowserWindow; the final captured renderer frame is repeated to encode its measured terminal hold.",
    frameTiming: `variable frame rate from renderer timestamps with two repeated terminal samples ${terminalFrameHoldMs}ms apart; B-frame reordering is disabled so the MP4 container covers the final PTS`,
    frameCount: recorder.frameTimestamps.length,
    encodedFrameCount: encodedFrameTimestampsMs.length,
    maximumFrameGapMs,
    maximumPresentationTimingErrorMs,
    capturedSpanMs,
    encodedSpanMs,
    encodedDurationMs,
    terminalFrameCoverage,
    terminalScreenshot: {
      file: terminalScreenshotFile.split("/").at(-1),
      sha256: createHash("sha256").update(await readFile(terminalScreenshotFile)).digest("hex"),
      recognizedText: terminalFrameText,
    },
    decodeValidation: {
      decodeToNullExitCode: decodeExit.code,
      diagnostics: decoderDiagnostics.trim(),
      terminalFrameExtractedAndRecognized: true,
    },
    startedAtUtc: new Date(recorder.recordingStartedAtMs).toISOString(),
    endedAtUtc: new Date(recordingEndedAtMs).toISOString(),
    wallClockDurationMs: recordingEndedAtMs - recorder.recordingStartedAtMs,
    frameTimestamps: recorder.frameTimestamps,
    encodedFrameTimestampsMs,
    events: recorder.events,
    stream: probe.streams[0],
    encodedDurationSeconds: Number(Number(probe.format.duration).toFixed(3)),
    decodeToNullSucceeded: true,
  };
  recorder.receipt = segment;
  return segment;
}

async function abandonContinuousRecording() {
  if (!activeRecordingSegment) return;
  const recorder = activeRecordingSegment;
  recorder.capturing = false;
  await recorder.loop;
  activeRecordingSegment = undefined;
}

async function captureStep(caption, selector) {
  await mkdir(framesDirectory, { recursive: true });
  await refreshCaptureSurface();
  const file = join(framesDirectory, `${String(frames.length + 1).padStart(2, "0")}.png`);
  await writeFile(file, await capturePagePng(`checkpoint ${frames.length + 1}`));
  frames.push({ file, caption, capturedAtUtc: new Date().toISOString(), selector });
  process.stdout.write(`Captured checkpoint ${frames.length}: ${caption}\n`);
}

function holdNextDraftSave() {
  const filter = { urls: [`${productSession.origin}/api/threads/*/context-drafts/*`] };
  let heldCallback;
  let intercepted = false;
  const held = new Promise((resolveHeld) => {
    mainWindow.webContents.session.webRequest.onBeforeRequest(filter, (details, callback) => {
      if (!intercepted && details.method === "PUT") {
        intercepted = true;
        heldCallback = callback;
        resolveHeld();
        return;
      }
      callback({});
    });
  });
  return Object.freeze({
    wait: () => held,
    release() {
      if (!heldCallback) throw new Error("Cannot release a draft save before it is held.");
      mainWindow.webContents.session.webRequest.onBeforeRequest(filter, null);
      heldCallback({});
    },
  });
}

async function startServices() {
  runtime = new GraphCompleteRuntimeService({
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
  const runtimeSession = await runtime.start();
  catalogRefreshServer = await startModelCatalogRefreshServer({
    refresh: () => product.publishProviderCatalog(catalogSnapshot),
  });
  product = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: appServerBinary,
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    providerCatalogRefreshSession: catalogRefreshServer.session,
    defaultHarnessConfiguration: "fixture-task-system",
  });
  productSession = await product.start();
  await product.publishProviderCatalog(catalogSnapshot);
}

async function stopServices() {
  if (product) await product.close().catch(() => undefined);
  if (catalogRefreshServer) await catalogRefreshServer.close().catch(() => undefined);
  if (runtime) await runtime.close().catch(() => undefined);
  product = undefined;
  catalogRefreshServer = undefined;
  runtime = undefined;
  productSession = undefined;
}

async function openThreadWindow(threadId) {
  const createWindow = createWindowFactory({
    BrowserWindow,
    desktopDirectory: join(repositoryRoot, "desktop"),
    getAppearance: () => "dark",
    updater: { status: () => ({ phase: "development" }) },
    openExternal: async () => {},
  });
  mainWindow = await createWindow(productSession);
  mainWindow.setSize(1480, 920);
  await mainWindow.loadURL(`${productSession.origin}/?threadId=${encodeURIComponent(threadId)}`);
  mainWindow.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  mainWindow.focus();
  mainWindow.webContents.focus();
  await waitFor("production thread workspace", () => evaluate(`(() => (
    document.querySelector('#desktopAccountOnboarding')?.classList.contains('hidden')
    && !document.body.classList.contains('desktop-account-pending')
    && !document.querySelector('#appShell')?.classList.contains('hidden')
    && getComputedStyle(document.querySelector('#appShell')).visibility !== 'hidden'
    && !document.querySelector('#threadView')?.classList.contains('hidden')
    && document.querySelectorAll('.graph-node').length === 3
    && !document.querySelector('#threadPrompt')?.disabled
  ))()`));
  await waitForPaint();
}

async function restartStack(threadId) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  mainWindow = undefined;
  await stopServices();
  await startServices();
  await openThreadWindow(threadId);
}

async function run() {
  process.stdout.write("Starting real-Electron zero-inference interaction-context capture.\n");
  if (workingTreeDirty) throw new Error("Interaction-context evidence capture requires a clean committed source snapshot.");
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    beforeRestartVideoFile,
    afterRestartVideoFile,
    beforeTerminalScreenshotFile,
    afterTerminalScreenshotFile,
    composerScreenshotFile,
    restartedScreenshotFile,
    manifestFile,
  ].map((path) => rm(path, { force: true })));
  captureTextRecognizer = createCaptureTextRecognizer();
  await captureTextRecognizer.ready;
  registerIpc();
  keepaliveWindow = new BrowserWindow({ width: 1, height: 1, show: false });
  await startServices();

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
  const thread = await productRequest("/api/threads", {
    method: "POST",
    body: JSON.stringify({
      title: "Interaction context verification",
      initialMessage: "Show the deterministic task system.",
      projectId: project.id,
      harnessId: "fixture-task-system",
      modelSelection,
    }),
  });
  await waitForAcceptedInteractions(thread.id, 1);
  await openThreadWindow(thread.id);

  await clickNode("Incoming queue");
  await waitFor("Incoming queue Node Details", () => evaluate(`
    document.querySelector('#detailTitle')?.textContent === 'Incoming queue'
      && !document.querySelector('#inspector')?.classList.contains('hidden')
      && !document.querySelector('#attachNodeContext')?.classList.contains('hidden')
  `));
  await captureStep(
    "1. Selecting a graph node opens its full Node Details without covering the graph or composer",
    "#inspector",
  );
  await click("#attachNodeContext");
  await waitFor("new context annotation editor", () => evaluate(`Boolean(document.querySelector('#contextAnnotationEditor'))`));
  await setValue("#contextAnnotationEditor", "Queue order controls which task is claimed next.");
  await waitFor("first annotation autosave", async () => {
    const response = await productRequest(`/api/threads/${thread.id}/context-drafts`);
    return response.drafts?.[0]?.text === "Queue order controls which task is claimed next."
      && response.drafts[0].revision >= 1;
  });
  await captureStep(
    "2. The node's + opens its saved annotation editor in the bottom third of Node Details",
    "#inspector",
  );
  let rejectedDraftSave = false;
  const draftSaveFilter = { urls: [`${productSession.origin}/api/threads/*/context-drafts/*`] };
  mainWindow.webContents.session.webRequest.onBeforeRequest(draftSaveFilter, (details, callback) => {
    if (!rejectedDraftSave && details.method === "PUT") {
      rejectedDraftSave = true;
      callback({ cancel: true });
      return;
    }
    callback({});
  });
  await setValue("#contextAnnotationEditor", "Queue order must remain stable while workers are busy.");
  await waitFor("inline annotation save failure", () => evaluate(`(() => {
    const error = document.querySelector('#nodeContextDock [role="alert"]');
    return error?.textContent?.startsWith('Not saved:')
      && document.querySelector('#contextAnnotationEditor')?.value
        === 'Queue order must remain stable while workers are busy.';
  })()`));
  await captureStep(
    "3. A failed save stays in Node Details with the draft intact and an inline retryable error",
    "#nodeContextDock",
  );
  mainWindow.webContents.session.webRequest.onBeforeRequest(draftSaveFilter, null);
  await setValue("#contextAnnotationEditor", "Queue order controls which task is claimed next.");
  await waitFor("annotation save recovery", async () => {
    const response = await productRequest(`/api/threads/${thread.id}/context-drafts`);
    return response.drafts?.[0]?.text === "Queue order controls which task is claimed next."
      && response.drafts[0].revision >= 2
      && await evaluate(`document.querySelector('#nodeContextDock [role="alert"]')?.classList.contains('hidden')`);
  });
  const switchedDraftText = "Queue order remains FIFO when both workers are busy.";
  const heldSwitchSave = holdNextDraftSave();
  await setValue("#contextAnnotationEditor", switchedDraftText);
  await clickNode("Two-worker pool");
  await waitFor("node-switch draft persistence to be held", () => Promise.race([
    heldSwitchSave.wait().then(() => true),
    sleep(40).then(() => false),
  ]));
  const heldSwitchState = await evaluate(`({
    title: document.querySelector('#detailTitle')?.textContent,
    editorValue: document.querySelector('#contextAnnotationEditor')?.value,
    dockHidden: document.querySelector('#nodeContextDock')?.classList.contains('hidden'),
  })`);
  if (heldSwitchState.title !== "Incoming queue"
    || heldSwitchState.editorValue !== switchedDraftText
    || heldSwitchState.dockHidden) {
    throw new Error(`Node switch escaped before its draft save settled: ${JSON.stringify(heldSwitchState)}`);
  }
  await captureStep(
    "4. While the draft save is held, Node Details stays on the source node with the exact text visible",
    "#nodeContextDock",
  );
  heldSwitchSave.release();
  await waitFor("node switch persists and hides the source draft dock", async () => {
    const response = await productRequest(`/api/threads/${thread.id}/context-drafts`);
    return response.drafts?.[0]?.text === switchedDraftText
      && await evaluate(`document.querySelector('#detailTitle')?.textContent === 'Two-worker pool'
        && document.querySelector('#nodeContextDock')?.classList.contains('hidden')`);
  });
  await captureStep(
    "5. After persistence settles, switching opens the next node without carrying the editor across",
    "#inspector",
  );
  await clickNode("Incoming queue");
  await waitFor("source draft restored after node switch", () => evaluate(`
    document.querySelector('#contextAnnotationEditor')?.value === ${JSON.stringify(switchedDraftText)}
  `));
  await captureStep(
    "6. Returning to the source node restores the exact unconfirmed draft in its Node Details dock",
    "#inspector",
  );
  await setValue("#contextAnnotationEditor", "Queue order controls which task is claimed next.");
  const heldCloseSave = holdNextDraftSave();
  await click("#closeInspector");
  await waitFor("Node Details close persistence to be held", () => Promise.race([
    heldCloseSave.wait().then(() => true),
    sleep(40).then(() => false),
  ]));
  const heldCloseState = await evaluate(`({
    inspectorHidden: document.querySelector('#inspector')?.classList.contains('hidden'),
    title: document.querySelector('#detailTitle')?.textContent,
    editorValue: document.querySelector('#contextAnnotationEditor')?.value,
  })`);
  if (heldCloseState.inspectorHidden
    || heldCloseState.title !== "Incoming queue"
    || heldCloseState.editorValue !== "Queue order controls which task is claimed next.") {
    throw new Error(`Node Details closed before its draft save settled: ${JSON.stringify(heldCloseState)}`);
  }
  await captureStep(
    "7. While Close waits on a held save, the exact draft remains visible in Node Details",
    "#nodeContextDock",
  );
  heldCloseSave.release();
  await waitFor("Node Details closes only after the draft is saved", async () => {
    const response = await productRequest(`/api/threads/${thread.id}/context-drafts`);
    return response.drafts?.[0]?.text === "Queue order controls which task is claimed next."
      && await evaluate(`document.querySelector('#inspector')?.classList.contains('hidden')
        && !document.querySelector('#contextAnnotationEditor')`);
  });
  await captureStep(
    "8. After persistence settles, Node Details closes and the graph and composer remain usable",
    "#graphStage",
  );
  await clickNode("Incoming queue");
  await waitFor("saved draft restored after closing Node Details", () => evaluate(`
    document.querySelector('#contextAnnotationEditor')?.value === 'Queue order controls which task is claimed next.'
  `));
  await click("[aria-label='Confirm annotation']");
  await waitFor("first collapsed context pill", () => evaluate(`
    document.querySelectorAll('.composer-context-pill-wrap').length === 1
      && document.querySelector('.composer-context-pill')?.getAttribute('aria-expanded') === 'false'
      && !document.querySelector('.composer-context-preview')
  `));
  await captureStep(
    "9. Confirming closes the editor and leaves a compact collapsed node pill above the composer",
    "#composerContextTray",
  );
  await click("#attachNodeContext");
  await setValue("#contextAnnotationEditor", "Discard this temporary annotation.");
  await waitFor("temporary draft saved before discard", async () => {
    const response = await productRequest(`/api/threads/${thread.id}/context-drafts`);
    return response.drafts?.[0]?.text === "Discard this temporary annotation.";
  });
  await captureStep(
    "10. The × control discards only this unconfirmed draft while the confirmed node context remains attached",
    "#nodeContextDock",
  );
  await click("[aria-label='Discard annotation draft for Incoming queue']");
  await waitFor("temporary draft discarded from Node Details", async () => {
    const response = await productRequest(`/api/threads/${thread.id}/context-drafts`);
    return response.drafts?.length === 0
      && await evaluate(`!document.querySelector('#contextAnnotationEditor')`);
  });
  await captureStep(
    "11. After discard, the temporary editor is gone and the confirmed collapsed pill is unchanged",
    "#composerContextTray",
  );
  await click("[aria-label='Show Incoming queue annotations']");
  await waitFor("first compact annotation preview", () => evaluate(`
    document.querySelectorAll('.composer-context-annotations li').length === 1
  `));
  await click("#attachNodeContext");
  await setValue("#contextAnnotationEditor", "Prioritize worker availability when reasoning.");
  await click("[aria-label='Confirm annotation']");
  await waitFor("second confirmation collapsed", () => evaluate(`
    !document.querySelector('#contextAnnotationEditor')
      && document.querySelector('[aria-label="Show Incoming queue annotations"]')?.disabled === false
      && document.querySelector('.composer-context-pill')?.getAttribute('aria-expanded') === 'false'
      && !document.querySelector('.composer-context-preview')
  `));
  await click("[aria-label='Show Incoming queue annotations']");
  await waitFor("second ordered annotation", () => evaluate(`
    document.querySelectorAll('.composer-context-annotations li').length === 2
  `));
  const explicitPreview = await evaluate(`(() => {
    const preview = document.querySelector('.composer-context-preview')?.getBoundingClientRect();
    const inspector = document.querySelector('#inspector')?.getBoundingClientRect();
    return preview && inspector ? {
      width: preview.width,
      height: preview.height,
      avoidsInspector: preview.right < inspector.left,
    } : null;
  })()`);
  if (!explicitPreview?.avoidsInspector) {
    throw new Error(`Composer context preview overlaps Node Details: ${JSON.stringify(explicitPreview)}`);
  }
  await captureStep(
    "12. Confirmed annotations stay read-only in an explicitly opened compact preview",
    ".composer-context-preview",
  );
  await click("[aria-label='Delete annotation 2 for Incoming queue']");
  await waitFor("second annotation deleted from the explicit preview", () => evaluate(`(() => {
    const values = [...document.querySelectorAll('.composer-context-annotations li > span')]
      .map((element) => element.textContent);
    return JSON.stringify(values) === JSON.stringify(['Queue order controls which task is claimed next.']);
  })()`));
  await click("#attachNodeContext");
  await setValue("#contextAnnotationEditor", "Prioritize worker availability when reasoning.");
  await click("[aria-label='Confirm annotation']");
  await waitFor("re-added annotation confirmation settled", () => evaluate(`
    !document.querySelector('#contextAnnotationEditor')
      && !document.querySelector('[aria-label="Show Incoming queue annotations"]')?.disabled
  `));
  await click("[aria-label='Show Incoming queue annotations']");
  await click("[aria-label='Close Incoming queue annotations']");
  await clickNode("Two-worker pool");
  await waitFor("first draft editor settled before opening second draft", () => evaluate(`
    document.querySelector('#detailTitle')?.textContent === 'Two-worker pool'
      && !document.querySelector('#contextAnnotationEditor')
      && document.querySelector('#nodeContextDock')?.classList.contains('hidden')
  `));
  await click("#attachNodeContext");
  await setValue("#contextAnnotationEditor", "Keep both workers busy while tasks are queued.");
  await click("[aria-label='Confirm annotation']");
  await waitFor("worker-pool context confirmation settled", () => evaluate(`
    !document.querySelector('#contextAnnotationEditor')
      && document.querySelectorAll('.composer-context-pill').length === 2
  `));
  await clickNode("Results store");
  await click("#attachNodeContext");
  await setValue("#contextAnnotationEditor", "Preserve completed results in claim order.");
  await click("[aria-label='Confirm annotation']");
  await waitFor("results context confirmation settled", () => evaluate(`
    !document.querySelector('#contextAnnotationEditor')
      && document.querySelectorAll('.composer-context-pill').length === 3
  `));
  mainWindow.setSize(1104, 920);
  await waitForPaint();
  const pillOverflow = await waitFor("multiple node pills scroll horizontally", () => evaluate(`(() => {
    const strip = document.querySelector('.composer-context-pills');
    if (!strip || strip.children.length !== 3) return null;
    const overflow = getComputedStyle(strip).overflowX;
    const scrollable = strip.scrollWidth > strip.clientWidth;
    strip.scrollLeft = strip.scrollWidth;
    const scrolled = strip.scrollLeft > 0;
    return { overflow, scrollable, scrolled };
  })()`));
  if (pillOverflow.overflow !== "auto" || !pillOverflow.scrollable || !pillOverflow.scrolled) {
    throw new Error(`Multiple node pills did not scroll horizontally: ${JSON.stringify(pillOverflow)}`);
  }
  await captureStep(
    "13. Multiple attached-node pills scroll horizontally within the available composer width",
    ".composer-context-pills",
  );
  mainWindow.setSize(1480, 920);
  await waitForPaint();
  await evaluate(`(() => { window.confirm = () => true; return true; })()`);
  await click("[aria-label='Detach Two-worker pool']");
  await click("[aria-label='Detach Results store']");
  await click("[aria-label='Show Incoming queue annotations']");
  await waitFor("incoming queue annotations reopened", () => evaluate(`
    document.querySelectorAll('.composer-context-annotations li').length === 2
  `));
  await setValue("#threadPrompt", "Use this connected queue context in the follow-up.");
  await waitFor("message and context send enabled", () => evaluate(`document.querySelector('#sendInteraction')?.disabled === false`));
  await refreshCaptureSurface();
  await writeFile(composerScreenshotFile, await capturePagePng("grouped composer screenshot"));
  await captureStep(
    "14. A compact node pill opens a fixed scrollable list for ordered annotations above the composer",
    "#composerContextTray",
  );
  await click("[aria-label='Close Incoming queue annotations']");
  await click("#sendInteraction");
  const secondDetail = await waitForAcceptedInteractions(thread.id, 2);
  await waitFor("second turn context pill", () => evaluate(`
    document.querySelector('#turnPickerButton')?.textContent === 'Turn 2 of 2'
      && !document.querySelector('#interactionContextPill')?.classList.contains('hidden')
      && document.querySelector('#interactionContextCount')?.textContent === '1'
      && document.querySelector('#threadPrompt')?.disabled === false
  `));
  const secondContext = secondDetail.interactions[1].contexts?.[0];
  if (JSON.stringify(secondContext?.annotations) !== JSON.stringify([
    "Queue order controls which task is claimed next.",
    "Prioritize worker availability when reasoning.",
  ])) throw new Error(`Message+context annotations were not durably ordered: ${JSON.stringify(secondContext)}`);
  await click("#interactionContextPill");
  await waitFor("second turn context popover", () => evaluate(`
    !document.querySelector('#interactionContextPopover')?.classList.contains('hidden')
      && document.querySelectorAll('#interactionContextPopover li').length === 2
  `));
  await captureStep(
    "15. The turn banner shows one connected-node pill; its popover restores both annotations in order",
    "#interactionContextPopover",
  );

  await click("#interactionContextPopover .interaction-context-node");
  await waitFor("historical target Node Details", () => evaluate(`
    document.querySelector('#detailTitle')?.textContent === 'Incoming queue'
      && !document.querySelector('#inspector')?.classList.contains('hidden')
      && !document.querySelector('#attachNodeContext')?.classList.contains('hidden')
      && document.querySelector('#attachNodeContext')?.disabled === false
  `));
  await captureStep(
    "16. Clicking the connected node reopens its full Node Details from history",
    "#inspector",
  );

  await click("#attachNodeContext");
  await waitFor("historical target context editor", () => evaluate(`
    Boolean(document.querySelector('#contextAnnotationEditor'))
  `));
  await setValue("#contextAnnotationEditor", "This annotation alone is a valid interaction input.");
  await click("[aria-label='Confirm annotation']");
  await waitFor("annotation-only send enabled", () => evaluate(`
    document.querySelector('#threadPrompt')?.value === ''
      && document.querySelector('#sendInteraction')?.disabled === false
  `));
  await captureStep(
    "17. A connected node with a non-empty annotation enables send even when message text is empty",
    "#threadComposerShell",
  );
  await click("#sendInteraction");
  const thirdDetail = await waitForAcceptedInteractions(thread.id, 3);
  await waitFor("annotation-only history pill", () => evaluate(`
    document.querySelector('#turnPickerButton')?.textContent === 'Turn 3 of 3'
      && document.querySelector('#interactionText')?.textContent === ''
      && !document.querySelector('#interactionContextPill')?.classList.contains('hidden')
  `));
  const thirdContext = thirdDetail.interactions[2].contexts?.[0];
  if (JSON.stringify(thirdContext?.annotations) !== JSON.stringify([
    "This annotation alone is a valid interaction input.",
  ])) throw new Error(`Annotation-only context was not durable: ${JSON.stringify(thirdContext)}`);
  await click("#interactionContextPill");
  await waitFor("annotation-only context popover", () => evaluate(`
    document.querySelector('#interactionContextPopover li')?.textContent
      === 'This annotation alone is a valid interaction input.'
  `));
  await captureStep(
    "18. Annotation-only history has no derived message label; the context pill preserves the actual input",
    "#interactionBanner",
  );

  await restartStack(thread.id);
  const restartedDetail = await waitForAcceptedInteractions(thread.id, 3);
  await waitFor("persisted context after full service and window restart", () => evaluate(`
    document.querySelector('#turnPickerButton')?.textContent === 'Turn 3 of 3'
      && document.querySelector('#interactionContextCount')?.textContent === '1'
      && !document.querySelector('#interactionContextPill')?.classList.contains('hidden')
  `));
  await click("#interactionContextPill");
  await waitFor("restarted context popover", () => evaluate(`
    document.querySelector('#interactionContextPopover li')?.textContent
      === 'This annotation alone is a valid interaction input.'
  `));
  await refreshCaptureSurface();
  await writeFile(restartedScreenshotFile, await capturePagePng("restarted context screenshot"));
  await captureStep(
    "19. After restarting Electron's Rust graph/app services and window, the exact context is still visible",
    "#interactionContextPopover",
  );
  await click("#interactionContextPopover .interaction-context-node");
  await waitFor("restarted target Node Details", () => evaluate(`
    document.querySelector('#detailTitle')?.textContent === 'Incoming queue'
      && !document.querySelector('#inspector')?.classList.contains('hidden')
  `));
  await captureStep(
    "20. The persisted context still reopens the exact target node after restart",
    "#inspector",
  );

  const restartDraftA = "Keep queue claims in their original order.";
  await click("#closeInspector");
  await waitFor("close Node Details before the recorded two-draft journey", () => evaluate(`
    document.querySelector('#inspector')?.classList.contains('hidden')
  `));
  const beforeRestartRecording = await startContinuousRecording("before-restart");
  await captureRecordingBoundary(beforeRestartRecording, "journey recording started with the graph ready and Node Details closed", ["Incoming queue"]);
  await clickNode("Incoming queue");
  await waitFor("recorded Incoming queue Node Details open", () => evaluate(`
    document.querySelector('#detailTitle')?.textContent === 'Incoming queue'
      && !document.querySelector('#inspector')?.classList.contains('hidden')
  `));
  await captureRecordingBoundary(beforeRestartRecording, "opened Incoming queue Node Details for draft A", ["Incoming queue"]);
  await click("#attachNodeContext");
  await waitFor("recorded first draft editor open", () => evaluate(`Boolean(document.querySelector('#contextAnnotationEditor'))`));
  await captureRecordingBoundary(beforeRestartRecording, "opened the draft A editor", ["Incoming queue", "Add an annotation"]);
  await setValue("#contextAnnotationEditor", restartDraftA);
  const restartDraftRecordA = await waitFor("first restart draft saved", async () => {
    const response = await productRequest(`/api/threads/${thread.id}/context-drafts`);
    return response.drafts?.find((draft) => draft.text === restartDraftA) || false;
  });
  await captureRecordingBoundary(beforeRestartRecording, "typed and durably saved draft A on Incoming queue", [restartDraftA]);
  await clickNode("Two-worker pool");
  await waitFor("recorded switch to Two-worker pool", () => evaluate(`
    document.querySelector('#detailTitle')?.textContent === 'Two-worker pool'
      && !document.querySelector('#contextAnnotationEditor')
  `));
  await captureRecordingBoundary(beforeRestartRecording, "switched from Incoming queue to Two-worker pool", ["Two-worker pool"]);
  await click("#attachNodeContext");
  const restartDraftB = "Keep both workers available for queued tasks.";
  await waitFor("second draft editor open in continuous recording", () => evaluate(`Boolean(document.querySelector('#contextAnnotationEditor'))`));
  await captureRecordingBoundary(beforeRestartRecording, "opened the draft B editor", ["Two-worker pool", "Add an annotation"]);
  await setValue("#contextAnnotationEditor", restartDraftB);
  const bothRestartDrafts = await waitFor("two occurrence-bound drafts saved", async () => {
    const response = await productRequest(`/api/threads/${thread.id}/context-drafts`);
    return response.drafts?.length === 2
      && response.drafts.some((draft) => draft.targetNode?.title === "Incoming queue" && draft.text === restartDraftA)
      && response.drafts.some((draft) => draft.targetNode?.title === "Two-worker pool" && draft.text === restartDraftB)
      ? response.drafts
      : false;
  });
  assertDeepEqual(
    bothRestartDrafts.find((draft) => draft.text === restartDraftA),
    restartDraftRecordA,
    "Creating B changed the complete durable A record",
  );
  const restartDraftRecordB = bothRestartDrafts.find((draft) => draft.text === restartDraftB);
  if (!restartDraftRecordB) throw new Error("The durable B draft record was absent after save.");
  await captureRecordingBoundary(beforeRestartRecording, "typed and durably saved draft B on Two-worker pool", [restartDraftB]);
  await clickNode("Incoming queue");
  await waitFor("draft A restored before restart", () => evaluate(`
    document.querySelector('#contextAnnotationEditor')?.value === ${JSON.stringify(restartDraftA)}
  `));
  await captureRecordingBoundary(beforeRestartRecording, "restored draft A after saving B", [restartDraftA]);
  await clickNode("Two-worker pool");
  await waitFor("draft B restored before restart", () => evaluate(`
    document.querySelector('#contextAnnotationEditor')?.value === ${JSON.stringify(restartDraftB)}
  `));
  await captureRecordingBoundary(beforeRestartRecording, "restored draft B after saving and restoring A", [restartDraftB]);
  await clickNode("Incoming queue");
  await waitFor("draft A left visible before restart", () => evaluate(`
    document.querySelector('#contextAnnotationEditor')?.value === ${JSON.stringify(restartDraftA)}
  `));
  await captureRecordingBoundary(beforeRestartRecording, "both complete durable drafts are present before service/window restart", [restartDraftA]);
  await stopContinuousRecording(beforeRestartRecording);
  const restartOperationStartedAtUtc = new Date().toISOString();
  await restartStack(thread.id);
  const restartOperationEndedAtUtc = new Date().toISOString();
  const afterRestartRecording = await startContinuousRecording("after-restart");
  await captureRecordingBoundary(afterRestartRecording, "Electron BrowserWindow and app services reopened after explicit recording discontinuity", ["Incoming queue"]);
  await waitForAcceptedInteractions(thread.id, 3);
  const reopenedDrafts = await productRequest(`/api/threads/${thread.id}/context-drafts`);
  assertDeepEqual(reopenedDrafts.drafts, bothRestartDrafts, "Full service and window restart changed either complete draft record");
  await clickNode("Incoming queue");
  await waitFor("first draft restored after restart", () => evaluate(`
    document.querySelector('#contextAnnotationEditor')?.value === ${JSON.stringify(restartDraftA)}
  `));
  await captureRecordingBoundary(afterRestartRecording, "restored draft A after full service/window restart", [restartDraftA]);
  await writeFile(twoDraftsScreenshotFile, await capturePagePng("two drafts restored after restart"));
  await captureStep(
    "21. After a full service and window restart, the first exact unconfirmed draft restores on its node",
    "#nodeContextDock",
  );
  await clickNode("Two-worker pool");
  await waitFor("second draft restored after restart", () => evaluate(`
    document.querySelector('#contextAnnotationEditor')?.value === ${JSON.stringify(restartDraftB)}
  `));
  await captureRecordingBoundary(afterRestartRecording, "restored draft B after full service/window restart", [restartDraftB]);
  await captureStep(
    "22. Selecting the other node restores its separate exact unconfirmed draft after restart",
    "#nodeContextDock",
  );
  await writeFile(secondDraftScreenshotFile, await capturePagePng("second draft restored after restart"));
  await clickNode("Incoming queue");
  const restartDraftRecordBBeforeConfirm = structuredClone(restartDraftRecordB);
  await click("[aria-label='Confirm annotation']");
  const confirmedState = await waitFor("first draft confirmed while second remains", async () => {
    const response = await productRequest(`/api/threads/${thread.id}/context-drafts`);
    return response.drafts?.length === 1
      && response.drafts[0].text === restartDraftB
      && response.confirmations?.some((item) => item.annotation === restartDraftA)
      ? response
      : false;
  });
  assertDeepEqual(confirmedState.drafts, [restartDraftRecordBBeforeConfirm], "Confirming A changed the complete durable B record");
  const confirmedARecord = structuredClone(confirmedState.confirmations.find((item) => item.annotation === restartDraftA));
  if (!confirmedARecord
    || confirmedARecord.draftId !== restartDraftRecordA.id
    || confirmedARecord.annotation !== restartDraftA) {
    throw new Error(`Confirmation A resolved to the wrong draft: ${JSON.stringify(confirmedARecord)}`);
  }
  assertDeepEqual(confirmedARecord.target, restartDraftRecordA.target, "Confirmed A used a different occurrence than its draft");
  await captureRecordingBoundary(afterRestartRecording, "confirmed A while the full B record remained unchanged", ["Incoming queue"]);
  await writeFile(confirmedDraftScreenshotFile, await capturePagePng("confirmed draft and remaining draft"));
  await captureStep(
    "23. Confirming the first draft leaves the other occurrence's durable draft unchanged",
    "#composerContextTray",
  );
  await clickNode("Two-worker pool");
  await waitFor("second draft editor selected for discard", () => evaluate(`
    document.querySelector('#contextAnnotationEditor')?.value === ${JSON.stringify(restartDraftB)}
      && document.querySelector('[aria-label="Discard annotation draft for Two-worker pool"]')
  `));
  await captureRecordingBoundary(afterRestartRecording, "restored B editor before discard", [restartDraftB]);
  await click("[aria-label='Discard annotation draft for Two-worker pool']");
  const discardedState = await waitFor("second draft discarded without changing confirmation", async () => {
    const response = await productRequest(`/api/threads/${thread.id}/context-drafts`);
    return response.drafts?.length === 0
      && response.confirmations?.some((item) => item.annotation === restartDraftA)
      ? response
      : false;
  });
  assertDeepEqual(discardedState.confirmations, [confirmedARecord], "Discarding B changed the complete confirmed A record");
  await waitFor("discarded B leaves its Node Details visible without a draft editor", () => evaluate(`(() => {
    const dock = document.querySelector('#nodeContextDock');
    return document.querySelector('#detailTitle')?.textContent === 'Two-worker pool'
      && !document.querySelector('#contextAnnotationEditor')
      && dock?.classList.contains('hidden') === true;
  })()`));
  await captureRecordingBoundary(
    afterRestartRecording,
    "discarded B leaves its historical node visible with no draft editor",
    ["Two-worker pool"],
    criticalBoundaryHoldMs,
  );
  await click("#attachNodeContext");
  const freshDraftB = "Review worker availability before sending.";
  await waitFor("fresh B editor reopened after discard", () => evaluate(`Boolean(document.querySelector('#contextAnnotationEditor'))`));
  await captureRecordingBoundary(afterRestartRecording, "recreated a fresh empty B editor after discard", ["Two-worker pool", "Add an annotation"]);
  await setValue("#contextAnnotationEditor", freshDraftB);
  const freshDraftRecord = await waitFor("fresh unconfirmed second draft saved", async () => {
    const response = await productRequest(`/api/threads/${thread.id}/context-drafts`);
    return response.drafts?.length === 1 && response.drafts[0].text === freshDraftB
      ? response.drafts[0]
      : false;
  });
  const freshDraftSnapshot = structuredClone(freshDraftRecord);
  await captureRecordingBoundary(afterRestartRecording, "created fresh B after discarding the original B", [freshDraftB]);
  await click("#closeInspector");
  await waitFor("fresh draft editor closes before ordinary Send", () => evaluate(`
    document.querySelector('#inspector')?.classList.contains('hidden')
      && !document.querySelector('#contextAnnotationEditor')
  `));
  const preWarningThread = await productRequest(`/api/threads/${thread.id}`);
  const interactionIdsBeforeWarning = interactionIds(preWarningThread);
  await setValue("#threadPrompt", "Use the confirmed queue note for this follow-up.");
  await click("#sendInteraction");
  const warningPresentation = await waitFor("draft omission warning is visibly anchored and names the actual remaining draft", () => evaluate(`(() => {
    const dialog = document.querySelector('#contextDraftSendWarning');
    const bounds = dialog?.getBoundingClientRect();
    const style = dialog && getComputedStyle(dialog);
    return dialog?.open === true
      && dialog.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      && bounds.width > 0 && bounds.height > 0
      && bounds.right <= window.innerWidth && bounds.bottom <= window.innerHeight
      && style.display !== 'none' && style.visibility === 'visible'
      && document.querySelector('#contextDraftSendWarningList strong')?.textContent === 'Two-worker pool'
      ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      : false;
  })()`));
  await captureRecordingBoundary(afterRestartRecording, "first omission warning opened with fresh B named", ["Drafts will be omitted", "Two-worker pool"]);
  assertDeepEqual(
    (await productRequest(`/api/threads/${thread.id}/context-drafts`)).drafts,
    [freshDraftSnapshot],
    "Opening warning changed the complete fresh B record",
  );
  assertDeepEqual(
    interactionIds(await productRequest(`/api/threads/${thread.id}`)),
    interactionIdsBeforeWarning,
    "Opening warning created or removed an interaction",
  );
  await refreshCaptureSurface();
  await writeFile(warningScreenshotFile, await capturePagePng("draft omission warning"));
  await captureStep(
    "24. Send names the remaining unconfirmed Two-worker pool draft before omitting it",
    "#contextDraftSendWarning",
  );
  await click("#cancelContextDraftSend");
  await waitFor("Go back restores exact composition and draft", async () => {
    const response = await productRequest(`/api/threads/${thread.id}/context-drafts`);
    return !await evaluate(`document.querySelector('#contextDraftSendWarning')?.open === true`)
      && await evaluate(`document.querySelector('#threadPrompt')?.value === 'Use the confirmed queue note for this follow-up.'`)
      && response.drafts?.length === 1 && response.drafts[0].text === freshDraftB;
  });
  const goBackDraftState = await productRequest(`/api/threads/${thread.id}/context-drafts`);
  assertDeepEqual(goBackDraftState.drafts, [freshDraftSnapshot], "Go back changed the complete fresh B record");
  assertDeepEqual(
    interactionIds(await productRequest(`/api/threads/${thread.id}`)),
    interactionIdsBeforeWarning,
    "Go back created or removed an interaction",
  );
  await captureRecordingBoundary(afterRestartRecording, "Go back restored composition without changing B or interactions", ["Use the confirmed queue note for this follow-up."]);
  await captureStep(
    "25. Go back restores the editable message and leaves the exact draft intact",
    "#composerContextTray",
  );
  await click("#sendInteraction");
  const secondWarningPresentation = await waitFor("second omission warning visibly reopened with the remaining draft named", () => evaluate(`(() => {
    const dialog = document.querySelector('#contextDraftSendWarning');
    const bounds = dialog?.getBoundingClientRect();
    const style = dialog && getComputedStyle(dialog);
    return dialog?.open === true
      && dialog.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      && bounds.width > 0 && bounds.height > 0
      && bounds.right <= window.innerWidth && bounds.bottom <= window.innerHeight
      && style.display !== 'none' && style.visibility === 'visible'
      && document.querySelector('#contextDraftSendWarningList strong')?.textContent === 'Two-worker pool'
      ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      : false;
  })()`));
  assertDeepEqual(
    (await productRequest(`/api/threads/${thread.id}/context-drafts`)).drafts,
    [freshDraftSnapshot],
    "Reopening warning changed the complete fresh B record",
  );
  assertDeepEqual(
    interactionIds(await productRequest(`/api/threads/${thread.id}`)),
    interactionIdsBeforeWarning,
    "Reopening warning created or removed an interaction",
  );
  await captureRecordingBoundary(
    afterRestartRecording,
    "second omission warning visibly reopened before explicit override",
    ["Drafts will be omitted", "Two-worker pool"],
    criticalBoundaryHoldMs,
  );
  await click("#confirmContextDraftSend");
  const overrideDetail = await waitForAcceptedInteractions(thread.id, 4);
  const overrideInteraction = overrideDetail.interactions.at(-1);
  const submittedContextPayload = (overrideInteraction.contexts || []).map(({ target, annotations }) => ({ target, annotations }));
  assertDeepEqual(submittedContextPayload, [{
    target: confirmedARecord.target,
    annotations: [confirmedARecord.annotation],
  }], "Override submitted contexts beyond A's exact occurrence and single annotation");
  assertDeepEqual(
    interactionIds(overrideDetail),
    [...interactionIdsBeforeWarning, overrideInteraction.id],
    "Override did not append exactly one interaction after the warning journey",
  );
  await captureRecordingBoundary(afterRestartRecording, "explicit override submitted exactly A and no other context", ["Use the confirmed queue note for this follow-up."]);
  const durableAfterOverride = await productRequest(`/api/threads/${thread.id}/context-drafts`);
  assertDeepEqual(durableAfterOverride.drafts, [freshDraftSnapshot], "Override changed the complete durable B record");
  const freshDraftTurnIndex = overrideDetail.interactions.findIndex((interaction) => (
    String(interaction.graphNodeId) === String(freshDraftRecord.target.sourceInteractionNodeId)
  ));
  if (freshDraftTurnIndex < 0) {
    throw new Error(`The fresh draft source occurrence is absent from accepted history: ${JSON.stringify(freshDraftRecord)}`);
  }
  const currentTurnLabel = await evaluate(`document.querySelector('#turnPickerButton')?.textContent`);
  const currentTurnNumber = Number(currentTurnLabel?.match(/^Turn (\d+) of (\d+)$/)?.[1]);
  for (let turnNumber = currentTurnNumber; turnNumber > freshDraftTurnIndex + 1; turnNumber -= 1) {
    await click("#previousTurn");
    await waitFor(`draft-owning historical turn ${turnNumber - 1}`, () => evaluate(`
      document.querySelector('#turnPickerButton')?.textContent === ${JSON.stringify(`Turn ${turnNumber - 1} of ${overrideDetail.interactions.length}`)}
    `));
  }
  await clickNode("Two-worker pool");
  await waitFor("unconfirmed draft restores on its original occurrence", () => evaluate(`
    document.querySelector('#contextAnnotationEditor')?.value === ${JSON.stringify(freshDraftB)}
      && !document.querySelector('#nodeContextDock')?.classList.contains('hidden')
  `));
  const restoredAfterHistoryDraftState = await productRequest(`/api/threads/${thread.id}/context-drafts`);
  assertDeepEqual(restoredAfterHistoryDraftState.drafts, [freshDraftSnapshot], "Historical restoration changed the complete fresh B record");
  await captureRecordingBoundary(afterRestartRecording, "restored fresh B on its exact historical occurrence after override", [freshDraftB]);
  await writeFile(overrideScreenshotFile, await capturePagePng("draft restored after override"));
  await captureStep(
    "26. The accepted follow-up clears the composer; the omitted draft remains on its original historical node occurrence",
    "#nodeContextDock",
  );
  const afterRestartRecordingReceipt = await stopContinuousRecording(afterRestartRecording);
  const restartDiscontinuity = {
    startsAtUtc: recordingSegments[0].receipt.endedAtUtc,
    endsAtUtc: afterRestartRecordingReceipt.startedAtUtc,
    durationMs: Date.parse(afterRestartRecordingReceipt.startedAtUtc)
      - Date.parse(recordingSegments[0].receipt.endedAtUtc),
    restartOperationStartedAtUtc,
    restartOperationEndedAtUtc,
    reason: "Recording stopped and the first segment was encoded; then the Electron BrowserWindow and Rust app/graph services were stopped and reopened; recording resumed only on the reopened window.",
    beforeSegment: "interaction-context-before-restart.mp4",
    afterSegment: "interaction-context-after-restart.mp4",
  };

  if (restartedDetail.interactions[2].contexts?.[0]?.targetNode?.title !== "Incoming queue") {
    throw new Error("Restarted product history did not preserve the target-node snapshot.");
  }
  if (recordingSegments.length !== 2
    || recordingSegments[0].receipt?.file !== "interaction-context-before-restart.mp4"
    || recordingSegments[1].receipt !== afterRestartRecordingReceipt) {
    throw new Error("The before/after restart recording segments are incomplete or out of order.");
  }
  assertDeepEqual(recordingSegments[0].events.map((event) => event.name), [
    "journey recording started with the graph ready and Node Details closed",
    "opened Incoming queue Node Details for draft A",
    "opened the draft A editor",
    "typed and durably saved draft A on Incoming queue",
    "switched from Incoming queue to Two-worker pool",
    "opened the draft B editor",
    "typed and durably saved draft B on Two-worker pool",
    "restored draft A after saving B",
    "restored draft B after saving and restoring A",
    "both complete durable drafts are present before service/window restart",
  ], "The pre-restart continuous recording missed a required draft transition");
  assertDeepEqual(recordingSegments[1].events.map((event) => event.name), [
    "Electron BrowserWindow and app services reopened after explicit recording discontinuity",
    "restored draft A after full service/window restart",
    "restored draft B after full service/window restart",
    "confirmed A while the full B record remained unchanged",
    "restored B editor before discard",
    "discarded B leaves its historical node visible with no draft editor",
    "recreated a fresh empty B editor after discard",
    "created fresh B after discarding the original B",
    "first omission warning opened with fresh B named",
    "Go back restored composition without changing B or interactions",
    "second omission warning visibly reopened before explicit override",
    "explicit override submitted exactly A and no other context",
    "restored fresh B on its exact historical occurrence after override",
  ], "The post-restart continuous recording missed a required warning or override transition");
  for (const segment of recordingSegments) {
    for (const event of segment.events) {
      const frame = segment.frameTimestamps[event.capturedFrameNumber];
      if (!frame
        || frame.capturedAtUtc !== event.capturedFrameAtUtc
        || frame.sha256 !== event.capturedFrameSha256
        || event.paintSynchronized !== "webContents.invalidate followed by two renderer animation frames before capture"
        || event.visibleContentAccepted !== true
        || event.observedHoldMs < defaultBoundaryHoldMs
        || event.holdEndFrameNumber <= event.capturedFrameNumber
        || event.maximumHoldCaptureGapMs > maximumContinuousFrameGapMs) {
        throw new Error(`Visual boundary ${event.name} is not tied to painted, text-verified endpoint frames and a continuous measured hold.`);
      }
      if ((event.name.includes("discarded B leaves")
        || event.name.includes("second omission warning"))
        && event.observedHoldMs < criticalBoundaryHoldMs) {
        throw new Error(`Critical visual boundary ${event.name} was held for less than ${criticalBoundaryHoldMs}ms.`);
      }
    }
  }
  const composerBytes = await readFile(composerScreenshotFile);
  const restartedBytes = await readFile(restartedScreenshotFile);
  const twoDraftsBytes = await readFile(twoDraftsScreenshotFile);
  const secondDraftBytes = await readFile(secondDraftScreenshotFile);
  const confirmedDraftBytes = await readFile(confirmedDraftScreenshotFile);
  const warningBytes = await readFile(warningScreenshotFile);
  const overrideBytes = await readFile(overrideScreenshotFile);
  const historicalMontageBytes = await readFile(historicalMontageFile);
  const sourceHashesAfterCapture = await sourceFingerprints();
  const sourceCommitAfterCapture = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const sourceTreeAfterCapture = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  if (JSON.stringify(sourceHashesBeforeCapture) !== JSON.stringify(sourceHashesAfterCapture)) {
    throw new Error(`Source proof files changed during capture: ${JSON.stringify({ sourceHashesBeforeCapture, sourceHashesAfterCapture })}`);
  }
  if (sourceCommitAfterCapture !== sourceCommit || sourceTreeAfterCapture !== sourceTree) {
    throw new Error(`The committed source snapshot changed during capture: ${JSON.stringify({ sourceCommit, sourceCommitAfterCapture, sourceTree, sourceTreeAfterCapture })}`);
  }
  const manifest = {
    schemaVersion: 1,
    passed: true,
    capturedAt: new Date().toISOString(),
    sourceCommit,
    sourceTree,
    sourceCommitAfterCapture,
    sourceTreeAfterCapture,
    sourceHashesBeforeCapture,
    sourceHashesAfterCapture,
    workingTreeDirty,
    command: `npm run build && ${OPT_IN}=1 electron scripts/capture-interaction-context-evidence.mjs`,
    paidInferenceCalls: 0,
    runtime: "real Electron BrowserWindow + production renderer + Rust app/graph servers + SQLite",
    harness: "fixture-task-system (deterministic zero-inference implementation)",
    viewport: { width: 1480, height: 920 },
    recordingPixelDimensions: recordingSegments.map((segment) => segment.pixelDimensions),
    thread: {
      id: thread.id,
      interactionIds: overrideDetail.interactions.map((interaction) => interaction.id),
      statuses: overrideDetail.interactions.map((interaction) => interaction.completionStatus),
    },
    draftJourney: {
      restoredDrafts: bothRestartDrafts.map((draft) => ({
        id: draft.id,
        revision: draft.revision,
        text: draft.text,
        target: draft.target,
      })),
      freshDraftAfterDiscard: {
        id: freshDraftRecord.id,
        revision: freshDraftRecord.revision,
        text: freshDraftRecord.text,
        target: freshDraftRecord.target,
      },
      confirmedDraftText: restartDraftA,
      owningHistoryTurn: freshDraftTurnIndex + 1,
      submittedInteractionId: overrideInteraction.id,
      submittedContexts: overrideInteraction.contexts,
      interactionIdsBeforeWarning,
      interactionIdsAfterOverride: interactionIds(overrideDetail),
      completeStateSnapshots: {
        draftBBeforeConfirm: restartDraftRecordBBeforeConfirm,
        draftBAfterConfirm: confirmedState.drafts[0],
        confirmedABeforeDiscard: confirmedARecord,
        confirmedAAfterDiscard: discardedState.confirmations[0],
        freshDraftAtWarning: freshDraftSnapshot,
        freshDraftAfterGoBack: goBackDraftState.drafts?.[0],
        freshDraftAfterOverride: durableAfterOverride.drafts?.[0],
        freshDraftAfterHistoricalRestoration: restoredAfterHistoryDraftState.drafts?.[0],
      },
    },
    warningPresentation,
    secondWarningPresentation,
    assertions: {
      allRecordedBoundariesHavePaintedTextAndMeasuredHold: true,
      nodeDetailsOpened: true,
      nodeSwitchSavedAndRestoredDraft: true,
      closeWaitedForDraftSave: true,
      draftDiscardedFromDock: true,
      multipleAnnotationsAddedAndOrdered: true,
      compactComposerPopoverVisible: true,
      compactComposerPopoverAvoidsNodeDetails: true,
      multipleNodePillStripScrolls: true,
      confirmedPreviewIsReadOnly: true,
      annotationDeletedFromExplicitPreview: true,
      messageAndContextSent: true,
      historyPillAndPopoverVisible: true,
      historicalTargetNodeReopened: true,
      annotationOnlyInteractionSent: true,
      servicesAndWindowRestarted: true,
      persistedContextVisibleAfterRestart: true,
      targetNodeReopenedAfterRestart: true,
      twoOccurrenceBoundDraftsSurviveFullRestart: true,
      separateDraftRestorationAfterRestart: true,
      confirmingOneDraftPreservesTheOther: true,
      discardingOneDraftPreservesConfirmedContext: true,
      omissionWarningAndGoBackPreserveDraft: true,
      warningAndGoBackCreateNoInteraction: true,
      explicitOverrideSubmitsConfirmedContextOnly: true,
      explicitOverrideAddsExactlyOneInteraction: true,
      historicalDraftRestoredOnOwningOccurrenceAfterOverride: true,
    },
    screenshots: [
      {
        file: "grouped-composer.png",
        sha256: createHash("sha256").update(composerBytes).digest("hex"),
      },
      {
        file: "restarted-context.png",
        sha256: createHash("sha256").update(restartedBytes).digest("hex"),
      },
      { file: "two-drafts-restored.png", sha256: createHash("sha256").update(twoDraftsBytes).digest("hex") },
      { file: "second-draft-restored.png", sha256: createHash("sha256").update(secondDraftBytes).digest("hex") },
      { file: "confirmed-draft-with-other-draft.png", sha256: createHash("sha256").update(confirmedDraftBytes).digest("hex") },
      { file: "draft-omission-warning.png", sha256: createHash("sha256").update(warningBytes).digest("hex") },
      { file: "draft-after-override.png", sha256: createHash("sha256").update(overrideBytes).digest("hex") },
    ],
    recording: {
      mode: "two continuous direct-renderer recordings; each boundary waits for paint and OCR-matches its exact required text at both ends of a continuously sampled visible hold; timestamps define VFR durations with an explicit terminal-frame hold and full-restart discontinuity",
      segments: recordingSegments.map((segment) => segment.receipt),
      discontinuity: restartDiscontinuity,
      eventCheckpoints: frames.map(({ caption, capturedAtUtc, selector }) => ({ caption, capturedAtUtc, selector })),
      historicalStillMontage: {
        file: historicalMontageFile.split("/").at(-1),
        sha256: createHash("sha256").update(historicalMontageBytes).digest("hex"),
        role: "Retained from the prior evidence snapshot. This timed still-frame montage is historical and does not prove the missing interaction transitions.",
      },
    },
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

async function stop() {
  await abandonContinuousRecording();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  if (keepaliveWindow && !keepaliveWindow.isDestroyed()) keepaliveWindow.destroy();
  await stopServices();
  if (captureTextRecognizer) await captureTextRecognizer.close().catch(() => undefined);
  unregisterIpc();
  await rm(dataDirectory, { recursive: true, force: true });
}

app.whenReady().then(run).then(async () => {
  await stop();
  app.exit(0);
}).catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await stop();
  app.exit(1);
});
