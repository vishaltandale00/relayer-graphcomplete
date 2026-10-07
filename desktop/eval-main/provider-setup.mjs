import { abortable } from "./abortable.mjs";
import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createManagedRuntimeInstaller } from "../main/managed-runtimes/installer.mjs";
import { createManagedRuntimeResolver, managedRecipeInstalled } from "../main/managed-runtimes/resolver.mjs";
import { createProviderComposition } from "../main/providers/provider-composition.mjs";
import { productionProviderAdapterRegistry, productionHarnessRuntimeDescriptor, productionProviderRuntimeDependencies } from "../main/providers/provider-adapter-registry.mjs";
import { createProviderRuntimeStateRemover } from "../main/providers/provider-runtime-state.mjs";
import { createHarnessReadinessCoordinator, createPostUpgradeReadiness } from "../main/services/harness-readiness.mjs";
import { assemblePrimeManagedRuntime, checkPrimeManagedRuntime, createPrimeReviewedTreeCopier } from "../main/services/prime-managed-runtime.mjs";
import { PRIME_AGENT_ASSET_SHA256, selectPrimeAgentDependencyClosureSha256 } from "../main/services/prime-agent-runtime.mjs";
import { HARNESS_MANAGED_RUNTIME_REQUIREMENTS, managedRuntimeRequirementForAdapter } from "../shared/managed-runtime-requirements.mjs";

