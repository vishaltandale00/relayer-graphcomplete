import { describe, expect, it, vi } from "vitest";

import { createProviderAdapterRegistry } from "../desktop/main/providers/provider-adapter-contract.mjs";
import { createProviderComposition } from "../desktop/main/providers/provider-composition.mjs";

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
});
