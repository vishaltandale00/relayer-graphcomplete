import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, ".relayer/evidence/interaction-graph-scroll-video");
await mkdir(output, { recursive: true });
const sourcePath = resolve(root, "desktop/renderer/src/product-workspace/workspace.js");
const treatment = await readFile(sourcePath, "utf8");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
// Undo this fix alone in the served response. Preserve unrelated workspace edits.
const reversals = [
  ['      const popover = $("#turnPopover");\n      const title = popover.querySelector(".interaction-graph-heading") ?? graphDocument.createElement("div");', '      const title = graphDocument.createElement("div");'],
  ['      // Keep the scroll host mounted while status/context updates rebuild the cards.\n      const viewport = popover.querySelector(".interaction-graph-viewport") ?? graphDocument.createElement("div");', '      const viewport = graphDocument.createElement("div");'],
  ['      viewport.replaceChildren(renderInteractionGraph(graphDocument, graph, interaction?.id, async (node) => {', '      viewport.append(renderInteractionGraph(graphDocument, graph, interaction?.id, async (node) => {'],
  ['      if (viewport.parentElement !== popover) popover.replaceChildren(title, viewport);', '      $("#turnPopover").replaceChildren(title, viewport);'],
];
let baseline = treatment;
for (const [before, after] of reversals) {
  assert.equal(baseline.split(before).length - 1, 1, "Baseline reversal must match exactly one fix seam");
  baseline = baseline.replace(before, after);
}
const served = {};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const variant = url.pathname.startsWith("/baseline/") ? "baseline" : "treatment";
    const pathname = url.pathname.replace(/^\/(baseline|treatment)(?=\/)/, "");
    const path = resolve(root, `.${pathname}`);
    if (!path.startsWith(root)) throw new Error("Outside fixture root");
    let body = await readFile(path);
    if (path === sourcePath) body = Buffer.from(variant === "baseline" ? baseline : treatment);
    if (pathname.endsWith("/desktop/renderer/index.html")) body = Buffer.from(body.toString()
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
      .replace("</body>", `<script type="module" src="/${variant}/scripts/fixtures/interaction-graph-layout.js"></script></body>`));
    // The fixture's absolute import must select this recording's workspace source.
    if (pathname.endsWith("/scripts/fixtures/interaction-graph-layout.js")) body = Buffer.from(body.toString()
      .replace('import("/desktop/renderer/src/product-workspace/workspace.js")', `import("/${variant}/desktop/renderer/src/product-workspace/workspace.js")`));
    served[`${variant}${pathname}`] = sha256(body);
    response.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" })[extname(path)] ?? "application/octet-stream");
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
const recordings = [];
try {
  for (const variant of ["baseline", "treatment"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: output, size: { width: 1280, height: 720 } } });
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/${variant}/desktop/renderer/index.html`);
      await page.waitForFunction(() => Boolean(globalThis.layoutWorkspace));
      await page.evaluate(() => {
        const first = layoutFixture.turns[0];
        for (let id = 7; id <= 18; id++) layoutFixture.turns.push({ ...first, id, graphNodeId: id * 10, text: `Sky follow-up ${id}` });
        layoutWorkspace.render();
        const overlay = document.createElement("div");
        overlay.id = "recording-status";
        overlay.style.cssText = "position:fixed;bottom:8px;left:50%;transform:translateX(-50%);z-index:10000;padding:12px 20px;border-radius:8px;background:#111e;color:white;font:600 17px system-ui;pointer-events:none;white-space:nowrap";
        overlay.textContent = "Open interaction graph";
        document.body.append(overlay);
        const cursor = document.createElement("div");
        cursor.style.cssText = "position:fixed;width:18px;height:18px;border:3px solid #ffb94a;border-radius:50%;pointer-events:none;z-index:10001;transform:translate(-50%,-50%)";
        document.body.append(cursor);
        document.addEventListener("mousemove", event => { cursor.style.left = `${event.clientX}px`; cursor.style.top = `${event.clientY}px`; });
      });
      await page.locator("#turnPickerButton").click();
      await page.waitForTimeout(1500);
      const viewport = page.locator(".interaction-graph-viewport");
      const bounds = await viewport.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.evaluate(() => document.querySelector("#recording-status").textContent = "Scroll down 196 pixels");
      await page.mouse.wheel(0, 196);
      await page.waitForFunction(() => document.querySelector(".interaction-graph-viewport").scrollTop >= 190);
      const before = await viewport.evaluate(element => element.scrollTop);
      await page.waitForTimeout(1800);
      await page.evaluate(() => document.querySelector("#recording-status").textContent = "Workspace refresh in 1 second");
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        layoutFixture.turns.at(-1).completionStatus = "running";
        layoutWorkspace.render();
      });
      await page.waitForTimeout(150);
      const after = await viewport.evaluate(element => element.scrollTop);
      if (variant === "baseline") assert.equal(after, 0, "Baseline must visibly reproduce the jump to top");
      else assert.equal(after, before, "Treatment must preserve the same native wheel scroll");
      await page.evaluate(({ before, after }) => document.querySelector("#recording-status").textContent = `Scroll position after refresh: ${before} → ${after} px`, { before, after });
      await page.screenshot({ path: resolve(output, `${variant}-after-refresh.png`) });
      await page.waitForTimeout(4500);
      const video = page.video();
      await context.close();
      const videoPath = await video.path();
      recordings.push({ variant, before, after, videoPath });
    } finally { await context.close(); }
  }
  assert.equal(sha256(await readFile(sourcePath)), sha256(treatment), "Production source changed during capture");
  const caption = await browser.newPage({ viewport: { width: 2560, height: 112 } });
  await caption.setContent(`<html><body style="margin:0;background:#0e131b;color:#fff;font-family:system-ui"><div style="display:flex"><div style="width:50%;padding:16px 30px;box-sizing:border-box"><strong style="font-size:30px;color:#ffb6a8">BASELINE — before the scroll fix</strong><div style="font-size:20px;margin-top:8px">Same renderer fixture + wheel gesture. Refresh rebuilds the scroll host.</div></div><div style="width:50%;padding:16px 30px;box-sizing:border-box"><strong style="font-size:30px;color:#a7efbd">TREATMENT — with the scroll fix</strong><div style="font-size:20px;margin-top:8px">Same renderer fixture + wheel gesture. Refresh keeps the scroll host.</div></div></div></body></html>`);
  await caption.screenshot({ path: resolve(output, "comparison-header.png") });
  await caption.close();
  const comparison = resolve(output, "baseline-vs-treatment.mp4");
  await run("/opt/homebrew/bin/ffmpeg", ["-y", "-i", recordings[0].videoPath, "-i", recordings[1].videoPath, "-loop", "1", "-i", resolve(output, "comparison-header.png"), "-filter_complex", "[0:v]setpts=PTS-STARTPTS,fps=30[b];[1:v]setpts=PTS-STARTPTS,fps=30[t];[b][t]hstack=inputs=2:shortest=1[pair];[2:v][pair]vstack=inputs=2:shortest=1[out]", "-map", "[out]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", "12", comparison], { maxBuffer: 4 * 1024 * 1024 });
  const receipt = { sourceCommit: (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(), workspaceSourceSha256: sha256(treatment), baselineSourceSha256: sha256(baseline), recorderSourceSha256: sha256(await readFile(fileURLToPath(import.meta.url))), baselineDerivation: "Inverse of only the four scroll-host fix substitutions; unrelated workspace edits retained. Production file never modified.", fixture: "scripts/fixtures/interaction-graph-layout.js", recordings, served, comparisonSha256: sha256(await readFile(comparison)), proofBoundary: "Chromium production-renderer fixture, synthetic graph state, no paid inference. Does not certify packaged desktop or release." };
  await writeFile(resolve(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ comparison, recordings: recordings.map(({ variant, before, after }) => ({ variant, before, after })), receipt: resolve(output, "receipt.json") }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
