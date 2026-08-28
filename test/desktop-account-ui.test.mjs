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
    onboarding: { ...element(), open: false, show: vi.fn(function show() { this.open = true; }), close: vi.fn(function close() { this.open = false; }) },
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
  return {
    api,
    elements,
    storage,
    openSettings,
    changed: (value) => changed(value),
    controller: createDesktopAccountController({ api, elements, storage, openSettings }),
  };
}

describe("desktop account presentation", () => {
  it("offers optional sign-in after local UI is available and Not now durably suppresses future prompts", async () => {
    const { controller, elements, storage } = fixture();

    await controller.start({ offerOnboarding: true });

    expect(elements.onboarding.show).toHaveBeenCalledOnce();
    expect(elements.accountButton.textContent).toBe("Sign in");
    expect(elements.onboardingStatus.textContent).toContain("privacy-filtered error reports");

    elements.onboardingNotNow.onclick();
    expect(storage.setItem).toHaveBeenCalledWith(ACCOUNT_ONBOARDING_PREFERENCE_KEY, "dismissed");
    expect(elements.onboarding.close).toHaveBeenCalledOnce();

    await controller.refresh({ offerOnboarding: true });
    expect(elements.onboarding.show).toHaveBeenCalledOnce();
  });

  it("renders only normalized account presentation fields and makes Preview explicit", async () => {
    const { controller, elements, changed } = fixture();
    await controller.start();

    changed({
      status: "signed-in",
      channel: "preview",
      subject: "auth0|pseudonymous-123",
      email: "must-not-render@example.test",
      accessToken: "secret",
    });

    expect(elements.accountButton.textContent).toBe("Account · Preview");
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
    const { controller, elements, api } = fixture();
    api.read.mockRejectedValueOnce(new Error("private failure detail"));

    await expect(controller.start({ offerOnboarding: true })).resolves.toEqual({
      status: "error",
      channel: "stable",
      reason: "authentication-failed",
    });
    expect(elements.settingsStatus.textContent).toBe("Account status unavailable");
    expect(elements.settingsDetail.textContent).not.toContain("private failure detail");
    expect(elements.onboarding.show).not.toHaveBeenCalled();
  });
});
