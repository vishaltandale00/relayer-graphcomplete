import { afterEach, describe, expect, it, vi } from "vitest";

import { createShellNavigation } from "../desktop/renderer/src/shell-navigation.js";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

afterEach(() => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else delete globalThis.document;
});

function classList(...initial) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : force;
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    },
  };
}

function element() {
  const listeners = new Map();
  const attributes = new Map();
  return {
    classList: classList(),
    listeners,
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name),
    focus: vi.fn(),
    click: vi.fn(),
    contains: (target) => target === this,
  };
}

function setup({ narrow = false, collapsed = false, enabled = true } = {}) {
  const settingsItem = element();
  const accountItem = element();
  settingsItem.closest = () => settingsItem;
  accountItem.closest = () => accountItem;
  const trigger = element();
  const panel = element();
  panel.classList.add("hidden");
  panel.querySelector = (selector) => selector.includes("Settings") ? settingsItem : accountItem;
  panel.contains = (target) => target === panel || target === settingsItem || target === accountItem;
  trigger.contains = (target) => target === trigger;
  const body = { classList: classList(...(collapsed ? ["sidebar-collapsed"] : [])) };
  const mediaListeners = new Set();
  const mediaQuery = {
    matches: narrow,
    addEventListener: (_name, callback) => mediaListeners.add(callback),
    removeEventListener: (_name, callback) => mediaListeners.delete(callback),
    change(value) {
      this.matches = value;
      for (const listener of mediaListeners) listener();
    },
  };
  const documentListeners = new Map();
  globalThis.document = {
    addEventListener: (name, handler) => documentListeners.set(name, handler),
    removeEventListener: (name) => documentListeners.delete(name),
  };
  const settingsButton = element();
  const accountButton = element();
  const controller = createShellNavigation({
    trigger, panel, settingsButton, accountButton, body,
    mediaQuery, windowObject: {}, enabled,
  });
  return {
    trigger, panel, settingsItem, accountItem, body, mediaQuery, documentListeners,
    settingsButton, accountButton, controller,
  };
}

describe("shell navigation fallback", () => {
  it("appears for collapsed or narrow layouts and closes when neither applies", () => {
    const { trigger, panel, body, mediaQuery, settingsButton, controller } = setup();
    expect(trigger.classList.contains("hidden")).toBe(true);
    mediaQuery.change(true);
    expect(trigger.classList.contains("hidden")).toBe(false);
    trigger.listeners.get("click")();
    expect(panel.classList.contains("hidden")).toBe(false);
    mediaQuery.change(false);
    expect(trigger.classList.contains("hidden")).toBe(true);
    expect(panel.classList.contains("hidden")).toBe(true);

    body.classList.add("sidebar-collapsed");
    controller.sync();
    expect(trigger.classList.contains("hidden")).toBe(false);
    trigger.listeners.get("click")();
    body.classList.remove("sidebar-collapsed");
    controller.sync();
    expect(trigger.classList.contains("hidden")).toBe(true);
    expect(panel.classList.contains("hidden")).toBe(true);
    expect(settingsButton.focus).toHaveBeenCalledTimes(2);
  });

  it("keeps the navigation affordance out of Eval even in a collapsed shell", () => {
    const { trigger, panel } = setup({ narrow: true, collapsed: true, enabled: false });
    expect(trigger.classList.contains("hidden")).toBe(true);
    expect(panel.classList.contains("hidden")).toBe(true);
  });

  it("routes through the existing controls and supports Escape, outside dismissal, and disposal", () => {
    const fixture = setup({ narrow: true });
    const { trigger, panel, settingsItem, accountItem, settingsButton, accountButton, documentListeners, controller } = fixture;
    trigger.listeners.get("click")();
    expect(settingsItem.focus).toHaveBeenCalledOnce();
    panel.listeners.get("click")({ target: settingsItem });
    expect(settingsButton.click).toHaveBeenCalledOnce();
    expect(panel.classList.contains("hidden")).toBe(true);

    trigger.listeners.get("click")();
    panel.listeners.get("click")({ target: accountItem });
    expect(accountButton.click).toHaveBeenCalledOnce();

    trigger.listeners.get("click")();
    const escape = { key: "Escape", preventDefault: vi.fn() };
    documentListeners.get("keydown")(escape);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(trigger.focus).toHaveBeenCalledTimes(3);

    trigger.listeners.get("click")();
    documentListeners.get("click")({ target: {} });
    expect(panel.classList.contains("hidden")).toBe(true);
    controller.dispose();
    expect(documentListeners.size).toBe(0);
  });
});
