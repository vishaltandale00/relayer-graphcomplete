import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_ONBOARDING_PREFERENCE_KEY,
  createDesktopAccountController,
  normalizeDesktopAccountState,
  revealDesktopWorkspace,
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
  it("holds the workspace behind the optional onboarding gate and survives read, refresh, and storage failures", async () => {
    // Phase 1: the startup visibility gate releases before showing the
    // workspace during recovery.
    const body = { classList: classList("desktop-account-pending") };
    const showApplication = vi.fn();
    revealDesktopWorkspace(showApplication, body);
    expect(body.classList.contains("desktop-account-pending"), "startup pending class released").toBe(false);
    expect(showApplication, "application shown exactly once").toHaveBeenCalledOnce();

    // Phase 2: the optional account step gates the workspace until the user
    // continues, persists the dismissal, and stays dismissed across refreshes.
    const gating = fixture();
    await gating.controller.start({ offerOnboarding: true });
    expect(gating.elements.onboarding.classList.contains("hidden"), "onboarding surface visible").toBe(false);
    expect(gating.showWorkspace, "workspace held behind onboarding").not.toHaveBeenCalled();
    expect(gating.elements.accountButton.textContent, "corner control offers sign-in").toBe("Sign in");
    expect(gating.elements.onboardingStatus.textContent, "onboarding privacy copy").toContain("privacy-filtered error reports");

    gating.elements.onboardingNotNow.onclick();
    expect(gating.storage.setItem, "dismissal preference persisted").toHaveBeenCalledWith(ACCOUNT_ONBOARDING_PREFERENCE_KEY, "dismissed");
    expect(gating.elements.onboarding.classList.contains("hidden"), "onboarding dismissed").toBe(true);
    expect(gating.showWorkspace, "workspace revealed on dismissal").toHaveBeenCalledOnce();

    await gating.controller.refresh({ offerOnboarding: true });
    expect(gating.elements.onboarding.classList.contains("hidden"), "dismissal survives refresh").toBe(true);
    expect(gating.showWorkspace, "workspace not re-revealed by refresh").toHaveBeenCalledOnce();

    // Phase 3: signing in completes onboarding.
    const completing = fixture();
    await completing.controller.start({ offerOnboarding: true });
    completing.changed({ status: "signed-in", channel: "stable", subject: "auth0|pseudonymous-123" });
    expect(completing.storage.setItem, "completion preference persisted").toHaveBeenCalledWith(ACCOUNT_ONBOARDING_PREFERENCE_KEY, "completed");
    expect(completing.elements.onboarding.classList.contains("hidden"), "onboarding hidden after sign-in").toBe(true);
    expect(completing.showWorkspace, "workspace revealed on sign-in").toHaveBeenCalledOnce();

    // Phase 4: an account read failure stays inside the optional surface
    // instead of failing desktop boot.
    const readFailing = fixture();
    readFailing.api.read.mockRejectedValueOnce(new Error("private failure detail"));
    await expect(readFailing.controller.start({ offerOnboarding: true }), "boot survives the read failure").resolves.toEqual({
      status: "error",
      channel: "stable",
      reason: "authentication-failed",
    });
    expect(readFailing.elements.settingsStatus.textContent, "read failure status copy").toBe("Account status unavailable");
    expect(readFailing.elements.onboarding.classList.contains("hidden"), "gate still offered after read failure").toBe(false);
    expect(readFailing.showWorkspace, "workspace still held after read failure").not.toHaveBeenCalled();
    readFailing.elements.onboardingNotNow.onclick();
    expect(readFailing.showWorkspace, "workspace reachable after failed read").toHaveBeenCalledOnce();

    // Phase 5: a failed post-provider refresh keeps the optional gate.
    const refreshFailing = fixture();
    await refreshFailing.controller.start();
    refreshFailing.api.read.mockRejectedValueOnce(new Error("private refresh failure"));
    await refreshFailing.controller.refresh({ offerOnboarding: true });
    expect(refreshFailing.elements.onboarding.classList.contains("hidden"), "gate held after refresh failure").toBe(false);
    expect(refreshFailing.showWorkspace, "workspace held after refresh failure").not.toHaveBeenCalled();
    refreshFailing.elements.onboardingNotNow.onclick();
    expect(refreshFailing.showWorkspace, "workspace reachable after failed refresh").toHaveBeenCalledOnce();

    // Phase 6: an unavailable preference store never blocks continuation.
    const storageFailing = fixture();
    await storageFailing.controller.start({ offerOnboarding: true });
    storageFailing.storage.setItem.mockImplementationOnce(() => { throw new Error("storage unavailable"); });
    expect(() => storageFailing.elements.onboardingNotNow.onclick(), "dismissal survives storage failure").not.toThrow();
    expect(storageFailing.elements.onboarding.classList.contains("hidden"), "onboarding dismissed despite storage failure").toBe(true);
    expect(storageFailing.showWorkspace, "workspace revealed despite storage failure").toHaveBeenCalledOnce();
  }, 10_000);

  it("renders minimal account status and coalesces sign-in actions on the corner control", async () => {
    // Phase 1: settings stay minimal and exclude sensitive or release details.
    const minimal = fixture();
    await minimal.controller.start();
    minimal.changed({
      status: "signed-in",
      channel: "preview",
      subject: "auth0|pseudonymous-123",
      email: "must-not-render@example.test",
      accessToken: "secret",
    });
    expect(minimal.elements.accountButton.textContent, "corner control labels the account").toBe("Account");
    expect(minimal.elements.settingsStatus.textContent, "settings status excludes sensitive detail").toBe("Signed in");
    expect(minimal.elements.settingsLogout.classList.contains("hidden"), "logout offered while signed in").toBe(false);
    expect(minimal.elements.settingsSignIn.classList.contains("hidden"), "sign-in hidden while signed in").toBe(true);

    // Phase 2: uncertain and unknown states keep local use available with
    // concise copy.
    const degraded = fixture();
    await degraded.controller.start();
    degraded.changed({ status: "uncertain", channel: "stable", subject: "auth0|123", reason: "offline" });
    expect(degraded.elements.settingsStatus.textContent, "uncertain offline status copy").toBe("Account unavailable offline");
    degraded.changed({ status: "totally-new", channel: "preview", token: "secret" });
    expect(degraded.elements.settingsStatus.textContent, "unknown status copy").toBe("Account status unavailable");
    expect(normalizeDesktopAccountState({ status: "totally-new", channel: "preview" }), "unknown state normalizes to auth failure").toEqual({
      status: "error",
      channel: "preview",
      reason: "authentication-failed",
    });

    // Phase 3: the bottom-right control starts sign-in directly and opens
    // settings only for an existing account.
    const control = fixture();
    await control.controller.start();
    expect(control.elements.accountButton.getAttribute("title"), "corner control title while signed out").toBe("Sign in");
    expect(control.elements.accountButton.getAttribute("aria-label"), "corner control accessible label").toBe("Sign in to Relayer.");
    control.elements.accountButton.onclick();
    expect(control.api.login, "corner click starts sign-in").toHaveBeenCalledOnce();
    expect(control.openSettings, "corner click does not open settings while signed out").not.toHaveBeenCalled();
    control.changed({ status: "signing-in", channel: "stable" });
    expect(control.elements.settingsStatus.textContent, "signing-in status copy").toBe("Finish signing in in your browser");
    control.changed({ status: "signed-in", channel: "stable", subject: "auth0|123" });
    expect(control.elements.accountButton.getAttribute("title"), "corner control title while signed in").toBe("Account");
    control.elements.accountButton.onclick();
    expect(control.openSettings, "corner click opens settings for an existing account").toHaveBeenCalledOnce();
    control.elements.settingsLogout.onclick();
    expect(control.api.logout, "settings logout action").toHaveBeenCalledOnce();

    // Phase 4: rapid sign-in actions coalesce into one browser flow.
    const coalescing = fixture();
    let resolveLogin;
    coalescing.api.login.mockImplementationOnce(() => new Promise((resolve) => { resolveLogin = resolve; }));
    await coalescing.controller.start();
    coalescing.elements.accountButton.onclick();
    coalescing.elements.accountButton.onclick();
    coalescing.elements.onboardingSignIn.onclick();
    coalescing.elements.settingsSignIn.onclick();
    expect(coalescing.api.login, "rapid actions coalesce into one login").toHaveBeenCalledOnce();
    expect(coalescing.elements.accountButton.textContent, "corner control shows pending sign-in").toBe("Signing in…");
    expect(coalescing.elements.accountButton.disabled, "corner control disabled while signing in").toBe(true);
    expect(coalescing.elements.onboardingSignIn.disabled, "onboarding sign-in disabled while signing in").toBe(true);
    expect(coalescing.elements.settingsSignIn.disabled, "settings sign-in disabled while signing in").toBe(true);
    resolveLogin({ status: "signing-in", channel: "stable" });
    await vi.waitFor(() => expect(coalescing.elements.settingsStatus.textContent, "pending browser sign-in copy").toBe("Finish signing in in your browser"));
  }, 10_000);

  it("anchors the account surface in the static markup contract", async () => {
    const [html, css] = await Promise.all([
      readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8"),
    ]);
    const sidebarFooter = html.slice(html.indexOf('<div class="sidebar-footer">'), html.indexOf("</aside>"));

    expect(html, "onboarding is a full surface, not a dialog").toContain('<section class="desktop-account-onboarding hidden" id="desktopAccountOnboarding"');
    expect(html, "no dialog-based onboarding").not.toContain('<dialog class="desktop-account-onboarding"');
    expect(html, "onboarding continue action copy").toContain('id="desktopAccountOnboardingNotNow">Continue without an account</button>');
    expect(sidebarFooter, "account control not anchored in the sidebar footer").not.toContain('id="desktopAccountButton"');
    expect(html, "account control is a hidden corner control").toContain('class="desktop-account-corner-control hidden" id="desktopAccountButton"');
    const accountPanel = html.slice(html.indexOf('id="accountSettingsPanel"'), html.indexOf('id="providerSettingsPanel"'));
    expect(accountPanel, "account panel exposes status").toContain('id="desktopAccountStatus"');
    expect(accountPanel, "account panel exposes sign-in").toContain('id="desktopAccountSignIn"');
    expect(accountPanel, "account panel exposes logout").toContain('id="desktopAccountLogout"');
    expect(accountPanel, "account panel has no intro copy").not.toContain("account-settings-intro");
    expect(accountPanel, "account panel leaks no detail row").not.toContain("desktopAccountDetail");
    expect(accountPanel, "account panel exposes no channel control").not.toContain("desktopAccountChannel");
    expect(accountPanel, "account panel exposes no release channel copy").not.toContain("Release channel");
    expect(css, "onboarding surface covers the viewport").toContain(".desktop-account-onboarding{position:fixed;inset:0;");
    expect(css, "corner control anchored bottom-right").toContain(".desktop-account-corner-control{position:fixed;right:16px;bottom:14px;");
  });
});
