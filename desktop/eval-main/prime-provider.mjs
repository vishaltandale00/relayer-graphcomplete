import { readFile } from "node:fs/promises";
import { createManagedRuntimeInstaller } from "../main/managed-runtimes/installer.mjs";
import { createManagedRuntimeResolver } from "../main/managed-runtimes/resolver.mjs";
import { createProviderComposition } from "../main/providers/provider-composition.mjs";
import { productionProviderAdapterRegistry, productionHarnessRuntimeDescriptor, productionProviderRuntimeDependencies } from "../main/providers/provider-adapter-registry.mjs";
import { assemblePrimeManagedRuntime, checkPrimeManagedRuntime, createPrimeReviewedTreeCopier } from "../main/services/prime-managed-runtime.mjs";
import { PRIME_AGENT_ASSET_SHA256, selectPrimeAgentDependencyClosureSha256 } from "../main/services/prime-agent-runtime.mjs";
import { createHarnessReadinessCoordinator } from "../main/services/harness-readiness.mjs";
import { HARNESS_MANAGED_RUNTIME_REQUIREMENTS, managedRuntimeRequirementForHarness } from "../shared/managed-runtime-requirements.mjs";

// Explicit development opt-in. Credentials never become part of an Eval selection
// or run record; the Eval host retains them in memory until shutdown.
export async function loadEvalPrimeProfile({ isPackaged, environment = process.env }) {
  const path = environment.RELAYER_EVAL_PRIME_PROFILE_FILE;
  if (!path) return null;
  if (isPackaged) throw new Error("Local Prime Eval profiles are development-only.");
  let profile;
  try {
    const document = JSON.parse(await readFile(path, "utf8"));
    profile = document.runs?.[environment.RELAYER_EVAL_PRIME_PROFILE || "prime-openrouter"];
  } catch {
    throw new Error("Could not read the local Prime Eval profile.");
  }
  if (profile?.auth?.kind !== "openrouter" || typeof profile.auth.apiKey !== "string"
    || !profile.auth.apiKey.trim() || typeof profile.modelId !== "string" || !profile.modelId.trim()
    || typeof profile.verificationHelperModelId !== "string" || !profile.verificationHelperModelId.trim()
    || profile.modelId === profile.verificationHelperModelId) {
    throw new Error("Prime Eval requires an OpenRouter credential and two distinct explicit model IDs.");
  }
  return { apiKey: profile.auth.apiKey, endpoint: profile.auth.endpoint ?? undefined,
    modelIds: [profile.modelId, profile.verificationHelperModelId] };
}

export function createEvalManagedPrimeRuntime({ root, appRoot, pythonClientRoot, isPackaged,
  createInstaller = createManagedRuntimeInstaller }) {
  let installer;
  let resolver;
  const getInstaller = () => installer ??= createInstaller({ root, assembleRecipe: async (context) => {
    if (context.recipe.runtimeId !== "prime") return;
    await assemblePrimeManagedRuntime(context, {
      copyReviewedTrees: createPrimeReviewedTreeCopier({ appRoot, pythonClientRoot,
        expectedClosureSha256: selectPrimeAgentDependencyClosureSha256({
          isPackaged, javascriptContract: context.recipe.runtimeContract.javascript,
        }),
        expectedPythonClientSha256: PRIME_AGENT_ASSET_SHA256.pythonPackageTree,
      }),
    });
  } });
  const getResolver = () => resolver ??= createManagedRuntimeResolver(getInstaller());
  const recipeId = managedRuntimeRequirementForHarness("prime.agent").recipeId;
  return { installer: {
    activeOperations: () => installer?.activeOperations() ?? [],
    cancelAll: (reason) => installer?.cancelAll(reason) ?? Promise.resolve(),
  },
    prepare: async () => productionHarnessRuntimeDescriptor(await getResolver().prepare(recipeId)),
    resolve: async () => productionHarnessRuntimeDescriptor(await getResolver().get(recipeId)),
  };
}

