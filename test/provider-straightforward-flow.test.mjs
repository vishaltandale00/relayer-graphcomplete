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
  it("creates managed default families for the complete six-adapter production roster", async () => {
    const { product, session } = await productFixture();
    const observed = {};
    const failures = {};

    for (const flow of flows) {
      try {
      const onboardingProviderId = `onboarding-${flow.adapterId}`;
      await addDiscoveredProvider(product, flow, onboardingProviderId);
      const completion = await productRequest(session, "/api/provider-onboarding/default", {
        method: "POST",
        body: JSON.stringify({ providerId: onboardingProviderId }),
      });
      const afterOnboarding = await productRequest(session, "/api/model-settings");
      const onboardingFamily = familyForProvider(afterOnboarding, onboardingProviderId);
      observed[flow.adapterId] = {
        completion: {
          harnessId: completion.defaults.harnessId,
          providerId: completion.defaults.providerId,
          familyMatches: completion.defaults.familyId === completion.resolution.familyId,
          members: completion.resolution.resolvableMembers,
        },
        onboarding: familyCheckpoint(afterOnboarding, flow, onboardingProviderId, onboardingFamily),
      };
      } catch (error) {
        failures[`onboarding:${flow.adapterId}`] = error.message;
      }
    }

    const preservedDefaults = structuredClone((await productRequest(session, "/api/model-settings")).defaults);
    for (const flow of flows) {
      const settingsProviderId = `settings-${flow.adapterId}`;
      try {
        await addDiscoveredProvider(product, flow, settingsProviderId);
      } catch (error) {
        failures[`settings-create:${flow.adapterId}`] = error.message;
      }
    }
    const afterSettings = await productRequest(session, "/api/model-settings");
    for (const flow of flows) {
      try {
      const settingsProviderId = `settings-${flow.adapterId}`;
      const settingsFamily = familyForProvider(afterSettings, settingsProviderId);
      observed[flow.adapterId].settings = familyCheckpoint(
        afterSettings,
        flow,
        settingsProviderId,
        settingsFamily,
      );
      } catch (error) {
        failures[`settings-project:${flow.adapterId}`] = error.message;
      }
    }

    expect({ failures, observed }).toEqual({ failures: {}, observed: Object.fromEntries(flows.map((flow) => {
      const onboardingProviderId = `onboarding-${flow.adapterId}`;
      const settingsProviderId = `settings-${flow.adapterId}`;
      return [flow.adapterId, {
        completion: {
          harnessId: flow.harnessId,
          providerId: onboardingProviderId,
          familyMatches: true,
          members: familyMembers(onboardingProviderId, flow.modelIds),
        },
        onboarding: expectedFamilyCheckpoint(flow, onboardingProviderId),
        settings: expectedFamilyCheckpoint(flow, settingsProviderId),
      }];
    })) });
    expect(afterSettings.defaults).toEqual(preservedDefaults);
    expect(afterSettings.families.filter(({ kind }) => kind === "custom")).toEqual([]);
  }, 15_000);
});

function familyCheckpoint(settings, flow, providerId, family) {
  const selection = normalizePickerSelection(settings, { harnessId: flow.harnessId, familyId: family.id });
  const composer = newThreadRequestBody({
    title: "Ready composer",
    initialMessage: "Explain idempotency keys.",
    permissionProfileId: "ask",
    projectId: null,
    pickerPayload: pickerSelectionPayload(selection),
  });
  return {
    kind: family.kind,
    enabled: family.enabled,
    members: family.members,
    selectionAvailable: pickerSelectionIsAvailable(settings, selection),
    composer: {
      harnessId: composer.harnessId,
      providerId: composer.modelSelection.providerId,
      modelId: composer.modelSelection.modelId,
      familyMatches: composer.modelSelection.familyId === family.id,
    },
  };
}

function expectedFamilyCheckpoint(flow, providerId) {
  return {
    kind: "system",
    enabled: true,
    members: familyMembers(providerId, flow.modelIds),
    selectionAvailable: true,
    composer: {
      harnessId: flow.harnessId,
      providerId,
      modelId: flow.modelIds[0],
      familyMatches: true,
    },
  };
}

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
