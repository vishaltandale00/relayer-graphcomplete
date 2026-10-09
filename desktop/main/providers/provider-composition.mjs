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
  accountCheckTimeoutMs,
  diagnostics = null,
  modelCatalogOptions = {},
}) {
  // The models each provider's catalog last published in this process. A post-upgrade
  // readiness evaluation evaluates the routes they give (#556).
  const publishedModels = new Map();
  const modelCatalog = new ModelCatalogService({
    adapters: [],
    diagnostics,
    // Each refresh carries the connection generation it started with (PROV-002). None runs
    // while a reconnect is pending.
    connectionGenerations: {
      current: (providerId) => providerDefinitions.refreshGeneration(providerId),
      resync: (providerId) => providerDefinitions.resyncConnectionGeneration(providerId),
    },
    publishSnapshot: async (snapshot, options) => {
      const published = await publishCatalog(snapshot, options);
      publishedModels.set(snapshot.providerId, {
        models: snapshot.models ?? [],
        connected: snapshot.connected === true,
        generation: options?.connectionGeneration,
      });
      providerDefinitions.catalogPublished(snapshot.providerId, { connected: snapshot.connected, models: snapshot.models ?? [] });
      if (options?.reason === "explicit" && snapshot.connected === true) {
        await providerDefinitions.evaluateCatalogReadiness(
          snapshot.providerId,
          snapshot.models ?? [],
          "explicit-repair",
          options,
        );
        // The catalog committed before readiness, so its exact generation authorizes setup.
        // A lifecycle change during setup still makes the refresh result superseded.
        if (providerDefinitions.refreshGeneration(snapshot.providerId) !== options.connectionGeneration) {
          throw Object.assign(new Error("provider_connection_superseded"), { code: "provider_connection_superseded" });
        }
      }
      return published;
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
    accountCheckTimeoutMs,
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
          if (reason !== "explicit" && reason !== "recovery") {
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
    // Refuses new provider access and lifecycle actions at once, before shutdown awaits other
    // services; close() then tears the providers down.
    beginShutdown() {
      providerDefinitions.beginShutdown();
    },
    async start() {
      await providerDefinitions.reconcileStartup();
      await providerDefinitions.activate();
      await modelCatalog.startup();
    },
    // After an upgrade: recovers, as Repair does, each managed provider whose activation
    // failed and whose runtime recipe is one of recipeIds (installed, and due for an
    // evaluation). Its "recovery" refresh reinstalls the exact recipe when needed, activates
    // the provider and publishes the catalog that recovery discovered, once. It evaluates no
    // readiness: the post-upgrade step then evaluates each due harness once for all its
    // providers. One failure spares the rest; a stopped step recovers no further provider.
    async repairFailedActivations(recipeIds, { recipeForAdapter, signal } = {}) {
      const recipes = new Set(recipeIds);
      const failed = (await providerDefinitions.activeDefinitions()).filter((definition) => {
        if (definition.accessContract !== "managed-runtime@1") return false;
        if (!providerDefinitions.activationFailed(definition.id)) return false;
        try { return recipes.has(recipeForAdapter(definition.adapterId)); } catch { return false; }
      });
      const results = [];
      for (const { id } of failed) {
        if (signal?.aborted) break;
        try {
          results.push({ status: "fulfilled", value: await modelCatalog.refresh(id, "recovery", { signal }) });
        } catch (reason) {
          results.push({ status: "rejected", reason });
        }
      }
      return results;
    },
    // Every active provider with its last published models, for an evaluation that is not
    // tied to one provider (the recipe-update trigger).
    async readinessRoutes() {
      return (await providerDefinitions.activeDefinitions())
        .filter(({ id }) => {
          const snapshot = publishedModels.get(id);
          const generation = providerDefinitions.readinessGeneration(id);
          return snapshot?.connected === true && snapshot.models.length > 0
            && generation !== null && generation === snapshot.generation;
        })
        .map((providerDefinition) => Object.freeze({
          providerDefinition,
          models: publishedModels.get(providerDefinition.id).models,
          ...providerDefinitions.readinessAuthorization(providerDefinition.id, publishedModels.get(providerDefinition.id).generation),
        }));
    },
    async close() {
      const results = await Promise.allSettled([providerDefinitions.close(), modelCatalog.close()]);
      const failures = results.filter(({ status }) => status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(({ reason }) => reason), "Provider composition did not close cleanly.");
    },
  });
}
