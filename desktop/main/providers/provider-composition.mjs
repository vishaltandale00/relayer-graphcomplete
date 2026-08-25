import { ModelCatalogService } from "../models/model-catalog-service.mjs";
import { toProductCatalogSnapshot } from "../models/model-catalog-adapter.mjs";
import { ProviderDefinitionService } from "./provider-definition-service.mjs";

export function createProviderComposition({
  registry,
  definitionStore,
  credentialStore,
  publishCatalog,
  providerStatuses = async () => new Map(),
  runtimeDependencies = async () => ({}),
  removeRuntimeState = async () => false,
  diagnostics = null,
  modelCatalogOptions = {},
}) {
  const modelCatalog = new ModelCatalogService({
    adapters: [],
    diagnostics,
    publishSnapshot: publishCatalog,
    ...modelCatalogOptions,
  });
  const providerDefinitions = new ProviderDefinitionService({
    registry,
    definitionStore,
    credentialStore,
    diagnostics,
    providerStatuses,
    runtimeDependencies,
    removeRuntimeState,
    publishCatalog: (snapshot, options) => publishCatalog(toProductCatalogSnapshot(snapshot), options),
    onRuntimeReady: (_definition, runtime) => modelCatalog.register(runtime.catalog ?? runtime),
    onRuntimeRemoved: (definition) => modelCatalog.unregister(definition.id),
    onRuntimeChanged: (definition) => modelCatalog.providerChanged(definition.id),
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
