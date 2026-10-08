// Artifact viewer, main-process seams (PRD 6.6): what each kind opens, what the
// artifact scheme will serve, drift reporting, and the Eval agent preview.
import { appendFile, cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fingerprintPath } from "@relayer/harness-host";
import { artifactFileStatus, artifactViewPlan, createArtifactRequestHandler } from "../desktop/main/services/artifact-viewer.mjs";
import { draftPreviewArtifact } from "../desktop/main/services/draft-preview-renderer.mjs";
import { createPlaywrightDraftPreviewRenderer } from "../desktop/eval-main/draft-preview-renderer.mjs";
import { artifactFrameDocument } from "../desktop/renderer/src/artifact-viewer.js";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

// Eval renders previews in Playwright's headless Chromium. The default CI Vitest job
// installs no browser, so this check runs where one is installed, as browser scripts do.
const headlessChromium = existsSync(chromium.executablePath());

const root = resolve(import.meta.dirname, "..");
const fixture = join(root, "test", "fixtures", "artifact-viewer", "thread-folder");
const site = { kind: "website", source: { file: "site/index.html", root: "site" } };
let folder;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "relayer-artifact-viewer-"));
  await cp(fixture, folder, { recursive: true });
});
afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

function serve(artifact) {
  const plan = artifactViewPlan(artifact, folder);
  const handler = createArtifactRequestHandler({ getPlan: () => plan, markedPath: join(root, "desktop", "renderer", "vendor", "marked.umd.js") });
  return (path, headers = {}) => handler(new Request(`relayer-artifact://view${path}`, { headers }));
}

describe("artifact view plans (ART-007)", () => {
  it("opens each kind at the part the agent asked for", () => {
    const plan = (artifact) => artifactViewPlan(artifact, "/thread").url;
    expect(plan({ ...site, part: { route: "#pricing" } })).toBe("relayer-artifact://view/index.html#pricing");
    expect(plan({ kind: "pdf", source: { file: "docs/investor-brief.pdf" }, part: { page: 4 } })).toBe("relayer-artifact://view/investor-brief.pdf#page=4");
    expect(plan({ kind: "video", source: { file: "media/promo.mp4" }, part: { start: 10, end: 15 } }))
      .toBe("relayer-artifact://view/__relayer/view?kind=video&file=promo.mp4&start=10&end=15");
    expect(plan({ kind: "markdown", source: { file: "docs/brand-guide.md" }, part: { heading: "Colour" } }))
      .toBe("relayer-artifact://view/__relayer/view?kind=markdown&file=brand-guide.md&heading=Colour");
    expect(plan({ kind: "url", source: { url: "https://example.com/" } })).toBe("https://example.com/");
    // Review: `?` and `#` parts replace the base's own query and fragment.
    expect(plan({ kind: "url", source: { url: "https://example.com/app?old=1#top" }, part: { route: "?new=2" } })).toBe("https://example.com/app?new=2#top");
    expect(plan({ kind: "url", source: { url: "https://example.com/app#top" }, part: { route: "#plans" } })).toBe("https://example.com/app#plans");
  });
});

