import { app, BrowserWindow, ipcMain } from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { EdgeObject, GraphApiError, LayerObject, NodeObject, RelayerGraphClient } from "@relayer/graph-client";

import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";

const CAPTURE_OPT_IN = "RELAYER_CAPTURE_GRAPH_AUTHORING_REPAIR_EVIDENCE";
const VIDEO_OPT_IN = "RELAYER_RECORD_GRAPH_AUTHORING_REPAIR_VIDEO";
const repositoryRoot = resolve(import.meta.dirname, "..");
const outputDirectory = join(repositoryRoot, "docs", "prd", "assets", "evidence", "graph-authoring-repair");
const dataDirectory = mkdtempSync(join(tmpdir(), "relayer-graph-authoring-repair-evidence-"));
const screenshotFile = join(outputDirectory, "accepted-replay-safe-graph.png");
const videoFile = join(outputDirectory, "graph-authoring-repair.mp4");
const artifactFile = join(outputDirectory, "deterministic-artifact.json");
const manifestFile = join(outputDirectory, "manifest.json");
const services = [];
const ipcChannels = [];
let mainWindow;
let artifact;
let exitCode = 1;

if (process.env[CAPTURE_OPT_IN] !== "1") {
  throw new Error(`Evidence capture is opt-in. Set ${CAPTURE_OPT_IN}=1.`);
}
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const workingTreeDirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8" }).trim());

app.setName("Relayer Graph Authoring Repair Evidence");
mkdirSync(join(dataDirectory, "electron-profile"), { recursive: true });
app.setPath("userData", join(dataDirectory, "electron-profile"));
app.commandLine.appendSwitch("disable-gpu");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function registerIpc(channel, handler) {
  ipcMain.handle(channel, handler);
  ipcChannels.push(channel);
}

function registerProductIpc() {
  registerIpc("relayer:account-read", () => ({ status: "connected", account: { email: "zero-inference@relayer.test", planType: "Fixture" } }));
  registerIpc("relayer:account-login", () => ({ status: "connected" }));
  registerIpc("relayer:account-logout", () => ({ status: "disconnected" }));
  registerIpc("relayer:model-catalog-settings-open", () => null);
  registerIpc("relayer:model-catalog-refresh", () => null);
  registerIpc("relayer:folder-choose", () => null);
  registerIpc("relayer:appearance-read", () => ({ appearance: "dark" }));
  registerIpc("relayer:appearance-set", () => ({ appearance: "dark" }));
  registerIpc("relayer:update-status", () => ({ phase: "development", channel: "stable", version: "evidence" }));
  registerIpc("relayer:update-check", () => ({ phase: "development" }));
  registerIpc("relayer:update-download", () => ({ phase: "development" }));
  registerIpc("relayer:update-install", () => ({ installing: false }));
  registerIpc("relayer:update-channel", () => ({ phase: "development" }));
}

function errorEvidence(error) {
  if (!(error instanceof GraphApiError)) throw error;
  return {
    status: error.status,
    code: error.code,
    path: error.path,
    message: error.message,
    issues: error.issues.map(({ code, path, message }) => ({ code, path, message })),
  };
}

function issueCodes(value) {
  return [value.code, ...value.issues.map((issue) => issue.code)];
}

async function authorProgram(graph, interactionId, revision) {
  const summary = new NodeObject(
    "git-compare",
    "Replay-safe repair",
    revision === 1
      ? "This draft will be corrected by rerunning the whole authoring program."
      : "The authoring program was rerun with the same stable client keys, so the accepted response contains one logical copy.",
    "concept",
    "repair-summary",
  );
  const accepted = new NodeObject(
    "check-circle",
    "Accepted result",
    "The intended root and detail layer were accepted after the abandoned draft layer was explicitly discarded.",
    "concept",
    "accepted-result",
  );
  const detail = new NodeObject(
    "info",
    "Repair evidence",
    "The same node, edge, layer, and action IDs survived the full-program rerun. A second root key was rejected before persistence.",
    "detail",
    "repair-detail",
  );
  const abandoned = new NodeObject(
    "archive",
    "Abandoned draft",
    "This node remains reusable even though its orphan layer is stopped.",
    "detail",
    "abandoned-node",
  );
  for (const node of [summary, accepted, detail, abandoned]) await graph.submitNode(node);

  const rootEdge = new EdgeObject([summary, accepted], "repair-result-edge");
  await graph.createEdge(rootEdge);
  const rootLayer = new LayerObject([summary, accepted], [rootEdge], "repair-root-layer");
  const detailLayer = new LayerObject([detail], [], "repair-detail-layer");
  const abandonedLayer = new LayerObject([abandoned], [], "abandoned-layer");
  for (const layer of [rootLayer, detailLayer, abandonedLayer]) await graph.submitLayer(layer);

  const detailAction = {
    kind: "navigate",
    relation: "expand",
    sourceLayer: rootLayer,
    label: "Inspect repair evidence",
    target: detailLayer,
    clientKey: "inspect-repair",
  };
  const rootAction = {
    kind: "navigate",
    relation: "expand",
    label: "Response",
    target: rootLayer,
    clientKey: "root-response",
  };
  const detailActionRecord = await graph.addAction(summary, detailAction);
  const rootActionRecord = await graph.addAction(interactionId, rootAction);
  return {
    objects: { summary, accepted, detail, abandoned, rootEdge, rootLayer, detailLayer, abandonedLayer },
    records: {
      nodes: [summary.ref.id, accepted.ref.id, detail.ref.id, abandoned.ref.id],
      edge: rootEdge.ref.id,
      layers: [rootLayer.ref.id, detailLayer.ref.id, abandonedLayer.ref.id],
      actions: [detailActionRecord.id, rootActionRecord.id],
    },
  };
}

