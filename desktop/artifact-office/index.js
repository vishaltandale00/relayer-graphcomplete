// Office documents in the artifact viewer (PRD 6.6.9). scripts/prepare-renderer-vendor.mjs
// bundles this into desktop/renderer/vendor/artifact-office.js; the artifact scheme serves it
// to the artifact's own isolated view, never to Relayer's page.
import { renderAsync } from "docx-preview";
import { read, utils } from "xlsx";
import { pptxToHtml } from "@jvmr/pptx-to-html";

const SLIDE = { width: 960, height: 540 };
/** A sheet shows at most this many rows and columns, so a huge range cannot stall the view. */
const SHEET_LIMIT = { rows: 1000, columns: 100 };
/** An Office file is a zip; one this large, or expanding past this, is not parsed in the view. */
const ARCHIVE_LIMIT = { bytes: 50 * 1024 * 1024, expanded: 250 * 1024 * 1024 };
/**
 * Converters parse a part whole (a worksheet's cells, shared strings, a document's body)
 * before the view clips anything, so every part is capped, whatever name a parser reads
 * for it: 32 MB is about a million spreadsheet cells, far beyond any document a person reads.
 */
const PART_LIMIT = 32 * 1024 * 1024;
/** Word list bullets in the Symbol and Wingdings fonts, which browsers lack, as Unicode. */
const SYMBOL_BULLETS = Object.freeze({ "\uF0B7": "\u2022", "\uF0A7": "\u25AA", "\uF0D8": "\u27A2", "\uF076": "\u2756", "\uF0FC": "\u2713", "\uF06E": "\u25A0", "\uF06C": "\u25CF" });

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

async function renderWord(bytes, root) {
  const pages = element("div", "office-word");
  const styles = element("div");
  root.append(styles, pages);
  await renderAsync(bytes, pages, styles, { inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false });
  for (const style of styles.querySelectorAll("style")) {
    style.textContent = style.textContent.replace(/[\uF06C\uF06E\uF076\uF0A7\uF0B7\uF0D8\uF0FC]/gu, (glyph) => SYMBOL_BULLETS[glyph]);
  }
  return () => {
    // The last heading above the top of the view, as for Markdown.
    const headings = [...pages.querySelectorAll("h1,h2,h3,h4,h5,h6,[class*='heading'],[class*='title']")]
      .filter((heading) => heading.textContent.trim() && heading.getBoundingClientRect().top <= 80);
    return { heading: headings.at(-1)?.textContent ?? null };
  };
}

/**
 * Each visible sheet in its own tab, opened at the sheet the workbook was saved on. Hidden
 * sheets stay hidden. Cells show the values the file saved; nothing is recalculated.
 */
function renderExcel(bytes, root) {
  const book = read(bytes, { type: "array", sheetRows: SHEET_LIMIT.rows });
  const tabs = element("nav", "office-sheet-tabs");
  const sheet = element("div", "office-sheet");
  root.append(tabs, sheet);
  const visible = book.SheetNames.filter((_, index) => !book.Workbook?.Sheets?.[index]?.Hidden);
  const names = visible.length ? visible : book.SheetNames;
  // Each sheet's whole range and merged cells, read before any is clipped to the limit.
  const fullRanges = new Map(book.SheetNames.map((name) => [name, book.Sheets[name]["!fullref"] ?? book.Sheets[name]["!ref"] ?? "A1"]));
  const merges = new Map(book.SheetNames.map((name) => [name, book.Sheets[name]["!merges"] ?? []]));
  const saved = book.SheetNames[book.Workbook?.WBView?.[0]?.activeTab ?? 0];
  let shown = names.includes(saved) ? saved : names[0];
  const show = (name) => {
    shown = name;
    const cells = book.Sheets[name];
    const full = utils.decode_range(fullRanges.get(name));
    const range = utils.decode_range(cells["!ref"] ?? "A1");
    range.e.c = Math.min(range.e.c, range.s.c + SHEET_LIMIT.columns - 1);
    cells["!ref"] = utils.encode_range(range);
    // The HTML writer checks every cell against every merge, so only merges in view are kept,
    // and at most a thousand of them; the rest of the sheet shows unmerged.
    cells["!merges"] = merges.get(name)
      .filter((merge) => merge.s.r <= range.e.r && merge.s.c <= range.e.c && merge.e.r >= range.s.r && merge.e.c >= range.s.c)
      .slice(0, 1000);
    const clipped = full.e.r > range.e.r || full.e.c > range.e.c;
    sheet.innerHTML = utils.sheet_to_html(cells, { header: "", footer: "" });
    if (clipped) sheet.prepend(element("p", "office-sheet-limit", `Showing the first ${SHEET_LIMIT.rows} rows and ${SHEET_LIMIT.columns} columns. Open the file in Excel for the rest.`));
    for (const tab of tabs.children) tab.setAttribute("aria-selected", String(tab.textContent === name));
  };
  for (const name of names) {
    const tab = element("button", "office-sheet-tab", name);
    tab.type = "button";
    tab.onclick = () => show(name);
    tabs.append(tab);
  }
  if (names.length < 2) tabs.hidden = true;
  if (shown !== undefined) show(shown);
  return () => ({ sheet: shown ?? null });
}

