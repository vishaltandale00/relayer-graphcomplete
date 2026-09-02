import { describe, expect, it, vi } from "vitest";

import { registerDesktopIpc } from "../desktop/main/ipc/register-ipc.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";

function fixture(validateProviderOnboarding, savedSettings = { appearance: "dark" }) {
  const handlers = new Map();
  const writes = [];
  let currentSettings = structuredClone(savedSettings);
  const modelCatalog = { settingsOpened: vi.fn(), explicitRefresh: vi.fn() };
  const settings = {
    read: async () => structuredClone(currentSettings),
    write: async (value) => {
      currentSettings = structuredClone(value);
      writes.push(structuredClone(value));
      return structuredClone(currentSettings);
    },
    update: async (mutate) => {
      currentSettings = await mutate(structuredClone(currentSettings));
      writes.push(structuredClone(currentSettings));
      return structuredClone(currentSettings);
    },
  };
  registerDesktopIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: vi.fn() },
    shell: { openExternal: vi.fn() },
    nativeTheme: {},
    credentials: { account: vi.fn(), login: vi.fn(), logout: vi.fn() },
    modelCatalog,
    providerDefinitions: {
      adapters: () => [], list: async () => [],
      logout: vi.fn(async () => ({ status: "disconnected" })),
      reconnect: vi.fn(async (id) => ({
        status: "pending", connectionId: id, providerDefinition: { id },
        login: { authUrl: "https://login.example.test" },
      })),
    },
    validateProviderOnboarding,
    settings,
    updater: { status: () => ({ phase: "idle" }), check: vi.fn(), download: vi.fn(), install: vi.fn(), setChannel: vi.fn() },
    getWindow: () => null,
    getAppearance: () => "dark",
    setAppearance: vi.fn(),
  });
  return {
    complete: handlers.get("relayer:provider-onboarding-complete"),
    status: handlers.get("relayer:provider-status"),
    logout: handlers.get("relayer:provider-logout"),
    reconnect: handlers.get("relayer:provider-reconnect"),
    refreshModels: handlers.get("relayer:model-catalog-refresh"),
    modelCatalog,
    settings,
    readSettings: () => structuredClone(currentSettings),
    writes,
  };
}

