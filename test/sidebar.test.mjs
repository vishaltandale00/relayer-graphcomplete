import { Window } from "happy-dom";
import { designCss } from "../scripts/design/build.mjs";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { initializeSidebar } from "../desktop/renderer/src/sidebar.js";

function classList() {
  const values = new Set();
  return {
    contains: (name) => values.has(name),
    toggle(name, force) {
      const enabled = force ?? !values.has(name);
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    },
  };
}

function fixture(narrow = false, lockup) {
  const body = { classList: classList() };
  const listeners = new Map();
  const brandListeners = new Map();
  const brand = {
    addEventListener: (name, callback) => brandListeners.set(name, callback),
    hover: () => brandListeners.get("pointerenter")(),
    leave: () => brandListeners.get("pointerleave")(),
  };
  const toggle = {
    title: "",
    attributes: new Map(),
    addEventListener: (name, callback) => listeners.set(name, callback),
    setAttribute(name, value) { this.attributes.set(name, value); },
    click() { listeners.get("click")(); },
  };
  const mediaListeners = new Set();
  const mediaQuery = {
    matches: narrow,
    addEventListener: (_name, callback) => mediaListeners.add(callback),
    change(matches) {
      this.matches = matches;
      for (const callback of mediaListeners) callback({ matches });
    },
  };
  initializeSidebar({ body, toggle, mediaQuery, lockup, brand });
  return { body, toggle, mediaQuery, brand };
}

describe("responsive sidebar", () => {
  it("starts narrow in the icon rail and preserves explicit expansion until leaving the breakpoint", () => {
    const { body, toggle, mediaQuery } = fixture(true);
    expect(body.classList.contains("sidebar-collapsed")).toBe(true);
    expect(toggle.attributes.get("aria-expanded")).toBe("false");

    toggle.click();
    expect(body.classList.contains("sidebar-collapsed")).toBe(false);
    expect(toggle.attributes.get("aria-expanded")).toBe("true");
    mediaQuery.change(true);
    expect(body.classList.contains("sidebar-collapsed")).toBe(false);

    mediaQuery.change(false);
    mediaQuery.change(true);
    expect(body.classList.contains("sidebar-collapsed")).toBe(true);
  });

  it("spreads the brand lockup on hover, folds it back on leave, and ignores hover in the icon rail", () => {
    const spreads = [];
    const lockup = { setSpread: (value, options = {}) => spreads.push(options.animate === false ? "snap" : value) };
    const { toggle, brand } = fixture(false, lockup);
    expect(spreads).toEqual(["snap"]); // rests on the mark
    brand.hover();
    brand.leave();
    expect(spreads).toEqual(["snap", 1, 0]);
    brand.hover();
    toggle.click(); // collapsing while hovered snaps to the mark with the rail, no overhang
    expect(spreads).toEqual(["snap", 1, 0, 1, "snap"]);
    brand.hover();
    expect(spreads).toEqual(["snap", 1, 0, 1, "snap"]); // no room for the word in the rail
    brand.leave();
    toggle.click();
    expect(spreads.slice(-2)).toEqual([0, "snap"]); // expanding returns to the mark, not the word
  });

  it("keeps the sidebar in flow and sizes the new-thread composer from available space", async () => {
    const [html, css, main, account, evalSettings] = await Promise.all([
      readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/main.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/desktop-account.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/eval-renderer/product-settings.js", import.meta.url), "utf8"),
    ]);
    expect(html).toContain('id="collapseSidebar"');
    expect(html).toContain('id="desktopAccountButton"');
    expect(html).not.toContain("shellNavigation");
    expect(css).not.toMatch(/\.sidebar\s*\{[^}]*display:\s*none/);
    expect(css).toContain(".new-thread-view{grid-template-columns:minmax(0,1fr)}");
    expect(css).toContain(".new-thread-center{width:min(720px,calc(100% - 48px));max-width:none}");
    expect(css).not.toContain(".shell-navigation");
    // ACC-008: render the real colour-token generator with the production layout
    // stylesheet. Light mode's more specific palette selector must not replace width.
    const design = JSON.parse(await readFile(new URL("../designs/h-sticker-cocoa.json", import.meta.url), "utf8"));
    const layout = css.replace('@import url("./design/design.css");', "");
    for (const theme of ["dark", "light"]) {
      for (const [width, expanded] of [[1280, "244px"]]) {
        const owner = new Window({ width });
        owner.document.documentElement.dataset.theme = theme;
        owner.document.head.innerHTML = `<style>${designCss(design, "sidebar-regression")}${layout}</style>`;
        owner.document.body.innerHTML = '<aside class="sidebar"></aside>';
        const sidebar = owner.document.querySelector(".sidebar");
        expect(owner.getComputedStyle(sidebar).width).toBe(expanded);
        owner.document.body.classList.add("sidebar-collapsed");
        expect(owner.getComputedStyle(sidebar).width).toBe("58px");
        owner.happyDOM.abort();
      }
    }
    // Popups consume the same dimension, keeping controls beside the sidebar.
    expect(css).toContain("left:calc(var(--sidebar-width) + 8px)");
    expect(css).toContain("max-width:calc(100vw - var(--sidebar-width) - 16px)");
    expect(main).toContain("initializeSidebar({");
    expect(html).toContain('<svg class="brand-lockup" id="brandLockup"');
    expect(main).toContain('createBrandLockup($("#brandLockup")');
    expect(main).toContain('brand: $("#brandLockup")');
    expect(html).toContain('<svg class="brand-lockup hero-lockup" id="heroLockup"');
    expect(main).toContain('spreadOnHover($("#heroLockup"), createBrandLockup($("#heroLockup"), { height: 40, reducedMotion }))');
    expect(main).toContain('const reducedMotion = () => motion.matches;');
    // The Eval settings host swaps main.js for its own entry point, which must draw the same lockups.
    expect(evalSettings).toContain('import { createBrandLockup, spreadOnHover } from "/src/relayer-mark.js";');
    expect(evalSettings).toContain('[["brandLockup", 24], ["heroLockup", 40]]');
    expect(evalSettings).toContain('.sidebar-title strong").textContent = "Eval";');
    expect(account).not.toContain("additionalAccountButtons");
  });
});
