import { SecretApiProviderAdapter, bearerHeaders } from "./api-provider-adapter.mjs";

export const openAiApiDescriptor = Object.freeze({
  adapterId: "openai-api",
  implementationVersion: "1",
  label: "OpenAI API",
  accessContract: "secret@1",
  defaultEndpoint: "https://api.openai.com/v1",
  endpointEditableDuringCreation: true,
  connection: { mode: "secret-fields", fields: [{ id: "api-key", label: "API key", kind: "secret", required: true }] },
  catalog: { source: "provider-discovery" },
  create: ({ definition, fetch, secrets, managedRuntime, environment }) => new SecretApiProviderAdapter({
    definition, fetch, credentials: { apiKey: secrets?.["api-key"] }, headers: bearerHeaders,
    managedRuntime, runtimeId: "codex", environment,
  }),
});
