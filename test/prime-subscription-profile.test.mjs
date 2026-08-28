import { describe, expect, it, vi } from "vitest";

import { createPrimeSubscriptionProfile } from "../desktop/main/providers/prime-subscription-profile.mjs";

describe("Prime subscription profile", () => {
  it("namespaces OAuth credentials by exact provider definition and refreshes without another login", async () => {
    const entries = new Map();
    const credentialStore = {
      get: vi.fn(async (key) => entries.get(key) ?? null),
      set: vi.fn(async (key, value) => { entries.set(key, structuredClone(value)); }),
      delete: vi.fn(async (key) => entries.delete(key)),
    };
    class FakeAuthStorage {
      static inMemory(data = {}) { return new FakeAuthStorage(data); }
      constructor(data) { this.data = structuredClone(data); }
      async login(providerId, callbacks) {
        callbacks.onAuth({ url: `https://login.test/${providerId}` });
        this.data[providerId] = {
          type: "oauth", access: `access-${providerId}`, refresh: `refresh-${providerId}`, expires: 10,
        };
      }
      get(providerId) { return this.data[providerId]; }
      async getApiKey(providerId) {
        const current = this.data[providerId];
        this.data[providerId] = { ...current, access: `${current.access}-refreshed`, expires: 20 };
        return this.data[providerId].access;
      }
    }
    const profile = createPrimeSubscriptionProfile({
      credentialStore,
      loadPrimeModule: async () => ({ AuthStorage: FakeAuthStorage }),
    });

    const work = await profile.login({ id: "claude-work", adapterId: "claude-subscription" });
    const personal = await profile.login({ id: "claude-personal", adapterId: "claude-subscription" });
    expect(work.authUrl).toBe("https://login.test/anthropic");
    expect(personal.authUrl).toBe("https://login.test/anthropic");
    await expect(profile.account("claude-work")).resolves.toMatchObject({ status: "connected" });
    await expect(profile.account("claude-personal")).resolves.toMatchObject({ status: "connected" });

    await expect(profile.nativeRequestAccess("claude-work", "claude-subscription")).resolves.toEqual({
      kind: "secret", contract: "secret@1", apiKey: "access-anthropic-refreshed",
    });
    expect(entries.get("prime-subscription:claude-work").credential.access)
      .toBe("access-anthropic-refreshed");
    expect(entries.get("prime-subscription:claude-personal").credential.access)
      .toBe("access-anthropic");
    expect(JSON.stringify(await profile.account("claude-work"))).not.toContain("access-");
    expect(JSON.stringify(await profile.account("claude-work"))).not.toContain("refresh-");
  });

  it("disconnects only the named provider definition", async () => {
    const entries = new Map([
      ["prime-subscription:claude-work", { adapterId: "claude-subscription", provider: "anthropic", credential: { type: "oauth", access: "one", refresh: "r1", expires: 1 } }],
      ["prime-subscription:claude-personal", { adapterId: "claude-subscription", provider: "anthropic", credential: { type: "oauth", access: "two", refresh: "r2", expires: 1 } }],
    ]);
    const profile = createPrimeSubscriptionProfile({
      credentialStore: {
        get: async (key) => entries.get(key) ?? null,
        set: async (key, value) => { entries.set(key, value); },
        delete: async (key) => entries.delete(key),
      },
      loadPrimeModule: async () => ({ AuthStorage: class {} }),
    });

    await profile.logout("claude-work");

    await expect(profile.account("claude-work")).resolves.toEqual({ status: "disconnected", account: null });
    await expect(profile.account("claude-personal")).resolves.toMatchObject({ status: "connected" });
  });

  it("serializes refreshes per definition and persists each rotated credential", async () => {
    const entries = new Map([
      ["prime-subscription:claude-work", { adapterId: "claude-subscription", provider: "anthropic", credential: { type: "oauth", access: "access-0", refresh: "refresh-0", expires: 1 } }],
    ]);
    class FakeAuthStorage {
      static inMemory(data) { return new FakeAuthStorage(data); }
      constructor(data) { this.data = structuredClone(data); }
      get(provider) { return this.data[provider]; }
      async getApiKey(provider) {
        const current = this.data[provider];
        await Promise.resolve();
        const sequence = Number(current.access.split("-").at(-1)) + 1;
        this.data[provider] = { ...current, access: `access-${sequence}`, refresh: `refresh-${sequence}`, expires: sequence + 1 };
        return this.data[provider].access;
      }
    }
    const profile = createPrimeSubscriptionProfile({
      credentialStore: {
        get: async (key) => structuredClone(entries.get(key) ?? null),
        set: async (key, value) => { entries.set(key, structuredClone(value)); },
        delete: async (key) => entries.delete(key),
      },
      loadPrimeModule: async () => ({ AuthStorage: FakeAuthStorage }),
    });

    await expect(Promise.all([
      profile.nativeRequestAccess("claude-work", "claude-subscription"),
      profile.nativeRequestAccess("claude-work", "claude-subscription"),
    ])).resolves.toEqual([
      { kind: "secret", contract: "secret@1", apiKey: "access-1" },
      { kind: "secret", contract: "secret@1", apiKey: "access-2" },
    ]);
    expect(entries.get("prime-subscription:claude-work").credential.refresh).toBe("refresh-2");
  });

  it("does not restore credentials when disconnect wins a pending refresh", async () => {
    const entries = new Map([
      ["prime-subscription:claude-work", { adapterId: "claude-subscription", provider: "anthropic", credential: { type: "oauth", access: "access", refresh: "refresh", expires: 1 } }],
    ]);
    let finishRefresh;
    const refreshPaused = new Promise((resolve) => { finishRefresh = resolve; });
    let refreshStarted;
    const started = new Promise((resolve) => { refreshStarted = resolve; });
    class FakeAuthStorage {
      static inMemory(data) { return new FakeAuthStorage(data); }
      constructor(data) { this.data = structuredClone(data); }
      get(provider) { return this.data[provider]; }
      async getApiKey(provider) {
        refreshStarted();
        await refreshPaused;
        this.data[provider] = { ...this.data[provider], access: "late-access" };
        return "late-access";
      }
    }
    const profile = createPrimeSubscriptionProfile({
      credentialStore: {
        get: async (key) => structuredClone(entries.get(key) ?? null),
        set: async (key, value) => { entries.set(key, structuredClone(value)); },
        delete: async (key) => entries.delete(key),
      },
      loadPrimeModule: async () => ({ AuthStorage: FakeAuthStorage }),
    });

    const refresh = profile.nativeRequestAccess("claude-work", "claude-subscription");
    await started;
    await profile.logout("claude-work");
    finishRefresh();

    await expect(refresh).rejects.toThrow("connection is unavailable");
    expect(entries.has("prime-subscription:claude-work")).toBe(false);
  });

  it("repairs a corrupt derived entry through the existing reconnect login", async () => {
    const entries = new Map([["prime-subscription:claude-work", { broken: true }]]);
    class FakeAuthStorage {
      static inMemory(data = {}) { return new FakeAuthStorage(data); }
      constructor(data) { this.data = data; }
      async login(provider, callbacks) {
        callbacks.onAuth({ url: "https://login.test/repair" });
        this.data[provider] = { type: "oauth", access: "access", refresh: "refresh", expires: 10 };
      }
      get(provider) { return this.data[provider]; }
    }
    const profile = createPrimeSubscriptionProfile({
      credentialStore: {
        get: async (key) => entries.get(key) ?? null,
        set: async (key, value) => { entries.set(key, structuredClone(value)); },
        delete: async (key) => entries.delete(key),
      },
      loadPrimeModule: async () => ({ AuthStorage: FakeAuthStorage }),
    });

    await expect(profile.account("claude-work")).rejects.toThrow("credential is invalid");
    await expect(profile.login({ id: "claude-work", adapterId: "claude-subscription" }))
      .resolves.toMatchObject({ authUrl: "https://login.test/repair" });
    await expect(profile.account("claude-work")).resolves.toMatchObject({ status: "connected" });
  });
});
