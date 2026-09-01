import { ModelCatalogService } from "../models/model-catalog-service.mjs";
import {
  toProductCatalogSnapshot,
  unavailableModelCatalogSnapshot,
} from "../models/model-catalog-adapter.mjs";
import { ProviderDefinitionService } from "./provider-definition-service.mjs";

export function createProviderComposition({
  registry,
  definitionStore,
  credentialStore,
  publishCatalog,
  providerStatuses = async () => new Map(),
  runtimeDependencies = async () => ({}),
  prepareRuntime = async () => null,
  evaluateReadiness = async () => null,
  removeRuntimeState = async () => false,
  diagnostics = null,
  modelCatalogOptions = {},
}) {
  const modelCatalog = new ModelCatalogService({
    adapters: [],
    diagnostics,
    publishSnapshot: async (snapshot, options) => {
      if (options?.reason === "explicit") {
        await providerDefinitions.evaluateCatalogReadiness(
          snapshot.providerId,
          snapshot.models ?? [],
          "explicit-repair",
        );
      }
      return publishCatalog(snapshot, options);
    },
    ...modelCatalogOptions,
  });
  let providerDefinitions;
  providerDefinitions = new ProviderDefinitionService({
    registry,
    definitionStore,
    credentialStore,
    diagnostics,
    providerStatuses,
    runtimeDependencies,
    prepareRuntime,
    evaluateReadiness,
    removeRuntimeState,
    publishCatalog: (snapshot, options) => publishCatalog(toProductCatalogSnapshot(snapshot), options),
    onRuntimeReady: (definition, runtime) => {
      modelCatalog.unregister(definition.id);
      modelCatalog.register(runtime.catalog ?? runtime);
    },
    onRuntimeRemoved: (definition) => modelCatalog.unregister(definition.id),
    onRuntimeChanged: (definition) => modelCatalog.providerChanged(definition.id),
    onRuntimeUnavailable: (definition) => {
      modelCatalog.unregister(definition.id);
      modelCatalog.register({
        providerId: definition.id,
        discover: async ({ signal, reason } = {}) => {
          if (reason !== "explicit") {
            return unavailableModelCatalogSnapshot({
              providerId: definition.id,
              providerLabel: definition.label,
            }, "The provider could not be activated.");
          }
          try {
            return await providerDefinitions.recoverUnavailable(definition.id, { signal });
          } catch (error) {
            if (signal?.aborted) throw error;
            return unavailableModelCatalogSnapshot({
              providerId: definition.id,
              providerLabel: definition.label,
            }, "The provider could not be activated.");
          }
        },
      });
    },
  });
  return Object.freeze({
    modelCatalog,
    providerDefinitions,
    async start() {
      await providerDefinitions.reconcileStartup();
      await providerDefinitions.activate();
      await modelCatalog.startup();
    },
    async close() {
      const results = await Promise.allSettled([providerDefinitions.close(), modelCatalog.close()]);
      const failures = results.filter(({ status }) => status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(({ reason }) => reason), "Provider composition did not close cleanly.");
    },
  });
}
