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

function fixture(narrow = false) {
  const body = { classList: classList() };
  const listeners = new Map();
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
  initializeSidebar({ body, toggle, mediaQuery });
  return { body, toggle, mediaQuery };
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

  it("keeps the sidebar in flow and sizes the new-thread composer from available space", async () => {
    const [html, css, main, account] = await Promise.all([
      readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/main.js", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/src/desktop-account.js", import.meta.url), "utf8"),
    ]);
    expect(html).toContain('id="collapseSidebar"');
    expect(html).toContain('id="desktopAccountButton"');
    expect(html).not.toContain("shellNavigation");
    expect(css).not.toMatch(/\.sidebar\s*\{[^}]*display:\s*none/);
    expect(css).toContain(".new-thread-view{grid-template-columns:minmax(0,1fr)}");
    expect(css).toContain(".new-thread-center{width:min(720px,calc(100% - 48px));max-width:none}");
    expect(css).not.toContain(".shell-navigation");
    expect(main).toContain("initializeSidebar({");
    expect(account).not.toContain("additionalAccountButtons");
  });
});
