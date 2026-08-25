import { app, BrowserWindow, ipcMain } from "electron";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";

import { EvalService } from "../desktop/eval-main/eval-service.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";

const OPT_IN = "RELAYER_CAPTURE_HUMAN_ANNOTATION_EVIDENCE";
const repositoryRoot = resolve(import.meta.dirname, "..");
const outputDirectory = join(
  repositoryRoot,
  "docs",
  "prd",
  "assets",
  "evidence",
  "human-eval-annotations",
);
const videoOutputFile = join(outputDirectory, "human-eval-annotations.mp4");
const screenshotOutputFile = join(outputDirectory, "human-eval-annotations.png");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-human-annotation-evidence-"));
const framesDirectory = join(dataDirectory, "frames");
const stateFile = join(dataDirectory, "eval-data", "test-runs.json");
const configurationPath = join(repositoryRoot, "harnesses", "fixture-task-system.yaml");
const services = [];
const frames = [];
let evalService;
let productSession;
let reviewWindow;
let keepaliveWindow;

if (process.env[OPT_IN] !== "1") {
  throw new Error(`Evidence capture is opt-in. Set ${OPT_IN}=1.`);
}
process.stdout.write("Starting zero-inference human annotation evidence capture.\n");

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const workingTreeDirty = Boolean(execFileSync("git", ["status", "--porcelain"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim());

app.setName("Relayer Human Annotation Evidence");
mkdirSync(join(dataDirectory, "electron-profile"), { recursive: true });
app.setPath("userData", join(dataDirectory, "electron-profile"));
app.commandLine.appendSwitch("disable-gpu");

function sleep(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function productRequest(path, options = {}) {
  const response = await fetch(new URL(path, productSession.origin), {
    ...options,
    headers: {
      ...options.headers,
      Cookie: `${productSession.cookie.name}=${productSession.cookie.value}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Product request failed (${response.status}).`);
  return value;
}

async function waitForRun(runId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const run = evalService.getRun(runId);
    if (["passed", "failed", "error", "interrupted"].includes(run.status)) return run;
    await sleep(50);
  }
  throw new Error(`Eval run ${runId} did not finish.`);
}

async function waitFor(label, window, expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await sleep(50);
  }
  const diagnostic = await window.webContents.executeJavaScript(`({
    url: location.href,
    body: document.body?.innerText?.slice(0, 2500),
    toast: document.querySelector('#toast')?.textContent,
    capabilities: window.__relayerState?.capabilities,
  })`).catch(() => null);
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
}

async function clickElement(window, selector) {
  const point = await window.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
  })()`);
  if (!point) throw new Error(`Cannot click missing element ${selector}.`);
  window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
}

async function createAnnotationSession(threadIds) {
  const token = randomBytes(32).toString("hex");
  const username = userInfo().username;
  await productRequest("/api/internal/annotation-sessions", {
    method: "POST",
    body: JSON.stringify({
      token,
      threadIds,
      authorId: `local:${username}`,
      authorDisplayName: "Vishal",
    }),
  });
  return token;
}

async function openReview(execution, token) {
  const threadId = execution.threadIds[0];
  const acceptedTurn = execution.turns.find((turn) => turn.status === "accepted");
  if (!acceptedTurn) throw new Error("Evidence execution has no accepted turn.");
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    show: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0b0c0d",
    webPreferences: {
      preload: join(repositoryRoot, "desktop", "preload", "eval-review.cjs"),
      additionalArguments: [`--relayer-eval-execution=${execution.id}`],
      partition: `relayer-annotation-evidence-${randomBytes(16).toString("hex")}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  for (const cookie of [
    productSession.readOnlyCookie,
    { name: "relayer_annotation", value: token },
  ]) {
    await window.webContents.session.cookies.set({
      url: productSession.origin,
      name: cookie.name,
      value: cookie.value,
      httpOnly: true,
      sameSite: "strict",
      secure: false,
    });
  }
  await window.loadURL(
    `${productSession.origin}/?threadId=${encodeURIComponent(threadId)}&interactionId=${encodeURIComponent(acceptedTurn.interactionId)}&review=1`,
  );
  window.show();
  await waitFor(
    "annotation-capable ProductWorkspace",
    window,
    `Boolean(document.querySelector('.graph-node') && document.querySelector('#annotationPanel') && !document.querySelector('#threadAnnotationBadge')?.classList.contains('hidden'))`,
  );
  app.focus({ steal: true });
  window.focus();
  window.webContents.focus();
  await waitFor("focused annotation review", window, "document.hasFocus() === true");
  window.webContents.invalidate();
  await sleep(100);
  window.webContents.invalidate();
  await sleep(100);
  return window;
}

async function captureStep(window, caption, targetSelector, duration = 2.2) {
  await mkdir(framesDirectory, { recursive: true });
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-relayer-evidence-caption]')?.remove();
    document.querySelectorAll('[data-relayer-evidence-highlight]').forEach((element) => {
      element.style.removeProperty('box-shadow');
      element.removeAttribute('data-relayer-evidence-highlight');
    });
    const target = document.querySelector(${JSON.stringify(targetSelector)});
    if (target) {
      target.dataset.relayerEvidenceHighlight = 'true';
      target.style.boxShadow = '0 0 0 3px rgba(128,174,248,.72),0 14px 40px rgba(0,0,0,.5)';
    }
    const caption = document.createElement('div');
    caption.dataset.relayerEvidenceCaption = 'true';
    caption.textContent = ${JSON.stringify(caption)};
    caption.style.cssText = 'position:fixed;left:50%;top:58px;transform:translateX(-50%);z-index:1000;max-width:820px;padding:10px 16px;border:1px solid #4a5058;border-radius:10px;background:rgba(20,23,27,.96);box-shadow:0 14px 42px rgba(0,0,0,.5);color:#f1f2f3;font:600 14px/1.35 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;pointer-events:none';
    document.body.append(caption);
  })()`);
  await sleep(220);
  const file = join(framesDirectory, `${String(frames.length + 1).padStart(2, "0")}.png`);
  await writeFile(file, (await window.webContents.capturePage()).toPNG());
  frames.push({ file, duration, caption });
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-relayer-evidence-caption]')?.remove();
    document.querySelectorAll('[data-relayer-evidence-highlight]').forEach((element) => {
      element.style.removeProperty('box-shadow');
      element.removeAttribute('data-relayer-evidence-highlight');
    });
  })()`);
}

