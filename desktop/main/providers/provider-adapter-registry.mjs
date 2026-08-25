// This is the only production module that imports concrete provider adapter
// implementations. Consumers depend on this registry or inject a test registry.
import { createProviderAdapterRegistry } from "./provider-adapter-contract.mjs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { anthropicApiDescriptor } from "./implementations/anthropic-api.mjs";
import { claudeSubscriptionDescriptor } from "./implementations/claude-subscription.mjs";
import { codexSubscriptionDescriptor } from "./implementations/codex-subscription.mjs";
import { openAiApiDescriptor } from "./implementations/openai-api.mjs";
import { openRouterDescriptor } from "./implementations/openrouter.mjs";
import { vercelAiRouterDescriptor } from "./implementations/vercel-ai-router.mjs";

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

const PRODUCTION_RUNTIME_DEPENDENCIES = Object.freeze({
  "codex-subscription": async (definition, context) => {
    const root = join(context.runtimeRoot, definition.id);
    await mkdir(root, { recursive: true });
    return {
      environment: {
        ...managedRuntimeEnvironment(context.environment, root),
        CODEX_HOME: join(root, "codex-home"),
        RELAYER_CODEX_BINARY: context.codexBinary,
      },
    };
  },
  "claude-subscription": async (definition, context) => {
    const root = join(context.runtimeRoot, definition.id);
    await mkdir(root, { recursive: true });
    return {
      executable: context.claudeBinary || "claude",
      environment: {
        ...managedRuntimeEnvironment(context.environment, root),
        CLAUDE_CONFIG_DIR: join(root, "claude-home"),
      },
    };
  },
});

const SAFE_MANAGED_RUNTIME_ENVIRONMENT = Object.freeze([
  "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC",
  "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL",
]);

function managedRuntimeEnvironment(environment = {}, isolatedHome) {
  const filtered = Object.fromEntries(SAFE_MANAGED_RUNTIME_ENVIRONMENT.flatMap((key) => (
    typeof environment[key] === "string" ? [[key, environment[key]]] : []
  )));
  return { ...filtered, HOME: isolatedHome, USERPROFILE: isolatedHome };
}

export async function productionProviderRuntimeDependencies(definition, context) {
  return PRODUCTION_RUNTIME_DEPENDENCIES[definition.adapterId]?.(definition, context) ?? {};
}
