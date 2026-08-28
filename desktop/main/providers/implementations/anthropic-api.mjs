import { SecretApiProviderAdapter, anthropicHeaders } from "./api-provider-adapter.mjs";

export const anthropicApiDescriptor = Object.freeze({
  adapterId: "anthropic-api",
  implementationVersion: "1",
  label: "Anthropic API",
  accessContract: "secret@1",
  definitionRuntimeState: true,
  defaultEndpoint: "https://api.anthropic.com/v1",
  endpointEditableDuringCreation: true,
  connection: { mode: "secret-fields", fields: [{ id: "api-key", label: "API key", kind: "secret", required: true }] },
  catalog: { source: "provider-discovery" },
  create: ({ definition, fetch, secrets, managedRuntime, environment }) => new SecretApiProviderAdapter({
    definition, fetch, credentials: { apiKey: secrets?.["api-key"] }, headers: anthropicHeaders,
    managedRuntime, runtimeId: "claude", environment,
  }),
});