describe("the artifact scheme (PRD 6.6.4)", () => {
  it("serves the site and answers byte ranges for media", async () => {
    const page = await serve(site)("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/u);
    const video = serve({ kind: "video", source: { file: "media/promo.mp4" } });
    const range = await video("/promo.mp4", { range: "bytes=0-99" });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toMatch(/^bytes 0-99\/\d+$/u);
    expect((await range.arrayBuffer()).byteLength).toBe(100);
    expect((await video("/promo.mp4", { range: "bytes=99999999-" })).status).toBe(416);
  });

  it("serves nothing outside the artifact's folder, links included", async () => {
    await writeFile(join(folder, "secret.txt"), "thread secret");
    await symlink(join(folder, "secret.txt"), join(folder, "site", "linked.txt"));
    const get = serve(site);
    expect((await get("/%2e%2e/secret.txt")).status).toBe(404);
    expect((await get("/linked.txt")).status).toBe(404);
    expect((await get("/../docs/brand-guide.md")).status).toBe(404);
    expect((await get("/styles.css")).status).toBe(200);
    // Review #14: a single-page site's client route serves its entry; a missing asset does not.
    const route = await get("/pricing");
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("<html");
    expect((await get("/missing.css")).status).toBe(404);
    await rm(join(folder, "site", "linked.txt"));
  });
});

describe("drift since acceptance (ART-004)", () => {
  it("reports changed and missing files, link retargets included", async () => {
    const accepted = await fingerprintPath(join(folder, "site"));
    const plan = artifactViewPlan(site, folder);
    expect((await artifactFileStatus(plan, accepted)).state).toBe("ok");
    await appendFile(join(folder, "site", "styles.css"), "\n/* edited */\n");
    expect((await artifactFileStatus(plan, accepted)).state).toBe("changed");
    // Review #6: retargeting a link inside the root is a change too.
    const before = await fingerprintPath(join(folder, "site"));
    await symlink("styles.css", join(folder, "site", "theme.css"));
    const linked = await fingerprintPath(join(folder, "site"));
    expect(linked).not.toBe(before);
    await rm(join(folder, "site", "theme.css"));
    await symlink("app.js", join(folder, "site", "theme.css"));
    expect(await fingerprintPath(join(folder, "site"))).not.toBe(linked);
    await rm(join(folder, "site", "theme.css"));
    const image = artifactViewPlan({ kind: "image", source: { file: "brand/missing.png" } }, folder);
    expect((await artifactFileStatus(image, undefined)).state).toBe("missing");
  });
});

describe("deployed sites in a share or Eval frame (ART-008)", () => {
  it.runIf(headlessChromium)("move between their own pages but never to another site", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const fetched = [];
      // The share page's own policy frames any https site; the frame's document narrows it.
      await page.route("https://share.example/**", (route) => route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-src https:" }, body: "<iframe></iframe>" }));
      await page.route(/^https:\/\/(site|elsewhere)\.example\//u, (route) => {
        fetched.push(route.request().url());
        route.fulfill({ contentType: "text/html", body: '<script>setTimeout(() => { location.href = location.pathname === "/" ? "/pricing" : "https://elsewhere.example/"; }, 50)</script>' });
      });
      await page.goto("https://share.example/");
      await page.locator("iframe").evaluate((frame, srcdoc) => { frame.srcdoc = srcdoc; }, artifactFrameDocument("https://site.example/", "Deployed site"));
      await expect.poll(() => fetched, { timeout: 5000 }).toContain("https://site.example/pricing");
      await page.waitForTimeout(500);
      expect(fetched).toEqual(["https://site.example/", "https://site.example/pricing"]);
    } finally {
      await browser.close();
    }
  }, 30_000);
});

describe("agent previews of artifact layers (ART-005)", () => {
  const layer = (artifact) => ({ version: 1, target: { kind: "layer", layerId: 9 }, layer: { renderer: "artifact" }, nodes: [{ id: 3, artifact }], edges: [], assets: [] });

  it("previews only artifact layers as artifacts", () => {
    expect(draftPreviewArtifact(layer(site))).toEqual(site);
    expect(draftPreviewArtifact({ ...layer(site), layer: {} })).toBe(null);
    expect(draftPreviewArtifact({ ...layer(site), target: { kind: "node", nodeId: 3 } })).toBe(null);
  });

  it.runIf(headlessChromium)("renders the artifact itself in Eval's headless Chromium, at its screen size", async () => {
    const renderer = createPlaywrightDraftPreviewRenderer({ rendererDirectory: join(root, "desktop", "renderer") });
    try {
      const guide = await renderer.render({ snapshot: layer({ kind: "markdown", source: { file: "docs/brand-guide.md" }, part: { heading: "Colour" } }), workingDirectory: folder });
      expect({ width: guide.width, height: guide.height }).toEqual({ width: 1164, height: 703 });
      expect([...guide.png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      const phone = await renderer.render({ snapshot: layer({ ...site, viewport: "phone" }), workingDirectory: folder });
      expect({ width: phone.width, height: phone.height }).toEqual({ width: 390, height: 844 });
      await expect(renderer.render({ snapshot: layer(site) })).rejects.toThrow(/thread folder/u);
    } finally {
      await renderer.close();
    }
  }, 30_000);
});
