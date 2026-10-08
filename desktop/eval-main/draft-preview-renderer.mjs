import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { startIsolatedPageServer } from "../main/services/isolated-page-capture.mjs";
import {
  ARTIFACT_SCHEME,
  artifactPreviewSettled,
  artifactPreviewSize,
  artifactViewPlan,
  createArtifactRequestHandler,
} from "../main/services/artifact-viewer.mjs";
import {
  DRAFT_PREVIEW_FRAMES,
  DRAFT_PREVIEW_MAX_BYTES,
  DRAFT_PREVIEW_START_VIEWPORT,
  DRAFT_PREVIEW_TEMPLATE,
  draftPreviewArtifact,
  draftPreviewFrame,
  draftPreviewStepScript,
  frameDraftPreview,
} from "../main/services/draft-preview-renderer.mjs";

/** The largest single file an Eval artifact preview buffers. */
const MAX_PREVIEW_RESOURCE_BYTES = 64 * 1024 * 1024;

/** Headless Chromium has no custom schemes, so artifact files are routed from this origin. */
const ARTIFACT_ORIGIN = "https://artifact.relayer.invalid";

/**
 * An artifact layer's preview (PRD 6.6, ART-005): the artifact itself, served by the
 * viewer's own request handler. Nothing else loads, except a URL artifact's own site.
 */
async function renderArtifactPreview(browser, { artifact, folder, rendererDirectory }) {
  if (artifact.kind !== "url" && typeof folder !== "string") throw new Error("The artifact's thread folder is unknown.");
  const plan = artifactViewPlan(artifact, folder);
  const handler = createArtifactRequestHandler({ getPlan: () => plan, vendorDirectory: join(rendererDirectory, "vendor") });
  const scheme = `${ARTIFACT_SCHEME}://view`;
  const url = plan.kind === "url" ? plan.url : plan.url.replace(scheme, ARTIFACT_ORIGIN);
  const allowed = new URL(url).origin;
  const viewport = artifactPreviewSize(artifact, DRAFT_PREVIEW_FRAMES.layer);
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: "block", acceptDownloads: false });
  try {
    await context.route("**/*", async (route) => {
      const requested = route.request().url();
      // Like the viewer, the page itself never navigates to another site.
      if (route.request().isNavigationRequest() && new URL(requested).origin !== allowed) return route.abort();
      // A deployed site, web app or website may load internet assets such as fonts, as in the
      // viewer; a PDF, video, image or Markdown file loads nothing else.
      if (plan.kind === "url" || plan.kind === "app") return route.continue();
      if (new URL(requested).origin !== allowed) return plan.kind === "website" ? route.continue() : route.abort();
      const response = await handler(new Request(requested.replace(ARTIFACT_ORIGIN, scheme), { headers: route.request().headers() }));
      // A preview never buffers a huge file; it fails that one request instead.
      if (Number(response.headers.get("content-length") ?? 0) > MAX_PREVIEW_RESOURCE_BYTES) {
        await response.body?.cancel().catch(() => {});
        return route.abort();
      }
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    // The agent previews the same starting state the viewer applies.
    if (artifact.seed?.cookies?.length && plan.kind === "app") {
      await context.addCookies(artifact.seed.cookies.map((cookie) => ({ url: new URL(url).origin, name: cookie.name, value: cookie.value, path: cookie.path ?? "/" })));
    }
    if (artifact.seed?.localStorage) {
      await context.addInitScript((entries) => {
        if (sessionStorage.getItem("__relayerSeeded")) return;
        sessionStorage.setItem("__relayerSeeded", "1");
        for (const [key, value] of entries) localStorage.setItem(key, value);
      }, Object.entries(artifact.seed.localStorage));
    }
    const page = await context.newPage();
    await page.goto(url);
    await artifactPreviewSettled(plan.kind, (script) => page.evaluate(script));
    // Like the desktop capture, halve a photo-heavy screenshot until it fits the cap; the
    // browser itself redraws it smaller, so no image library is needed.
    let png = await page.screenshot({ type: "png" });
    let size = { ...viewport };
    while (png.byteLength > DRAFT_PREVIEW_MAX_BYTES && size.width > 200) {
      size = { width: Math.round(size.width / 2), height: Math.round(size.height / 2) };
      const shrink = await context.newPage();
      await shrink.setViewportSize(size);
      await shrink.setContent(`<style>html,body{margin:0}img{display:block;width:${size.width}px;height:${size.height}px}</style><img src="data:image/png;base64,${Buffer.from(png).toString("base64")}">`);
      png = await shrink.screenshot({ type: "png" });
      await shrink.close();
    }
    if (png.byteLength > DRAFT_PREVIEW_MAX_BYTES) throw new Error("Preview too large");
    return { png: new Uint8Array(png), ...size };
  } finally {
    await context.close();
  }
}

/**
 * Eval render bridge (PRD §11.10): the same isolated draft page in headless
 * Chromium. Eval renders dark, matching its review renderer's default.
 */
export function createPlaywrightDraftPreviewRenderer({ rendererDirectory, theme = "dark", launch = () => chromium.launch({ headless: true }) }) {
  let browser;
  let previous = Promise.resolve();
  const render = async ({ snapshot, workingDirectory }) => {
      browser ??= launch();
      const running = await browser;
      const root = await realpath(rendererDirectory);
      const artifact = draftPreviewArtifact(snapshot);
      if (artifact) return renderArtifactPreview(running, { artifact, folder: workingDirectory, rendererDirectory: root });
      const frame = draftPreviewFrame(snapshot);
      const { renderDraftPreviewTemplate } = await import(pathToFileURL(resolve(root, DRAFT_PREVIEW_TEMPLATE)).href);
      const prefix = `/${randomUUID()}/`;
      const server = await startIsolatedPageServer({
        root, prefix, html: renderDraftPreviewTemplate({ snapshot, theme, assetBase: prefix.slice(0, -1) }),
      });
      const context = await running.newContext({
        viewport: DRAFT_PREVIEW_START_VIEWPORT, deviceScaleFactor: 1, colorScheme: theme,
        serviceWorkers: "block", acceptDownloads: false,
      });
      try {
        await context.route("**/*", (route) => (
          route.request().url().startsWith(server.origin + prefix) ? route.continue() : route.abort()
        ));
        const page = await context.newPage();
        await page.goto(server.url);
        const clip = await frameDraftPreview({
          snapshot,
          call: (step) => page.evaluate(draftPreviewStepScript(step)),
          resize: (viewport) => page.setViewportSize(viewport),
        });
        const png = await page.screenshot({ type: "png", clip });
        if (png.byteLength > DRAFT_PREVIEW_MAX_BYTES) throw new Error("Preview too large");
        return { png: new Uint8Array(png), ...frame };
      } finally {
        await context.close();
        server.closeAllConnections();
        await server.close();
      }
  };
  return {
    // One render at a time, each bounded like the desktop capture.
    render(request) {
      const pending = previous.then(() => {
        let deadline;
        return Promise.race([
          render(request),
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Preview capture timed out")), 15_000); }),
        ]).finally(() => clearTimeout(deadline));
      });
      previous = pending.catch(() => {});
      return pending;
    },
    async close() {
      const running = await browser?.catch(() => undefined);
      browser = undefined;
      await running?.close();
    },
  };
}
