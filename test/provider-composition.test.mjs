import { describe, expect, it, vi } from "vitest";

import { createProviderAdapterRegistry } from "../desktop/main/providers/provider-adapter-contract.mjs";
import { createProviderComposition } from "../desktop/main/providers/provider-composition.mjs";

function recoverableModel(definition, modelId) {
  return {
    id: modelId, executionModel: modelId, label: "Recovered", description: "",
    visible: true, availability: "available", unavailableReason: null, availabilityNotice: null,
    isDefault: true, replacementModelId: null, upgradeInfo: null, supportedEfforts: [],
    defaultEffort: null, inputModalities: ["text"], supportsPersonality: false,
    serviceTiers: [], defaultServiceTier: null,
  };
}

describe("injectable production provider composition", () => {
  it("drives startup, repair, tombstones, and execution through one composition", async () => {
    const published = [];
    let definitions = [
      {
        id: "missing", adapterId: "fake-missing", label: "Missing API", endpoint: "https://fake.example/v1",
        accessContract: "secret@1", credentialReference: "provider:missing", lifecycleState: "active",
      },
      {
        id: "recoverable", adapterId: "recoverable-api", label: "Recoverable", endpoint: "https://recover.example/v1",
        accessContract: "secret@1", credentialReference: "provider:recoverable", lifecycleState: "active",
      },
      {
        id: "codex", adapterId: "codex-subscription", label: "Codex", endpoint: null,
        accessContract: "managed-runtime@1", credentialReference: null,
        lifecycleState: "tombstoned", removedAt: "1",
      },
    ];
    let runtimeReady = false;
    const prepareRuntime = vi.fn(async () => { runtimeReady = true; });
    const evaluateReadiness = vi.fn(async () => {});
    const missingCreate = vi.fn();
    const tombstonedCreate = vi.fn(() => { throw new Error("tombstoned provider must not be instantiated"); });
    const recoverableCreate = vi.fn(({ definition }) => {
      if (!runtimeReady) throw new Error("managed runtime unavailable");
      return {
        providerId: definition.id,
        discover: async () => ({
          provider: { id: definition.id, label: definition.label, status: "available" },
          models: [recoverableModel(definition, "recovered-model")],
          systemFamily: { id: definition.id, label: definition.label, modelIds: ["recovered-model"] },
        }),
        close: vi.fn(async () => {}),
      };
    });
    const composition = createProviderComposition({
      registry: createProviderAdapterRegistry([
        {
          adapterId: "fake-missing", implementationVersion: "1", label: "Fake API",
          accessContract: "secret@1", defaultEndpoint: "https://fake.example/v1",
          connection: { mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }] },
          create: missingCreate,
        },
        {
          adapterId: "recoverable-api", implementationVersion: "1", label: "Recoverable API",
          accessContract: "secret@1", defaultEndpoint: "https://recover.example/v1",
          connection: { mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }] },
          create: recoverableCreate,
        },
        {
          adapterId: "codex-subscription", implementationVersion: "1", label: "Codex subscription",
          accessContract: "managed-runtime@1", defaultEndpoint: null,
          connection: { mode: "managed-login", fields: [] }, create: tombstonedCreate,
        },
        {
          adapterId: "fake-composition", implementationVersion: "7", label: "Fake composition",
          accessContract: "secret@1", defaultEndpoint: "https://fake.example/v1",
          endpointEditableDuringCreation: true,
          connection: { mode: "secret-fields", fields: [{ id: "api-key", label: "API key", kind: "secret" }] },
          create: ({ definition }) => ({
            providerId: definition.id,
            discover: async () => ({
              provider: { id: definition.id, label: definition.label, status: "available" },
              models: [recoverableModel(definition, "fake-model")],
              systemFamily: { id: definition.id, label: definition.label, modelIds: [] },
            }),
            executionAccess: async () => ({ kind: "secret", endpoint: definition.endpoint, fields: { "api-key": "execution-only" } }),
            close: vi.fn(async () => {}),
          }),
        },
      ]),
      definitionStore: {
        async load() { return structuredClone(definitions); },
        async save(next) { definitions = structuredClone(next); },
        async createWithCatalog(candidate) { definitions.push(structuredClone(candidate)); },
      },
      credentialStore: {
        async get(reference) {
          if (reference === "provider:missing") return null;
          return reference === "provider:composed" ? { "api-key": "execution-only" } : { key: "opaque" };
        },
        async set() {},
        async delete() {},
        async listReferences() { return ["provider:missing", "provider:recoverable"]; },
      },
      prepareRuntime,
      evaluateReadiness,
      publishCatalog: async (snapshot) => { published.push(snapshot); },
      modelCatalogOptions: { backgroundIntervalMs: 60_000 },
    });

    await composition.start();
    expect(composition.providerDefinitions.adapters().map(({ adapterId }) => adapterId),
      "composition exposes the registry adapters").toEqual(
      ["fake-missing", "recoverable-api", "codex-subscription", "fake-composition"],
    );
    const snapshotsFor = (providerId) => published.filter((snapshot) => snapshot.providerId === providerId);
    expect(snapshotsFor("missing").at(-1), "missing persisted credentials publish unavailable").toEqual(
      expect.objectContaining({
        providerId: "missing", connected: false, models: [],
        unavailableReason: expect.objectContaining({ code: "provider_unavailable" }),
      }),
    );
    expect(snapshotsFor("recoverable").at(-1), "unready managed runtime publishes disconnected").toMatchObject({
      providerId: "recoverable", connected: false,
    });
    expect(tombstonedCreate, "tombstoned legacy provider is never instantiated").not.toHaveBeenCalled();
    expect(prepareRuntime, "startup never prepares runtimes eagerly").not.toHaveBeenCalled();

    await composition.modelCatalog.explicitRefresh("recoverable");
    expect(prepareRuntime, "explicit refresh prepares the runtime exactly once").toHaveBeenCalledOnce();
    expect(evaluateReadiness, "repair readiness evaluates the recovered catalog").toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "explicit-repair",
        providerDefinition: expect.objectContaining({ id: "recoverable" }),
        models: [expect.objectContaining({ id: "recovered-model" })],
      }),
    );
    expect(recoverableCreate, "startup attempt plus repair attempt").toHaveBeenCalledTimes(2);
    expect(snapshotsFor("recoverable").at(-1), "repaired provider publishes its recovered model").toMatchObject({
      providerId: "recoverable", connected: true, models: [{ id: "recovered-model" }],
    });
    const recoveredLease = await composition.providerDefinitions.acquireExecution("recoverable");
    expect(recoveredLease.runtime.providerId, "recovered provider hands out its runtime").toBe("recoverable");
    await recoveredLease.release();

    await composition.modelCatalog.explicitRefresh("missing");
    expect(snapshotsFor("missing"), "explicit refresh stays deterministic for missing credentials").toEqual([
      snapshotsFor("missing")[0], snapshotsFor("missing")[0],
    ]);

    const connected = await composition.providerDefinitions.connect({
      adapterId: "fake-composition", label: "Fake Work", endpoint: "https://fake.example/v1",
      fields: { "api-key": "opaque" },
    });
    const providerId = connected.providerDefinition.id;
    await composition.modelCatalog.explicitRefresh(providerId);
    expect(snapshotsFor(providerId).at(-1), "staged definition connects through discovery").toMatchObject({
      providerId, connected: true, models: [{ id: "fake-model" }],
    });
    const lease = await composition.providerDefinitions.acquireExecution(providerId);
    expect(lease.descriptor.implementationVersion, "execution carries the registry descriptor").toBe("7");
    await lease.release();
    await composition.close();
  }, 15_000);
});
