import { afterEach, describe, expect, it, vi } from "vitest";

import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function captureExportHandler({ mode = "interactive", getThread, onExportConversation }) {
  const element = (initialClasses = []) => {
    const classes = new Set(initialClasses);
    const attributes = new Map();
    return {
      disabled: false,
      textContent: "",
      focus: vi.fn(),
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
          if (force) classes.add(name);
          else classes.delete(name);
        },
      },
      setAttribute: (name, value) => attributes.set(name, String(value)),
      getAttribute: (name) => attributes.get(name) ?? null,
      classes,
    };
  };
  const button = element();
  const settingsButton = element();
  const settingsMenu = element(["hidden"]);
  const settingsControl = element(["hidden"]);
  settingsControl.contains = (target) => [settingsControl, settingsButton, settingsMenu, button].includes(target);
  const listeners = new Map();
  const graphDocument = {
    defaultView: { innerWidth: 1200 },
    addEventListener: (name, handler) => listeners.set(name, handler),
  };
  const graphStage = { ownerDocument: graphDocument };
  const threadView = {
    dataset: {},
    set innerHTML(markup) {
      expect(markup).toContain('id="conversationSettingsButton"');
      expect(markup).toContain('id="conversationSettingsMenu"');
    },
  };
  const root = {
    querySelector(selector) {
      if (selector === "#threadView") return threadView;
      if (selector === "#conversationSettings") return settingsControl;
      if (selector === "#conversationSettingsButton") return settingsButton;
      if (selector === "#conversationSettingsMenu") return settingsMenu;
      if (selector === "#exportConversation") return button;
      if (selector === "#graphStage") return graphStage;
      return null;
    },
    querySelectorAll: () => [],
  };

  expect(() => createProductWorkspace({
    root,
    mode,
    getState: () => ({}),
    getThread,
    selection: {},
    showThread: () => {},
    showEmpty: () => {},
    onExportConversation,
  })).toThrow();
  expect(button.onclick).toBeTypeOf("function");
  expect(settingsButton.onclick).toBeTypeOf("function");
  return {
    button,
    classes: button.classes,
    settingsButton,
    settingsControl,
    settingsMenu,
    listeners,
  };
}

function installToast() {
  const toast = {
    textContent: "",
    classList: { add: vi.fn(), remove: vi.fn() },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { querySelector: (selector) => selector === "#toast" ? toast : null },
  });
  return toast;
}

afterEach(() => {
  vi.useRealTimers();
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else delete globalThis.document;
});

describe("conversation export product control", () => {
  it("passes the currently selected thread, suppresses a second click, and restores after save", async () => {
    vi.useFakeTimers();
    const toast = installToast();
    const completion = deferred();
    const selectedThread = { id: 41 };
    const onExportConversation = vi.fn(() => completion.promise);
    const { button, classes, settingsButton, settingsMenu } = captureExportHandler({
      getThread: () => selectedThread,
      onExportConversation,
    });

    settingsButton.onclick();
    expect(settingsButton.getAttribute("aria-expanded")).toBe("true");
    expect(settingsMenu.classes.has("hidden")).toBe(false);
    const first = button.onclick();
    const second = button.onclick();
    expect(onExportConversation).toHaveBeenCalledTimes(1);
    expect(onExportConversation).toHaveBeenCalledWith(41);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe("Exporting…");
    expect(classes.has("hidden")).toBe(false);
    expect(settingsButton.getAttribute("aria-expanded")).toBe("false");
    expect(settingsMenu.classes.has("hidden")).toBe(true);

    completion.resolve({ status: "saved" });
    await Promise.all([first, second]);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(button.textContent).toBe("Export conversation…");
    expect(toast.textContent).toBe("Conversation exported.");
  });

  it.each([
    [{ status: "canceled" }, "Export canceled."],
    [new Error("Disk is full."), "Disk is full."],
  ])("reports cancellation and failure honestly", async (outcome, message) => {
    vi.useFakeTimers();
    const toast = installToast();
    const onExportConversation = outcome instanceof Error
      ? vi.fn(async () => { throw outcome; })
      : vi.fn(async () => outcome);
    const { button } = captureExportHandler({
      getThread: () => ({ id: 8 }),
      onExportConversation,
    });

    await button.onclick();
    expect(toast.textContent).toBe(message);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("false");
  });

  it("dismisses conversation settings from Escape or an outside pointer", () => {
    const { settingsButton, settingsMenu, listeners } = captureExportHandler({
      getThread: () => ({ id: 12 }),
      onExportConversation: vi.fn(async () => ({ status: "saved" })),
    });

    settingsButton.onclick();
    listeners.get("keydown")({ key: "Escape" });
    expect(settingsMenu.classes.has("hidden")).toBe(true);
    expect(settingsButton.focus).toHaveBeenCalledOnce();

    settingsButton.onclick();
    listeners.get("pointerdown")({ target: {} });
    expect(settingsMenu.classes.has("hidden")).toBe(true);
    expect(settingsButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("remains hidden and inert in review mode even if an export callback is supplied", async () => {
    installToast();
    const onExportConversation = vi.fn(async () => ({ status: "saved" }));
    const { button, settingsControl } = captureExportHandler({
      mode: "review",
      getThread: () => ({ id: 19 }),
      onExportConversation,
    });

    expect(settingsControl.classes.has("hidden")).toBe(true);
    await button.onclick();
    expect(onExportConversation).not.toHaveBeenCalled();
  });
});
