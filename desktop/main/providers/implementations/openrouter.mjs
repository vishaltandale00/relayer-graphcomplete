import { SecretApiProviderAdapter, bearerHeaders } from "./api-provider-adapter.mjs";

export const openRouterDescriptor = Object.freeze({
  adapterId: "openrouter",
  implementationVersion: "1",
  label: "OpenRouter",
  accessContract: "secret@1",
  definitionRuntimeState: true,
  defaultEndpoint: "https://openrouter.ai/api/v1",
  endpointEditableDuringCreation: true,
  connection: { mode: "secret-fields", fields: [{ id: "api-key", label: "API key", kind: "secret", required: true }] },
  catalog: { source: "provider-discovery" },
  create: ({ definition, fetch, secrets, managedRuntime, environment }) => new SecretApiProviderAdapter({
    definition, fetch, credentials: { apiKey: secrets?.["api-key"] }, headers: bearerHeaders,
    managedRuntime, runtimeId: "codex", environment,
  }),
});