function repairFixtureFactory() {
  return () => ({
    traceSupport: () => ({ prompt: "none", messages: "none", reasoningSummaries: "none", modelCalls: "none", toolCalls: "none", usage: "none", childStreams: "none", nativeArtifacts: "none" }),
    state: () => ({}),
    async complete(context) {
      const graph = new RelayerGraphClient(context.graph.acquireCapability());
      const first = await authorProgram(graph, context.inputGraph.id, 1);
      let orphanSubmissionError;
      try {
        await graph.submit(context.inputGraph.id);
        throw new Error("The first submission unexpectedly accepted an orphan draft layer.");
      } catch (error) {
        orphanSubmissionError = errorEvidence(error);
      }
      if (!issueCodes(orphanSubmissionError).includes("orphan_draft_layers")) {
        throw new Error(`Expected orphan_draft_layers, received ${JSON.stringify(orphanSubmissionError)}.`);
      }

      const replay = await authorProgram(graph, context.inputGraph.id, 2);
      let duplicateRootError;
      try {
        await graph.addAction(context.inputGraph.id, {
          kind: "navigate",
          relation: "expand",
          label: "Duplicate response",
          target: replay.objects.rootLayer,
          clientKey: "different-root-key",
        });
        throw new Error("A second root client key unexpectedly persisted.");
      } catch (error) {
        duplicateRootError = errorEvidence(error);
      }
      if (!issueCodes(duplicateRootError).includes("root_action_already_exists")) {
        throw new Error(`Expected root_action_already_exists, received ${JSON.stringify(duplicateRootError)}.`);
      }

      const firstDiscard = await graph.discardLayer(replay.objects.abandonedLayer);
      const repeatedDiscard = await graph.discardLayer(replay.objects.abandonedLayer);
      const completion = await graph.submit(context.inputGraph.id);
      const stoppedAfterSubmission = await graph.getLayer(replay.objects.abandonedLayer);
      const stableIds = JSON.stringify(first.records) === JSON.stringify(replay.records);
      const stoppedLayerStable = firstDiscard.id === repeatedDiscard.id
        && repeatedDiscard.id === stoppedAfterSubmission.layer.id
        && firstDiscard.state === "stopped"
        && repeatedDiscard.state === "stopped"
        && stoppedAfterSubmission.layer.state === "stopped";
      if (!stableIds || !stoppedLayerStable) {
        throw new Error(`Replay/discard evidence invariant failed: ${JSON.stringify({ stableIds, stoppedLayerStable })}`);
      }

      artifact = {
        schemaVersion: 1,
        scenario: "graph-authoring-repair-replay-and-discard",
        paidInferenceCalls: 0,
        interactionNodeId: context.inputGraph.id,
        stableClientKeys: [
          "repair-summary", "accepted-result", "repair-detail", "abandoned-node",
          "repair-result-edge", "repair-root-layer", "repair-detail-layer", "abandoned-layer",
          "inspect-repair", "root-response",
        ],
        firstProgramRecords: first.records,
        replayedProgramRecords: replay.records,
        initialSubmissionError: orphanSubmissionError,
        duplicateRootError,
        discard: {
          first: firstDiscard,
          repeated: repeatedDiscard,
          afterAcceptedSubmission: stoppedAfterSubmission.layer,
        },
        acceptedOutput: {
          rootActionId: completion.rootAction.id,
          rootLayerId: completion.rootLayer.layer.id,
          nodeTitles: completion.rootLayer.nodes.map((node) => node.title),
        },
        assertions: {
          wholeProgramReplayPreservedRecordIds: stableIds,
          orphanSubmissionRejected: issueCodes(orphanSubmissionError).includes("orphan_draft_layers"),
          duplicateRootRejectedWithoutPersistence: issueCodes(duplicateRootError).includes("root_action_already_exists"),
          repeatedDiscardReturnedSameStoppedLayer: stoppedLayerStable,
          finalSubmissionAccepted: true,
        },
      };
    },
  });
}