// Recognize only our auth setting and native Codex's generated project trust
// entries. This is deliberately not a permissive TOML/configuration parser.
function isIsolatedCodexConfig(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  if (lines.shift() !== 'cli_auth_credentials_store = "file"') return false;
  const projects = new Set();
  while (lines.length) {
    const match = /^\[projects\.("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\]$/.exec(lines.shift());
    if (!match) return false;
    let path;
    try { path = JSON.parse(match[1]); } catch { return false; }
    if (!path || projects.has(path)) return false;
    projects.add(path);
    if (!/^trust_level = "(?:trusted|untrusted)"$/.test(lines.shift() ?? "")) return false;
  }
  return true;
}

// The host injects its secure credential store; tests may use an ephemeral store.
// Native login adapters retain their own profile-scoped credential state.
export function createEvalProviderSetup({ userDataDirectory, productServer, productSession,
  runtimeSession, appRoot, pythonClientRoot, isBusy = () => false,
  environment = process.env, fetchImpl = fetch, registry = productionProviderAdapterRegistry,
  createInstaller = createManagedRuntimeInstaller, runtimeResolver: injectedResolver,
  createComposition = createProviderComposition, checkPrime = checkPrimeManagedRuntime,
  credentialStore: suppliedCredentialStore, secretsPersisted = false, now = Date.now, loginTimeoutMs = 10 * 60_000,
  scheduleTimeout = setTimeout, cancelTimeout = clearTimeout }) {
  const runtimeRoot = join(userDataDirectory, "provider-runtime");
  const legacyCodexHome = join(userDataDirectory, "codex-home");
  let installer;
  let resolver = injectedResolver;
  const getResolver = () => {
    if (resolver) return resolver;
    installer = createInstaller({ root: join(userDataDirectory, "managed-runtimes"),
      assembleRecipe: async (context) => {
        if (context.recipe.runtimeId !== "prime") return;
        await assemblePrimeManagedRuntime(context, {
          copyReviewedTrees: createPrimeReviewedTreeCopier({ appRoot, pythonClientRoot,
            expectedClosureSha256: selectPrimeAgentDependencyClosureSha256({ isPackaged: false,
              javascriptContract: context.recipe.runtimeContract.javascript }),
            expectedPythonClientSha256: PRIME_AGENT_ASSET_SHA256.pythonPackageTree,
          }),
        });
      },
    });
    resolver = createManagedRuntimeResolver(installer);
    return resolver;
  };
  const runtime = async (recipeId, prepare = false) => productionHarnessRuntimeDescriptor(
    await getResolver()[prepare ? "prepare" : "get"](recipeId), { environment });
  const configurations = new Map([...runtimeSession.configurations].filter(([, value]) => (
    Object.hasOwn(HARNESS_MANAGED_RUNTIME_REQUIREMENTS, value.implementation)
  )));
  const selections = new Map();
  const pendingLoginDeadlines = new Map();
  const entries = new Map();
  const credentialStore = suppliedCredentialStore ?? {
    set: async (key, value) => { entries.set(key, structuredClone(value)); },
    get: async (key) => entries.has(key) ? structuredClone(entries.get(key)) : null,
    delete: async (key) => entries.delete(key),
    listReferences: async () => [...entries.keys()],
  };
  const readiness = createHarnessReadinessCoordinator({ configurations,
    digestConfiguration: runtimeSession.digestConfiguration,
    runtimeRequirements: HARNESS_MANAGED_RUNTIME_REQUIREMENTS,
    prepareRecipe: (recipeId) => runtime(recipeId, true),
    checkers: {
      "codex.basic": async ({ runtime: value }) => ({ available: value?.runtimeId === "codex" && !!value.executable }),
      "claude.basic": async ({ runtime: value }) => ({ available: value?.runtimeId === "claude" && !!value.executable && !!value.moduleUrl }),
      "prime.agent": ({ runtime: value, signal }) => checkPrime({ runtime: value, signal }),
    },
    publishAvailability: async (updates) => {
      await productServer.publishHarnessReadiness(updates);
    },
    recipeInstalled: (recipeId) => managedRecipeInstalled(getResolver(), recipeId),
  });
  const composition = createComposition({ registry,
    definitionStore: productServer.providerDefinitionStore(), credentialStore,
    providerStatuses: () => productServer.providerStatuses(),
    removeRuntimeState: createProviderRuntimeStateRemover({ runtimeRoot, registry }),
    runtimeDependencies: async (definition) => {
      if (definition.accessContract === "secret@1") return productionProviderRuntimeDependencies(definition, {});
      const managedRuntime = await runtime(managedRuntimeRequirementForAdapter(definition.adapterId).recipeId);
      const dependencies = await productionProviderRuntimeDependencies(definition, {
        runtimeRoot, legacyCodexHome, environment, managedRuntime,
      });
      // Native Codex file auth is isolated in this Eval profile, including new
      // named subscriptions. Do not accidentally share an OS keychain login.
      if (dependencies.environment?.CODEX_HOME) {
        await mkdir(dependencies.environment.CODEX_HOME, { recursive: true, mode: 0o700 });
        const configPath = join(dependencies.environment.CODEX_HOME, "config.toml");
        const isolatedConfig = 'cli_auth_credentials_store = "file"\n';
        try { await writeFile(configPath, isolatedConfig, { flag: "wx", mode: 0o600 }); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          // Native Codex can append project trust entries after login/use. Preserve
          // those bytes, but continue rejecting arbitrary execution configuration.
          if (!isIsolatedCodexConfig(await readFile(configPath, "utf8"))) {
            throw Object.assign(new Error("Existing Codex config cannot prove file-backed authentication."), { code: "EVAL_CODEX_AUTH_CONFIG_UNSAFE" });
          }
        }
      }
      return dependencies;
    },
    prepareRuntime: async ({ adapterId }) => {
      if (registry.get(adapterId).accessContract !== "secret@1") {
        await runtime(managedRuntimeRequirementForAdapter(adapterId).recipeId, true);
      }
    },
    evaluateReadiness: (input) => readiness.evaluate(input),
    publishCatalog: (snapshot, options) => productServer.publishProviderCatalog(snapshot, options),
  });
  async function request(path, { method = "GET", body, signal } = {}) {
    const response = await fetchImpl(new URL(path, productSession.origin), {
      method, signal, headers: { "Content-Type": "application/json",
        Cookie: `${productSession.cookie.name}=${productSession.cookie.value}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Eval model setup request failed (${response.status}).`);
    return response.status === 204 ? undefined : response.json();
  }
  async function defaultSelection(harnessId) {
    const selected = await request(`/api/model-selection/default?harnessId=${encodeURIComponent(harnessId)}`);
    if (!selected) throw new Error("No available model for this Eval harness. Configure a compatible provider and family in Settings.");
    return request("/api/model-selection/validate", { method: "POST", body: selected });
  }
  async function refreshAvailability() {
    selections.clear();
    await Promise.all([...configurations.keys()].map(async (harnessId) => {
      try { const selection = await defaultSelection(harnessId); selections.set(harnessId, selection); } catch { /* Product resolver remains the authority for admission. */ }
    }));
  }
  async function mutation(operation) {
    if (await isBusy()) throw new Error("Finish active Eval work before changing provider setup.");
    try {
      const result = await operation();
      await refreshAvailability();
      return result;
    } catch (error) {
      const storageMessages = {
        EVAL_CODEX_AUTH_CONFIG_UNSAFE: 'Eval Codex requires its profile config.toml to contain cli_auth_credentials_store = "file" and optional Codex project trust entries. Existing configuration was preserved; review and replace it before reconnecting.',
        EVAL_LOGIN_TIMEOUT: "Provider sign-in expired. Connect again to start a new sign-in.",
        EVAL_CREDENTIAL_UNSUPPORTED: "Persistent Eval API credentials currently require macOS Keychain. Native subscription connections are still available.",
        EVAL_CREDENTIAL_UNAVAILABLE: "Eval credential storage is unavailable. Unlock the macOS Keychain and try again.",
        EVAL_CREDENTIAL_CORRUPT: "Eval credentials could not be read. Existing credential data was preserved.",
      };
      throw new Error(Object.hasOwn(storageMessages, error?.code)
        ? storageMessages[error.code] : "Provider setup failed. Check the connection details and try again.");
    }
  }
  const definitions = composition.providerDefinitions;
  const forgetLogin = (id) => {
    const entry = pendingLoginDeadlines.get(id);
    if (entry?.timer != null) cancelTimeout(entry.timer);
    pendingLoginDeadlines.delete(id);
  };
  async function expireLogin(id, entry) {
    if (pendingLoginDeadlines.get(id) !== entry || entry.expired) return;
    // Production serialization decides whether cancellation still owns a pending
    // connection. A connection committed before this timer is never signed out.
    const cancelled = await definitions.cancelConnection(id);
    if (pendingLoginDeadlines.get(id) !== entry) return;
    if (cancelled) entry.expired = true;
    else forgetLogin(id);
  }
  const rememberLogin = (result) => {
    if (result?.status === "pending") {
      const id = result.connectionId;
      if (!pendingLoginDeadlines.has(id) || pendingLoginDeadlines.get(id).expired) {
        forgetLogin(id);
        const entry = { deadline: now() + loginTimeoutMs, expired: false, timer: null };
        pendingLoginDeadlines.set(id, entry);
        entry.timer = scheduleTimeout(() => expireLogin(id, entry).catch(() => {
          // Cleanup failure cannot revive the local pending attempt. Subsequent
          // explicit completion reports its bounded outcome without raw errors.
          if (pendingLoginDeadlines.get(id) === entry) entry.expired = true;
        }), loginTimeoutMs);
        entry.timer?.unref?.();
      }
    } else if (result?.providerDefinition?.id) forgetLogin(result.providerDefinition.id);
    return result;
  };
  return Object.freeze({
    async start(profile) {
      if (profile) {
        const stored = (await productServer.providerDefinitionStore().load()).find(({ id }) => id === "eval-openrouter");
        if (stored) {
          if (stored.adapterId !== "openrouter" || stored.lifecycleState !== "active"
            || stored.endpoint !== (profile.endpoint ?? "https://openrouter.ai/api/v1")) {
            throw new Error("Existing Eval provider does not match the requested Prime profile.");
          }
          await credentialStore.set(stored.credentialReference, { "api-key": profile.apiKey });
        }
      }
      await composition.start();
      // The same one post-upgrade evaluation as Desktop, for routes the app server marked
      // due (a changed digest or runtime recipe). Eval waits for it, so its default
      // selections below see the result; a failure leaves the routes pending.
      await createPostUpgradeReadiness({
        readiness,
        updatesDue: () => productServer.harnessReadinessUpdatesDue(),
        composition,
        recipeForAdapter: (adapterId) => managedRuntimeRequirementForAdapter(adapterId).recipeId,
        onError: (error) => console.error("Eval post-upgrade harness readiness evaluation failed:", error),
      }).start().evaluation;
      if (profile) {
        if (!(await definitions.list()).some(({ id }) => id === "eval-openrouter")) {
          await definitions.connect({ connectionId: "eval-openrouter", harnessId: "prime-agent-basic",
            adapterId: "openrouter", label: "Eval OpenRouter", endpoint: profile.endpoint,
            fields: { "api-key": profile.apiKey } });
        } else await composition.modelCatalog.refresh("eval-openrouter", "explicit");
        const settings = await request("/api/model-settings");
        const name = "Eval Prime pinned models";
        const members = profile.modelIds.map((modelId, index) => ({ providerId: "eval-openrouter", modelId, roles: index === 0 ? [{ name: "orchestrator" }] : [] }));
        const existing = settings.families?.find((family) => family.name === name);
        if (existing && JSON.stringify(existing.members.map(({ providerId, modelId, roles }) => ({ providerId, modelId, roles }))) !== JSON.stringify(members)) {
          throw new Error("The existing Prime model family differs from the requested profile.");
        }
        const family = existing ?? await request("/api/model-families", { method: "POST", body: { name, enabled: true, members } });
        await request("/api/model-settings/defaults", { method: "PUT", body: {
          harnessId: "prime-agent-basic", familyId: family.id,
          providerId: "eval-openrouter", modelId: profile.modelIds[0],
        } });
      }
      await refreshAvailability();
    },
    status: async () => ({ adapters: definitions.adapters(), definitions: await definitions.list(), secretsPersisted }),
    connect: (input) => mutation(async () => rememberLogin(await definitions.connect(input))),
    completeConnection: (id) => mutation(async () => {
      const entry = pendingLoginDeadlines.get(id);
      if (entry && (entry.expired || now() >= entry.deadline)) {
        if (!entry.expired) await expireLogin(id, entry);
        throw Object.assign(new Error("Sign-in expired."), { code: "EVAL_LOGIN_TIMEOUT" });
      }
      try { return rememberLogin(await definitions.completeConnection(id)); }
      catch (error) { forgetLogin(id); throw error; }
    }),
    cancelConnection: (id) => mutation(async () => {
      try { return await definitions.cancelConnection(id); }
      finally { forgetLogin(id); }
    }),
    rename: (id, label) => mutation(() => definitions.rename(id, label)),
    logout: (id) => mutation(() => definitions.logout(id)),
    reconnect: (id) => mutation(async () => rememberLogin(await definitions.reconnect(id))),
    remove: (id) => mutation(() => definitions.remove(id)),
    refresh: (id) => mutation(() => id == null
      ? composition.modelCatalog.refreshAll("explicit") : composition.modelCatalog.refresh(id, "explicit")),
    async settingsOpened() { await composition.modelCatalog.settingsOpened(); await refreshAvailability(); },
    refreshAvailability,
    availability: (id) => selections.has(id) ? { available: true, unavailableReason: null }
      : { available: false, unavailableReason: "Connect a compatible provider and select an available model family in Settings." },
    async select(harnessId) {
      await composition.modelCatalog.refreshAll("pre-inference");
      const selection = await defaultSelection(harnessId);
      selections.set(harnessId, selection);
      return selection;
    },
    async resolveCodexJudgeRuntime(config, { signal } = {}) {
      signal?.throwIfAborted();
      const settings = await request("/api/model-settings", { signal });
      const connected = (await definitions.list()).filter((definition) => (
        definition.adapterId === "codex-subscription" && definition.lifecycleState === "active" && definition.connected
      ));
      const definition = connected.find(({ id }) => id === settings.defaults?.providerId)
        ?? connected.find(({ id }) => id === "codex")
        ?? (connected.length === 1 ? connected[0] : null);
      if (!definition) throw Object.assign(new Error("Choose a connected Codex subscription as the default provider before running a Codex judge."), { code: "actor_authentication_required" });
      const lease = await definitions.acquireExecution(definition.id);
      try {
        if (config !== undefined) {
          // Discovery is read-only native model/list, never runtime installation or
          // inference. Hold this connection's lease through discovery and resolution.
          const requested = typeof config === "string" ? { model: config } : config;
          const snapshot = await abortable(signal, () => composition.modelCatalog.refresh(definition.id, "pre-inference"));
          const model = snapshot?.provider?.status === "available" && snapshot.models?.find((candidate) => (
            (candidate.id === requested?.model || candidate.executionModel === requested?.model)
            && candidate.visible !== false && candidate.availability === "available" && candidate.inputModalities?.includes("image")
          ));
          if (!model) throw Object.assign(new Error("The actor model is unavailable in this connection's discovered catalog."), { code: "actor_model_unsupported" });
          if (requested.modelReasoningEffort !== undefined && !model.supportedEfforts?.some(({ id }) => id === requested.modelReasoningEffort)) {
            throw Object.assign(new Error("The actor reasoning effort is unavailable for this model."), { code: "actor_effort_unsupported" });
          }
        }
        signal?.throwIfAborted();
        const access = await abortable(signal, () => lease.runtime.executionAccess());
        if (access.kind !== "managed-runtime" || access.runtimeId !== "codex") {
          throw new Error("The selected provider has no managed Codex execution access.");
        }
        return Object.freeze({ ...await abortable(signal, () => runtime(HARNESS_MANAGED_RUNTIME_REQUIREMENTS["codex.basic"].recipeId)), environment: access.environment });
      } finally { await lease.release(); }
    },
    acquireExecution: (id) => definitions.acquireExecution(id),
    resolveCodexRuntime: () => runtime(HARNESS_MANAGED_RUNTIME_REQUIREMENTS["codex.basic"].recipeId),
    resolveClaudeRuntime: () => runtime(HARNESS_MANAGED_RUNTIME_REQUIREMENTS["claude.basic"].recipeId),
    resolvePrimeRuntime: () => runtime(HARNESS_MANAGED_RUNTIME_REQUIREMENTS["prime.agent"].recipeId),
    async close() {
      for (const id of pendingLoginDeadlines.keys()) forgetLogin(id);
      await installer?.cancelAll("Eval is stopping.");
      try { await composition.close(); } finally { entries.clear(); selections.clear(); pendingLoginDeadlines.clear(); }
    },
  });
}
