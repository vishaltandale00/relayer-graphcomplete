import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import {
  normalizePickerSelection,
  pickerSelectionIsAvailable,
  pickerSelectionPayload,
} from "../desktop/renderer/src/model-picker-model.js";
import { newThreadRequestBody } from "../desktop/renderer/src/interaction-request-model.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const services = [];
const directories = [];

const flows = [
  {
    adapterId: "codex-subscription",
    harnessId: "codex-basic",
    accessContract: "managed-runtime@1",
    endpoint: null,
    modelIds: ["gpt-5.6-sol"],
  },
  {
    adapterId: "openai-api",
    harnessId: "codex-basic",
    accessContract: "secret@1",
    endpoint: "https://api.openai.com/v1",
    modelIds: ["gpt-5.6-sol"],
  },
  {
    adapterId: "claude-subscription",
    harnessId: "claude-basic",
    accessContract: "managed-runtime@1",
    endpoint: null,
    modelIds: ["sonnet"],
  },
  {
    adapterId: "anthropic-api",
    harnessId: "claude-basic",
    accessContract: "secret@1",
    endpoint: "https://api.anthropic.com/v1",
    modelIds: ["claude-sonnet-5"],
  },
  {
    adapterId: "openrouter",
    harnessId: "prime-agent-basic",
    accessContract: "secret@1",
    endpoint: "https://openrouter.ai/api/v1",
    modelIds: [
      "deepseek/deepseek-v4-pro-0813",
      "qwen/qwen3.8-max",
      "z-ai/glm-5.3",
    ],
  },
  {
    adapterId: "vercel-ai-router",
    harnessId: "prime-agent-basic",
    accessContract: "secret@1",
    endpoint: "https://ai-gateway.vercel.sh/v1",
    modelIds: [
      "deepseek/deepseek-v4-pro-0813",
      "alibaba/qwen3.8-max",
      "zai/glm-5.3",
    ],
  },
];

afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("straightforward discovered-model provider flows", () => {
  it.each(flows)(
    "$adapterId creates its default family for $harnessId without typed models or a custom family",
    async (flow) => {
      const { product, session } = await productFixture();
      const onboardingProviderId = `onboarding-${flow.adapterId}`;
      await addDiscoveredProvider(product, flow, onboardingProviderId);

      const completion = await productRequest(session, "/api/provider-onboarding/default", {
        method: "POST",
        body: JSON.stringify({ providerId: onboardingProviderId }),
      });
      expect(completion.defaults).toMatchObject({
        harnessId: flow.harnessId,
        providerId: onboardingProviderId,
        familyId: completion.resolution.familyId,
      });
      expect(completion.resolution.resolvableMembers).toEqual(familyMembers(
        onboardingProviderId,
        flow.modelIds,
      ));

      const afterOnboarding = await productRequest(session, "/api/model-settings");
      const onboardingFamily = familyForProvider(afterOnboarding, onboardingProviderId);
      expect(onboardingFamily).toMatchObject({ kind: "system", enabled: true });
      expect(onboardingFamily.members).toEqual(familyMembers(onboardingProviderId, flow.modelIds));
      expect(readyComposerRequest(afterOnboarding, flow.harnessId, onboardingFamily.id)).toMatchObject({
        harnessId: flow.harnessId,
        modelSelection: {
          familyId: onboardingFamily.id,
          providerId: onboardingProviderId,
          modelId: flow.modelIds[0],
        },
      });

      const preservedDefaults = structuredClone(afterOnboarding.defaults);
      const settingsProviderId = `settings-${flow.adapterId}`;
      await addDiscoveredProvider(product, flow, settingsProviderId);
      const afterSettings = await productRequest(session, "/api/model-settings");
      expect(afterSettings.defaults).toEqual(preservedDefaults);
      const settingsFamily = familyForProvider(afterSettings, settingsProviderId);
      expect(settingsFamily).toMatchObject({ kind: "system", enabled: true });
      expect(readyComposerRequest(afterSettings, flow.harnessId, settingsFamily.id)).toMatchObject({
        harnessId: flow.harnessId,
        modelSelection: {
          familyId: settingsFamily.id,
          providerId: settingsProviderId,
          modelId: flow.modelIds[0],
        },
      });
      expect(afterSettings.families.filter(({ kind }) => kind === "custom")).toEqual([]);
    },
    15_000,
  );
});

async function productFixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-provider-straightforward-"));
  directories.push(dataDirectory);
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [
      join(repositoryRoot, "harnesses", "codex-basic.yaml"),
      join(repositoryRoot, "harnesses", "claude-basic.yaml"),
      join(repositoryRoot, "harnesses", "prime-agent-basic.yaml"),
    ],
    acquireProviderExecution: async () => {
      throw new Error("Provider execution is outside this zero-inference selector test.");
    },
  });
  services.push(runtime);
  const runtimeSession = await runtime.start();
  const product = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    defaultHarnessConfiguration: "codex-basic",
  });
  services.push(product);
  const session = await product.start();
  return { product, session };
}

async function addDiscoveredProvider(product, flow, providerId) {
  await product.providerDefinitionStore().createWithCatalog({
    id: providerId,
    adapterId: flow.adapterId,
    label: providerId,
    endpoint: flow.endpoint,
    accessContract: flow.accessContract,
    credentialReference: flow.accessContract === "secret@1" ? `provider:${providerId}` : null,
    lifecycleState: "active",
    removedAt: null,
  }, catalogSnapshot(providerId, flow.modelIds));
}

function catalogSnapshot(providerId, modelIds) {
  return {
    provider: { id: providerId, label: providerId, status: "available", unavailableReason: null },
    models: modelIds.map((modelId, position) => ({
      id: modelId,
      catalogId: modelId,
      executionModel: modelId,
      label: modelId,
      description: "Provider-discovered model",
      visible: true,
      availability: "available",
      unavailableReason: null,
      unavailableReasonCode: null,
      availabilityNotice: null,
      isDefault: position === 0,
      replacementModelId: null,
      upgradeInfo: null,
      supportedEfforts: [],
      defaultEffort: null,
      inputModalities: ["text"],
      supportsPersonality: false,
      serviceTiers: [],
      defaultServiceTier: null,
      catalogSource: "deterministic-provider-fixture",
    })),
    systemFamily: {
      id: `${providerId}-reported`,
      label: `${providerId} reported`,
      modelIds,
    },
  };
}

function familyMembers(providerId, modelIds) {
  return modelIds.map((modelId, position) => ({ providerId, modelId, position }));
}

function familyForProvider(settings, providerId) {
  const family = settings.families.find((candidate) => (
    candidate.members.some((member) => member.providerId === providerId)
  ));
  if (!family) throw new Error(`Missing automatic family for ${providerId}.`);
  return family;
}

function readyComposerRequest(settings, harnessId, familyId) {
  const selection = normalizePickerSelection(settings, { harnessId, familyId });
  expect(pickerSelectionIsAvailable(settings, selection)).toBe(true);
  return newThreadRequestBody({
    title: "Ready composer",
    initialMessage: "Explain idempotency keys.",
    permissionProfileId: "ask",
    projectId: null,
    pickerPayload: pickerSelectionPayload(selection),
  });
}

async function productRequest(session, path, options = {}) {
  const response = await fetch(new URL(path, session.origin), {
    ...options,
    headers: {
      ...options.headers,
      Cookie: `${session.cookie.name}=${session.cookie.value}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}
