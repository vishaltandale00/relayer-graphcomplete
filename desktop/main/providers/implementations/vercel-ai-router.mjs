import {
  EXECUTION_ELIGIBLE,
  MODEL_CAPABILITY_UNKNOWN,
  MODEL_NOT_EXECUTION_ELIGIBLE,
  SecretApiProviderAdapter,
  bearerHeaders,
} from "./api-provider-adapter.mjs";

function vercelModelEligibility(model) {
  if (model?.type === "language") return EXECUTION_ELIGIBLE;
  if (["embedding", "image", "video"].includes(model?.type)) return MODEL_NOT_EXECUTION_ELIGIBLE;
  return MODEL_CAPABILITY_UNKNOWN;
}

function tokenCapabilities(model) {
  const contextWindow = model?.context_window;
  const maxOutputTokens = model?.max_tokens;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1
    || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) return null;
  return { contextWindow, maxOutputTokens };
}

export const vercelAiRouterDescriptor = Object.freeze({
  adapterId: "vercel-ai-router",
  implementationVersion: "2",
  label: "Vercel AI Gateway",
  accessContract: "secret@1",
  definitionRuntimeState: true,
  defaultEndpoint: "https://ai-gateway.vercel.sh/v1",
  endpointEditableDuringCreation: true,
  connection: { mode: "secret-fields", fields: [{ id: "api-key", label: "API key", kind: "secret", required: true }] },
  catalog: { source: "provider-discovery" },
  create: ({ definition, fetch, secrets, managedRuntime, environment }) => new SecretApiProviderAdapter({
    definition, fetch, credentials: { apiKey: secrets?.["api-key"] }, headers: bearerHeaders,
    modelCapabilities: tokenCapabilities,
    modelEligibility: vercelModelEligibility,
    requireCatalogBeforeExecution: true,
    managedRuntime, runtimeId: "codex", environment,
  }),
});