async function finalizeVideo() {
  const concatFile = join(framesDirectory, "frames.txt");
  const entries = frames.flatMap((frame) => [
    `file '${frame.file.replaceAll("'", "'\\''")}'`,
    `duration ${frame.duration}`,
  ]);
  entries.push(`file '${frames.at(-1).file.replaceAll("'", "'\\''")}'`);
  await writeFile(concatFile, `${entries.join("\n")}\n`);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", concatFile,
    "-vf", "scale=1480:920:force_original_aspect_ratio=decrease,pad=1480:920:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
    "-r", "30", "-movflags", "+faststart", videoOutputFile,
  ], { cwd: repositoryRoot, stdio: "inherit" });
  const videoBytes = await readFile(videoOutputFile);
  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "json", videoOutputFile,
  ], { cwd: repositoryRoot, encoding: "utf8" }));
  return {
    file: "human-eval-annotations.mp4",
    sha256: createHash("sha256").update(videoBytes).digest("hex"),
    durationSeconds: Number(Number(probe.format.duration).toFixed(3)),
  };
}

async function run() {
  process.stdout.write("Electron ready; creating deterministic Eval execution.\n");
  keepaliveWindow = new BrowserWindow({ width: 1, height: 1, show: false });
  await mkdir(outputDirectory, { recursive: true });
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [configurationPath],
    additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory },
  });
  services.push(runtime);
  const runtimeSession = await runtime.start();
  process.stdout.write("Graph runtime started.\n");
  const productServer = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    defaultHarnessConfiguration: "fixture-task-system",
    allowHarnessOverride: true,
    enableReadOnlySession: true,
  });
  services.push(productServer);
  productSession = await productServer.start();
  process.stdout.write("Product server started.\n");
  evalService = await new EvalService({
    stateFile,
    productSession,
    configurationPaths: [configurationPath],
  }).open();
  process.stdout.write("Eval service opened.\n");
  ipcMain.handle("relayer-eval:review-context", (_event, executionId) => (
    evalService.reviewContext(executionId)
  ));

  const created = await evalService.createRun({
    testCaseIds: ["empty-project.task-system.single-turn"],
    harnessConfigurationNames: ["fixture-task-system"],
    judgeConfigurationName: "deterministic-graph-contract",
  });
  process.stdout.write(`Eval run queued: ${created.id}.\n`);
  const completed = await waitForRun(created.id);
  process.stdout.write(`Eval run completed: ${completed.status}.\n`);
  if (completed.status !== "passed") {
    throw new Error(`Deterministic Eval run did not pass: ${JSON.stringify(completed)}`);
  }
  const execution = completed.executions[0];
  const firstToken = await createAnnotationSession(execution.threadIds);
  reviewWindow = await openReview(execution, firstToken);
  process.stdout.write("Annotation-capable review window opened.\n");

  await captureStep(
    reviewWindow,
    "1. Open a fixed Eval execution in the production ProductWorkspace",
    ".graph-node",
  );
  await reviewWindow.webContents.executeJavaScript(`document.querySelector('.graph-node')?.click()`);
  await waitFor(
    "node annotation panel",
    reviewWindow,
    `!document.querySelector('#annotationPanel')?.classList.contains('hidden') && document.querySelector('#detailTitle')?.textContent === 'Incoming queue'`,
  );
  await captureStep(
    reviewWindow,
    "2. Node details stay above a compact annotation composer in the bottom-right",
    "#annotationPanel",
  );
  await reviewWindow.webContents.executeJavaScript(`(() => {
    const field = document.querySelector('#annotationComment');
    field.value = 'The queue explanation is clear and directly tied to this node.';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus();
  })()`);
  await captureStep(
    reviewWindow,
    "3. Add a sparse comment without changing the accepted graph",
    "#annotationComment",
  );
  await clickElement(reviewWindow, "#annotationRatingInput");
  await waitFor(
    "expanded rating surface",
    reviewWindow,
    `document.hasFocus() && document.querySelector('#annotationRating')?.classList.contains('expanded') === true`,
  );
  await captureStep(
    reviewWindow,
    "4. Focusing the white thumb expands the same pill and reveals four labels",
    "#annotationRating",
    2.8,
  );
  await reviewWindow.webContents.executeJavaScript(`document.querySelector('[data-rating="4"]')?.click()`);
  await reviewWindow.webContents.executeJavaScript(`document.querySelector('#annotationRatingInput')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor(
    "collapsed selected rating",
    reviewWindow,
    `document.querySelector('#annotationRatingOutput')?.textContent === 'Great' && document.querySelector('#annotationRating')?.classList.contains('expanded') === false`,
  );
  await captureStep(
    reviewWindow,
    "5. The collapsed control shows only the selected rating: Great",
    "#annotationRating",
  );
  await reviewWindow.webContents.executeJavaScript(`document.querySelector('#submitAnnotation')?.click()`);
  await waitFor(
    "saved annotation",
    reviewWindow,
    `document.querySelector('.annotation-item p')?.textContent.includes('queue explanation') && document.querySelector('.annotation-item-rating')?.textContent === 'Great'`,
  );
  await captureStep(
    reviewWindow,
    "6. Submit with the compact arrow; the comment and rating are saved inline",
    ".annotation-item",
    3,
  );

  reviewWindow.destroy();
  reviewWindow = undefined;
  const secondToken = await createAnnotationSession(execution.threadIds);
  reviewWindow = await openReview(execution, secondToken);
  await reviewWindow.webContents.executeJavaScript(`document.querySelector('.graph-node')?.click()`);
  await waitFor(
    "restored annotation after reopen",
    reviewWindow,
    `document.querySelector('.annotation-item p')?.textContent.includes('queue explanation') && document.querySelector('.annotation-item-rating')?.textContent === 'Great'`,
  );
  await captureStep(
    reviewWindow,
    "7. Reopening the Eval review restores the annotation and its exact node anchor",
    "#annotationPanel",
    3.4,
  );

  const screenshotBytes = (await reviewWindow.webContents.capturePage()).toPNG();
  await writeFile(screenshotOutputFile, screenshotBytes);
  const video = await finalizeVideo();
  const manifest = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    sourceCommit,
    workingTreeDirty,
    command: `${OPT_IN}=1 electron scripts/capture-human-eval-annotation-evidence.mjs`,
    paidInferenceCalls: 0,
    execution: {
      runId: completed.id,
      executionId: execution.id,
      threadId: execution.threadIds[0],
      status: completed.status,
    },
    viewport: { width: 1480, height: 920 },
    persistenceReplay: true,
    screenshot: {
      file: "human-eval-annotations.png",
      sha256: createHash("sha256").update(screenshotBytes).digest("hex"),
    },
    video: {
      ...video,
      steps: frames.map((frame) => frame.caption),
    },
  };
  await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

async function stop() {
  ipcMain.removeHandler("relayer-eval:review-context");
  if (keepaliveWindow && !keepaliveWindow.isDestroyed()) keepaliveWindow.destroy();
  if (reviewWindow && !reviewWindow.isDestroyed()) reviewWindow.destroy();
  for (const service of services.reverse()) await service.close().catch(() => undefined);
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