async function productRequest(session, path, init = {}) {
  const response = await fetch(new URL(path, session.origin), {
    ...init,
    headers: {
      Accept: "application/json",
      Cookie: `${session.cookie.name}=${session.cookie.value}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error?.message || JSON.stringify(value));
  return value;
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

async function pause(milliseconds) {
  await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function waitForWindow(label, expression) {
  return waitFor(label, () => mainWindow.webContents.executeJavaScript(expression));
}

async function recordWorkspaceWalkthrough() {
  const frameRate = 10;
  const frameDirectory = join(dataDirectory, "video-frames");
  await mkdir(frameDirectory, { recursive: true });
  let capturing = true;
  let frameCount = 0;
  const captureFrames = (async () => {
    while (capturing) {
      const startedAt = Date.now();
      const frame = (await mainWindow.webContents.capturePage()).toPNG();
      await writeFile(join(frameDirectory, `frame-${String(frameCount).padStart(5, "0")}.png`), frame);
      frameCount += 1;
      await pause(Math.max(0, (1_000 / frameRate) - (Date.now() - startedAt)));
    }
  })();
  await pause(2_000);
  await mainWindow.webContents.executeJavaScript(`[...document.querySelectorAll('.graph-node')].find((node) => node.textContent.includes('Replay-safe repair'))?.click()`);
  await waitForWindow("root repair inspector", `document.querySelector('#detailTitle')?.textContent === 'Replay-safe repair'`);
  await pause(3_000);
  await mainWindow.webContents.executeJavaScript(`[...document.querySelectorAll('[data-action-id]')].find((button) => button.textContent.includes('Inspect repair evidence'))?.click()`);
  await waitForWindow("repair detail layer", `document.querySelector('.graph-node b')?.textContent === 'Repair evidence'`);
  await pause(3_000);
  await mainWindow.webContents.executeJavaScript(`document.querySelector('.graph-node')?.click()`);
  await waitForWindow("repair detail inspector", `document.querySelector('#detailTitle')?.textContent === 'Repair evidence'`);
  await pause(3_000);
  await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-review-path-index="0"]')?.click()`);
  await waitForWindow("returned root layer", `[...document.querySelectorAll('.graph-node b')].some((node) => node.textContent === 'Accepted result')`);
  await pause(2_000);
  capturing = false;
  await captureFrames;
  if (frameCount === 0) throw new Error("Electron window recording produced no frames.");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-framerate", String(frameRate),
    "-i", join(frameDirectory, "frame-%05d.png"),
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", videoFile,
  ], { cwd: repositoryRoot, stdio: "inherit" });
  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "json", videoFile,
  ], { cwd: repositoryRoot, encoding: "utf8" }));
  const bytes = await readFile(videoFile);
  return {
    file: "graph-authoring-repair.mp4",
    sha256: sha256(bytes),
    durationSeconds: Number(Number(probe.format.duration).toFixed(3)),
    capture: `Direct frame recording of the real Electron BrowserWindow at ${frameRate} fps`,
    visibleSteps: [
      "Accepted root graph renders in production ProductWorkspace",
      "Root node inspector exposes the authored detail-layer action",
      "Navigate action opens the accepted detail layer",
      "Detail node opens in the production inspector",
      "Breadcrumb returns to the accepted root layer",
    ],
  };
}

