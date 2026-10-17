import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvalProviderSetup } from "../desktop/eval-main/provider-setup.mjs";
import { createProviderAdapterRegistry } from "../desktop/main/providers/provider-adapter-contract.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup({ managed = false, openai = false, failing = false, credentialStore, now, accountStatus = "connected", closeFails = false, scheduleTimeout, cancelTimeout, updatesDue = [], inputModalities = ["text", "image"], modelRules = { allow: [], deny: [] }, defaultProviderId = "chosen" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "eval-provider-setup-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let stored = [];
  let busy = false;
  let discoverHook;
  const snapshots = new Map();
  const dependencies = [];
  const adapterId = managed ? "codex-subscription" : openai ? "openai-api" : "openrouter";
  const selection = { harnessId: "codex-basic", familyId: 1, providerId: "chosen", modelId: "gpt-test" };
  const registry = createProviderAdapterRegistry([{
    adapterId, implementationVersion: "1", label: "Test provider",
    accessContract: managed ? "managed-runtime@1" : "secret@1",
    defaultEndpoint: managed ? null : openai ? "https://api.openai.com/v1" : "https://provider.example/v1",
    connection: managed ? { mode: "managed-login" } : { mode: "secret-fields", fields: [{ id: "api-key", label: "Key", kind: "secret" }] },
    create: ({ definition, ...deps }) => {
      dependencies.push(deps);
      const discover = async (options) => {
        await discoverHook?.(options);
        if (failing) throw new Error(`Provider echoed ${deps.secrets?.["api-key"]}`);
        return { provider: { id: definition.id, label: definition.label, status: "available" },
          systemFamily: { id: definition.id, label: definition.label, modelIds: ["gpt-test"] },
          models: [{ id: "gpt-test", executionModel: "gpt-test", label: "Test", availability: "available", visible: true, description: "", unavailableReason: null, availabilityNotice: null, isDefault: true, replacementModelId: null, upgradeInfo: null, supportedEfforts: [{ id: "low", description: "Low" }], defaultEffort: null, inputModalities, supportsPersonality: false, serviceTiers: [], defaultServiceTier: null }],
        };
      };
      return { providerId: definition.id, discover,
        credentials: { login: async () => ({ authUrl: "https://provider.example/login" }), account: async () => ({ status: accountStatus }), logout: async () => ({ status: "disconnected" }) },
        executionAccess: async () => managed
          ? ({ kind: "managed-runtime", runtimeId: "codex", environment: deps.environment })
          : openai ? ({ kind: "secret", endpoint: definition.endpoint, fields: { "api-key": deps.secrets?.["api-key"] } }) : ({ kind: "secret", value: deps.secrets?.["api-key"] }),
        close: async () => { if (closeFails) throw new Error("native cancellation failed"); },
      };
    },
  }]);
  const runtimeResolver = { get: vi.fn(async () => ({ runtimeId: "codex", version: "0.159.3", executable: "/managed/codex" })), prepare: vi.fn(async () => ({ runtimeId: "codex", version: "0.159.3", executable: "/managed/codex" })), validate: vi.fn(async () => ({ runtimeId: "codex" })) };
  const due = new Set(updatesDue);
  const publishHarnessReadiness = vi.fn(async (updates) => { for (const { harnessId } of updates) due.delete(harnessId); });
  const fetchImpl = vi.fn(async (url, options) => {
    if (String(url).startsWith("https://api.openai.com/v1/")) {
      expect(options.headers.Authorization).toBe("Bearer private-key");
      expect(options.redirect).toBe("error");
      if (String(url).endsWith("/models/gpt-6-luna")) return Response.json({ id: "gpt-6-luna" });
      return Response.json({ model: "gpt-6-luna", answers: [{ type: "choice", name: "action", choice: "action-0", ignored: "private-key" }], usage: { input_tokens: 12, arbitrary: "private-key" } });
    }
    expect(options.headers.Cookie).toBe("control=private");
    if (url.pathname === "/api/model-settings") return Response.json({ defaults: { providerId: defaultProviderId } });
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
    setDiscoverHook: hook => { discoverHook = hook; },
    setBusy: (value) => { busy = value; }, seed: (definitions) => { stored = structuredClone(definitions); }, stored: () => stored,
    connect: () => service.connect({ connectionId: "chosen", adapterId, label: "Chosen", fields: { "api-key": "private-key" } }),
  };
}

