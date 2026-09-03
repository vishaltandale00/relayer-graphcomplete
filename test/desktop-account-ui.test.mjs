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
    accountLabel: element(),
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
  it("releases the startup visibility gate before showing the workspace during recovery", () => {
    const body = { classList: classList("desktop-account-pending") };
    const showApplication = vi.fn();

    revealDesktopWorkspace(showApplication, body);

    expect(body.classList.contains("desktop-account-pending")).toBe(false);
    expect(showApplication).toHaveBeenCalledOnce();
  });

  it("holds the workspace behind a standalone optional account step until the user continues", async () => {
    const { controller, elements, storage, showWorkspace } = fixture();

    await controller.start({ offerOnboarding: true });

    expect(elements.onboarding.classList.contains("hidden")).toBe(false);
    expect(showWorkspace).not.toHaveBeenCalled();
    expect(elements.accountLabel.textContent).toBe("Sign in");
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

  it("keeps account settings minimal and excludes sensitive or release-channel details", async () => {
    const { controller, elements, changed } = fixture();
    await controller.start();

    changed({
      status: "signed-in",
      channel: "preview",
      subject: "auth0|pseudonymous-123",
      email: "must-not-render@example.test",
      accessToken: "secret",
    });

    expect(elements.accountLabel.textContent).toBe("Account");
    expect(elements.settingsStatus.textContent).toBe("Signed in");
    expect(elements.settingsLogout.classList.contains("hidden")).toBe(false);
    expect(elements.settingsSignIn.classList.contains("hidden")).toBe(true);
  });

  it("keeps local use available in uncertain and error states with concise status copy", async () => {
    const { controller, elements, changed } = fixture();
    await controller.start();

    changed({ status: "uncertain", channel: "stable", subject: "auth0|123", reason: "offline" });
    expect(elements.settingsStatus.textContent).toBe("Account unavailable offline");

    changed({ status: "totally-new", channel: "preview", token: "secret" });
    expect(elements.settingsStatus.textContent).toBe("Account status unavailable");
    expect(normalizeDesktopAccountState({ status: "totally-new", channel: "preview" })).toEqual({
      status: "error",
      channel: "preview",
      reason: "authentication-failed",
    });
  });

  it("starts sign-in directly from the sidebar-footer control and opens settings only for an existing account", async () => {
    const { controller, elements, openSettings, api, changed } = fixture();
    await controller.start();

    expect(elements.accountButton.getAttribute("title")).toBe("Sign in");
    expect(elements.accountButton.getAttribute("aria-label")).toBe("Sign in to Relayer.");
    elements.accountButton.onclick();
    expect(api.login).toHaveBeenCalledOnce();
    expect(openSettings).not.toHaveBeenCalled();

    changed({ status: "signing-in", channel: "stable" });
    expect(elements.settingsStatus.textContent).toBe("Finish signing in in your browser");

    changed({ status: "signed-in", channel: "stable", subject: "auth0|123" });
    expect(elements.accountButton.getAttribute("title")).toBe("Account");
    elements.accountButton.onclick();
    expect(openSettings).toHaveBeenCalledOnce();

    elements.settingsLogout.onclick();
    expect(api.logout).toHaveBeenCalledOnce();
  });

  it("coalesces rapid sign-in actions into one browser flow", async () => {
    const { controller, elements, api } = fixture();
    let resolveLogin;
    api.login.mockImplementationOnce(() => new Promise((resolve) => { resolveLogin = resolve; }));
    await controller.start();

    elements.accountButton.onclick();
    elements.accountButton.onclick();
    elements.onboardingSignIn.onclick();
    elements.settingsSignIn.onclick();

    expect(api.login).toHaveBeenCalledOnce();
    expect(elements.accountLabel.textContent).toBe("Signing in…");
    expect(elements.accountButton.disabled).toBe(true);
    expect(elements.onboardingSignIn.disabled).toBe(true);
    expect(elements.settingsSignIn.disabled).toBe(true);

    resolveLogin({ status: "signing-in", channel: "stable" });
    await vi.waitFor(() => expect(elements.settingsStatus.textContent).toBe("Finish signing in in your browser"));
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
    expect(elements.onboarding.classList.contains("hidden")).toBe(false);
    expect(showWorkspace).not.toHaveBeenCalled();
    elements.onboardingNotNow.onclick();
    expect(showWorkspace).toHaveBeenCalledOnce();
  });

  it("preserves the optional startup gate when the post-provider account refresh fails", async () => {
    const { controller, elements, api, showWorkspace } = fixture();
    await controller.start();
    api.read.mockRejectedValueOnce(new Error("private refresh failure"));

    await controller.refresh({ offerOnboarding: true });

    expect(elements.onboarding.classList.contains("hidden")).toBe(false);
    expect(showWorkspace).not.toHaveBeenCalled();
    elements.onboardingNotNow.onclick();
    expect(showWorkspace).toHaveBeenCalledOnce();
  });

  it("continues into the workspace when onboarding preference storage is unavailable", async () => {
    const { controller, elements, storage, showWorkspace } = fixture();
    await controller.start({ offerOnboarding: true });
    storage.setItem.mockImplementationOnce(() => { throw new Error("storage unavailable"); });

    expect(() => elements.onboardingNotNow.onclick()).not.toThrow();
    expect(elements.onboarding.classList.contains("hidden")).toBe(true);
    expect(showWorkspace).toHaveBeenCalledOnce();
  });

  it("uses a full onboarding surface and seats the account control in the sidebar footer", async () => {
    const [html, css] = await Promise.all([
      readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8"),
      readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8"),
    ]);
    const sidebarFooter = html.slice(html.indexOf('<div class="sidebar-footer">'), html.indexOf("</aside>"));

    expect(html).toContain('<section class="desktop-account-onboarding hidden" id="desktopAccountOnboarding"');
    expect(html).not.toContain('<dialog class="desktop-account-onboarding"');
    expect(html).toContain('id="desktopAccountOnboardingNotNow">Continue without an account</button>');
    expect(sidebarFooter).toContain('id="desktopAccountButton"');
    expect(sidebarFooter).toContain('class="footer-button account-footer-button hidden"');
    expect(html).not.toContain("desktop-account-corner-control");
    const accountPanel = html.slice(html.indexOf('id="accountSettingsPanel"'), html.indexOf('id="providerSettingsPanel"'));
    expect(accountPanel).toContain('id="desktopAccountStatus"');
    expect(accountPanel).toContain('id="desktopAccountSignIn"');
    expect(accountPanel).toContain('id="desktopAccountLogout"');
    expect(accountPanel).not.toContain("account-settings-intro");
    expect(accountPanel).not.toContain("desktopAccountDetail");
    expect(accountPanel).not.toContain("desktopAccountChannel");
    expect(accountPanel).not.toContain("Release channel");
    expect(css).toContain(".desktop-account-onboarding{position:fixed;inset:0;");
    // Nothing floats over the workspace any more, and the control keeps its
    // glyph when the sidebar collapses to icons.
    expect(css).not.toContain("desktop-account-corner-control");
    // A drawn person mark in the sidebar's stroked-SVG idiom, not a glyph.
    expect(css).toContain(".account-footer-button svg{width:16px;height:16px");
    expect(css).toContain("stroke:currentColor");
    expect(css).not.toContain("account-footer-button:before");
    // The label collapses through the rule every other footer control uses,
    // leaving the mark visible on the icon-only rail.
    expect(sidebarFooter).toContain('<span id="desktopAccountLabel">Sign in</span>');
    expect(sidebarFooter).toContain("<svg viewBox=\"0 0 20 20\"");
    expect(css).toContain("body.sidebar-collapsed .footer-button span");
    // Two controls do not fit the 58px collapsed rail side by side.
    expect(css).toContain("body.sidebar-collapsed .sidebar-footer{flex-direction:column");
    // Nor do Settings, Account and the update indicator fit the 210px rail the
    // 980px breakpoint switches to, so the footer drops its labels there and
    // the circular indicator keeps its diameter instead of being squashed.
    expect(css).toContain("@media(max-width:980px){.sidebar-footer .footer-button span:not([aria-hidden]){display:none}");
    expect(css).toContain(".update-button{margin-left:auto;flex:none");
    // A busy label must not wrap inside a 34px control.
    expect(css).toContain("white-space:nowrap;overflow:hidden;text-overflow:ellipsis");
    // Hiding the label must never take the decorative glyph with it, and the
    // footer controls keep a name once their label is gone.
    expect(css).toContain("body.sidebar-collapsed .footer-button span:not([aria-hidden])");
    expect(sidebarFooter).toContain('id="settingsButton" type="button" title="Settings" aria-label="Settings"');
    expect(sidebarFooter).toContain('<span aria-hidden="true">⚙</span>');
    expect(sidebarFooter).toContain('id="updateButton" type="button" title="Application update available" aria-label="Application update available"');
  });
});