describe("provider onboarding IPC hard gate", () => {
  it("hard-gates completion and migration on authoritative product validation", async () => {
    const forged = fixture(async () => false);
    await expect(forged.complete(), "a forged completion without resolving defaults rejects")
      .rejects.toThrow("working default provider, family, and harness");
    expect(forged.writes, "a forged completion persists nothing").toEqual([]);

    const validate = vi.fn(async () => true);
    const valid = fixture(validate);
    await expect(valid.complete(), "a validated completion resolves").resolves.toEqual({ hasCompletedOnboarding: true });
    expect(validate, "completion consults the authoritative validator exactly once").toHaveBeenCalledOnce();
    expect(valid.writes, "completion persists only after validation").toEqual([
      { appearance: "dark", providerOnboardingComplete: true },
    ]);

    const migrateValidate = vi.fn(async () => true);
    const migrating = fixture(migrateValidate, { appearance: "dark" });
    await expect(migrating.status(), "an already-valid Codex user migrates without first-run setup")
      .resolves.toMatchObject({ hasCompletedOnboarding: true });
    expect(migrateValidate, "migration consults the validator exactly once").toHaveBeenCalledOnce();
    expect(migrating.writes, "migration persists the completion flag").toEqual([
      { appearance: "dark", providerOnboardingComplete: true },
    ]);

    let finishValidation;
    const pendingValidate = vi.fn(() => new Promise((resolve) => { finishValidation = resolve; }));
    const pending = fixture(pendingValidate, { appearance: "dark" });
    const pendingStatus = pending.status();
    await vi.waitFor(() => expect(pendingValidate).toHaveBeenCalledOnce());
    await pending.settings.update((current) => ({
      ...current,
      composerDrafts: { pendingNewThread: { text: "Keep me", scope: null }, threadFollowups: {} },
    }));
    finishValidation(true);
    await expect(pendingStatus, "pending validation still completes").resolves.toMatchObject({ hasCompletedOnboarding: true });
    expect(pending.readSettings(), "composer drafts written during validation survive migration").toMatchObject({
      providerOnboardingComplete: true,
      composerDrafts: { pendingNewThread: { text: "Keep me", scope: null } },
    });

    const blocked = fixture(async () => false, { appearance: "dark" });
    await expect(blocked.status(), "unresolvable defaults never migrate an existing user")
      .resolves.toMatchObject({ hasCompletedOnboarding: false });
    expect(blocked.writes, "a blocked migration persists nothing").toEqual([]);
  });

  it("routes provider actions by exact definition identity through the generic IPC", async () => {
    const routed = fixture(async () => false);
    await expect(routed.logout(null, { id: "claude-work" }), "logout targets the exact definition")
      .resolves.toEqual({ status: "disconnected" });
    await expect(routed.reconnect(null, { id: "claude-work" }), "reconnect keeps the same definition identity")
      .resolves.toMatchObject({
        status: "pending", connectionId: "claude-work", providerDefinition: { id: "claude-work" },
      });
    await routed.refreshModels(null, "openai-work");
    expect(routed.modelCatalog.explicitRefresh, "model-family recovery refreshes the exact provider")
      .toHaveBeenCalledWith("openai-work");
  });

  it("reads authoritative onboarding and provider state through the app server seam", async () => {
    function serverFixture(defaultHarnessConfiguration) {
      const service = new RelayerAppServerService({
        userDataDirectory: "/tmp/unused", binaryPath: "/tmp/unused", webDirectory: "/tmp/unused",
        permissionCatalogPath: "/tmp/unused", defaultHarnessConfiguration,
      });
      service.start = async () => ({ origin: "http://127.0.0.1:43123", cookie: { name: "relayer_control", value: "token" } });
      return service;
    }

    const incomplete = serverFixture(undefined);
    const incompleteFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      complete: false,
      defaults: { providerId: "codex", harnessId: "codex-basic", familyId: null },
      blockingReason: { code: "default_family_required", message: "Choose a family." },
    }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await expect(incomplete.validateProviderOnboarding(),
      "an incomplete saved-default status is an incomplete first run").resolves.toBe(false);
    expect(incompleteFetch.mock.calls[0][0].pathname, "onboarding status uses the exact endpoint")
      .toBe("/api/provider-onboarding/status");
    expect(incompleteFetch.mock.calls[0][0].search, "onboarding status carries no query").toBe("");
    expect(incompleteFetch.mock.calls[0][1], "onboarding status authenticates with the control cookie")
      .toMatchObject({ headers: { Cookie: "relayer_control=token" } });
    incompleteFetch.mockRestore();

    const alternate = serverFixture("packaged-default");
    const alternateFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      complete: true,
      defaults: { providerId: "anthropic-work", harnessId: "claude-basic", familyId: 12 },
      resolution: { familyId: 12, familyRevision: 3, resolvableMembers: [{ providerId: "anthropic-work", modelId: "claude-sonnet", position: 0 }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(alternate.validateProviderOnboarding(),
      "saved alternate-harness defaults stay valid after restart").resolves.toBe(true);
    expect(alternateFetch.mock.calls[0][0].searchParams.has("harnessId"),
      "alternate-harness validation never consults the boot harness").toBe(false);
    alternateFetch.mockRestore();

    const statuses = serverFixture(undefined);
    const statusFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      providers: [{
        id: "work-api", connected: false,
        unavailableReason: { code: "credentials_revoked", message: "Reconnect this provider." },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(statuses.providerStatuses(), "provider connection and revocation state loads authoritatively")
      .resolves.toEqual(new Map([["work-api", {
        connected: false,
        unavailableReason: { code: "credentials_revoked", message: "Reconnect this provider." },
      }]]));
    expect(statusFetch, "provider statuses come from the model-settings endpoint").toHaveBeenCalledWith(
      new URL("http://127.0.0.1:43123/api/model-settings"),
      { headers: { Cookie: "relayer_control=token" }, signal: undefined },
    );
    statusFetch.mockRestore();
  });
});