async function run() {
  await access(join(repositoryRoot, "target", "debug", "relayer-graph-server"));
  await access(join(repositoryRoot, "target", "debug", "relayer-app-server"));
  if (process.env[VIDEO_OPT_IN] === "1") {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
  }
  await mkdir(outputDirectory, { recursive: true });
  registerProductIpc();

  const configurationPath = join(repositoryRoot, "harnesses", "fixture-task-system.yaml");
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [configurationPath],
    additionalImplementations: { "fixture.task-system": repairFixtureFactory() },
  });
  services.push(runtime);
  const runtimeSession = await runtime.start();
  let product;
  const catalogSnapshot = {
    providerId: "codex",
    label: "Codex fixture",
    connected: true,
    models: [{ id: "fixture-model", label: "Fixture model", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }],
    systemFamily: { key: "codex", name: "Codex", modelIds: ["fixture-model"] },
  };
  const catalogRefreshServer = await startModelCatalogRefreshServer({
    refresh: () => product.publishProviderCatalog(catalogSnapshot),
  });
  services.push(catalogRefreshServer);
  product = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    providerCatalogRefreshSession: catalogRefreshServer.session,
    defaultHarnessConfiguration: "fixture-task-system",
  });
  services.push(product);
  const productSession = await product.start();
  await product.publishProviderCatalog(catalogSnapshot);

  const modelSettings = await productRequest(productSession, "/api/model-settings");
  const modelSelection = { familyId: modelSettings.families[0].id, providerId: "codex", modelId: "fixture-model" };
  const thread = await productRequest(productSession, "/api/threads", {
    method: "POST",
    body: JSON.stringify({
      title: "Replay-safe graph authoring",
      initialMessage: "Demonstrate repair-safe graph authoring.",
      harnessId: "fixture-task-system",
      modelSelection,
    }),
  });
  const accepted = await waitFor("accepted deterministic repair interaction", async () => {
    const detail = await productRequest(productSession, `/api/threads/${thread.id}`);
    return detail.interactions[0]?.completionStatus === "accepted" ? detail : false;
  }, 20_000);
  if (!artifact) throw new Error("The deterministic repair harness did not publish its evidence artifact.");

  const createWindow = createWindowFactory({
    BrowserWindow,
    desktopDirectory: join(repositoryRoot, "desktop"),
    getAppearance: () => "dark",
    updater: { status: () => ({ phase: "development" }) },
  });
  mainWindow = await createWindow(productSession);
  mainWindow.setSize(1420, 900);
  await mainWindow.loadURL(`${productSession.origin}/?threadId=${thread.id}`);
  mainWindow.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  mainWindow.focus();
  await waitForWindow("accepted root graph", `(() => {
    const titles = [...document.querySelectorAll('.graph-node b')].map((node) => node.textContent);
    return titles.includes('Replay-safe repair') && titles.includes('Accepted result');
  })()`);
  await pause(500);

  const screenshotBytes = (await mainWindow.webContents.capturePage()).toPNG();
  await writeFile(screenshotFile, screenshotBytes);
  const video = process.env[VIDEO_OPT_IN] === "1" ? await recordWorkspaceWalkthrough() : undefined;

  const generatedArtifact = {
    ...artifact,
    generatedAt: new Date().toISOString(),
    sourceCommit,
    workingTreeDirty,
    productThreadId: accepted.thread.id,
    productInteractionId: accepted.interactions[0].id,
  };
  const artifactBytes = Buffer.from(`${JSON.stringify(generatedArtifact, null, 2)}\n`);
  await writeFile(artifactFile, artifactBytes);
  const manifest = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    sourceCommit,
    workingTreeDirty,
    command: `${CAPTURE_OPT_IN}=1${video ? ` ${VIDEO_OPT_IN}=1` : ""} electron scripts/capture-graph-authoring-repair-evidence.mjs`,
    paidInferenceCalls: 0,
    product: {
      renderer: "desktop/renderer ProductWorkspace",
      runtime: "real Rust graph server, Rust app server, SQLite stores, and Electron BrowserWindow",
      deterministicHarness: "fixture.task-system implementation registered for the evidence run",
    },
    screenshot: {
      file: "accepted-replay-safe-graph.png",
      sha256: sha256(screenshotBytes),
      proves: ["Production ProductWorkspace renders the accepted replay-safe root graph"],
    },
    deterministicArtifact: {
      file: "deterministic-artifact.json",
      sha256: sha256(artifactBytes),
      proves: [
        "Whole-program replay retained the same node, edge, layer, and action IDs",
        "Orphan submission failed before discard",
        "A second root client key was rejected without persistence",
        "Repeated discard returned the same stopped layer",
        "The discarded layer remained stopped after final graph acceptance",
      ],
    },
    ...(video ? { screenRecording: video } : {}),
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  exitCode = 0;
}

async function shutdown() {
  mainWindow?.destroy();
  for (const channel of ipcChannels) ipcMain.removeHandler(channel);
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

process.stdout.write("Starting isolated graph-authoring-repair evidence capture...\n");
void app.whenReady()
  .then(run)
  .catch((error) => process.stderr.write(`${error.stack || error.message}\n`))
  .finally(shutdown);
