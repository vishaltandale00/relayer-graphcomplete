import {
  EXECUTION_ELIGIBLE,
  MODEL_CAPABILITY_UNKNOWN,
  MODEL_NOT_EXECUTION_ELIGIBLE,
  SecretApiProviderAdapter,
  bearerHeaders,
} from "./api-provider-adapter.mjs";

const NON_AGENT_MODEL_ID = /(?:^|[-_.])(audio|batch|embedding|image|moderation|realtime|speech|transcribe|tts|whisper)(?:$|[-_.])/i;
const REVIEWED_AGENT_MODEL_ID = /^(?:gpt-(?:5\.6(?:-(?:sol|terra|luna))?|5\.[45]|5(?:-(?:mini|nano|pro))?|4\.1(?:-(?:mini|nano))?|4o(?:-mini)?|4-turbo|3\.5-turbo)|o(?:1(?:-(?:mini|pro|preview))?|3(?:-(?:mini|pro))?|4-mini))(?:-\d{4}-\d{2}-\d{2})?$/i;

function isOpenAiAgentModel(model) {
  const id = typeof model?.id === "string" ? model.id : "";
  if (NON_AGENT_MODEL_ID.test(id) || /^(?:dall-e-|omni-moderation)/i.test(id)) {
    return MODEL_NOT_EXECUTION_ELIGIBLE;
  }
  if (REVIEWED_AGENT_MODEL_ID.test(id)) return EXECUTION_ELIGIBLE;
  return MODEL_CAPABILITY_UNKNOWN;
}

export const openAiApiDescriptor = Object.freeze({
  adapterId: "openai-api",
  implementationVersion: "2",
  label: "OpenAI API",
  accessContract: "secret@1",
  definitionRuntimeState: true,
  defaultEndpoint: "https://api.openai.com/v1",
  endpointEditableDuringCreation: true,
  connection: { mode: "secret-fields", fields: [{ id: "api-key", label: "API key", kind: "secret", required: true }] },
  catalog: { source: "provider-discovery" },
  create: ({ definition, fetch, secrets, managedRuntime, environment }) => new SecretApiProviderAdapter({
    definition, fetch, credentials: { apiKey: secrets?.["api-key"] }, headers: bearerHeaders,
    managedRuntime, runtimeId: "codex", environment, modelEligibility: isOpenAiAgentModel,
  }),
});
