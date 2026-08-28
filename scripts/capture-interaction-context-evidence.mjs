import { app, BrowserWindow, ipcMain } from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";

import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";
import { createElectronWorkspaceDriver } from "./electron-workspace-driver.mjs";

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
const videoOutputFile = join(outputDirectory, "interaction-context.mp4");
const composerScreenshotFile = join(outputDirectory, "grouped-composer.png");
const restartedScreenshotFile = join(outputDirectory, "restarted-context.png");
const manifestFile = join(outputDirectory, "manifest.json");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-interaction-context-evidence-"));
const framesDirectory = join(dataDirectory, "frames");
const configurationPath = join(repositoryRoot, "harnesses", "fixture-task-system.yaml");
const graphServerBinary = join(repositoryRoot, "target", "debug", "relayer-graph-server");
const appServerBinary = join(repositoryRoot, "target", "debug", "relayer-app-server");
const frames = [];

let runtime;
let catalogRefreshServer;
let product;
let productSession;
let mainWindow;
let keepaliveWindow;

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
  ipcMain.handle("relayer:folder-choose", () => null);
  ipcMain.handle("relayer:tutorial-read", () => ({
    status: "dismissed",
    automaticEligible: false,
  }));
}

function unregisterIpc() {
  for (const channel of [
    "relayer:account-read",
    "relayer:appearance-read",
    "relayer:update-status",
    "relayer:folder-choose",
    "relayer:tutorial-read",
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

async function captureStep(caption, selector, duration = 2.4) {
  await mkdir(framesDirectory, { recursive: true });
  await evaluate(`(() => {
    document.querySelector('[data-relayer-evidence-caption]')?.remove();
    document.querySelectorAll('[data-relayer-evidence-highlight]').forEach((element) => {
      element.style.removeProperty('box-shadow');
      element.removeAttribute('data-relayer-evidence-highlight');
    });
    const target = document.querySelector(${JSON.stringify(selector)});
    if (target) {
      target.dataset.relayerEvidenceHighlight = 'true';
      target.style.boxShadow = '0 0 0 3px rgba(128,174,248,.78),0 14px 40px rgba(0,0,0,.5)';
    }
    const caption = document.createElement('div');
    caption.dataset.relayerEvidenceCaption = 'true';
    caption.textContent = ${JSON.stringify(caption)};
    caption.style.cssText = 'position:fixed;left:50%;top:58px;transform:translateX(-50%);z-index:1000;max-width:900px;padding:10px 16px;border:1px solid #4a5058;border-radius:10px;background:rgba(20,23,27,.97);box-shadow:0 14px 42px rgba(0,0,0,.5);color:#f1f2f3;font:600 14px/1.35 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;pointer-events:none';
    document.body.append(caption);
  })()`);
  await refreshCaptureSurface();
  const file = join(framesDirectory, `${String(frames.length + 1).padStart(2, "0")}.png`);
  await writeFile(file, (await mainWindow.webContents.capturePage()).toPNG());
  frames.push({ file, duration, caption });
  await evaluate(`(() => {
    document.querySelector('[data-relayer-evidence-caption]')?.remove();
    document.querySelectorAll('[data-relayer-evidence-highlight]').forEach((element) => {
      element.style.removeProperty('box-shadow');
      element.removeAttribute('data-relayer-evidence-highlight');
    });
  })()`);
}

async function startServices() {
  runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary,
    configurationPaths: [configurationPath],
    additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory },
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
  });
  mainWindow = await createWindow(productSession);
  mainWindow.setSize(1480, 920);
  await mainWindow.loadURL(`${productSession.origin}/?threadId=${encodeURIComponent(threadId)}`);
  mainWindow.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  mainWindow.focus();
  mainWindow.webContents.focus();
  await waitFor("production thread workspace", () => evaluate(`(() => (
    !document.querySelector('#threadView')?.classList.contains('hidden')
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

async function encodeVideo() {
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
  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_name,width,height,pix_fmt",
    "-of", "json",
    videoOutputFile,
  ], { cwd: repositoryRoot, encoding: "utf8" }));
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", videoOutputFile, "-f", "null", "-",
  ], { cwd: repositoryRoot, stdio: "inherit" });
  return {
    file: "interaction-context.mp4",
    sha256: createHash("sha256").update(await readFile(videoOutputFile)).digest("hex"),
    durationSeconds: Number(Number(probe.format.duration).toFixed(3)),
    stream: probe.streams[0],
    playbackDecoded: true,
  };
}

async function run() {
  process.stdout.write("Starting real-Electron zero-inference interaction-context capture.\n");
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    videoOutputFile,
    composerScreenshotFile,
    restartedScreenshotFile,
    manifestFile,
  ].map((path) => rm(path, { force: true })));
  registerIpc();
  keepaliveWindow = new BrowserWindow({ width: 1, height: 1, show: false });
  await startServices();

  const project = await productRequest("/api/projects", {
    method: "POST",
    body: JSON.stringify({ path: repositoryRoot }),
  });
  const modelSettings = await productRequest("/api/model-settings");
  const modelSelection = {
    familyId: modelSettings.families[0].id,
    providerId: "codex",
    modelId: "fixture-model",
  };
  const thread = await productRequest("/api/threads", {
    method: "POST",
    body: JSON.stringify({
      title: "Interaction context verification",
      initialMessage: "Show the deterministic task system.",
      projectId: project.id,
      permissionProfileId: "auto",
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
    "1. Open Node Details for any visible node; the + control connects it to the next interaction",
    "#inspector",
  );

  await click("#attachNodeContext");
  await waitFor("new context annotation editor", () => evaluate(`Boolean(document.querySelector('#contextAnnotationEditor'))`));
  await setValue("#contextAnnotationEditor", "Queue order controls which task is claimed next.");
  await click("[aria-label='Confirm annotation']");
  await waitFor("first collapsed context pill", () => evaluate(`
    document.querySelectorAll('.composer-context-pill-wrap').length === 1
      && document.querySelector('.composer-context-pill')?.getAttribute('aria-expanded') === 'false'
      && !document.querySelector('.composer-context-preview')
  `));
  await click("[aria-label='Show Incoming queue annotations']");
  await waitFor("first compact annotation preview", () => evaluate(`
    document.querySelectorAll('.composer-context-annotations li').length === 1
  `));
  await click("#attachNodeContext");
  await setValue("#contextAnnotationEditor", "Prioritize worker availability when reasoning.");
  await click("[aria-label='Confirm annotation']");
  await waitFor("second confirmation collapsed", () => evaluate(`
    document.querySelector('.composer-context-pill')?.getAttribute('aria-expanded') === 'false'
      && !document.querySelector('.composer-context-preview')
  `));
  await click("[aria-label='Show Incoming queue annotations']");
  await waitFor("second ordered annotation", () => evaluate(`
    document.querySelectorAll('.composer-context-annotations li').length === 2
  `));
  const previewBeforeEdit = await evaluate(`(() => {
    const preview = document.querySelector('.composer-context-preview')?.getBoundingClientRect();
    const inspector = document.querySelector('#inspector')?.getBoundingClientRect();
    return preview && inspector ? {
      width: preview.width,
      height: preview.height,
      avoidsInspector: preview.right < inspector.left,
    } : null;
  })()`);
  if (!previewBeforeEdit?.avoidsInspector) {
    throw new Error(`Composer context preview overlaps Node Details: ${JSON.stringify(previewBeforeEdit)}`);
  }
  const longAnnotation = "Queue ordering is the key bottleneck. Compare the oldest pending items with current worker capacity, preserve their original priority, and call out any work that has remained stalled across multiple interactions.";
  await click("[aria-label='Edit annotation 1 for Incoming queue']");
  await setValue("#contextAnnotationEditor", longAnnotation);
  const previewDuringEdit = await waitFor("fixed long annotation editor", () => evaluate(`(() => {
    const preview = document.querySelector('.composer-context-preview')?.getBoundingClientRect();
    const editor = document.querySelector('#contextAnnotationEditor');
    if (!preview || !editor || editor.scrollHeight <= editor.clientHeight) return null;
    const initialScrollTop = editor.scrollTop;
    editor.scrollTop = editor.scrollHeight;
    return {
      width: preview.width,
      height: preview.height,
      editorOverflow: getComputedStyle(editor).overflowY,
      editorScrolled: editor.scrollTop > initialScrollTop,
    };
  })()`));
  if (Math.abs(previewDuringEdit.width - previewBeforeEdit.width) >= 1
    || Math.abs(previewDuringEdit.height - previewBeforeEdit.height) >= 1
    || previewDuringEdit.editorOverflow !== "auto"
    || !previewDuringEdit.editorScrolled) {
    throw new Error(`Long annotation edit changed preview geometry: ${JSON.stringify({ previewBeforeEdit, previewDuringEdit })}`);
  }
  await click("[aria-label='Confirm annotation']");
  await waitFor("edited annotation confirmation collapsed", () => evaluate(`
    document.querySelector('.composer-context-pill')?.getAttribute('aria-expanded') === 'false'
      && !document.querySelector('.composer-context-preview')
  `));
  await click("[aria-label='Show Incoming queue annotations']");
  await waitFor("edited ordered annotations", () => evaluate(`(() => {
    const values = [...document.querySelectorAll('.composer-context-annotations li > span')]
      .map((element) => element.textContent);
    return JSON.stringify(values) === JSON.stringify([
      ${JSON.stringify("Queue ordering is the key bottleneck. Compare the oldest pending items with current worker capacity, preserve their original priority, and call out any work that has remained stalled across multiple interactions.")},
      'Prioritize worker availability when reasoning.',
    ]);
  })()`));
  await click("[aria-label='Edit annotation 2 for Incoming queue']");
  await captureStep(
    "2. Editing stays inside the fixed popover and keeps an explicit trash control available",
    ".composer-context-preview",
  );
  await click("[aria-label='Delete annotation being edited for Incoming queue']");
  await waitFor("annotation deleted while editing", () => evaluate(`(() => {
    const values = [...document.querySelectorAll('.composer-context-annotations li > span')]
      .map((element) => element.textContent);
    return JSON.stringify(values) === JSON.stringify([${JSON.stringify(longAnnotation)}]);
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
  await click("#attachNodeContext");
  await click("[aria-label='Confirm annotation']");
  await waitFor("worker-pool context confirmation settled", () => evaluate(`
    !document.querySelector('#contextAnnotationEditor')
      && document.querySelectorAll('.composer-context-pill').length === 2
  `));
  await clickNode("Results store");
  await click("#attachNodeContext");
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
    "3. Multiple attached-node pills scroll horizontally within the available composer width",
    ".composer-context-pills",
  );
  mainWindow.setSize(1480, 920);
  await waitForPaint();
  await click("[aria-label='Detach Two-worker pool']");
  await click("[aria-label='Detach Results store']");
  await click("[aria-label='Show Incoming queue annotations']");
  await waitFor("incoming queue annotations reopened", () => evaluate(`
    document.querySelectorAll('.composer-context-annotations li').length === 2
  `));
  await setValue("#threadPrompt", "Use this connected queue context in the follow-up.");
  await waitFor("message and context send enabled", () => evaluate(`document.querySelector('#sendInteraction')?.disabled === false`));
  await refreshCaptureSurface();
  await writeFile(composerScreenshotFile, (await mainWindow.webContents.capturePage()).toPNG());
  await captureStep(
    "4. A compact node pill opens a fixed scrollable list for ordered annotations above the composer",
    "#composerContextTray",
    3,
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
    longAnnotation,
    "Prioritize worker availability when reasoning.",
  ])) throw new Error(`Message+context annotations were not durably ordered: ${JSON.stringify(secondContext)}`);
  await click("#interactionContextPill");
  await waitFor("second turn context popover", () => evaluate(`
    !document.querySelector('#interactionContextPopover')?.classList.contains('hidden')
      && document.querySelectorAll('#interactionContextPopover li').length === 2
  `));
  await captureStep(
    "5. The turn banner shows one connected-node pill; its popover restores both annotations in order",
    "#interactionContextPopover",
    3,
  );

  await click("#interactionContextPopover .interaction-context-node");
  await waitFor("historical target Node Details", () => evaluate(`
    document.querySelector('#detailTitle')?.textContent === 'Incoming queue'
      && !document.querySelector('#inspector')?.classList.contains('hidden')
      && !document.querySelector('#attachNodeContext')?.classList.contains('hidden')
      && document.querySelector('#attachNodeContext')?.disabled === false
  `));
  await captureStep(
    "6. Clicking the connected node reopens its full Node Details from history",
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
    "7. A connected node with a non-empty annotation enables send even when message text is empty",
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
    "8. Annotation-only history has no derived message label; the context pill preserves the actual input",
    "#interactionBanner",
    3,
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
  await writeFile(restartedScreenshotFile, (await mainWindow.webContents.capturePage()).toPNG());
  await captureStep(
    "9. After restarting Electron's Rust graph/app services and window, the exact context is still visible",
    "#interactionContextPopover",
    3.4,
  );
  await click("#interactionContextPopover .interaction-context-node");
  await waitFor("restarted target Node Details", () => evaluate(`
    document.querySelector('#detailTitle')?.textContent === 'Incoming queue'
      && !document.querySelector('#inspector')?.classList.contains('hidden')
  `));
  await captureStep(
    "10. The persisted context still reopens the exact target node after restart",
    "#inspector",
    3.4,
  );

  if (restartedDetail.interactions[2].contexts?.[0]?.targetNode?.title !== "Incoming queue") {
    throw new Error("Restarted product history did not preserve the target-node snapshot.");
  }
  const video = await encodeVideo();
  const composerBytes = await readFile(composerScreenshotFile);
  const restartedBytes = await readFile(restartedScreenshotFile);
  const manifest = {
    schemaVersion: 1,
    passed: true,
    capturedAt: new Date().toISOString(),
    sourceCommit,
    workingTreeDirty,
    command: `npm run build && ${OPT_IN}=1 electron scripts/capture-interaction-context-evidence.mjs`,
    paidInferenceCalls: 0,
    runtime: "real Electron BrowserWindow + production renderer + Rust app/graph servers + SQLite",
    harness: "fixture-task-system (deterministic zero-inference implementation)",
    viewport: { width: 1480, height: 920 },
    thread: {
      id: thread.id,
      interactionIds: restartedDetail.interactions.map((interaction) => interaction.id),
      statuses: restartedDetail.interactions.map((interaction) => interaction.completionStatus),
    },
    assertions: {
      nodeDetailsOpened: true,
      multipleAnnotationsAddedEditedAndOrdered: true,
      compactComposerPopoverVisible: true,
      compactComposerPopoverAvoidsNodeDetails: true,
      multipleNodePillStripScrolls: true,
      editPreservesPopoverDimensions: true,
      longAnnotationEditorScrolls: true,
      annotationDeletedWhileEditing: true,
      messageAndContextSent: true,
      historyPillAndPopoverVisible: true,
      historicalTargetNodeReopened: true,
      annotationOnlyInteractionSent: true,
      servicesAndWindowRestarted: true,
      persistedContextVisibleAfterRestart: true,
      targetNodeReopenedAfterRestart: true,
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
    ],
    video: {
      ...video,
      steps: frames.map((frame) => frame.caption),
    },
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

async function stop() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  if (keepaliveWindow && !keepaliveWindow.isDestroyed()) keepaliveWindow.destroy();
  await stopServices();
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
