// This is the only production module that imports concrete provider adapter
// implementations. Consumers depend on this registry or inject a test registry.
import { createProviderAdapterRegistry } from "./provider-adapter-contract.mjs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  withConventionalPathKey,
  withManagedCodexPath,
} from "../../shared/codex-runtime-environment.mjs";
import { anthropicApiDescriptor } from "./implementations/anthropic-api.mjs";
import { claudeSubscriptionDescriptor } from "./implementations/claude-subscription.mjs";
import { codexSubscriptionDescriptor } from "./implementations/codex-subscription.mjs";
import { openAiApiDescriptor } from "./implementations/openai-api.mjs";
import { openRouterDescriptor } from "./implementations/openrouter.mjs";
import { vercelAiRouterDescriptor } from "./implementations/vercel-ai-router.mjs";
import { requireManagedRuntime } from "./implementations/managed-runtime-contract.mjs";

const ACTIVE_PROVIDER_ADAPTERS = Object.freeze([
  Object.freeze({ descriptor: codexSubscriptionDescriptor, module: "providers/implementations/codex-subscription.mjs" }),
  Object.freeze({ descriptor: claudeSubscriptionDescriptor, module: "providers/implementations/claude-subscription.mjs" }),
  Object.freeze({ descriptor: openAiApiDescriptor, module: "providers/implementations/openai-api.mjs" }),
  Object.freeze({ descriptor: anthropicApiDescriptor, module: "providers/implementations/anthropic-api.mjs" }),
  Object.freeze({ descriptor: openRouterDescriptor, module: "providers/implementations/openrouter.mjs" }),
  Object.freeze({ descriptor: vercelAiRouterDescriptor, module: "providers/implementations/vercel-ai-router.mjs" }),
]);

export const ACTIVE_PROVIDER_ADAPTER_IDS = Object.freeze(
  ACTIVE_PROVIDER_ADAPTERS.map(({ descriptor }) => descriptor.adapterId),
);
export const ACTIVE_PROVIDER_ADAPTER_MODULES = Object.freeze(Object.fromEntries(
  ACTIVE_PROVIDER_ADAPTERS.map(({ descriptor, module }) => [descriptor.adapterId, module]),
));

export const PROVIDER_ADAPTER_SUPPORT_MODULES = Object.freeze([
  "providers/implementations/managed-runtime-contract.mjs",
  "providers/implementations/api-provider-adapter.mjs",
  "providers/implementations/managed-subscription-adapter.mjs",
]);

export const PACKAGED_PROVIDER_MODULES = Object.freeze([
  ...PROVIDER_ADAPTER_SUPPORT_MODULES,
  ...Object.values(ACTIVE_PROVIDER_ADAPTER_MODULES),
]);

export const productionProviderAdapterRegistry = createProviderAdapterRegistry(
  ACTIVE_PROVIDER_ADAPTERS.map(({ descriptor }) => descriptor),
);

export function resolveLegacyCodexHome(userDataPath, environment = {}) {
  return environment.RELAYER_CODEX_HOME || join(userDataPath, "codex-home");
}

const CODEX_PROVIDER_ADAPTERS = new Set([
  "codex-subscription", "openai-api", "openrouter", "vercel-ai-router",
]);
const CLAUDE_PROVIDER_ADAPTERS = new Set(["claude-subscription", "anthropic-api"]);

const PRODUCTION_RUNTIME_DEPENDENCIES = Object.freeze({
  codex: async (definition, context, managedRuntime) => {
    // The provider-platform migration preserves the built-in definition's
    // stable `codex` id. Keep that one definition on the home used by prior
    // releases so an existing subscription session survives the update. Every
    // definition created through the provider UI retains its isolated home.
    const codexHome = definition.id === "codex" && typeof context.legacyCodexHome === "string"
      ? context.legacyCodexHome
      : join(context.runtimeRoot, definition.id, "codex-home");
    await mkdir(codexHome, { recursive: true });
    return {
      managedRuntime,
      executable: managedRuntime.executable,
      environment: withManagedCodexPath({
        ...managedRuntimeEnvironment(context.environment),
        CODEX_HOME: codexHome,
        RELAYER_CODEX_BINARY: managedRuntime.executable,
      }, managedRuntime.executable, { platform: context.platform }),
    };
  },
  claude: async (definition, context, managedRuntime) => {
    const root = join(context.runtimeRoot, definition.id);
    const claudeHome = join(root, "claude-home");
    await mkdir(claudeHome, { recursive: true });
    return {
      managedRuntime,
      executable: managedRuntime.executable,
      moduleUrl: managedRuntime.moduleUrl,
      environment: withConventionalPathKey({
        ...managedRuntimeEnvironment(context.environment),
        CLAUDE_CONFIG_DIR: claudeHome,
      }, { platform: context.platform }),
    };
  },
});

const SAFE_MANAGED_RUNTIME_ENVIRONMENT = Object.freeze([
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC",
  "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL",
  // Native credential stores resolve through the real OS user home. Provider
  // state remains isolated by CODEX_HOME and CLAUDE_CONFIG_DIR below.
  "HOME", "USERPROFILE",
]);

export function productionManagedRuntimeEnvironment(environment = {}) {
  return Object.fromEntries(SAFE_MANAGED_RUNTIME_ENVIRONMENT.flatMap((key) => (
    typeof environment[key] === "string" ? [[key, environment[key]]] : []
  )));
}

const managedRuntimeEnvironment = productionManagedRuntimeEnvironment;

export function productionHarnessRuntimeDescriptor(runtime, { environment = process.env } = {}) {
  return Object.freeze({
    runtimeId: runtime.runtimeId,
    version: runtime.version,
    ...(typeof runtime.installationRoot === "string" ? { installationRoot: runtime.installationRoot } : {}),
    ...(typeof runtime.privateStateRoot === "string" ? { privateStateRoot: runtime.privateStateRoot } : {}),
    executable: runtime.executable,
    ...(runtime.modulePath ? { moduleUrl: pathToFileURL(runtime.modulePath).href } : {}),
    environment: Object.freeze(productionManagedRuntimeEnvironment(environment)),
  });
}

export async function productionProviderRuntimeDependencies(definition, context) {
  if (definition.accessContract === "secret@1") return {};
  const runtimeId = CODEX_PROVIDER_ADAPTERS.has(definition.adapterId)
    ? "codex"
    : CLAUDE_PROVIDER_ADAPTERS.has(definition.adapterId)
      ? "claude"
      : null;
  if (!runtimeId) return {};
  const managedRuntime = requireManagedRuntime(context?.managedRuntime, runtimeId);
  return PRODUCTION_RUNTIME_DEPENDENCIES[runtimeId](definition, context, managedRuntime);
}