/** Every slide, scaled to the view's width, opened at the requested slide. */
async function renderPowerPoint(bytes, root, slide) {
  const slides = (await pptxToHtml(bytes, { ...SLIDE, scaleToFit: true, letterbox: true })).map((html, index) => {
    const frame = element("section", "office-slide");
    frame.dataset.slide = String(index + 1);
    frame.innerHTML = html;
    return frame;
  });
  root.append(...slides);
  const fit = () => root.style.setProperty("--slide-zoom", String(Math.min(1.5, Math.max(0.2, (innerWidth - 48) / SLIDE.width))));
  fit();
  addEventListener("resize", fit);
  if (Number.isSafeInteger(slide) && slide >= 1) {
    // A slide past the end is the agent's mistake; it shows as a page error, not silently.
    if (slide > slides.length) console.error(`The deck has ${slides.length} slides, so slide ${slide} does not exist; showing the last slide.`);
    slides[Math.min(slide, slides.length) - 1]?.scrollIntoView();
  }
  return () => {
    // The last slide whose top is above the middle of the view. The deck has room below its
    // last slide (see OFFICE_STYLES) so that one, too, can scroll up to the middle.
    const middle = innerHeight / 2;
    const current = slides.filter((frame) => frame.getBoundingClientRect().top <= middle).at(-1) ?? slides[0];
    return { slide: current ? Number(current.dataset.slide) : null };
  };
}

/** Whether a zip extra field holds a ZIP64 record (tag 0x0001), or runs past the file. */
function hasZip64(view, start, length) {
  if (start + length > view.byteLength) return true;
  for (let at = start; at + 4 <= start + length; at += 4 + view.getUint16(at + 2, true)) {
    if (view.getUint16(at, true) === 0x0001) return true;
  }
  return false;
}