describe("Eval production provider setup", () => {
  it.each(["openai-decisions-codex-text-v1", "openai-decisions-codex-text-v2"])("%s preflights both pinned actor routes and confines API credentials to the Decisions transport", async contractId => {
    const f = await setup({ openai: true });
    await f.connect();
    const native = { executable: "/managed/codex", environment: { CODEX_HOME: "/isolated" } };
    const text = vi.fn().mockResolvedValue(native);
    const service = { ...f.service, resolveCodexJudgeRuntime: text };
    const config = { model: "gpt-test", modelReasoningEffort: "low", decision: { contractId, providerId: "chosen", model: "gpt-6-luna" } };
    const runtime = await service.resolveTaskActorRuntime(config);
    expect(runtime.textRuntime).toBe(native);
    expect(text).toHaveBeenCalledWith(config, {});
    const result = await runtime.decide({ model: "gpt-6-luna", questions: [] });
    expect(result).toEqual({ answer: { type: "choice", name: "action", choice: "action-0" }, usage: { input_tokens: 12 } });
    expect(JSON.stringify({ config, runtime, result })).not.toContain("private-key");
    await expect(service.resolveTaskActorRuntime({ ...config, decision: { ...config.decision, providerId: "missing" } })).rejects.toMatchObject({ code: "actor_authentication_required" });
    text.mockRejectedValueOnce(new Error("Text runtime unavailable"));
    await expect(service.resolveTaskActorRuntime(config)).rejects.toThrow("Text runtime unavailable");
    expect(f.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/decisions"))).toHaveLength(1);
    await service.resolveTaskActorRuntime({ model: "gpt-test" });
    expect(text).toHaveBeenLastCalledWith({ model: "gpt-test" }, {});
  });
  it("retains API credentials only in the execution lease while exposing safe persisted definitions and validated defaults", async () => {
    const fixture = await setup();
    await fixture.service.start();
    await fixture.connect();
    const status = await fixture.service.status();
    expect(status.secretsPersisted).toBe(false);
    expect(status.adapters[0].adapterId).toBe("openrouter");
    expect(JSON.stringify(status)).not.toContain("private-key");
    expect(JSON.stringify(fixture.stored())).not.toContain("private-key");
    const lease = await fixture.service.acquireExecution("chosen");
    expect(await lease.runtime.executionAccess()).toEqual({ kind: "secret", value: "private-key" });
    await lease.release();
    expect(await fixture.service.select("codex-basic")).toMatchObject({ providerId: "chosen", modelId: "gpt-test" });
    fixture.setBusy(true);
    await expect(fixture.service.remove("chosen")).rejects.toThrow("Finish active Eval work");
    fixture.setBusy(false);
    await fixture.service.remove("chosen");
    await expect(fixture.service.acquireExecution("chosen")).rejects.toThrow("unavailable");
  });

  it("prepares native login explicitly and scopes its native credential home to the Eval definition", async () => {
    const fixture = await setup({ managed: true });
    await fixture.service.start();
    expect(fixture.runtimeResolver.prepare).not.toHaveBeenCalled();
    const login = await fixture.connect();
    expect(login.login.authUrl).toBe("https://provider.example/login");
    expect(fixture.runtimeResolver.prepare).toHaveBeenCalledWith("codex@0.159.3");
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
    ['cli_auth_credentials_store = "file"\n\n[projects."/fixture/repo"]\ntrust_level = "trusted"\n', true],
    ['cli_auth_credentials_store = "file"\n[projects."/fixture/repo"]\ncli_auth_credentials_store = "keyring"\n', false],
    ['[projects."/fixture/repo"]\ncli_auth_credentials_store = "file"\n', false],
    ['cli_auth_credentials_store = "file"\n[mcp_servers.extra]\ncommand = "unexpected"\n', false],
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
      harnessId: "codex-basic", available: true, providerConnections: [{ providerId: "codex", generation: 1, modelIds: ["gpt-test"] }],
    })], expect.objectContaining({ signal: expect.any(AbortSignal) }));
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

  it("preflights the actor model and effort against the connected provider before resolving runtime", async () => {
    const fixture = await setup({ managed: true });
    await fixture.service.start(); await fixture.connect(); await fixture.service.completeConnection("chosen");
    fixture.runtimeResolver.prepare.mockClear();
    await expect(fixture.service.resolveCodexJudgeRuntime({ model: "missing", modelReasoningEffort: "low" })).rejects.toMatchObject({ code: "actor_model_unsupported" });
    await expect(fixture.service.resolveCodexJudgeRuntime({ model: "gpt-test", modelReasoningEffort: "high" })).rejects.toMatchObject({ code: "actor_effort_unsupported" });
    expect(await fixture.service.resolveCodexJudgeRuntime({ model: "gpt-test", modelReasoningEffort: "low" })).toMatchObject({ executable: "/managed/codex" });
    expect(fixture.runtimeResolver.prepare).not.toHaveBeenCalled();
    await expect(fixture.service.logout("chosen")).resolves.toBeDefined();
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
    expect(fixture.runtimeResolver.prepare).toHaveBeenCalledWith("codex@0.159.3", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const judge = await fixture.service.resolveCodexJudgeRuntime();
    expect(judge.environment.CODEX_HOME).toBe(join(fixture.directory, "provider-runtime", "chosen", "codex-home"));
    expect(judge.environment.API_KEY).toBeUndefined();
    await fixture.service.logout("chosen");
    await expect(fixture.service.resolveCodexJudgeRuntime()).rejects.toMatchObject({ code: "actor_authentication_required" });
  });
  it("refreshes stale subscription status before judge admission without changing candidate defaults", async () => {
    const fixture = await setup({ managed: true });
    await fixture.service.start(); await fixture.connect(); await fixture.service.completeConnection("chosen");
    const snapshot = fixture.snapshots.get("chosen");
    fixture.snapshots.set("chosen", { ...snapshot, connected: false });
    expect((await fixture.service.status()).definitions.find(item => item.id === "chosen").connected).toBe(false);
    const judge = await fixture.service.resolveCodexJudgeRuntime({ model: "gpt-test", modelReasoningEffort: "low" });
    expect(judge.environment.CODEX_HOME).toBe(join(fixture.directory, "provider-runtime", "chosen", "codex-home"));
    expect(fixture.fetchImpl.mock.calls.filter(([url]) => url.pathname === "/api/model-settings/defaults")).toHaveLength(0);
  });

  it("keeps the candidate provider default while an independent Codex judge refreshes its subscription", async () => {
    const fixture = await setup({ managed: true, defaultProviderId: "claude-candidate" });
    await fixture.service.start(); await fixture.connect(); await fixture.service.completeConnection("chosen");
    fixture.snapshots.set("chosen", { ...fixture.snapshots.get("chosen"), connected: false });
    const judge = await fixture.service.resolveCodexJudgeRuntime({ model: "gpt-test", modelReasoningEffort: "low" });
    expect(judge.environment.CODEX_HOME).toBe(join(fixture.directory, "provider-runtime", "chosen", "codex-home"));
    expect(fixture.fetchImpl.mock.calls.filter(([url]) => url.pathname === "/api/model-settings/defaults")).toHaveLength(0);
    const settings = await (await fixture.fetchImpl(new URL("http://127.0.0.1/api/model-settings"), { headers: { Cookie: "control=private" } })).json();
    expect(settings.defaults.providerId).toBe("claude-candidate");
  });

  it("refuses an uninstalled subscription runtime as missing evaluator authentication without installing it", async () => {
    const fixture = await setup({ managed: true });
    fixture.seed([{ id: "codex", adapterId: "codex-subscription", label: "Codex", accessContract: "managed-runtime@1", endpoint: null, credentialReference: null, lifecycleState: "active", removedAt: null }]);
    fixture.runtimeResolver.get.mockRejectedValue(Object.assign(new Error("private missing runtime"), { code: "managed_runtime_not_installed" }));
    await fixture.service.start();
    await expect(fixture.service.resolveCodexJudgeRuntime({ model: "gpt-test", modelReasoningEffort: "low" })).rejects.toMatchObject({ code: "actor_authentication_required" });
    expect(fixture.runtimeResolver.prepare).not.toHaveBeenCalled();
  });

  it("cancels the evaluator discovery itself before releasing its route", async () => {
    const fixture = await setup({ managed: true });
    await fixture.service.start(); await fixture.connect(); await fixture.service.completeConnection("chosen");
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let nativeSignal;
    fixture.setDiscoverHook(({ signal }) => {
      nativeSignal = signal;
      entered();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const controller = new AbortController();
    const pending = fixture.service.resolveCodexJudgeRuntime({ model: "gpt-test", modelReasoningEffort: "low" }, { signal: controller.signal });
    const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await started;
    controller.abort();
    await failure;
    expect(nativeSignal.aborted).toBe(true);
    fixture.setDiscoverHook(null);
    await expect(fixture.service.logout("chosen")).resolves.toBeDefined();
  });

  it("rejects text-only actor models before candidate inference", async () => {
    const fixture = await setup({ managed: true, inputModalities: ["text"] });
    await fixture.service.start(); await fixture.connect(); await fixture.service.completeConnection("chosen");
    await expect(fixture.service.resolveCodexJudgeRuntime({ model: "gpt-test", modelReasoningEffort: "low" })).rejects.toMatchObject({ code: "actor_model_unsupported" });
  });

});

it("preflights the independently pinned Decisions completion judge and keeps its contract separate from actor execution", async () => {
  const { COMPLETION_JUDGE_SPEC, COMPLETION_JUDGE_EVIDENCE_V2, COMPLETION_DECISION_CONTRACT } = await import("../desktop/eval-main/task-completion-judge.mjs");
  const f = await setup({ openai: true }); await f.connect();
  const text = vi.fn(async () => ({ executable: "/managed/codex", environment: { CODEX_HOME: "/isolated" } }));
  const service = { ...f.service, resolveCodexJudgeRuntime: text };
  const config = { ...structuredClone(COMPLETION_JUDGE_SPEC), evidenceContract: structuredClone(COMPLETION_JUDGE_EVIDENCE_V2), decision: { contractId: COMPLETION_DECISION_CONTRACT.id, providerId: "chosen", model: "gpt-6-luna" } };
  const runtime = await service.resolveCompletionJudgeRuntime(config);
  expect(text).toHaveBeenCalledWith(config, {});
  expect(f.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/decisions"))).toHaveLength(0);
  await runtime.decide({ model: "gpt-6-luna", questions: [] });
  expect(JSON.stringify({ runtime, config })).not.toContain("private-key");
  await expect(service.resolveTaskActorRuntime(config)).rejects.toThrow("contract");
  await expect(service.resolveCompletionJudgeRuntime({ ...config, decision: { ...config.decision, contractId: "openai-decisions-codex-text-v2" } })).rejects.toThrow("configuration");
  await expect(service.resolveCompletionJudgeRuntime({ ...config, decision: { ...config.decision, providerId: "missing" } })).rejects.toMatchObject({ code: "actor_authentication_required" });
  text.mockRejectedValueOnce(new Error("Feedback route unavailable"));
  await expect(service.resolveCompletionJudgeRuntime(config)).rejects.toThrow("Feedback route unavailable");
  expect(f.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/decisions"))).toHaveLength(1);
  await service.resolveCompletionJudgeRuntime(COMPLETION_JUDGE_SPEC);
  expect(text).toHaveBeenLastCalledWith(COMPLETION_JUDGE_SPEC, {});
});


it.each(["actor", "judge"])("classifies a missing pinned Decisions model before %s inference", async route => {
  const { COMPLETION_JUDGE_SPEC, COMPLETION_JUDGE_EVIDENCE_V2, COMPLETION_DECISION_CONTRACT } = await import("../desktop/eval-main/task-completion-judge.mjs");
  const f = await setup({ openai: true }); await f.connect();
  const text = vi.fn(); const service = { ...f.service, resolveCodexJudgeRuntime: text };
  const config = route === "actor" ? { model: "gpt-test", modelReasoningEffort: "low", decision: { contractId: "openai-decisions-codex-text-v1", providerId: "chosen", model: "gpt-6-luna" } }
    : { ...structuredClone(COMPLETION_JUDGE_SPEC), evidenceContract: structuredClone(COMPLETION_JUDGE_EVIDENCE_V2), decision: { contractId: COMPLETION_DECISION_CONTRACT.id, providerId: "chosen", model: "gpt-6-luna" } };
  f.fetchImpl.mockImplementationOnce(async () => Response.json({ error: "PRIVATE_PROVIDER_DETAILS" }, { status: 404 }));
  await expect(route === "actor" ? service.resolveTaskActorRuntime(config) : service.resolveCompletionJudgeRuntime(config)).rejects.toMatchObject({ code: "actor_model_unsupported" });
  expect(text).not.toHaveBeenCalled();
  expect(f.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/decisions"))).toHaveLength(0);
});

it("keeps Decisions inference 404s separate from model-discovery errors", async () => {
  const f = await setup({ openai: true }); await f.connect();
  const service = { ...f.service, resolveCodexJudgeRuntime: vi.fn(async () => ({})) };
  const runtime = await service.resolveTaskActorRuntime({ model: "gpt-test", modelReasoningEffort: "low", decision: { contractId: "openai-decisions-codex-text-v1", providerId: "chosen", model: "gpt-6-luna" } });
  f.fetchImpl.mockImplementationOnce(async () => Response.json({ error: "PRIVATE_PROVIDER_DETAILS" }, { status: 404 }));
  const error = await runtime.decide({ model: "gpt-6-luna", questions: [] }).catch(error => error);
  expect(error).toMatchObject({ status: 404 });
  expect(error.code).not.toBe("actor_model_unsupported");
  expect(error.message).not.toContain("PRIVATE_PROVIDER_DETAILS");
});
