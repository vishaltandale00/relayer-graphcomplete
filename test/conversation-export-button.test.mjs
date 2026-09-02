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
  it("exports the selected thread once, suppresses a second click, and reports every outcome honestly", async () => {
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
    expect(settingsButton.getAttribute("aria-expanded"), "the settings menu opens").toBe("true");
    expect(settingsMenu.classes.has("hidden"), "the settings menu is visible").toBe(false);
    const first = button.onclick();
    const second = button.onclick();
    expect(onExportConversation, "a second click is suppressed").toHaveBeenCalledTimes(1);
    expect(onExportConversation, "the export names the currently selected thread").toHaveBeenCalledWith(41);
    expect(button.disabled, "the button disables while busy").toBe(true);
    expect(button.getAttribute("aria-busy"), "the button reports busy").toBe("true");
    expect(button.textContent, "the busy label").toBe("Exporting…");
    expect(classes.has("hidden"), "the button stays visible").toBe(false);
    expect(settingsButton.getAttribute("aria-expanded"), "starting an export closes the menu").toBe("false");
    expect(settingsMenu.classes.has("hidden"), "the menu hides").toBe(true);

    completion.resolve({ status: "saved" });
    await Promise.all([first, second]);
    expect(button.disabled, "the button restores after save").toBe(false);
    expect(button.getAttribute("aria-busy"), "the button goes idle").toBe("false");
    expect(button.textContent, "the idle label").toBe("Export conversation…");
    expect(toast.textContent, "a saved export toasts").toBe("Conversation exported.");

    const outcomes = [
      ["a canceled export", { status: "canceled" }, "Export canceled."],
      ["a failed export", new Error("Disk is full."), "Disk is full."],
    ];
    expect(outcomes, "outcome inventory").toHaveLength(2);
    for (const [label, outcome, message] of outcomes) {
      const outcomeToast = installToast();
      const { button: outcomeButton } = captureExportHandler({
        getThread: () => ({ id: 8 }),
        onExportConversation: outcome instanceof Error
          ? vi.fn(async () => { throw outcome; })
          : vi.fn(async () => outcome),
      });

      await outcomeButton.onclick();
      expect(outcomeToast.textContent, `${label} reports honestly`).toBe(message);
      expect(outcomeButton.disabled, `${label} restores the button`).toBe(false);
      expect(outcomeButton.getAttribute("aria-busy"), `${label} clears the busy state`).toBe("false");
    }
  });

  it("dismisses the settings menu on Escape or an outside pointer and stays inert in review mode", async () => {
    const { settingsButton, settingsMenu, listeners } = captureExportHandler({
      getThread: () => ({ id: 12 }),
      onExportConversation: vi.fn(async () => ({ status: "saved" })),
    });

    settingsButton.onclick();
    listeners.get("keydown")({ key: "Escape" });
    expect(settingsMenu.classes.has("hidden"), "escape dismisses the menu").toBe(true);
    expect(settingsButton.focus, "focus returns to the trigger").toHaveBeenCalledOnce();

    settingsButton.onclick();
    listeners.get("pointerdown")({ target: {} });
    expect(settingsMenu.classes.has("hidden"), "an outside pointer dismisses the menu").toBe(true);
    expect(settingsButton.getAttribute("aria-expanded"), "the aria state collapses").toBe("false");

    installToast();
    const reviewExport = vi.fn(async () => ({ status: "saved" }));
    const { button, settingsControl } = captureExportHandler({
      mode: "review",
      getThread: () => ({ id: 19 }),
      onExportConversation: reviewExport,
    });

    expect(settingsControl.classes.has("hidden"), "review mode hides the control").toBe(true);
    await button.onclick();
    expect(reviewExport, "review mode never exports").not.toHaveBeenCalled();
  });
});