/** The response's bytes, refusing a file over the limit before holding more than that. */
async function readBounded(response) {
  const tooLarge = () => new Error("The file is too large to show here. Open it in its own app.");
  if (Number(response.headers.get("content-length") ?? 0) > ARCHIVE_LIMIT.bytes) throw tooLarge();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > ARCHIVE_LIMIT.bytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/**
 * Refuse an archive too large to parse safely, before any converter expands it. The zip's
 * central directory gives each entry's expanded size; its local header must agree, since a
 * parser may trust either; and each entry is inflated once, counting bytes, so a stream that
 * expands past its declared size is caught without ever holding more than one chunk.
 */
async function checkArchive(bytes) {
  const tooLarge = () => { throw new Error("The file is too large to show here. Open it in its own app."); };
  const damaged = () => { throw new Error("This Office file is damaged."); };
  if (bytes.byteLength > ARCHIVE_LIMIT.bytes) tooLarge();
  const view = new DataView(bytes);
  // The end-of-central-directory record sits within the last 64 KiB (its comment's limit).
  // Parsers search backward for it, some from the last bytes and some from 22 bytes earlier.
  // The signature nearest the end must therefore be the record itself, with a comment running
  // exactly to the end of the file; a signature hidden in that comment fails. Signatures
  // earlier in the file, inside a part's data, are never reached and do not matter.
  let end = -1;
  for (let at = bytes.byteLength - 4; at >= Math.max(0, bytes.byteLength - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error("This is not an Office file.");
  if (end + 22 > bytes.byteLength || end + 22 + view.getUint16(end + 20, true) !== bytes.byteLength) damaged();
  // One disk, and a directory that runs exactly up to the end record: an archive whose
  // record undercounts its entries cannot hide one from this check.
  const count = view.getUint16(end + 10, true);
  const length = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true);
  if (view.getUint16(end + 8, true) !== count || at + length !== end) damaged();
  let expanded = 0;
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== 0x02014b50) damaged();
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    if (at + 46 + nameLength > bytes.byteLength) damaged();
    const name = new Uint8Array(bytes, at + 46, nameLength);
    if (size > PART_LIMIT) tooLarge();
    // 0xFFFFFFFF marks a ZIP64 size, which is over the limit anyway.
    expanded += size === 0xffffffff ? Infinity : size;
    if (expanded > ARCHIVE_LIMIT.expanded) tooLarge();
    const local = view.getUint32(at + 42, true);
    if (local + 30 > bytes.byteLength || view.getUint32(local, true) !== 0x04034b50) damaged();
    // With a data descriptor (flag bit 3) the local sizes may be zero; otherwise they must match.
    const described = (view.getUint16(local + 6, true) & 0x8) !== 0;
    const localCompressed = view.getUint32(local + 18, true);
    const localSize = view.getUint32(local + 22, true);
    // A parser may name the part from its local header, so the two names must be the same bytes.
    const localName = new Uint8Array(bytes, local + 30, Math.min(view.getUint16(local + 26, true), Math.max(0, bytes.byteLength - local - 30)));
    if (localName.length !== name.length || localName.some((byte, index) => byte !== name[index])) damaged();
    // A parser may follow the local compression method, so it must be the central one.
    if (view.getUint16(local + 8, true) !== method) damaged();
    if (!(described && localCompressed === 0 && localSize === 0) && (localCompressed !== compressed || localSize !== size)) damaged();
    // A ZIP64 extra field carries 64-bit sizes a parser may trust over the checked ones; an
    // Office file under the byte limit never needs one, so either header carrying it is refused.
    if (hasZip64(view, at + 46 + view.getUint16(at + 28, true), view.getUint16(at + 30, true))
      || hasZip64(view, local + 30 + view.getUint16(local + 26, true), view.getUint16(local + 28, true))) damaged();
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + compressed > bytes.byteLength) damaged();
    entries.push({ method, start, compressed, size });
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  if (at !== end) damaged();
  for (const { method, start, compressed, size } of entries) {
    if (method === 0) {
      if (compressed !== size) damaged();
      continue;
    }
    // Office files store or deflate their parts; nothing else is expected.
    if (method !== 8) damaged();
    const reader = new Blob([new Uint8Array(bytes, start, compressed)]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    let produced = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        produced += value.byteLength;
        if (produced > size) damaged();
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error?.message === "This Office file is damaged.") throw error;
      damaged();
    }
    if (produced !== size) damaged();
  }
}

/**
 * Render one Office file into `#office`. The view's note location script reads
 * `window.relayerOfficeLocation()` for the slide, sheet or heading in view.
 */
async function render(kind, source, { slide } = {}) {
  const root = document.getElementById("office");
  root.dataset.kind = kind;
  try {
    const response = await fetch(source);
    if (!response.ok) throw new Error("The file is not in the thread folder.");
    const bytes = await readBounded(response);
    await checkArchive(bytes);
    const locate = kind === "docx" ? await renderWord(bytes, root)
      : kind === "xlsx" ? renderExcel(bytes, root)
        : kind === "pptx" ? await renderPowerPoint(bytes, root, slide)
          : null;
    if (!locate) throw new Error(`Unsupported Office kind: ${kind}`);
    window.relayerOfficeLocation = locate;
    root.dataset.ready = "true";
  } catch (error) {
    root.replaceChildren(element("p", "office-error", `This document could not be shown: ${error.message}`));
    root.dataset.ready = "failed";
    console.error(`The ${kind} document could not be shown: ${error.message}`);
  }
}

window.relayerOffice = Object.freeze({ render });
