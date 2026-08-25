import { CodexCredentialAdapter } from "../../credentials/codex-credential-adapter.mjs";
import { CodexModelCatalogAdapter } from "../../models/codex-model-catalog-adapter.mjs";

export const codexSubscriptionDescriptor = Object.freeze({
  adapterId: "codex-subscription",
  implementationVersion: "1",
  label: "Codex subscription",
  accessContract: "managed-runtime@1",
  defaultEndpoint: null,
  endpointEditableDuringCreation: false,
  connection: { mode: "managed-login", fields: [] },
  catalog: { source: "provider-discovery" },
  create: ({ definition, environment, onAccountChanged, spawnProcess, shutdownTimeoutMs }) => {
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
          executable: credentials.executable,
          environment: Object.freeze({ ...credentials.environment }),
        });
      },
      close: () => credentials.close(),
    });
  },
});
