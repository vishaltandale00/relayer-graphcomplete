import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvalProviderSetup } from "../desktop/eval-main/provider-setup.mjs";
import { createProviderAdapterRegistry } from "../desktop/main/providers/provider-adapter-contract.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup({ managed = false, failing = false, credentialStore, now, accountStatus = "connected", closeFails = false, scheduleTimeout, cancelTimeout, updatesDue = [], modelRules = { allow: [], deny: [] } } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "eval-provider-setup-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let stored = [];
  let busy = false;
  const snapshots = new Map();
  const dependencies = [];
  const adapterId = managed ? "codex-subscription" : "openrouter";
  const selection = { harnessId: "codex-basic", familyId: 1, providerId: "chosen", modelId: "gpt-test" };
  const registry = createProviderAdapterRegistry([{
    adapterId, implementationVersion: "1", label: "Test provider",
    accessContract: managed ? "managed-runtime@1" : "secret@1",
    // As the production API adapters declare: removal deletes their private home.
    ...(managed ? {} : { definitionRuntimeState: true }),
    defaultEndpoint: managed ? null : "https://provider.example/v1",
    connection: managed ? { mode: "managed-login" } : { mode: "secret-fields", fields: [{ id: "api-key", label: "Key", kind: "secret" }] },
    create: ({ definition, ...deps }) => {
      dependencies.push(deps);
      const discover = async () => {
        if (failing) throw new Error(`Provider echoed ${deps.secrets?.["api-key"]}`);
        return { provider: { id: definition.id, label: definition.label, status: "available" },
          systemFamily: { id: definition.id, label: definition.label, modelIds: ["gpt-test"] },
          models: [{ id: "gpt-test", executionModel: "gpt-test", label: "Test", availability: "available", visible: true, description: "", unavailableReason: null, availabilityNotice: null, isDefault: true, replacementModelId: null, upgradeInfo: null, supportedEfforts: [], defaultEffort: null, inputModalities: ["text"], supportsPersonality: false, serviceTiers: [], defaultServiceTier: null }],
        };
      };
      return { providerId: definition.id, discover,
        credentials: { login: async () => ({ authUrl: "https://provider.example/login" }), account: async () => ({ status: accountStatus }), logout: async () => ({ status: "disconnected" }) },
        executionAccess: async () => managed
          ? ({ kind: "managed-runtime", runtimeId: "codex", environment: deps.environment })
          : ({ kind: "secret", value: deps.secrets?.["api-key"] }),
        close: async () => { if (closeFails) throw new Error("native cancellation failed"); },
      };
    },
  }]);
  const runtimeResolver = { get: vi.fn(async () => ({ runtimeId: "codex", version: "0.147.0", executable: "/managed/codex" })), prepare: vi.fn(async () => ({ runtimeId: "codex", version: "0.147.0", executable: "/managed/codex" })), validate: vi.fn(async () => ({ runtimeId: "codex" })) };
  const due = new Set(updatesDue);
  const publishHarnessReadiness = vi.fn(async (updates) => { for (const { harnessId } of updates) due.delete(harnessId); });
  const fetchImpl = vi.fn(async (url, options) => {
    expect(options.headers.Cookie).toBe("control=private");
    if (url.pathname === "/api/model-settings") return Response.json({ defaults: { providerId: "chosen" } });
    if (url.pathname === "/api/model-selection/default") return Response.json(selection);
    if (url.pathname === "/api/model-selection/validate") {
      expect(JSON.parse(options.body)).toEqual(selection);
      return Response.json(selection);
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  const service = createEvalProviderSetup({ userDataDirectory: directory,
    registry, runtimeResolver, credentialStore, now, scheduleTimeout, cancelTimeout, isBusy: () => busy, fetchImpl,
    environment: { HOME: "/test-home", API_KEY: "ambient-secret" },
    productSession: { origin: "http://127.0.0.1:1234", cookie: { name: "control", value: "private" } },
    productServer: {
      providerDefinitionStore: () => ({ load: async () => structuredClone(stored), save: async (value) => { stored = structuredClone(value); } }),
      publishProviderCatalog: async (value) => { snapshots.set(value.providerId, value); },
      providerStatuses: async () => snapshots,
      publishHarnessReadiness,
      harnessReadinessUpdatesDue: async () => [...due],
    },
    runtimeSession: { configurations: new Map([["codex-basic", { name: "codex-basic", implementation: "codex.basic", executionAccessContracts: [managed ? "managed-runtime@1" : "secret@1"], modelRules }]]), digestConfiguration: () => "digest" },
  });
  cleanups.push(() => service.close());
  return { service, directory, snapshots, dependencies, runtimeResolver, fetchImpl, publishHarnessReadiness, due,
    setBusy: (value) => { busy = value; }, seed: (definitions) => { stored = structuredClone(definitions); }, stored: () => stored,
    connect: () => service.connect({ connectionId: "chosen", adapterId, label: "Chosen", fields: { "api-key": "private-key" } }),
  };
}

describe("Eval production provider setup", () => {
  it("retains API credentials only in the execution lease while exposing safe persisted definitions and validated defaults", async () => {
    const fixture = await setup();
    await fixture.service.start();
    await fixture.connect();
    const status = await fixture.service.status();
    expect(status.secretsPersisted).toBe(false);
    expect(status.adapters[0].adapterId).toBe("openrouter");
    expect(JSON.stringify(status)).not.toContain("private-key");
    expect(JSON.stringify(fixture.stored())).not.toContain("private-key");
    // An API-key provider gets its private Codex home in the Eval profile, as in Relayer
    // Desktop, so a new codex.basic conversation on it can run (PRD AGT-013).
    const home = join(fixture.directory, "provider-runtime", "chosen", "codex-home");
    expect(fixture.dependencies.at(-1).environment).toEqual({ CODEX_HOME: home });
    await expect(access(home)).resolves.toBeUndefined();
    const lease = await fixture.service.acquireExecution("chosen");
    expect(await lease.runtime.executionAccess()).toEqual({ kind: "secret", value: "private-key" });
    await lease.release();
    expect(await fixture.service.select("codex-basic")).toMatchObject({ providerId: "chosen", modelId: "gpt-test" });
    fixture.setBusy(true);
    await expect(fixture.service.remove("chosen")).rejects.toThrow("Finish active Eval work");
    fixture.setBusy(false);
    await fixture.service.remove("chosen");
    await expect(fixture.service.acquireExecution("chosen")).rejects.toThrow("unavailable");
    await expect(access(join(fixture.directory, "provider-runtime", "chosen"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prepares native login explicitly and scopes its native credential home to the Eval definition", async () => {
    const fixture = await setup({ managed: true });
    await fixture.service.start();
    expect(fixture.runtimeResolver.prepare).not.toHaveBeenCalled();
    const login = await fixture.connect();
    expect(login.login.authUrl).toBe("https://provider.example/login");
    expect(fixture.runtimeResolver.prepare).toHaveBeenCalledWith("codex@0.147.0");
    const home = join(fixture.directory, "provider-runtime", "chosen", "codex-home");
    expect(fixture.dependencies[0].environment.CODEX_HOME).toBe(home);
    expect(fixture.dependencies[0].environment.API_KEY).toBeUndefined();
    expect(await readFile(join(home, "config.toml"), "utf8")).toContain('cli_auth_credentials_store = "file"');
    await fixture.service.completeConnection("chosen");
    const lease = await fixture.service.acquireExecution("chosen");
    await expect(fixture.service.logout("chosen")).rejects.toThrow("Provider setup failed");
    await lease.release();
    await fixture.service.logout("chosen");
    expect((await fixture.service.status()).definitions[0].connected).toBe(false);
  });

  it.each([
    ['cli_auth_credentials_store = "keyring"\n', false],
    ['# cli_auth_credentials_store = "file"\n', false],
    ['description = """\ncli_auth_credentials_store = "file"\n"""\n', false],
    ['', false],
    ['cli_auth_credentials_store = "file"\n', true],
  ])("validates existing Codex file auth before startup or reconnect: %s", async (config, safe) => {
    const fixture = await setup({ managed: true });
    fixture.seed([{ id: "codex", adapterId: "codex-subscription", label: "Codex", accessContract: "managed-runtime@1", endpoint: null, credentialReference: null, lifecycleState: "active", removedAt: null }]);
    const home = join(fixture.directory, "codex-home");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.toml"), config);
    await fixture.service.start();
    if (safe) {
      expect(fixture.dependencies).toHaveLength(1);
      expect(await fixture.service.reconnect("codex")).toMatchObject({ status: "pending" });
    } else {
      await expect(fixture.service.reconnect("codex")).rejects.toThrow("Existing configuration was preserved");
      expect(fixture.dependencies).toHaveLength(0);
    }
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(config);
  });

  // PR #576 review: an Eval profile that records a changed runtime recipe gets the same
  // one post-upgrade evaluation as Desktop, before Eval resolves its default selections.
  it("evaluates a route the app server marked due at startup, once", async () => {
    const fixture = await setup({
      managed: true, updatesDue: ["codex-basic"],
      modelRules: { allow: [{ adapterId: "codex-subscription", modelIdRegex: ".*" }], deny: [] },
    });
    fixture.seed([{ id: "codex", adapterId: "codex-subscription", label: "Codex", accessContract: "managed-runtime@1", endpoint: null, credentialReference: null, lifecycleState: "active", removedAt: null }]);
    await fixture.service.start();
    expect(fixture.publishHarnessReadiness).toHaveBeenCalledOnce();
    expect(fixture.publishHarnessReadiness).toHaveBeenCalledWith([expect.objectContaining({
      harnessId: "codex-basic", available: true,
    })]);
    expect(fixture.due.size).toBe(0);
  });

  it("does not reflect arbitrary provider errors into the browser", async () => {
    const fixture = await setup({ failing: true });
    await fixture.service.start();
    await expect(fixture.connect()).rejects.toThrow("Provider setup failed. Check the connection details and try again.");
    expect(fixture.stored()).toEqual([]);
  });

  it("bounds native pending or rejected sign-in and releases the connection name for retry", async () => {
    let time = 0;
    const fixture = await setup({ managed: true, now: () => time, accountStatus: "disconnected" });
    await fixture.service.start();
    await fixture.connect();
    expect(await fixture.service.completeConnection("chosen")).toMatchObject({ status: "pending" });
    time = 10 * 60_000;
    await expect(fixture.service.completeConnection("chosen")).rejects.toThrow("Provider sign-in expired");
    expect(fixture.stored()).toEqual([]);
    expect(await fixture.connect()).toMatchObject({ status: "pending" });
    expect(await fixture.service.cancelConnection("chosen")).toBe(true);
    expect(await fixture.connect()).toMatchObject({ status: "pending" });
  });

  it("expires abandoned browser sign-in without another poll and clears cancelled timers", async () => {
    const scheduled = [];
    const cancelTimeout = vi.fn();
    const fixture = await setup({ managed: true, accountStatus: "disconnected",
      scheduleTimeout: (callback, delay) => { const handle = { callback, delay, unref: vi.fn() }; scheduled.push(handle); return handle; }, cancelTimeout,
    });
    await fixture.service.start();
    await fixture.connect();
    expect(scheduled[0].delay).toBe(10 * 60_000);
    fixture.setBusy(true);
    await scheduled[0].callback();
    fixture.setBusy(false);
    await expect(fixture.service.completeConnection("chosen")).rejects.toThrow("Provider sign-in expired");
    expect(await fixture.connect()).toMatchObject({ status: "pending" });
    await fixture.service.cancelConnection("chosen");
    expect(cancelTimeout).toHaveBeenCalledWith(scheduled[1]);
    expect(fixture.stored()).toEqual([]);
  });

  it("releases a cancelled login even when native process cleanup fails", async () => {
    const fixture = await setup({ managed: true, accountStatus: "disconnected", closeFails: true });
    await fixture.service.start();
    await fixture.connect();
    expect(await fixture.service.cancelConnection("chosen")).toBe(true);
    expect(await fixture.connect()).toMatchObject({ status: "pending" });
    expect(fixture.stored()).toEqual([]);
  });

  it("shows only allowlisted credential storage guidance while keeping store details private", async () => {
    const fixture = await setup({ credentialStore: {
      listReferences: async () => [], get: async () => null, delete: async () => false,
      set: async () => { throw Object.assign(new Error("private backend detail"), { code: "EVAL_CREDENTIAL_UNSUPPORTED" }); },
    } });
    await fixture.service.start();
    await expect(fixture.connect()).rejects.toThrow("Persistent Eval API credentials currently require macOS Keychain");
    expect(fixture.stored()).toEqual([]);
  });

  it("resolves judges through connected subscription authority without preparing runtimes on settings reads", async () => {
    const fixture = await setup({ managed: true });
    await fixture.service.start();
    await fixture.connect();
    await fixture.service.completeConnection("chosen");
    fixture.runtimeResolver.prepare.mockClear();
    await fixture.service.settingsOpened();
    expect(fixture.runtimeResolver.prepare).not.toHaveBeenCalled();
    await fixture.service.refresh(null);
    expect(fixture.runtimeResolver.prepare).toHaveBeenCalledWith("codex@0.147.0");
    const judge = await fixture.service.resolveCodexJudgeRuntime();
    expect(judge.environment.CODEX_HOME).toBe(join(fixture.directory, "provider-runtime", "chosen", "codex-home"));
    expect(judge.environment.API_KEY).toBeUndefined();
    await fixture.service.logout("chosen");
    await expect(fixture.service.resolveCodexJudgeRuntime()).rejects.toThrow("Choose a connected Codex subscription");
  });
});
