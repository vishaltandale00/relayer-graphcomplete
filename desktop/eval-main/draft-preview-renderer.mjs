import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { startIsolatedPageServer } from "../main/services/isolated-page-capture.mjs";
import {
  ARTIFACT_SCHEME,
  artifactPreviewSettleMs,
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

/** Headless Chromium has no custom schemes, so artifact files are routed from this origin. */
const ARTIFACT_ORIGIN = "https://artifact.relayer.invalid";

/**
 * An artifact layer's preview (PRD 6.6, ART-005): the artifact itself, served by the
 * viewer's own request handler. Nothing else loads, except a URL artifact's own site.
 */
async function renderArtifactPreview(browser, { artifact, folder, rendererDirectory }) {
  if (artifact.kind !== "url" && typeof folder !== "string") throw new Error("The artifact's thread folder is unknown.");
  const plan = artifactViewPlan(artifact, folder);
  const handler = createArtifactRequestHandler({ getPlan: () => plan, markedPath: join(rendererDirectory, "vendor", "marked.umd.js") });
  const scheme = `${ARTIFACT_SCHEME}://view`;
  const url = plan.kind === "url" ? plan.url : plan.url.replace(scheme, ARTIFACT_ORIGIN);
  const allowed = new URL(url).origin;
  const viewport = artifactPreviewSize(artifact, DRAFT_PREVIEW_FRAMES.layer);
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: "block", acceptDownloads: false });
  try {
    await context.route("**/*", async (route) => {
      const requested = route.request().url();
      if (new URL(requested).origin !== allowed) return route.abort();
      if (plan.kind === "url") return route.continue();
      const response = await handler(new Request(requested.replace(ARTIFACT_ORIGIN, scheme), { headers: route.request().headers() }));
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForTimeout(artifactPreviewSettleMs(plan.kind));
    const png = await page.screenshot({ type: "png" });
    if (png.byteLength > DRAFT_PREVIEW_MAX_BYTES) throw new Error("Preview too large");
    return { png: new Uint8Array(png), ...viewport };
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
