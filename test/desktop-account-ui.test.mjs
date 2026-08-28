import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_ONBOARDING_PREFERENCE_KEY,
  createDesktopAccountController,
  normalizeDesktopAccountState,
} from "../desktop/renderer/src/desktop-account.js";

function classList(...initial) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : force;
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    },
    contains: (name) => values.has(name),
  };
}

function element() {
  const attributes = new Map();
  return {
    classList: classList(),
    textContent: "",
    disabled: false,
    hidden: false,
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name),
    focus: vi.fn(),
  };
}

function fixture() {
  const elements = {
    accountButton: element(),
    onboarding: { ...element(), classList: classList("hidden") },
    onboardingChannel: element(),
    onboardingStatus: element(),
    onboardingSignIn: element(),
    onboardingNotNow: element(),
    settingsStatus: element(),
    settingsDetail: element(),
    settingsChannel: element(),
    settingsSignIn: element(),
    settingsLogout: element(),
  };
  const values = new Map();
  const storage = {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
  };
  let changed;
  const api = {
    read: vi.fn(async () => ({ status: "signed-out", channel: "stable" })),
    login: vi.fn(async () => ({ status: "signing-in", channel: "stable" })),
    logout: vi.fn(async () => ({ status: "signed-out", channel: "stable" })),
    onChanged: vi.fn((callback) => { changed = callback; return () => {}; }),
  };
  const openSettings = vi.fn();
  const showWorkspace = vi.fn();
  return {
    api,
    elements,
    storage,
    openSettings,
    showWorkspace,
    changed: (value) => changed(value),
    controller: createDesktopAccountController({ api, elements, storage, openSettings, showWorkspace }),
  };
}

describe("desktop account presentation", () => {
  it("holds the workspace behind a standalone optional account step until the user continues", async () => {
    const { controller, elements, storage, showWorkspace } = fixture();

    await controller.start({ offerOnboarding: true });

    expect(elements.onboarding.classList.contains("hidden")).toBe(false);
    expect(showWorkspace).not.toHaveBeenCalled();
    expect(elements.accountButton.textContent).toBe("Sign in");
    expect(elements.onboardingStatus.textContent).toContain("privacy-filtered error reports");

    elements.onboardingNotNow.onclick();
    expect(storage.setItem).toHaveBeenCalledWith(ACCOUNT_ONBOARDING_PREFERENCE_KEY, "dismissed");
    expect(elements.onboarding.classList.contains("hidden")).toBe(true);
    expect(showWorkspace).toHaveBeenCalledOnce();

    await controller.refresh({ offerOnboarding: true });
    expect(elements.onboarding.classList.contains("hidden")).toBe(true);
    expect(showWorkspace).toHaveBeenCalledOnce();
  });

  it("reveals the workspace when optional onboarding completes by signing in", async () => {
    const { controller, elements, storage, showWorkspace, changed } = fixture();

    await controller.start({ offerOnboarding: true });
    changed({ status: "signed-in", channel: "stable", subject: "auth0|pseudonymous-123" });

    expect(storage.setItem).toHaveBeenCalledWith(ACCOUNT_ONBOARDING_PREFERENCE_KEY, "completed");
    expect(elements.onboarding.classList.contains("hidden")).toBe(true);
    expect(showWorkspace).toHaveBeenCalledOnce();
  });

  it("keeps release channel out of the everyday account control and in diagnostics", async () => {
    const { controller, elements, changed } = fixture();
    await controller.start();

    changed({
      status: "signed-in",
      channel: "preview",
      subject: "auth0|pseudonymous-123",
      email: "must-not-render@example.test",
      accessToken: "secret",
    });

    expect(elements.accountButton.textContent).toBe("Account");
    expect(elements.settingsStatus.textContent).toBe("Signed in");
    expect(elements.settingsDetail.textContent).toContain("auth0|pseudonymous-123");
    expect(elements.settingsDetail.textContent).not.toContain("must-not-render");
    expect(elements.settingsChannel.textContent).toBe("Preview");
    expect(elements.settingsLogout.classList.contains("hidden")).toBe(false);
    expect(elements.settingsSignIn.classList.contains("hidden")).toBe(true);
  });

  it("keeps local use available in uncertain and error states while explaining telemetry is paused", async () => {
    const { controller, elements, changed } = fixture();
    await controller.start();

    changed({ status: "uncertain", channel: "stable", subject: "auth0|123", reason: "offline" });
    expect(elements.settingsStatus.textContent).toBe("Account unavailable offline");
    expect(elements.settingsDetail.textContent).toContain("Local features remain available");
    expect(elements.settingsDetail.textContent).toContain("Error reporting is paused");

    changed({ status: "totally-new", channel: "preview", token: "secret" });
    expect(elements.settingsStatus.textContent).toBe("Account status unavailable");
    expect(elements.settingsDetail.textContent).toContain("Local features remain available");
    expect(normalizeDesktopAccountState({ status: "totally-new", channel: "preview" })).toEqual({
      status: "error",
      channel: "preview",
      reason: "authentication-failed",
    });
  });

  it("routes the quiet account control to Account settings and never disables local controls", async () => {
    const { controller, elements, openSettings, api, changed } = fixture();
    const localControl = element();
    await controller.start();

    elements.accountButton.onclick();
    expect(openSettings).toHaveBeenCalledOnce();

    elements.settingsSignIn.onclick();
    expect(api.login).toHaveBeenCalledOnce();
    changed({ status: "signing-in", channel: "stable" });
    expect(elements.settingsStatus.textContent).toBe("Finish signing in in your browser");
    expect(localControl.disabled).toBe(false);

    elements.settingsLogout.onclick();
    expect(api.logout).toHaveBeenCalledOnce();
    expect(localControl.disabled).toBe(false);
  });

  it("contains account read failures inside the optional surface instead of failing desktop boot", async () => {
    const { controller, elements, api, showWorkspace } = fixture();
    api.read.mockRejectedValueOnce(new Error("private failure detail"));

    await expect(controller.start({ offerOnboarding: true })).resolves.toEqual({
      status: "error",
      channel: "stable",
      reason: "authentication-failed",
    });
    expect(elements.settingsStatus.textContent).toBe("Account status unavailable");
    expect(elements.settingsDetail.textContent).not.toContain("private failure detail");
    expect(elements.onboarding.classList.contains("hidden")).toBe(false);
    expect(showWorkspace).not.toHaveBeenCalled();
    elements.onboardingNotNow.onclick();
    expect(showWorkspace).toHaveBeenCalledOnce();
  });

  it("uses a full onboarding surface and anchors the account control to the app viewport", async () => {
    const [html, css] = await Promise.all([
      readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8"),
    ]);
    const sidebarFooter = html.slice(html.indexOf('<div class="sidebar-footer">'), html.indexOf("</aside>"));

    expect(html).toContain('<section class="desktop-account-onboarding hidden" id="desktopAccountOnboarding"');
    expect(html).not.toContain('<dialog class="desktop-account-onboarding"');
    expect(html).toContain('id="desktopAccountOnboardingNotNow">Continue without an account</button>');
    expect(sidebarFooter).not.toContain('id="desktopAccountButton"');
    expect(html).toContain('class="desktop-account-corner-control hidden" id="desktopAccountButton"');
    expect(css).toContain(".desktop-account-onboarding{position:fixed;inset:0;");
    expect(css).toContain(".desktop-account-corner-control{position:fixed;right:16px;bottom:14px;");
  });
});