export function createEvalPrimeProvider({ userDataDirectory, productServer, productSession,
  runtimeSession, graphRuntime, managedPrimeRuntime, managedCodexRuntime,
  fetchImpl = fetch, createComposition = createProviderComposition }) {
  const request = async (path, { method = "GET", body } = {}) => {
    const response = await fetchImpl(new URL(path, productSession.origin), {
      method, headers: { "Content-Type": "application/json",
        Cookie: `${productSession.cookie.name}=${productSession.cookie.value}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Provider response bodies are not safe to reflect into Eval artifacts.
    if (!response.ok) throw new Error(`Prime Eval product admission failed (${response.status}).`);
    return response.status === 204 ? undefined : response.json();
  };
  const configurations = new Map([...runtimeSession.configurations].filter(([, configuration]) => (
    configuration.implementation === "prime.agent"
  )));
  const readiness = createHarnessReadinessCoordinator({ configurations,
    digestConfiguration: runtimeSession.digestConfiguration,
    runtimeRequirements: HARNESS_MANAGED_RUNTIME_REQUIREMENTS,
    prepareRecipe: () => managedPrimeRuntime.prepare(),
    checkers: { "prime.agent": ({ runtime }) => checkPrimeManagedRuntime({ runtime }) },
    publishAvailability: async (updates) => {
      await productServer.publishHarnessReadiness(updates);
      await graphRuntime.recordHarnessReadiness(updates);
    },
  });
  const entries = new Map();
  const credentialStore = {
    set: async (reference, value) => { entries.set(reference, structuredClone(value)); },
    get: async (reference) => entries.has(reference) ? structuredClone(entries.get(reference)) : null,
    delete: async (reference) => entries.delete(reference),
    listReferences: async () => [...entries.keys()],
  };
  const composition = createComposition({
    registry: productionProviderAdapterRegistry,
    definitionStore: productServer.providerDefinitionStore(),
    credentialStore,
    providerStatuses: () => productServer.providerStatuses(),
    runtimeDependencies: async (definition) => {
      if (definition.accessContract === "secret@1") {
        return productionProviderRuntimeDependencies(definition, {});
      }
      if (definition.id !== "codex" || definition.adapterId !== "codex-subscription") {
        throw new Error("This provider has no Desktop Eval execution adapter.");
      }
      // Preserve Eval's existing Codex login environment when composition reopens
      // a profile containing the built-in Codex definition. Do not move its home.
      const runtime = await managedCodexRuntime.resolve();
      return {
        managedRuntime: { runtimeId: "codex", ...runtime },
        environment: { ...runtime.environment, RELAYER_CODEX_BINARY: runtime.executable },
      };
    },
    evaluateReadiness: (input) => readiness.evaluate(input),
    publishCatalog: (snapshot, options) => productServer.publishProviderCatalog(snapshot, options),
  });
  let modelIds;
  let familyId;
  let ready = false;
  const selections = new Map();
  const unavailable = { available: false, unavailableReason: "Prime provider, model family, or runtime is unavailable." };
  return {
    async start(profile) {
      try {
        {
          const definitions = await productServer.providerDefinitionStore().load();
          const existing = definitions.find(({ id }) => id === "eval-openrouter");
          if (existing) {
            if (existing.adapterId !== "openrouter" || existing.lifecycleState !== "active"
              || existing.endpoint !== (profile.endpoint ?? "https://openrouter.ai/api/v1")) {
              throw new Error("Existing Eval provider does not match the requested provider.");
            }
            await credentialStore.set(existing.credentialReference, { "api-key": profile.apiKey });
          }
        }
        await composition.start();
        const existing = (await composition.providerDefinitions.list()).find(({ id }) => id === "eval-openrouter");
        if (existing) {
          if (existing.adapterId !== "openrouter" || existing.lifecycleState !== "active"
            || existing.endpoint !== (profile.endpoint ?? "https://openrouter.ai/api/v1")) {
            throw new Error("Existing Eval provider does not match the requested provider.");
          }
          const stored = await credentialStore.get(existing.credentialReference);
          if (stored?.["api-key"] !== profile.apiKey) {
            throw new Error("The supplied key differs from this profile's connected credential.");
          }
          await composition.modelCatalog.refresh("eval-openrouter", "explicit");
        } else {
          await composition.providerDefinitions.connect({ connectionId: "eval-openrouter",
            harnessId: "prime-agent-basic", adapterId: "openrouter", label: "Eval OpenRouter",
            endpoint: profile.endpoint, fields: { "api-key": profile.apiKey } });
        }
        modelIds = [...profile.modelIds];
        const settings = await request("/api/model-settings");
        const provider = settings.providers?.find(({ id }) => id === "eval-openrouter");
        if (!provider?.connected || modelIds.some((id) => !provider.models?.some((model) => (
          model.id === id && model.available !== false && model.visible !== false
        )))) throw new Error("Both requested Prime models must be available in the discovered catalog.");
        const members = modelIds.map((modelId) => ({ providerId: "eval-openrouter", modelId }));
        const name = "Eval Prime pinned models";
        const existingFamily = settings.families?.find((family) => family.name === name);
        if (existingFamily) {
          familyId = existingFamily.id;
        } else {
          familyId = (await request("/api/model-families", { method: "POST", body: { name, enabled: true, members } })).id;
        }
        await refreshSelections();
        if (!selections.has("prime-agent-basic")) throw new Error("Prime basic is unavailable.");
        ready = true;
      } catch {
        // Do not serialize arbitrary provider errors, which can contain credentials.
        throw new Error("Prime Eval provider setup failed; no Prime run was admitted.");
      }
    },
    availability: (harnessId) => selections.has(harnessId)
      ? { available: true, unavailableReason: null } : unavailable,
    async refreshAvailability() {
      if (!ready) return;
      try {
        await composition.modelCatalog.refresh("eval-openrouter", "settings-open");
        await refreshSelections();
      } catch { selections.clear(); }
    },
    async select(harnessId) {
      if (!ready) throw new Error("Prime Eval requires a connected provider and a pinned model family.");
      try { await composition.modelCatalog.refresh("eval-openrouter", "pre-inference"); }
      catch {
        selections.clear();
        throw new Error("Prime Eval catalog refresh failed; no run was admitted.");
      }
      try {
        const selected = await validate(harnessId);
        selections.set(harnessId, selected);
        return selected;
      } catch (error) {
        selections.delete(harnessId);
        throw error;
      }
    },
    acquireExecution: (id) => composition.providerDefinitions.acquireExecution(id),
    close: async () => { try { await composition.close(); } finally { entries.clear(); } },
  };
  async function refreshSelections() {
    selections.clear();
    // Admit the required basic route explicitly; additional configurations
    // qualify independently through the product resolver.
    for (const harnessId of new Set(["prime-agent-basic", ...configurations.keys()])) {
      try { selections.set(harnessId, await validate(harnessId)); }
      catch { /* This route stays visibly unavailable; other routes may be ready. */ }
    }
  }
  async function validate(harnessId) {
    const settings = await request("/api/model-settings");
    const family = settings.families?.find(({ id }) => id === familyId);
    const expected = modelIds.map((modelId) => ({ providerId: "eval-openrouter", modelId }));
    if (!family?.enabled || JSON.stringify(family.members.map(({ providerId, modelId }) => ({ providerId, modelId }))) !== JSON.stringify(expected)) {
      throw new Error("Prime Eval family roster changed; refusing model fallback or additional models.");
    }
    // Validate every member through the same product resolver, then pin the lead.
    const selections = [];
    for (const modelId of modelIds) {
      const selection = { harnessId, familyId, providerId: "eval-openrouter", modelId };
      const resolved = await request("/api/model-selection/validate", { method: "POST", body: selection });
      if (resolved.familyId !== familyId || resolved.providerId !== selection.providerId || resolved.modelId !== modelId) {
        throw new Error("Prime Eval model resolution changed the requested identity.");
      }
      selections.push(resolved);
    }
    return selections[0];
  }
}
