import { describe, expect, it, vi } from "vitest";

import { createProviderAdapterRegistry } from "../desktop/main/providers/provider-adapter-contract.mjs";
import { createProviderComposition } from "../desktop/main/providers/provider-composition.mjs";
import { readFile } from "node:fs/promises";

import {
  createHarnessReadinessCoordinator,
  startPostUpgradeReadiness,
} from "../desktop/main/services/harness-readiness.mjs";

describe("injectable production provider composition", () => {
  it("publishes missing persisted credentials as unavailable and keeps explicit refresh deterministic", async () => {
    const published = [];
    const composition = createProviderComposition({
      registry: createProviderAdapterRegistry([{
        adapterId: "fake-api", implementationVersion: "1", label: "Fake API",
        accessContract: "secret@1", defaultEndpoint: "https://fake.example/v1",
        connection: { mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }] },
        create: vi.fn(),
      }]),
      definitionStore: { async load() { return [{
        id: "missing", adapterId: "fake-api", label: "Missing API", endpoint: "https://fake.example/v1",
        accessContract: "secret@1", credentialReference: "provider:missing", lifecycleState: "active",
      }]; } },
      credentialStore: { async get() { return null; }, async listReferences() { return ["provider:missing"]; } },
      publishCatalog: async (snapshot) => { published.push(snapshot); },
      modelCatalogOptions: { backgroundIntervalMs: 60_000 },
    });

    await composition.start();
    expect(published).toEqual([expect.objectContaining({
      providerId: "missing", connected: false, models: [],
      unavailableReason: expect.objectContaining({ code: "provider_unavailable" }),
    })]);
    await composition.modelCatalog.explicitRefresh("missing");
    expect(published).toHaveLength(2);
    expect(published[1]).toEqual(published[0]);
    await composition.close();
  });

  it("recovers an unavailable API provider through the existing explicit refresh surface", async () => {
    const published = [];
    let runtimeReady = false;
    const prepareRuntime = vi.fn(async () => { runtimeReady = true; });
    const evaluateReadiness = vi.fn(async () => {});
    const create = vi.fn(({ definition }) => {
      if (!runtimeReady) throw new Error("managed runtime unavailable");
      return {
        providerId: definition.id,
        discover: async () => ({
          provider: { id: definition.id, label: definition.label, status: "available" },
          models: [{
            id: "recovered-model", executionModel: "recovered-model", label: "Recovered", description: "",
            visible: true, availability: "available", unavailableReason: null, availabilityNotice: null,
            isDefault: true, replacementModelId: null, upgradeInfo: null, supportedEfforts: [],
            defaultEffort: null, inputModalities: ["text"], supportsPersonality: false,
            serviceTiers: [], defaultServiceTier: null,
          }],
          systemFamily: { id: definition.id, label: definition.label, modelIds: ["recovered-model"] },
        }),
        close: vi.fn(async () => {}),
      };
    });
    const composition = createProviderComposition({
      registry: createProviderAdapterRegistry([{
        adapterId: "recoverable-api", implementationVersion: "1", label: "Recoverable API",
        accessContract: "secret@1", defaultEndpoint: "https://recover.example/v1",
        connection: { mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }] },
        create,
      }]),
      definitionStore: { async load() { return [{
        id: "recoverable", adapterId: "recoverable-api", label: "Recoverable", endpoint: "https://recover.example/v1",
        accessContract: "secret@1", credentialReference: "provider:recoverable", lifecycleState: "active",
      }]; } },
      credentialStore: { async get() { return { key: "opaque" }; }, async listReferences() { return ["provider:recoverable"]; } },
      prepareRuntime,
      evaluateReadiness,
      publishCatalog: async (snapshot) => { published.push(snapshot); },
      modelCatalogOptions: { backgroundIntervalMs: 60_000 },
    });

    await composition.start();
    expect(published.at(-1)).toMatchObject({ providerId: "recoverable", connected: false });
    expect(prepareRuntime).not.toHaveBeenCalled();
    await composition.modelCatalog.explicitRefresh("recoverable");
    expect(prepareRuntime).toHaveBeenCalledOnce();
    expect(evaluateReadiness).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "explicit-repair",
      providerDefinition: expect.objectContaining({ id: "recoverable" }),
      models: [expect.objectContaining({ id: "recovered-model" })],
    }));
    expect(create).toHaveBeenCalledTimes(2);
    expect(published.at(-1)).toMatchObject({
      providerId: "recoverable",
      connected: true,
      models: [{ id: "recovered-model" }],
    });
    const lease = await composition.providerDefinitions.acquireExecution("recoverable");
    expect(lease.runtime.providerId).toBe("recoverable");
    await lease.release();
    await composition.close();
  });

  it("does not instantiate or refresh a tombstoned legacy provider", async () => {
    const create = vi.fn(() => { throw new Error("tombstoned provider must not be instantiated"); });
    const composition = createProviderComposition({
      registry: createProviderAdapterRegistry([{
        adapterId: "codex-subscription", implementationVersion: "1", label: "Codex subscription",
        accessContract: "managed-runtime@1", defaultEndpoint: null,
        connection: { mode: "managed-login", fields: [] }, create,
      }]),
      definitionStore: { async load() { return [{
        id: "codex", adapterId: "codex-subscription", label: "Codex", endpoint: null,
        accessContract: "managed-runtime@1", credentialReference: null,
        lifecycleState: "tombstoned", removedAt: "1",
      }]; } },
      credentialStore: { async listReferences() { return []; } },
      publishCatalog: vi.fn(async () => {}),
    });
    await composition.start();
    expect(create).not.toHaveBeenCalled();
    await composition.close();
  });

  it("drives a fake registry through definition, catalog, and execution flows", async () => {
    let definitions = [];
    const published = [];
    const descriptor = {
      adapterId: "fake-composition", implementationVersion: "7", label: "Fake composition",
      accessContract: "secret@1", defaultEndpoint: "https://fake.example/v1",
      endpointEditableDuringCreation: true,
      connection: { mode: "secret-fields", fields: [{ id: "api-key", label: "API key", kind: "secret" }] },
      create: ({ definition }) => ({
        providerId: definition.id,
        discover: async () => ({
          provider: { id: definition.id, label: definition.label, status: "available" },
          models: [{
            id: "fake-model", executionModel: "fake-model", label: "Fake model", description: "",
            visible: true, availability: "available", unavailableReason: null, availabilityNotice: null,
            isDefault: false, replacementModelId: null, upgradeInfo: null, supportedEfforts: [],
            defaultEffort: null, inputModalities: ["text"], supportsPersonality: false,
            serviceTiers: [], defaultServiceTier: null,
          }],
          systemFamily: { id: definition.id, label: definition.label, modelIds: [] },
        }),
        executionAccess: async () => ({ kind: "secret", endpoint: definition.endpoint, fields: { "api-key": "execution-only" } }),
        close: vi.fn(async () => {}),
      }),
    };
    const composition = createProviderComposition({
      registry: createProviderAdapterRegistry([descriptor]),
      definitionStore: {
        async load() { return structuredClone(definitions); },
        async save(next) { definitions = structuredClone(next); },
        async createWithCatalog(candidate) { definitions.push(structuredClone(candidate)); },
      },
      credentialStore: { async set() {}, async get() { return { "api-key": "execution-only" }; }, async delete() {}, async listReferences() { return []; } },
      publishCatalog: async (snapshot) => { published.push(snapshot); },
      modelCatalogOptions: { backgroundIntervalMs: 60_000 },
    });
    await composition.start();
    expect(composition.providerDefinitions.adapters().map(({ adapterId }) => adapterId)).toEqual(["fake-composition"]);

    const connected = await composition.providerDefinitions.connect({
      adapterId: "fake-composition", label: "Fake Work", endpoint: "https://fake.example/v1", fields: { "api-key": "opaque" },
    });
    const providerId = connected.providerDefinition.id;
    await composition.modelCatalog.explicitRefresh(providerId);
    expect(published.at(-1)).toMatchObject({ providerId, connected: true, models: [{ id: "fake-model" }] });

    const lease = await composition.providerDefinitions.acquireExecution(providerId);
    expect(lease.descriptor.implementationVersion).toBe("7");
    await lease.release();
    await composition.close();
  });

  // One provider's leftover removal or cleanup failing must neither stop Relayer from
  // starting nor keep the other providers from activating or finishing their own removals.
  // Each failure is recorded; a removal that fails before its tombstone stays pending.
  it.each([
    ["its tombstone write fails", { failTombstone: true },
      { category: "provider_removal_startup_failed", providerId: "leaving", leaving: "removal_pending", orphan: false }],
    ["the store still counts an attempt on it as running", { deferTombstone: true },
      { category: "provider_removal_startup_deferred", providerId: "leaving", leaving: "removal_pending", orphan: false }],
    ["its credential cleanup fails after the tombstone", { failCredentialDelete: true },
      { category: "provider_removal_startup_failed", providerId: "leaving", leaving: "tombstoned", orphan: false }],
    ["its runtime state cleanup fails after the tombstone", { failRuntimeStateRemoval: true },
      { category: "provider_removal_startup_failed", providerId: "leaving", leaving: "tombstoned", orphan: false }],
    ["the runtime-state sweep fails", { failRuntimeStateSweep: true },
      { category: "provider_runtime_state_startup_cleanup_failed", leaving: "tombstoned", orphan: false }],
    ["listing stored credentials fails", { failListReferences: true },
      { category: "provider_credential_startup_cleanup_failed", leaving: "tombstoned", orphan: true }],
    ["deleting an orphaned credential fails", { failOrphanDelete: true },
      { category: "provider_credential_startup_cleanup_failed", providerId: "orphan", leaving: "tombstoned", orphan: true }],
  ])("starts and activates other providers when %s", async (_, faults, expected) => {
    const published = [];
    const diagnostics = [];
    const pending = (id) => ({
      id, adapterId: "fake-api", label: id, endpoint: "https://fake.example/v1",
      accessContract: "secret@1", credentialReference: `provider:${id}`, lifecycleState: "removal_pending",
    });
    let definitions = [
      pending("leaving"),
      pending("also-leaving"),
      {
        id: "staying", adapterId: "fake-api", label: "Staying", endpoint: "https://fake.example/v1",
        accessContract: "secret@1", credentialReference: "provider:staying", lifecycleState: "active",
      },
    ];
    const credentials = new Set(["provider:leaving", "provider:also-leaving", "provider:staying", "provider:orphan"]);
    const removeRuntimeState = async ({ id }) => {
      if (faults.failRuntimeStateRemoval && id === "leaving") throw new Error("runtime state busy");
      return true;
    };
    removeRuntimeState.reconcile = async () => {
      if (faults.failRuntimeStateSweep) throw new Error("runtime root unreadable");
    };
    const composition = createProviderComposition({
      registry: createProviderAdapterRegistry([{
        adapterId: "fake-api", implementationVersion: "1", label: "Fake API",
        accessContract: "secret@1", defaultEndpoint: "https://fake.example/v1",
        connection: { mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }] },
        create: ({ definition }) => ({
          providerId: definition.id,
          discover: async () => ({
            provider: { id: definition.id, label: definition.label, status: "available" },
            models: [{
              id: "staying-model", executionModel: "staying-model", label: "Staying", description: "",
              visible: true, availability: "available", unavailableReason: null, availabilityNotice: null,
              isDefault: true, replacementModelId: null, upgradeInfo: null, supportedEfforts: [],
              defaultEffort: null, inputModalities: ["text"], supportsPersonality: false,
              serviceTiers: [], defaultServiceTier: null,
            }],
            systemFamily: { id: definition.id, label: definition.label, modelIds: ["staying-model"] },
          }),
          close: vi.fn(async () => {}),
        }),
      }]),
      definitionStore: {
        async load() { return structuredClone(definitions); },
        async save(next) {
          const tombstonesLeaving = next.some(({ id, lifecycleState }) => id === "leaving" && lifecycleState === "tombstoned");
          if (faults.failTombstone && tombstonesLeaving) {
            throw Object.assign(new Error("catalog write failed"), { code: "catalog_unavailable" });
          }
          if (faults.deferTombstone && tombstonesLeaving) {
            throw Object.assign(new Error("drain incomplete"), { code: "provider_execution_drain_incomplete" });
          }
          definitions = structuredClone(next);
        },
      },
      credentialStore: {
        async get(reference) { return credentials.has(reference) ? { key: "opaque" } : null; },
        async delete(reference) {
          if (faults.failCredentialDelete && reference === "provider:leaving") throw new Error("keychain locked");
          if (faults.failOrphanDelete && reference === "provider:orphan") throw new Error("keychain locked");
          credentials.delete(reference);
        },
        async listReferences() {
          if (faults.failListReferences) throw new Error("keychain unavailable");
          return [...credentials];
        },
      },
      removeRuntimeState,
      diagnostics: { write: async (event) => { diagnostics.push(event); } },
      publishCatalog: async (snapshot) => { published.push(snapshot); },
      modelCatalogOptions: { backgroundIntervalMs: 60_000 },
    });

    await expect(composition.start()).resolves.toBeUndefined();
    expect(published).toContainEqual(expect.objectContaining({
      providerId: "staying", connected: true, models: [expect.objectContaining({ id: "staying-model" })],
    }));
    const lease = await composition.providerDefinitions.acquireExecution("staying");
    await lease.release();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      category: expected.category,
      ...(expected.providerId === undefined ? {} : { providerId: expected.providerId }),
    }));
    expect(definitions.find(({ id }) => id === "leaving").lifecycleState).toBe(expected.leaving);
    // The other pending removal still finishes, and its credential is deleted.
    expect(definitions.find(({ id }) => id === "also-leaving").lifecycleState).toBe("tombstoned");
    expect(credentials.has("provider:also-leaving")).toBe(false);
    expect(credentials.has("provider:staying")).toBe(true);
    expect(credentials.has("provider:orphan")).toBe(expected.orphan);
    await composition.close();
  });

  // #556: ChatGPT and OpenRouter both run through codex-basic, and readiness is per harness.
  // An upgrade that changed codex-basic's digest leaves both pending. Startup then runs one
  // background evaluation through the recipe-update trigger, as desktop/main/index.mjs does,
  // so both providers are ready again without a Repair.
  it("evaluates an upgraded shared route once after startup so both providers are ready without Repair", async () => {
    const model = (id) => ({
      id, executionModel: id, label: id, description: "", visible: true, availability: "available",
      unavailableReason: null, availabilityNotice: null, isDefault: true, replacementModelId: null,
      upgradeInfo: null, supportedEfforts: [], defaultEffort: null, inputModalities: ["text"],
      supportsPersonality: false, serviceTiers: [], defaultServiceTier: null,
    });
    const runtime = (definition) => ({
      providerId: definition.id,
      discover: async () => ({
        provider: { id: definition.id, label: definition.label, status: "available" },
        models: [model(`work-${definition.id}`)],
        systemFamily: { id: definition.id, label: definition.label, modelIds: [`work-${definition.id}`] },
      }),
      close: vi.fn(async () => {}),
    });
    const harness = (name, implementation, adapterIds) => ({
      schemaVersion: 1, name, implementation, implementationVersion: 1, permissionBindings: { auto: {} },
      modelRules: { allow: adapterIds.map((adapterId) => ({ adapterId, modelIdRegex: "^work-" })), deny: [] },
      executionAccessContracts: ["managed-runtime@1", "secret@1"], settings: {},
    });
    const configurations = new Map([
      ["codex-basic", harness("codex-basic", "codex.basic", ["codex-subscription", "openrouter"])],
      // Also routes OpenRouter, but its runtime was never installed on this machine.
      ["prime-agent-basic", harness("prime-agent-basic", "prime.agent", ["openrouter"])],
    ]);
    const record = new Map();
    const publishAvailability = vi.fn(async (updates) => {
      for (const update of updates) record.set(update.harnessId, update.available);
    });
    const prepareRecipe = vi.fn(async (recipeId) => ({ recipeId }));
    const readiness = createHarnessReadinessCoordinator({
      configurations,
      digestConfiguration: ({ name }) => `sha256:${name}-upgraded`,
      recipeSupported: async () => true,
      runtimeRequirements: {
        "codex.basic": { runtimeId: "codex", recipeId: "codex@0.147.0" },
        "prime.agent": { runtimeId: "prime", recipeId: "prime@0.8.1" },
      },
      prepareRecipe,
      checkers: {
        "codex.basic": async ({ runtime: prepared }) => ({ available: prepared?.recipeId === "codex@0.147.0" }),
        "prime.agent": async () => ({ available: true }),
      },
      publishAvailability,
      recipeInstalled: async (recipeId) => recipeId === "codex@0.147.0",
    });
    const composition = createProviderComposition({
      registry: createProviderAdapterRegistry([
        {
          adapterId: "codex-subscription", implementationVersion: "1", label: "ChatGPT",
          accessContract: "managed-runtime@1", defaultEndpoint: null,
          connection: { mode: "managed-login", fields: [] }, create: ({ definition }) => runtime(definition),
        },
        {
          adapterId: "openrouter", implementationVersion: "1", label: "OpenRouter",
          accessContract: "secret@1", defaultEndpoint: "https://openrouter.example/v1",
          connection: { mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }] },
          create: ({ definition }) => runtime(definition),
        },
      ]),
      definitionStore: { async load() { return [
        {
          id: "chatgpt", adapterId: "codex-subscription", label: "ChatGPT", endpoint: null,
          accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active",
        },
        {
          id: "openrouter", adapterId: "openrouter", label: "OpenRouter", endpoint: "https://openrouter.example/v1",
          accessContract: "secret@1", credentialReference: "provider:openrouter", lifecycleState: "active",
        },
      ]; } },
      credentialStore: { async get() { return { key: "opaque" }; }, async listReferences() { return ["provider:openrouter"]; } },
      evaluateReadiness: (request) => readiness.evaluate(request),
      publishCatalog: async () => {},
      modelCatalogOptions: { backgroundIntervalMs: 60_000 },
    });

    await composition.start();
    expect(prepareRecipe).not.toHaveBeenCalled();

    // The app server marked codex-basic due: its digest changed with the upgrade. The step
    // returns before it has even read the marks, so startup never waits for it.
    let releaseMarks;
    const marks = new Promise((resolve) => { releaseMarks = resolve; });
    const onError = vi.fn();
    const { evaluation } = startPostUpgradeReadiness({
      readiness,
      updatesDue: () => marks,
      recipeUpdates: [],
      routes: () => composition.readinessRoutes(),
      onError,
    });
    expect(prepareRecipe).not.toHaveBeenCalled();
    releaseMarks(["codex-basic", "prime-agent-basic"]);
    const result = await evaluation;
    expect(onError).not.toHaveBeenCalled();
    // The existing connected router authorizes completing missing Prime setup. Codex's
    // shared recipe still prepares once, and both results publish in one evaluation.
    expect(prepareRecipe).toHaveBeenCalledTimes(2);
    expect(prepareRecipe).toHaveBeenCalledWith("prime@0.8.1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(prepareRecipe).toHaveBeenCalledWith("codex@0.147.0", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(publishAvailability).toHaveBeenCalledTimes(2);
    expect(publishAvailability).toHaveBeenNthCalledWith(1, [{
      harnessId: "codex-basic", configurationDigest: "sha256:codex-basic-upgraded",
      generation: 1, available: true, unavailableReason: null, providerConnections: [{ providerId: "chatgpt", generation: 1, modelIds: ["work-chatgpt"] }, { providerId: "openrouter", generation: 1, modelIds: ["work-openrouter"] }],
    }], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(publishAvailability).toHaveBeenNthCalledWith(2, [{
      harnessId: "prime-agent-basic", configurationDigest: "sha256:prime-agent-basic-upgraded",
      generation: 1, available: true, unavailableReason: null, providerConnections: [{ providerId: "openrouter", generation: 1, modelIds: ["work-openrouter"] }],
    }], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result.readyHarnessIds).toEqual(["codex-basic", "prime-agent-basic"]);
    // Both providers are its routes; the app-server test
    // one_post_upgrade_evaluation_restores_both_providers_sharing_a_route shows this one
    // result makes both ready.
    expect((await composition.readinessRoutes()).map(({ providerDefinition }) => providerDefinition.id))
      .toEqual(["chatgpt", "openrouter"]);

    // The next start has nothing due, so it evaluates nothing.
    await startPostUpgradeReadiness({
      readiness, updatesDue: async () => [], routes: () => composition.readinessRoutes(),
    }).evaluation;
    expect(prepareRecipe).toHaveBeenCalledTimes(2);
    // A newly activated recipe is due too, and only for the harnesses that run it.
    await startPostUpgradeReadiness({
      readiness, updatesDue: async () => [], recipeUpdates: ["codex@0.147.0"],
      routes: () => composition.readinessRoutes(),
    }).evaluation;
    expect(prepareRecipe).toHaveBeenCalledTimes(3);
    expect(publishAvailability).toHaveBeenLastCalledWith([expect.objectContaining({
      harnessId: "codex-basic", generation: 2, available: true,
    })], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    // A failed read only reports; it never rejects into startup.
    const failure = new Error("app server unavailable");
    const reported = vi.fn();
    await expect(startPostUpgradeReadiness({
      readiness, updatesDue: async () => { throw failure; }, routes: () => composition.readinessRoutes(), onError: reported,
    }).evaluation).resolves.toBeNull();
    expect(reported).toHaveBeenCalledWith(failure);
    // Without the installed-recipe check it refuses, rather than skipping every harness.
    const unchecked = createHarnessReadinessCoordinator({
      configurations, digestConfiguration: ({ name }) => name, runtimeRequirements: {},
      prepareRecipe, checkers: { "codex.basic": async () => ({ available: true }), "prime.agent": async () => ({ available: true }) },
      publishAvailability,
    });
    const refused = vi.fn();
    await startPostUpgradeReadiness({
      readiness: unchecked, updatesDue: async () => ["codex-basic"], routes: () => composition.readinessRoutes(), onError: refused,
    }).evaluation;
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/installed-recipe check/) }));
    await composition.close();
  });

  // PR #576 review: an upgrade can leave the managed runtime present but broken. Then a
  // managed provider's activation fails, its recovery adapter publishes no models, and it has
  // no route, so the evaluation alone would never run. The post-upgrade step repairs that
  // provider as Repair does, but only when its runtime was installed before.
  it.each([
    ["repairs a managed provider whose activation failed on its broken runtime", true, "digest"],
    ["repairs a failed managed provider once for a newly activated recipe", true, "recipe"],
    ["never installs a missing runtime to recover a managed provider", false, "digest"],
    // PR #576 review: recovery discovers once and that catalog is what publishes. A second
    // discovery that fails must not leave the provider without a route.
    ["publishes the catalog its recovery discovered, without discovering again", true, "digest", true],
  ])("%s", async (_, installedBefore, trigger, discoverOnce = false) => {
    let runtimeHealthy = false;
    let discoveries = 0;
    const prepareRuntime = vi.fn(async () => { runtimeHealthy = true; });
    const create = vi.fn(({ definition }) => {
      if (!runtimeHealthy) throw new Error("managed runtime installation is invalid");
      return {
        providerId: definition.id,
        discover: async () => {
          discoveries += 1;
          if (discoverOnce && discoveries > 1) throw new Error("provider catalog unavailable");
          return discoveredCatalog(definition);
        },
        close: vi.fn(async () => {}),
      };
    });
    const discoveredCatalog = (definition) => ({
          provider: { id: definition.id, label: definition.label, status: "available" },
          models: [{
            id: "work-chatgpt", executionModel: "work-chatgpt", label: "Work", description: "",
            visible: true, availability: "available", unavailableReason: null, availabilityNotice: null,
            isDefault: true, replacementModelId: null, upgradeInfo: null, supportedEfforts: [],
            defaultEffort: null, inputModalities: ["text"], supportsPersonality: false,
            serviceTiers: [], defaultServiceTier: null,
          }],
          systemFamily: { id: definition.id, label: definition.label, modelIds: ["work-chatgpt"] },
    });
    const configurations = new Map([["codex-basic", {
      schemaVersion: 1, name: "codex-basic", implementation: "codex.basic", implementationVersion: 1,
      permissionBindings: { auto: {} },
      modelRules: { allow: [{ adapterId: "codex-subscription", modelIdRegex: "^work-" }], deny: [] },
      executionAccessContracts: ["managed-runtime@1"], settings: {},
    }]]);
    const due = new Set(trigger === "digest" ? ["codex-basic"] : []);
    const recipeUpdates = trigger === "recipe" ? ["codex@0.147.0"] : [];
    const prepareRecipe = vi.fn(async (recipeId) => ({ recipeId }));
    const publishAvailability = vi.fn(async (updates) => {
      for (const { harnessId } of updates) due.delete(harnessId);
    });
    const readiness = createHarnessReadinessCoordinator({
      configurations,
      digestConfiguration: ({ name }) => `sha256:${name}-upgraded`,
      runtimeRequirements: { "codex.basic": { runtimeId: "codex", recipeId: "codex@0.147.0" } },
      prepareRecipe,
      checkers: { "codex.basic": async () => ({ available: runtimeHealthy }) },
      publishAvailability,
      recipeInstalled: async () => installedBefore,
    });
    const published = [];
    const composition = createProviderComposition({
      registry: createProviderAdapterRegistry([{
        adapterId: "codex-subscription", implementationVersion: "1", label: "ChatGPT",
        accessContract: "managed-runtime@1", defaultEndpoint: null,
        connection: { mode: "managed-login", fields: [] }, create,
      }]),
      definitionStore: { async load() { return [{
        id: "chatgpt", adapterId: "codex-subscription", label: "ChatGPT", endpoint: null,
        accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active",
      }]; } },
      credentialStore: { async listReferences() { return []; } },
      prepareRuntime,
      evaluateReadiness: (request) => readiness.evaluate(request),
      publishCatalog: async (snapshot) => { published.push(snapshot); },
      modelCatalogOptions: { backgroundIntervalMs: 60_000 },
    });

    await composition.start();
    expect(published.at(-1)).toMatchObject({ providerId: "chatgpt", connected: false, models: [] });
    expect(await composition.readinessRoutes()).toEqual([]);

    const onError = vi.fn();
    await startPostUpgradeReadiness({
      readiness,
      updatesDue: async () => [...due],
      recipeUpdates,
      routes: () => composition.readinessRoutes(),
      repairProviders: (recipeIds) => composition.repairFailedActivations(recipeIds, {
        recipeForAdapter: () => "codex@0.147.0",
      }),
      onError,
    }).evaluation;
    expect(onError).not.toHaveBeenCalled();

    if (installedBefore) {
      // The repair's own evaluation is the one evaluation: nothing prepares or publishes again.
      expect(prepareRuntime).toHaveBeenCalledOnce();
      expect(prepareRecipe).toHaveBeenCalledOnce();
      expect(publishAvailability).toHaveBeenCalledOnce();
      expect(publishAvailability).toHaveBeenCalledWith([expect.objectContaining({
        harnessId: "codex-basic", available: true,
      })], expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(due.size).toBe(0);
      expect(published.at(-1)).toMatchObject({ providerId: "chatgpt", connected: true, models: [{ id: "work-chatgpt" }] });
      const lease = await composition.providerDefinitions.acquireExecution("chatgpt");
      await lease.release();
    } else {
      expect(prepareRuntime).not.toHaveBeenCalled();
      expect(publishAvailability).not.toHaveBeenCalled();
      expect(due).toEqual(new Set(["codex-basic"]));
      expect(prepareRecipe).not.toHaveBeenCalled();
    }
    await composition.close();
  });

  // PR #576 review: two managed providers on one harness whose activation failed on the same
  // broken runtime are both recovered, but the harness still gets one evaluation.
  it("recovers every failed managed provider of a due harness with one evaluation", async () => {
    let runtimeHealthy = false;
    const prepareRuntime = vi.fn(async () => { runtimeHealthy = true; });
    const model = (id) => ({
      id, executionModel: id, label: id, description: "", visible: true, availability: "available",
      unavailableReason: null, availabilityNotice: null, isDefault: true, replacementModelId: null,
      upgradeInfo: null, supportedEfforts: [], defaultEffort: null, inputModalities: ["text"],
      supportsPersonality: false, serviceTiers: [], defaultServiceTier: null,
    });
    const create = vi.fn(({ definition }) => {
      if (!runtimeHealthy) throw new Error("managed runtime installation is invalid");
      return {
        providerId: definition.id,
        discover: async () => ({
          provider: { id: definition.id, label: definition.label, status: "available" },
          models: [model(`work-${definition.id}`)],
          systemFamily: { id: definition.id, label: definition.label, modelIds: [`work-${definition.id}`] },
        }),
        close: vi.fn(async () => {}),
      };
    });
    const configurations = new Map([["codex-basic", {
      schemaVersion: 1, name: "codex-basic", implementation: "codex.basic", implementationVersion: 1,
      permissionBindings: { auto: {} },
      modelRules: { allow: [{ adapterId: "codex-subscription", modelIdRegex: "^work-" }], deny: [] },
      executionAccessContracts: ["managed-runtime@1"], settings: {},
    }]]);
    const due = new Set(["codex-basic"]);
    const publishAvailability = vi.fn(async (updates) => {
      for (const { harnessId } of updates) due.delete(harnessId);
    });
    const prepareRecipe = vi.fn(async (recipeId) => ({ recipeId }));
    const readiness = createHarnessReadinessCoordinator({
      configurations,
      digestConfiguration: ({ name }) => `sha256:${name}-upgraded`,
      runtimeRequirements: { "codex.basic": { runtimeId: "codex", recipeId: "codex@0.147.0" } },
      prepareRecipe,
      checkers: { "codex.basic": async () => ({ available: runtimeHealthy }) },
      publishAvailability,
      recipeInstalled: async () => true,
    });
    const published = [];
    const definition = (id) => ({
      id, adapterId: "codex-subscription", label: id, endpoint: null,
      accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active",
    });
    const composition = createProviderComposition({
      registry: createProviderAdapterRegistry([{
        adapterId: "codex-subscription", implementationVersion: "1", label: "ChatGPT",
        accessContract: "managed-runtime@1", defaultEndpoint: null,
        connection: { mode: "managed-login", fields: [] }, create,
      }]),
      definitionStore: { async load() { return [definition("work"), definition("personal")]; } },
      credentialStore: { async listReferences() { return []; } },
      prepareRuntime,
      evaluateReadiness: (request) => readiness.evaluate(request),
      publishCatalog: async (snapshot) => { published.push(snapshot); },
      modelCatalogOptions: { backgroundIntervalMs: 60_000 },
    });

    await composition.start();
    const onError = vi.fn();
    await startPostUpgradeReadiness({
      readiness,
      updatesDue: async () => [...due],
      routes: () => composition.readinessRoutes(),
      repairProviders: (recipeIds) => composition.repairFailedActivations(recipeIds, {
        recipeForAdapter: () => "codex@0.147.0",
      }),
      onError,
    }).evaluation;
    expect(onError).not.toHaveBeenCalled();
    expect(publishAvailability).toHaveBeenCalledOnce();
    expect(prepareRecipe).toHaveBeenCalledOnce();
    expect(due.size).toBe(0);
    for (const id of ["work", "personal"]) {
      expect(published.filter((snapshot) => snapshot.providerId === id).at(-1))
        .toMatchObject({ connected: true, models: [{ id: `work-${id}` }] });
    }
    await composition.close();
  });

  it("starts the post-upgrade evaluation from desktop startup without awaiting it", async () => {
    const source = await readFile(new URL("../desktop/main/index.mjs", import.meta.url), "utf8");
    const start = source.indexOf("await providerComposition.start();");
    const call = source.indexOf("postUpgradeReadiness = createPostUpgradeReadiness({", start);
    const window = source.indexOf("mainWindow = await createWindow(", start);
    expect(start).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(start);
    expect(call).toBeLessThan(window);
    const step = source.slice(call, source.indexOf("});", call));
    expect(step).toContain("updatesDue: () => productServer.harnessReadinessUpdatesDue()");
    expect(step).toContain("recipeUpdates: activation.recipeUpdates");
    // The runner recovers through the composition itself, forwarding the stop signal.
    expect(step).toContain("composition: providerComposition");
    expect(step).toContain("recipeForAdapter: (adapterId) => managedRuntimeRequirementForAdapter(adapterId).recipeId");
    expect(source.slice(call, window)).toContain("postUpgradeReadiness.start();");
    expect(source).toContain("recipeInstalled: (recipeId) => managedRecipeInstalled(managedRuntimeResolver, recipeId)");
    expect(source).not.toMatch(/await\s+postUpgradeReadiness\.start\(\)/);
    // PR #576/#607 review: the quit guard runs through the runner, which stops the evaluation
    // first and restarts it if the quit is declined; shutdown stops, cancels and awaits it
    // before the services it uses close.
    const confirm = source.slice(source.indexOf("const confirmQuit = "), source.indexOf("\n", source.indexOf("const confirmQuit = ") + 80));
    expect(source).toContain("postUpgradeReadiness.confirmQuit(() => confirmManagedQuit(options))");
    expect(confirm).toContain("postUpgradeReadiness");
    const shutdown = source.slice(source.indexOf("async function shutdownServices()"), source.indexOf("if (productServer) await productServer.close();"));
    expect(shutdown).toContain("await postUpgradeReadiness?.stopForShutdown(");
    expect(shutdown).toContain("managedRuntimeInstaller.cancelAll(");
    // Readiness checkers receive the stop, including the Prime kernel probe.
    expect(source).toContain('"prime.agent": ({ runtime, signal }) => checkPrimeManagedRuntime({ runtime, signal })');
    // Startup names each coordinated harness's required recipe for the app server.
    expect(source).toContain("harnessRuntimeRecipe: (configuration) => managedRuntimeInstaller.recipeIdentity(");
    expect(source).toContain("harnessRuntimeUpdated: (configuration) => updatedRuntimeIds.has(");
    expect(source).toContain("for (const runtimeId of runtimesChangedByActivation(activation)) updatedRuntimeIds.add(runtimeId);");
    expect(source.indexOf("runtimesChangedByActivation(activation)")).toBeLessThan(source.indexOf("await graphRuntime.start()"));
    const evalSource = await readFile(new URL("../desktop/eval-main/index.mjs", import.meta.url), "utf8");
    expect(evalSource).toContain("harnessRuntimeRecipe: ({ implementation }) => runtimeFileValidator.recipeIdentity(");
  });
});
