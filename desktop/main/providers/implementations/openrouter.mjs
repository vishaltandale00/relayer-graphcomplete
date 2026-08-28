import { SecretApiProviderAdapter, bearerHeaders } from "./api-provider-adapter.mjs";

function tokenCapabilities(model) {
  const contextWindow = model?.top_provider?.context_length;
  const maxOutputTokens = model?.top_provider?.max_completion_tokens;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1
    || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) return null;
  return { contextWindow, maxOutputTokens };
}

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
    modelCapabilities: tokenCapabilities,
    requireCatalogBeforeExecution: true,
    managedRuntime, runtimeId: "codex", environment,
  }),
});
