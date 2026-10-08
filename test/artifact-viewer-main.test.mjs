// Artifact viewer, main-process seams (PRD 6.6): what each kind opens, what the
// artifact scheme will serve, drift reporting, and the Eval agent preview.
import { appendFile, cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fingerprintPath } from "@relayer/harness-host";
import { artifactFileStatus, artifactPreviewSettled, artifactViewPlan, artifactViewerTesting, blocksNetwork, createArtifactRequestHandler } from "../desktop/main/services/artifact-viewer.mjs";
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
  const handler = createArtifactRequestHandler({ getPlan: () => plan, vendorDirectory: join(root, "desktop", "renderer", "vendor") });
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
    // Review: a file linked out of the folder it is served from cannot show, so it reads as missing.
    await symlink("../docs/brand-guide.md", join(folder, "site", "guide.md"));
    const linkedGuide = artifactViewPlan({ kind: "markdown", source: { file: "site/guide.md" } }, folder);
    expect((await artifactFileStatus(linkedGuide, undefined)).state).toBe("missing");
    await rm(join(folder, "site", "guide.md"));
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

describe("Office documents (ART-012)", () => {
  const office = {
    docx: { kind: "docx", source: { file: "docs/wholesale-proposal.docx" } },
    xlsx: { kind: "xlsx", source: { file: "docs/budget-2027.xlsx" } },
    pptx: { kind: "pptx", source: { file: "docs/seed-pitch.pptx" }, part: { slide: 3 } },
  };

  it("serve the Office bundle, its licences, and a page that takes only a whole slide number", async () => {
    const get = serve(office.docx);
    const bundle = await get("/__relayer/office.js");
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await bundle.text()).toContain("relayerOffice");
    const notices = await readFile(join(root, "desktop", "renderer", "vendor", "artifact-office.LICENSES.txt"), "utf8");
    for (const name of ["docx-preview", "xlsx", "@jvmr/pptx-to-html", "jszip", "pako"]) expect(notices).toContain(`== ${name} `);
    const { viewerPage } = artifactViewerTesting;
    expect(viewerPage("pptx", "deck.pptx", new URLSearchParams({ slide: "1);alert(1);(" }))).toContain("{ slide: null }");
    expect(viewerPage("pptx", "deck.pptx", new URLSearchParams({ slide: "3" }))).toContain("{ slide: 3 }");
  });

  it("keep every file kind but a website off the network (PRD 6.6.4)", () => {
    const plan = (artifact) => artifactViewPlan(artifact, "/thread");
    for (const kind of ["docx", "xlsx", "pptx"]) {
      for (const url of ["https://tracker.example/pixel.png", "http://127.0.0.1:8080/", "wss://host.example/"]) expect(blocksNetwork(plan({ kind, source: { file: `a.${kind}` } }), url)).toBe(true);
      expect(blocksNetwork(plan({ kind, source: { file: `a.${kind}` } }), "relayer-artifact://view/a")).toBe(false);
    }
    expect(blocksNetwork(plan(site), "https://fonts.example/font.woff2")).toBe(false);
    expect(blocksNetwork(plan({ kind: "url", source: { url: "https://example.com/" } }), "https://example.com/app.js")).toBe(false);
  });

  it("wait for an Office page to draw, but never longer than the deadline when it stops answering", async () => {
    const started = Date.now();
    // Review: a page busy parsing never answers; the wait still ends at its deadline.
    await expect(artifactPreviewSettled("docx", () => new Promise(() => {}), 300)).rejects.toThrow("did not finish drawing");
    expect(Date.now() - started).toBeLessThan(1000);
    // Review: a page still drawing at the deadline fails the capture instead of passing as ready.
    await expect(artifactPreviewSettled("xlsx", async () => null, 300)).rejects.toThrow("did not finish drawing");
    let checks = 0;
    await artifactPreviewSettled("pptx", async () => (++checks === 3 ? "true" : null), 5_000);
    expect(checks).toBe(3);
  });

  it("open in the viewer's Office page, a deck at its slide", () => {
    expect(artifactViewPlan(office.docx, "/thread").url).toBe("relayer-artifact://view/__relayer/view?kind=docx&file=wholesale-proposal.docx");
    const deck = artifactViewPlan(office.pptx, "/thread");
    expect(deck.url).toBe("relayer-artifact://view/__relayer/view?kind=pptx&file=seed-pitch.pptx&slide=3");
    expect(deck.address).toBe("docs/seed-pitch.pptx · slide 3");
    const { noteLocation } = artifactViewerTesting;
    expect(noteLocation(deck, { slide: 2 }, deck.url)).toBe("on slide 2");
    expect(noteLocation(artifactViewPlan(office.xlsx, "/thread"), { sheet: "Notes" }, "")).toBe("on the “Notes” sheet");
    expect(noteLocation(artifactViewPlan(office.docx, "/thread"), { heading: "Pricing" }, "")).toBe("under “Pricing”");
  });

  // The viewer's own page and Office bundle in Chromium, as Desktop and Eval load them.
  async function openInChromium(browser, artifact, { ready = "true", viewport = { width: 1164, height: 703 } } = {}) {
    const plan = artifactViewPlan(artifact, folder);
    const handler = createArtifactRequestHandler({ getPlan: () => plan, vendorDirectory: join(root, "desktop", "renderer", "vendor") });
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.route("https://artifact.relayer.invalid/**", async (route) => {
      const response = await handler(new Request(route.request().url().replace("https://artifact.relayer.invalid", "relayer-artifact://view")));
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.goto(plan.url.replace("relayer-artifact://view", "https://artifact.relayer.invalid"));
    await page.waitForSelector("#office[data-ready]", { state: "attached" });
    expect(await page.locator("#office").getAttribute("data-ready")).toBe(ready);
    const located = () => page.evaluate(artifactViewerTesting.NOTE_LOCATION_SCRIPT);
    return { page, located, errors };
  }

  it.runIf(headlessChromium)("render Word, every Excel sheet's saved values, and slides with their chart", async () => {
    const browser = await chromium.launch();
    try {
      const word = await openInChromium(browser, office.docx);
      expect(word.errors).toEqual([]);
      expect(await word.page.locator("#office").innerText()).toContain("Wholesale proposal: Harbour Hotel");
      // Word's Symbol-font bullets draw as bullets, not missing glyphs.
      const bullet = await word.page.evaluate(() => getComputedStyle([...document.querySelectorAll("#office p")].find((p) => p.textContent.startsWith("Weekly delivery")), "::before").content);
      expect(bullet).toContain("•");
      await word.page.getByText("Pricing", { exact: true }).evaluate((heading) => heading.scrollIntoView());
      expect((await word.located()).heading).toBe("Pricing");

      const sheet = await openInChromium(browser, office.xlsx);
      expect(await sheet.page.locator(".office-sheet-tab").allInnerTexts()).toEqual(["Budget", "Notes"]);
      // The total is a formula saved with its value; the viewer shows that value.
      expect(await sheet.page.locator(".office-sheet tr").last().innerText()).toMatch(/Total\s+34300\s+40200\s+40900\s+47600/u);
      await sheet.page.getByRole("button", { name: "Notes" }).click();
      expect(await sheet.page.locator(".office-sheet").innerText()).toContain("Green bean prices rise 4% a quarter.");
      expect((await sheet.located()).sheet).toBe("Notes");

      const deck = await openInChromium(browser, office.pptx);
      expect(await deck.page.locator(".office-slide").count()).toBe(4);
      expect((await deck.located()).slide).toBe(3);
      // python-pptx's column chart: one bar per quarter.
      expect(await deck.page.locator('[data-slide="3"] svg rect').count()).toBe(4);
      expect([...sheet.errors, ...deck.errors]).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it.runIf(headlessChromium)("stay usable on a huge sheet range and say when a slide is past the deck", async () => {
    const XLSX = await import("xlsx");
    const cells = XLSX.utils.aoa_to_sheet([["Only one cell"]]);
    cells["!ref"] = "A1:Z200000";
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, cells, "Export");
    await writeFile(join(folder, "docs", "huge.xlsx"), XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
    // Review: a sheet only wider than the limit keeps its note after switching tabs.
    const wideBook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wideBook, XLSX.utils.aoa_to_sheet([Array.from({ length: 150 }, (_, index) => index + 1)]), "Wide");
    XLSX.utils.book_append_sheet(wideBook, XLSX.utils.aoa_to_sheet([["Notes"]]), "Notes");
    await writeFile(join(folder, "docs", "wide.xlsx"), XLSX.write(wideBook, { type: "buffer", bookType: "xlsx" }));
    // Review: an archive that would expand past the limit is refused before any parser runs.
    // One central-directory entry claiming 2 GiB, then the end record.
    const bomb = Buffer.alloc(47 + 22);
    bomb.writeUInt32LE(0x02014b50, 0);
    bomb.writeUInt32LE(0x7fffffff, 24);
    bomb.writeUInt16LE(1, 28);
    bomb.write("a", 46);
    bomb.writeUInt32LE(0x06054b50, 47);
    bomb.writeUInt16LE(1, 47 + 8);
    bomb.writeUInt16LE(1, 47 + 10);
    bomb.writeUInt32LE(47, 47 + 12);
    await writeFile(join(folder, "docs", "bomb.docx"), bomb);
    // Review: one deflated entry whose headers claim 16 bytes but whose stream expands to 4 MiB,
    // first with the local header telling the truth, then with both headers lying.
    const { deflateRawSync } = await import("node:zlib");
    const zipOf = ({ central, local, data, localExtra = Buffer.alloc(0), entry: entryName = "a", localEntry = entryName, localMethod = 8, comment = Buffer.alloc(0) }) => {
      const name = Buffer.from(entryName);
      const localName = Buffer.from(localEntry);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(localMethod, 8);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(local, 22);
      header.writeUInt16LE(localName.length, 26);
      header.writeUInt16LE(localExtra.length, 28);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(8, 10);
      entry.writeUInt32LE(data.length, 20);
      entry.writeUInt32LE(central, 24);
      entry.writeUInt16LE(name.length, 28);
      const directory = Buffer.concat([entry, name]);
      const offset = header.length + localName.length + localExtra.length + data.length;
      const close = Buffer.alloc(22);
      close.writeUInt32LE(0x06054b50, 0);
      close.writeUInt16LE(1, 8);
      close.writeUInt16LE(1, 10);
      close.writeUInt32LE(directory.length, 12);
      close.writeUInt32LE(offset, 16);
      close.writeUInt16LE(comment.length, 20);
      return Buffer.concat([header, localName, localExtra, data, directory, close, comment]);
    };
    const flood = deflateRawSync(Buffer.alloc(4 * 1024 * 1024));
    await writeFile(join(folder, "docs", "headers.xlsx"), zipOf({ central: 16, local: 4 * 1024 * 1024, data: flood }));
    await writeFile(join(folder, "docs", "stream.xlsx"), zipOf({ central: 16, local: 16, data: flood }));
    // Review: an end record that undercounts its directory cannot hide an entry.
    const hidden = zipOf({ central: 16, local: 16, data: flood });
    hidden.writeUInt16LE(0, hidden.length - 22 + 8);
    hidden.writeUInt16LE(0, hidden.length - 22 + 10);
    await writeFile(join(folder, "docs", "hidden.pptx"), hidden);
    // Review: an honest 16-byte entry whose local ZIP64 extra field claims 4 GiB.
    const small = deflateRawSync(Buffer.alloc(16));
    const zip64 = Buffer.alloc(20);
    zip64.writeUInt16LE(0x0001, 0);
    zip64.writeUInt16LE(16, 2);
    zip64.writeBigUInt64LE(4n * 1024n ** 3n, 4);
    zip64.writeBigUInt64LE(BigInt(small.length), 12);
    await writeFile(join(folder, "docs", "zip64.xlsx"), zipOf({ central: 16, local: 16, data: small, localExtra: zip64 }));
    // Review: an entry stored centrally but deflated locally, which a parser could inflate unchecked.
    const storedCentrally = zipOf({ central: small.length, local: small.length, data: small, localMethod: 8 });
    storedCentrally.writeUInt16LE(0, 30 + 1 + small.length + 10);
    await writeFile(join(folder, "docs", "method.xlsx"), storedCentrally);
    // Review: a worksheet part over 32 MB is refused before the parser builds its cells.
    const sheetXml = deflateRawSync(Buffer.alloc(33 * 1024 * 1024, 0x20));
    await writeFile(join(folder, "docs", "dense.xlsx"), zipOf({ central: 33 * 1024 * 1024, local: 33 * 1024 * 1024, data: sheetXml, entry: "xl/worksheets/sheet1.xml" }));
    // Review: a 33 MB shared-strings part is refused like a worksheet, and so is a 33 MB part
    // under a harmless name (a Unicode-path extra field could rename it for a parser).
    await writeFile(join(folder, "docs", "strings.xlsx"), zipOf({ central: 33 * 1024 * 1024, local: 33 * 1024 * 1024, data: sheetXml, entry: "xl/sharedStrings.xml" }));
    await writeFile(join(folder, "docs", "unnamed.xlsx"), zipOf({ central: 33 * 1024 * 1024, local: 33 * 1024 * 1024, data: sheetXml, entry: "a" }));
    // Review: an entry named harmlessly centrally but as a worksheet locally.
    await writeFile(join(folder, "docs", "renamed.xlsx"), zipOf({ central: 16, local: 16, data: small, localEntry: "xl/worksheets/sheet1.xml" }));
    // Review: a second end record hidden in the first one's comment, which a parser searching
    // from the very end would pick instead.
    const decoy = Buffer.alloc(20);
    decoy.writeUInt32LE(0x06054b50, 0);
    await writeFile(join(folder, "docs", "decoy.xlsx"), zipOf({ central: 16, local: 16, data: small, comment: decoy }));
    // Review: two directory records pointing at one local entry would inflate it twice.
    const once = zipOf({ central: 16, local: 16, data: small });
    const record = once.subarray(once.length - 22 - 47, once.length - 22);
    const twice = Buffer.concat([once.subarray(0, once.length - 22), record, once.subarray(once.length - 22)]);
    twice.writeUInt16LE(2, twice.length - 22 + 8);
    twice.writeUInt16LE(2, twice.length - 22 + 10);
    twice.writeUInt32LE(94, twice.length - 22 + 12);
    await writeFile(join(folder, "docs", "twice.xlsx"), twice);
    // Review: a valid part whose bytes contain the end-record signature is not "damaged".
    const signed = Buffer.concat([Buffer.from("PK\x05\x06", "latin1"), Buffer.alloc(64)]);
    await writeFile(join(folder, "docs", "signed.xlsx"), zipOf({ central: signed.length, local: signed.length, data: deflateRawSync(signed, { level: 0 }) }));
    // Review: 50,000 merged ranges off screen do not slow the sheet in view.
    const merged = XLSX.utils.aoa_to_sheet(Array.from({ length: 1000 }, (_, row) => Array.from({ length: 10 }, (_, column) => row * 10 + column)));
    merged["!merges"] = Array.from({ length: 50_000 }, (_, index) => ({ s: { r: index % 1000, c: 200 + Math.floor(index / 1000) * 2 }, e: { r: index % 1000, c: 201 + Math.floor(index / 1000) * 2 } }));
    const mergedBook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(mergedBook, merged, "Merged");
    await writeFile(join(folder, "docs", "merged.xlsx"), XLSX.write(mergedBook, { type: "buffer", bookType: "xlsx" }));
    // Review: the workbook opens at the sheet it was saved on, and hidden sheets stay hidden.
    const savedBook = XLSX.utils.book_new();
    for (const name of ["Calc", "Summary", "Detail"]) XLSX.utils.book_append_sheet(savedBook, XLSX.utils.aoa_to_sheet([[name]]), name);
    savedBook.Workbook = { Sheets: [{ Hidden: 1 }, { Hidden: 0 }, { Hidden: 0 }] };
    // SheetJS's writer always saves the first visible tab as active, so set the saved view as Excel would.
    const { default: JSZip } = await import("jszip");
    const savedZip = await JSZip.loadAsync(XLSX.write(savedBook, { type: "buffer", bookType: "xlsx" }));
    savedZip.file("xl/workbook.xml", (await savedZip.file("xl/workbook.xml").async("string")).replace('activeTab="1"', 'activeTab="2"'));
    await writeFile(join(folder, "docs", "saved.xlsx"), await savedZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    // Without the extra field the same entry passes the archive check (and is just not a workbook).
    await writeFile(join(folder, "docs", "plain.xlsx"), zipOf({ central: 16, local: 16, data: small }));
    // Review: a file over the byte limit is refused before it is held whole.
    await writeFile(join(folder, "docs", "oversized.docx"), Buffer.alloc(51 * 1024 * 1024));
    const browser = await chromium.launch();
    try {
      const sheet = await openInChromium(browser, { kind: "xlsx", source: { file: "docs/huge.xlsx" } });
      expect(await sheet.page.locator(".office-sheet-limit").innerText()).toContain("first 1000 rows");
      expect(await sheet.page.locator(".office-sheet tr").count()).toBeLessThanOrEqual(1000);
      const wide = await openInChromium(browser, { kind: "xlsx", source: { file: "docs/wide.xlsx" } });
      await wide.page.getByRole("button", { name: "Notes" }).click();
      await wide.page.getByRole("button", { name: "Wide" }).click();
      expect(await wide.page.locator(".office-sheet-limit").count()).toBe(1);
      expect(await wide.page.locator(".office-sheet tr").first().locator("td").count()).toBe(100);
      const bombed = await openInChromium(browser, { kind: "docx", source: { file: "docs/bomb.docx" } }, { ready: "failed" });
      expect(await bombed.page.locator(".office-error").innerText()).toContain("too large to show here");
      const oversized = await openInChromium(browser, { kind: "docx", source: { file: "docs/oversized.docx" } }, { ready: "failed" });
      expect(await oversized.page.locator(".office-error").innerText()).toContain("too large to show here");
      for (const file of ["plain.xlsx", "signed.xlsx"]) {
        const passes = await openInChromium(browser, { kind: "xlsx", source: { file: `docs/${file}` } }, { ready: "failed" });
        expect(await passes.page.locator(".office-error").innerText(), file).not.toContain("damaged");
      }
      const mergedSheet = await openInChromium(browser, { kind: "xlsx", source: { file: "docs/merged.xlsx" } });
      expect(await mergedSheet.page.locator(".office-sheet tr").count()).toBe(1000);
      const savedSheet = await openInChromium(browser, { kind: "xlsx", source: { file: "docs/saved.xlsx" } });
      expect(await savedSheet.page.locator(".office-sheet-tab").allInnerTexts()).toEqual(["Summary", "Detail"]);
      expect((await savedSheet.located()).sheet).toBe("Detail");
      for (const file of ["dense.xlsx", "strings.xlsx", "unnamed.xlsx"]) {
        const large = await openInChromium(browser, { kind: "xlsx", source: { file: `docs/${file}` } }, { ready: "failed" });
        expect(await large.page.locator(".office-error").innerText(), file).toContain("too large to show here");
      }
      for (const file of ["headers.xlsx", "stream.xlsx", "hidden.pptx", "zip64.xlsx", "method.xlsx", "renamed.xlsx", "decoy.xlsx", "twice.xlsx"]) {
        const crafted = await openInChromium(browser, { kind: file.split(".").pop(), source: { file: `docs/${file}` } }, { ready: "failed" });
        expect(await crafted.page.locator(".office-error").innerText(), file).toContain("damaged");
      }
      const deck = await openInChromium(browser, { ...office.pptx, part: { slide: 7 } });
      expect(deck.errors).toEqual(["The deck has 4 slides, so slide 7 does not exist; showing the last slide."]);
      expect((await deck.located()).slide).toBe(4);
      // Review: in a narrow, tall window the last slide never reaches the middle; it still counts.
      const narrow = await openInChromium(browser, { ...office.pptx, part: { slide: 4 } }, { viewport: { width: 420, height: 1000 } });
      expect((await narrow.located()).slide).toBe(4);
    } finally {
      await browser.close();
      for (const file of ["huge.xlsx", "wide.xlsx", "bomb.docx", "headers.xlsx", "stream.xlsx", "hidden.pptx", "zip64.xlsx", "plain.xlsx", "signed.xlsx", "merged.xlsx", "saved.xlsx", "twice.xlsx", "method.xlsx", "dense.xlsx", "strings.xlsx", "unnamed.xlsx", "renamed.xlsx", "decoy.xlsx", "oversized.docx"]) await rm(join(folder, "docs", file), { force: true });
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
