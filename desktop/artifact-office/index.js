// Office documents in the artifact viewer (PRD 6.6.9). scripts/prepare-renderer-vendor.mjs
// bundles this into desktop/renderer/vendor/artifact-office.js; the artifact scheme serves it
// to the artifact's own isolated view, never to Relayer's page.
import { renderAsync } from "docx-preview";
import { read, utils } from "xlsx";
import { pptxToHtml } from "@jvmr/pptx-to-html";

const SLIDE = { width: 960, height: 540 };
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

/** Each sheet in its own tab. Cells show the values the file saved; nothing is recalculated. */
function renderExcel(bytes, root) {
  const book = read(bytes, { type: "array" });
  const tabs = element("nav", "office-sheet-tabs");
  const sheet = element("div", "office-sheet");
  root.append(tabs, sheet);
  let shown = book.SheetNames[0];
  const show = (name) => {
    shown = name;
    sheet.innerHTML = utils.sheet_to_html(book.Sheets[name], { header: "", footer: "" });
    for (const tab of tabs.children) tab.setAttribute("aria-selected", String(tab.textContent === name));
  };
  for (const name of book.SheetNames) {
    const tab = element("button", "office-sheet-tab", name);
    tab.type = "button";
    tab.onclick = () => show(name);
    tabs.append(tab);
  }
  if (book.SheetNames.length < 2) tabs.hidden = true;
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
  if (Number.isSafeInteger(slide) && slide >= 1) slides[Math.min(slide, slides.length) - 1]?.scrollIntoView();
  return () => {
    const middle = innerHeight / 2;
    const current = slides.filter((frame) => frame.getBoundingClientRect().top <= middle).at(-1) ?? slides[0];
    return { slide: current ? Number(current.dataset.slide) : null };
  };
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
    const bytes = await response.arrayBuffer();
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
