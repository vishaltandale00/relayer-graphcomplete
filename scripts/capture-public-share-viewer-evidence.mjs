import { app, BrowserWindow, session } from "electron";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";

import { renderPublicViewerTemplate } from "../desktop/renderer/src/public-share-viewer/template.js";

const OPT_IN = "RELAYER_CAPTURE_PUBLIC_SHARE_VIEWER_EVIDENCE";
const repositoryRoot = resolve(import.meta.dirname, "..");
const rendererRoot = resolve(repositoryRoot, "desktop/renderer");
const evidenceRoot = resolve(repositoryRoot, "docs/evidence/issue-471-public-share-viewer");
const routeId = "a".repeat(32);
const routePath = `/t/${routeId}`;
const sourceFiles = [
  "scripts/capture-public-share-viewer-evidence.mjs",
  "desktop/renderer/public-share.html",
  "desktop/renderer/styles.css",
  "desktop/renderer/src/public-share-viewer/adapter.js",
  "desktop/renderer/src/public-share-viewer/main.js",
  "desktop/renderer/src/public-share-viewer/snapshot.js",
  "desktop/renderer/src/public-share-viewer/template.js",
  "desktop/renderer/src/public-share-viewer/viewer.css",
  "desktop/renderer/src/product-workspace/model.js",
  "desktop/renderer/src/product-workspace/view.js",
  "desktop/renderer/src/product-workspace/workspace.js",
  "desktop/renderer/assets/relayer-logo.svg",
  "desktop/renderer/assets/relayer-share-og.svg",
  "desktop/renderer/vendor/lucide.min.js",
  "desktop/renderer/vendor/marked.umd.js",
];

if (process.env[OPT_IN] !== "1") {
  throw new Error(`Evidence capture is opt-in. Set ${OPT_IN}=1.`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function placement(nodeId, x, y) {
  return { nodeId, x, y };
}

function graphLayer(id, node, actions = [], placements = [placement(node.id, 0.5, 0.5)]) {
  return {
    layer: {
      id,
      nodes: [node.id],
      edges: [],
      layout: { version: 1, placements },
      state: "accepted",
    },
    nodes: [node],
    edges: [],
    actions,
  };
}

function navigateAction({ id, sourceNodeId, sourceLayerId, targetLayerId, relation, label }) {
  return {
    id,
    sourceNodeId,
    sourceLayerId,
    kind: "navigate",
    relation,
    label,
    variant: "pill",
    targetLayerId,
    state: "accepted",
  };
}

/**
 * A deliberately synthetic, fixed V1 snapshot. It is only a rendering input;
 * no local product database, provider, account, or live service is consulted.
 */
function syntheticSnapshot() {
  const turns = [];
  const manifest = [];
  for (let index = 1; index <= 5; index += 1) {
    const turnId = `turn:synthetic-${index}`;
    const interactionNodeId = `node:interaction-${index}`;
    const rootLayerId = `layer:root-${index}`;
    const rootNodeId = `node:root-${index}`;
    const nestedLayerId = `layer:details-${index}`;
    const nestedNodeId = `node:details-${index}`;
    const rootNode = {
      id: rootNodeId,
      kind: "concept",
      icon: index === 1 ? "sparkles" : "check-circle",
      title: index === 1 ? "Evidence-ready result" : `Accepted turn ${index}`,
      detail: index === 1
        ? "This synthetic result is rendered by the production ProductWorkspace. Select the node to inspect its Node Details."
        : `Synthetic accepted content for turn ${index}.`,
      state: "accepted",
    };
    const nestedNode = {
      id: nestedNodeId,
      kind: "detail",
      icon: "info",
      title: "Node Details evidence",
      detail: "The public viewer keeps accepted Node Details available while execution, mutation, and telemetry remain unavailable.",
      state: "accepted",
    };
    const nestedLayer = graphLayer(nestedLayerId, nestedNode);
    const nestedAction = navigateAction({
      id: `action:details-${index}`,
      sourceNodeId: rootNodeId,
      sourceLayerId: rootLayerId,
      targetLayerId: nestedLayerId,
      relation: "expand",
      label: "Inspect Node Details",
    });
    const rootLayer = graphLayer(rootLayerId, rootNode, [nestedAction]);
    const rootAction = navigateAction({
      id: `action:response-${index}`,
      sourceNodeId: interactionNodeId,
      sourceLayerId: null,
      targetLayerId: rootLayerId,
      relation: "expand",
      label: "Response",
    });
    const turn = {
      recordType: "turn",
      id: turnId,
      sequence: index,
      createdAt: `2026-09-25T00:0${index}:00Z`,
      text: index === 1 ? "Capture public viewer evidence" : `Review accepted evidence turn ${index}`,
      interactionNodeId,
      origin: { kind: "user" },
      completion: {
        status: "accepted",
        permissionProfileId: "auto",
        harnessConfigurationName: "synthetic-evidence",
        modelSelection: { providerId: "fixture", modelId: "fixture-model", modelFamilyId: 1 },
      },
      contexts: [],
      submittedInputs: [],
      acceptedView: {
        interactionNodeId,
        rootAction,
        rootLayerId,
        layers: [rootLayer, nestedLayer],
      },
    };
    manifest.push({ id: turnId, sequence: index });
    turns.push(turn);
  }
  return jsonl([
    {
      recordType: "header",
      exportVersion: 1,
      exportedAt: "2026-09-25T00:00:00Z",
      producer: {
        desktopVersion: "synthetic-evidence",
        buildCommit: "synthetic-evidence",
        platform: "darwin",
        architecture: "arm64",
      },
      conversation: {
        id: "conversation:synthetic-public-share",
        title: "Synthetic public viewer evidence",
        createdAt: "2026-09-25T00:00:00Z",
        projectName: "Synthetic evidence project",
        harnessConfigurationName: "synthetic-evidence",
        permissionProfileId: "auto",
      },
      turns: manifest,
    },
    ...turns,
  ]);
}

function isSafeRendererPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes("\0") || decoded.includes("..")) return false;
  const candidate = resolve(rendererRoot, `.${decoded}`);
  return candidate === rendererRoot || candidate.startsWith(`${rendererRoot}${sep}`);
}

