import { describe, expect, it, vi } from "vitest";

import { registerDesktopIpc } from "../desktop/main/ipc/register-ipc.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";

function fixture(validateProviderOnboarding, savedSettings = { appearance: "dark" }) {
  const handlers = new Map();
  const writes = [];
  registerDesktopIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: vi.fn() },
    shell: { openExternal: vi.fn() },
    nativeTheme: {},
    credentials: { account: vi.fn(), login: vi.fn(), logout: vi.fn() },
    modelCatalog: { settingsOpened: vi.fn(), explicitRefresh: vi.fn() },
    providerDefinitions: {
      adapters: () => [], list: async () => [],
      logout: vi.fn(async () => ({ status: "disconnected" })),
      reconnect: vi.fn(async (id) => ({
        status: "pending", connectionId: id, providerDefinition: { id },
        login: { authUrl: "https://login.example.test" },
      })),
    },
    validateProviderOnboarding,
    settings: {
      read: async () => savedSettings,
      write: async (value) => writes.push(value),
    },
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
    writes,
  };
}

describe("provider onboarding IPC hard gate", () => {
  it("rejects a forged completion when current product defaults do not resolve", async () => {
    const { complete, writes } = fixture(async () => false);
    await expect(complete()).rejects.toThrow("working provider and default model family");
    expect(writes).toEqual([]);
  });

  it("persists completion only after authoritative product validation", async () => {
    const validate = vi.fn(async () => true);
    const { complete, writes } = fixture(validate);
    await expect(complete()).resolves.toEqual({ hasCompletedOnboarding: true });
    expect(validate).toHaveBeenCalledOnce();
    expect(writes).toEqual([{ appearance: "dark", providerOnboardingComplete: true }]);
  });

  it("routes logout by exact provider definition through the generic IPC", async () => {
    const { logout } = fixture(async () => false);
    await expect(logout(null, { id: "claude-work" })).resolves.toEqual({ status: "disconnected" });
  });

  it("routes reconnect through the same definition identity and opens its managed login", async () => {
    const { reconnect } = fixture(async () => false);
    await expect(reconnect(null, { id: "claude-work" })).resolves.toMatchObject({
      status: "pending", connectionId: "claude-work", providerDefinition: { id: "claude-work" },
    });
  });

  it("migrates an existing already-valid Codex user without showing first-run setup", async () => {
    const validate = vi.fn(async () => true);
    const { status, writes } = fixture(validate, { appearance: "dark" });
    await expect(status()).resolves.toMatchObject({ hasCompletedOnboarding: true });
    expect(validate).toHaveBeenCalledOnce();
    expect(writes).toEqual([{ appearance: "dark", providerOnboardingComplete: true }]);
  });

  it("does not migrate an existing user whose defaults no longer resolve", async () => {
    const { status, writes } = fixture(async () => false, { appearance: "dark" });
    await expect(status()).resolves.toMatchObject({ hasCompletedOnboarding: false });
    expect(writes).toEqual([]);
  });

  it("treats an authoritative incomplete saved-default status as an incomplete first run", async () => {
    const service = new RelayerAppServerService({
      userDataDirectory: "/tmp/unused", binaryPath: "/tmp/unused", webDirectory: "/tmp/unused",
      permissionCatalogPath: "/tmp/unused",
    });
    service.start = async () => ({ origin: "http://127.0.0.1:43123", cookie: { name: "relayer_control", value: "token" } });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      complete: false,
      defaults: { providerId: "codex", harnessId: "codex-basic", familyId: null },
      blockingReason: { code: "default_family_required", message: "Choose a family." },
    }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await expect(service.validateProviderOnboarding()).resolves.toBe(false);
    expect(fetch.mock.calls[0][0].pathname).toBe("/api/provider-onboarding/status");
    expect(fetch.mock.calls[0][0].search).toBe("");
    expect(fetch.mock.calls[0][1]).toMatchObject({
      headers: { Cookie: "relayer_control=token" },
    });
    fetch.mockRestore();
  });

  it("accepts saved alternate-harness defaults after restart without consulting the boot harness", async () => {
    const service = new RelayerAppServerService({
      userDataDirectory: "/tmp/unused", binaryPath: "/tmp/unused", webDirectory: "/tmp/unused",
      permissionCatalogPath: "/tmp/unused", defaultHarnessConfiguration: "packaged-default",
    });
    service.start = async () => ({ origin: "http://127.0.0.1:43123", cookie: { name: "relayer_control", value: "token" } });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      complete: true,
      defaults: { providerId: "anthropic-work", harnessId: "claude-basic", familyId: 12 },
      resolution: { familyId: 12, familyRevision: 3, resolvableMembers: [{ providerId: "anthropic-work", modelId: "claude-sonnet", position: 0 }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(service.validateProviderOnboarding()).resolves.toBe(true);
    expect(fetch.mock.calls[0][0].pathname).toBe("/api/provider-onboarding/status");
    expect(fetch.mock.calls[0][0].searchParams.has("harnessId")).toBe(false);
    fetch.mockRestore();
  });

  it("loads authoritative provider connection and revocation state", async () => {
    const service = new RelayerAppServerService({
      userDataDirectory: "/tmp/unused", binaryPath: "/tmp/unused", webDirectory: "/tmp/unused",
      permissionCatalogPath: "/tmp/unused",
    });
    service.start = async () => ({ origin: "http://127.0.0.1:43123", cookie: { name: "relayer_control", value: "token" } });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      providers: [{
        id: "work-api", connected: false,
        unavailableReason: { code: "credentials_revoked", message: "Reconnect this provider." },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(service.providerStatuses()).resolves.toEqual(new Map([["work-api", {
      connected: false,
      unavailableReason: { code: "credentials_revoked", message: "Reconnect this provider." },
    }]]));
    expect(fetch).toHaveBeenCalledWith(new URL("http://127.0.0.1:43123/api/model-settings"), {
      headers: { Cookie: "relayer_control=token" }, signal: undefined,
    });
    fetch.mockRestore();
  });
});
