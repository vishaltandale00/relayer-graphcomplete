import { afterEach, describe, expect, it } from "vitest";

const globalNames = ["document", "location", "window"];
const originalGlobals = new Map(
  globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);

afterEach(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

function classList(...initial) {
  const values = new Set(initial);
  return {
    contains: (name) => values.has(name),
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : force;
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    },
  };
}

function tab(name) {
  const attributes = new Map();
  return {
    dataset: { settingsTab: name },
    classList: classList(),
    tabIndex: 0,
    focusCount: 0,
    focus() { this.focusCount += 1; },
    setAttribute: (key, value) => attributes.set(key, value),
    getAttribute: (key) => attributes.get(key),
  };
}

describe("Settings navigation", () => {
  it("swaps the sidebar, switches panels, and returns to the prior app view", async () => {
    const elements = new Map([
      ["#newThreadView", { classList: classList() }],
      ["#threadView", { classList: classList("hidden") }],
      ["#settingsView", { classList: classList("hidden") }],
      ["#settingsButton", { classList: classList(), focusCount: 0, focus() { this.focusCount += 1; } }],
      ["#appSidebarContent", { classList: classList() }],
      ["#settingsSidebarContent", { classList: classList("hidden") }],
      ["#settingsTitle", { textContent: "Settings" }],
    ]);
    const tabs = [tab("models"), tab("appearance"), tab("codex"), tab("updates")];
    const panels = ["models", "appearance", "codex", "updates"].map((name) => ({
      dataset: { settingsPanel: name },
      classList: name === "appearance" ? classList() : classList("hidden"),
    }));

    Object.assign(globalThis, {
      location: new URL("http://127.0.0.1:43123/"),
      window: { relayerDesktop: undefined, relayerEvalReview: undefined },
      document: {
        querySelector: (selector) => {
          const settingsTab = selector.match(/^\[data-settings-tab="(.+)"\]$/)?.[1];
          return elements.get(selector) || tabs.find((item) => item.dataset.settingsTab === settingsTab) || null;
        },
        querySelectorAll: (selector) => {
          if (selector === "[data-settings-tab]") return tabs;
          if (selector === "[data-settings-panel]") return panels;
          return [];
        },
      },
    });

    const navigation = await import("../desktop/renderer/src/navigation.js");
    const { viewState } = await import("../desktop/renderer/src/state.js");
    viewState.mainView = "new";
    viewState.previousMainView = "new";
    viewState.currentThreadId = null;
    viewState.settingsTab = "appearance";

    navigation.setMainView("settings", { moveFocus: true });
    expect(elements.get("#appSidebarContent").classList.contains("hidden")).toBe(true);
    expect(elements.get("#settingsSidebarContent").classList.contains("hidden")).toBe(false);
    expect(elements.get("#settingsTitle").textContent).toBe("Appearance");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].focusCount).toBe(1);
    expect(elements.get("#settingsButton").classList.contains("hidden")).toBe(true);

    navigation.setSettingsTab("updates");
    expect(elements.get("#settingsTitle").textContent).toBe("Application updates");
    expect(panels[1].classList.contains("hidden")).toBe(true);
    expect(panels[3].classList.contains("hidden")).toBe(false);

    await navigation.returnFromSettings();
    expect(viewState.mainView).toBe("new");
    expect(elements.get("#appSidebarContent").classList.contains("hidden")).toBe(false);
    expect(elements.get("#settingsButton").focusCount).toBe(1);

    viewState.mainView = "thread";
    viewState.currentThreadId = "42";
    navigation.setMainView("settings");
    const refreshedThreadIds = [];
    await navigation.returnFromSettings(async (threadId) => refreshedThreadIds.push(threadId));
    expect(viewState.mainView).toBe("thread");
    expect(refreshedThreadIds).toEqual(["42"]);
  });
});