async function startFixtureServer(page) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
      if (pathname === routePath || pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(page);
        return;
      }
      if (!isSafeRendererPath(pathname)) {
        response.writeHead(400);
        response.end("bad path");
        return;
      }
      const file = resolve(rendererRoot, `.${decodeURIComponent(pathname)}`);
      const body = await readFile(file);
      const contentType = pathname.endsWith(".css")
        ? "text/css"
        : pathname.endsWith(".js")
          ? "text/javascript"
          : pathname.endsWith(".svg")
            ? "image/svg+xml"
            : "application/octet-stream";
      response.writeHead(200, { "Content-Type": `${contentType}; charset=utf-8`, "Cache-Control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return { server, origin, url: `${origin}${routePath}` };
}

async function waitFor(window, label, expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  const diagnostic = await window.webContents.executeJavaScript(`({
    url: location.href,
    body: document.body?.innerText?.slice(0, 1200),
  })`).catch(() => null);
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
}

async function settlePaint(window) {
  await window.webContents.executeJavaScript(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  })`);
}

async function openViewer({ width, height, label, url }) {
  const viewerSession = session.fromPartition(`relayer-public-share-evidence-${label}`);
  const networkRequests = [];
  const origin = new URL(url).origin;
  viewerSession.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
    if (details.url.startsWith(origin)) {
      callback({});
      return;
    }
    networkRequests.push(details.url);
    callback({ cancel: true });
  });
  const window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: false,
    backgroundColor: "#0b0c0d",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `relayer-public-share-evidence-${label}`,
    },
  });
  await window.loadURL(url);
  await waitFor(window, "production ProductWorkspace", "Boolean(document.querySelector('.workspace-layout') && document.querySelector('.graph-node') && document.querySelector('.public-share-download-card'))");
  await settlePaint(window);
  const originalUrl = await window.webContents.executeJavaScript("location.href");
  const assertions = await window.webContents.executeJavaScript(`(() => {
    const layout = document.querySelector('.workspace-layout');
    const card = document.querySelector('.public-share-download-card');
    const node = document.querySelector('.graph-node');
    const banner = document.querySelector('.interaction-banner');
    return {
      downloadCardInsideWorkspace: Boolean(layout && card && card.parentElement === layout),
      environmentPanelAbsent: !document.querySelector('.environment-panel'),
      graphNodeRendered: Boolean(node && node.getBoundingClientRect().width > 0),
      interactionBannerRendered: Boolean(banner && banner.getBoundingClientRect().height > 0),
      mutationControlsInert: [...document.querySelectorAll('#sendInteraction, #threadPrompt, #approvalDock')]
        .every((element) => getComputedStyle(element).display === 'none'
          || getComputedStyle(element.closest('#threadComposerShell, #approvalDock') || element).display === 'none'),
    };
  })()`);
  if (Object.values(assertions).some((passed) => passed !== true)) {
    throw new Error(`Public viewer assertion failed: ${JSON.stringify(assertions)}`);
  }
  return { window, networkRequests, originalUrl, assertions };
}

async function revealNodeDetails(viewer) {
  const { window } = viewer;
  await window.webContents.executeJavaScript("document.querySelector('.graph-node')?.click(); true");
  await waitFor(window, "Node Details", "Boolean(document.querySelector('#inspector:not(.hidden) #inspectorContent'))");
  await settlePaint(window);
}

async function navigateWithoutChangingUrl(viewer) {
  const { window, originalUrl } = viewer;
  await window.webContents.executeJavaScript("document.querySelector('#detailActions .action-control')?.click(); true");
  await waitFor(window, "unchanged URL after navigation", `location.href === ${JSON.stringify(originalUrl)}`);
}

async function capture(window, file, viewport) {
  const image = await window.webContents.capturePage();
  const size = image.getSize();
  const output = size.width === viewport.width && size.height === viewport.height
    ? image
    : image.resize({ width: viewport.width, height: viewport.height });
  const bytes = output.toPNG();
  await writeFile(file, bytes);
  return { width: viewport.width, height: viewport.height, sourcePixelSize: size, sha256: sha256(bytes) };
}

async function sourceManifest() {
  const files = {};
  for (const file of sourceFiles) {
    const bytes = await readFile(resolve(repositoryRoot, file));
    files[file] = { bytes: bytes.byteLength, sha256: sha256(bytes) };
  }
  return files;
}

async function main() {
  const snapshot = syntheticSnapshot();
  const page = renderPublicViewerTemplate({
    snapshot,
    title: "Synthetic public viewer evidence",
    description: "Offline synthetic evidence for the read-only public viewer.",
  });
  const fixtureFile = join(evidenceRoot, "synthetic-snapshot.jsonl");
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(fixtureFile, snapshot);
  const fixture = await startFixtureServer(page);
  const captures = [];
  const opened = [];
  try {
    for (const viewport of [
      { name: "desktop-overview", width: 1440, height: 1000 },
      { name: "mobile-overview", width: 375, height: 812 },
    ]) {
      const viewer = await openViewer({ ...viewport, label: viewport.name, url: fixture.url });
      opened.push(viewer);
      if (viewport.width < 760) {
        await viewer.window.webContents.executeJavaScript("document.querySelector('.public-share-workspace-host')?.scrollIntoView({ block: 'start' }); true");
      }
      const file = join(evidenceRoot, `${viewport.name}.png`);
      captures.push({ name: viewport.name, viewport, file: relative(repositoryRoot, file), ...(await capture(viewer.window, file, viewport)) });
      await revealNodeDetails(viewer);
      if (viewport.name === "mobile-overview") {
        const detailFile = join(evidenceRoot, "mobile-node-details.png");
        captures.push({
          name: "mobile-node-details",
          viewport,
          file: relative(repositoryRoot, detailFile),
          ...(await capture(viewer.window, detailFile, viewport)),
        });
      }
      await navigateWithoutChangingUrl(viewer);
    }
    const networkRequests = opened.flatMap(({ networkRequests: requests }) => requests);
    const unchanged = (await Promise.all(opened.map(({ window, originalUrl }) => (
      window.webContents.executeJavaScript("location.href").then((url) => url === originalUrl)
    )))).every(Boolean);
    if (!unchanged) throw new Error("Public viewer navigation changed the URL.");
    if (networkRequests.length) throw new Error(`Unexpected non-local network requests: ${networkRequests.join(", ")}`);
    const manifest = {
      schemaVersion: 1,
      evidence: "issue-471-public-share-viewer",
      fixture: { kind: "synthetic", file: relative(repositoryRoot, fixtureFile), sha256: sha256(snapshot) },
      source: {
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
        dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8" }).trim()),
        sourceFiles: await sourceManifest(),
      },
      browser: {
        electron: process.versions.electron,
        origin: fixture.origin,
        networkRequests,
        unchangedUrl: unchanged,
        paidInferenceCalls: 0,
        assertions: opened.map(({ assertions }, index) => ({
          viewport: index === 0 ? "desktop-overview" : "mobile-overview",
          ...assertions,
          ...(index === 1 ? { nodeDetailsOpened: true } : {}),
        })),
      },
      captures,
    };
    await writeFile(join(evidenceRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`Wrote ${captures.length} public viewer evidence captures to ${evidenceRoot}.\n`);
  } finally {
    for (const { window } of opened) window.close();
    await new Promise((resolveServer) => fixture.server.close(resolveServer));
  }
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
