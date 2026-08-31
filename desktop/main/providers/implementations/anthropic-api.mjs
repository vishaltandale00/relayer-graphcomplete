import {
  EXECUTION_ELIGIBLE,
  MODEL_CAPABILITY_UNKNOWN,
  MODEL_NOT_EXECUTION_ELIGIBLE,
  SecretApiProviderAdapter,
  anthropicHeaders,
} from "./api-provider-adapter.mjs";

function anthropicModelEligibility(model) {
  const id = typeof model?.id === "string" ? model.id : "";
  if (/(?:^|[-_.])(embedding|image|moderation|speech|tts)(?:$|[-_.])/i.test(id)) {
    return MODEL_NOT_EXECUTION_ELIGIBLE;
  }
  if (/^claude-/i.test(id)) return EXECUTION_ELIGIBLE;
  return MODEL_CAPABILITY_UNKNOWN;
}

export const anthropicApiDescriptor = Object.freeze({
  adapterId: "anthropic-api",
  implementationVersion: "2",
  label: "Anthropic API",
  accessContract: "secret@1",
  definitionRuntimeState: true,
  defaultEndpoint: "https://api.anthropic.com/v1",
  endpointEditableDuringCreation: true,
  connection: { mode: "secret-fields", fields: [{ id: "api-key", label: "API key", kind: "secret", required: true }] },
  catalog: { source: "provider-discovery" },
  create: ({ definition, fetch, secrets, managedRuntime, environment }) => new SecretApiProviderAdapter({
    definition, fetch, credentials: { apiKey: secrets?.["api-key"] }, headers: anthropicHeaders,
    managedRuntime, runtimeId: "claude", environment, modelEligibility: anthropicModelEligibility,
  }),
});
