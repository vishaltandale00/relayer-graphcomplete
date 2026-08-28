import { CodexCredentialAdapter } from "../../credentials/codex-credential-adapter.mjs";
import { CodexModelCatalogAdapter } from "../../models/codex-model-catalog-adapter.mjs";
import { managedRuntimeExecutionDetails, requireManagedRuntime } from "./managed-runtime-contract.mjs";

export const codexSubscriptionDescriptor = Object.freeze({
  adapterId: "codex-subscription",
  implementationVersion: "1",
  label: "Codex subscription",
  accessContract: "managed-runtime@1",
  defaultEndpoint: null,
  endpointEditableDuringCreation: false,
  connection: { mode: "managed-login", fields: [] },
  catalog: { source: "provider-discovery" },
  create: ({ definition, environment, managedRuntime: runtimeDescriptor, onAccountChanged, spawnProcess, shutdownTimeoutMs }) => {
    const managedRuntime = requireManagedRuntime(runtimeDescriptor, "codex");
    if (environment?.RELAYER_CODEX_BINARY !== managedRuntime.executable) {
      throw new Error("Codex credential launch requires the provisioned managed runtime executable.");
    }
    const credentials = new CodexCredentialAdapter({
      providerDefinitionId: definition.id,
      environment,
      onAccountChanged,
      spawnProcess,
      shutdownTimeoutMs,
    });
    return Object.freeze({
      descriptor: codexSubscriptionDescriptor,
      definition,
      credentials,
      catalog: new CodexModelCatalogAdapter({
        credentials,
        providerId: definition.id,
        providerLabel: definition.label,
      }),
      executionAccess: async ({ signal } = {}) => {
        const account = await credentials.account({ signal });
        if (account?.status !== "connected") throw new Error("Codex subscription is not connected.");
        return Object.freeze({
          kind: "managed-runtime",
          ...managedRuntimeExecutionDetails(managedRuntime, credentials.environment),
        });
      },
      close: () => credentials.close(),
    });
  },
});
