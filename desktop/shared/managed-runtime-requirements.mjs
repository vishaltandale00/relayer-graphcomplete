const REQUIREMENTS = Object.freeze({
  claude: "0.3.250",
  codex: "0.147.0",
});

const RECIPES = Object.freeze(Object.fromEntries(Object.entries(REQUIREMENTS)
  .map(([runtimeId, version]) => [runtimeId, `${runtimeId}@${version}`])));

const ADAPTER_HARNESS_IMPLEMENTATIONS = Object.freeze({
  "anthropic-api": "claude.basic",
  "claude-subscription": "claude.basic",
  "codex-subscription": "codex.basic",
  "openai-api": "codex.basic",
  openrouter: "codex.basic",
  "vercel-ai-router": "codex.basic",
});

export const RELEASE_MANAGED_RUNTIME_REQUIREMENTS = REQUIREMENTS;
export const RELEASE_MANAGED_RUNTIME_RECIPES = RECIPES;
export const HARNESS_MANAGED_RUNTIME_REQUIREMENTS = Object.freeze({
  "claude.basic": Object.freeze({ runtimeId: "claude", recipeId: RECIPES.claude }),
  "codex.basic": Object.freeze({ runtimeId: "codex", recipeId: RECIPES.codex }),
});

export function managedRuntimeRequirementForHarness(implementation) {
  const requirement = HARNESS_MANAGED_RUNTIME_REQUIREMENTS[implementation];
  if (!requirement) throw new Error(`Harness implementation ${implementation} has no managed runtime requirement.`);
  return requirement;
}

export function compatibleHarnessImplementationForAdapter(adapterId) {
  const implementation = ADAPTER_HARNESS_IMPLEMENTATIONS[adapterId];
  if (!implementation) throw new Error(`Provider adapter ${adapterId} has no compatible managed harness.`);
  return implementation;
}

export function managedRuntimeRequirementForAdapter(adapterId) {
  return managedRuntimeRequirementForHarness(compatibleHarnessImplementationForAdapter(adapterId));
}

export function activeProviderRuntimeRequirements(definitions) {
  const runtimeIds = new Set(definitions
    .filter(({ lifecycleState }) => lifecycleState === "active")
    .map(({ adapterId }) => managedRuntimeRequirementForAdapter(adapterId).runtimeId));
  return Object.freeze([...runtimeIds].sort().map((runtimeId) => Object.freeze({
    runtimeId,
    recipeId: RECIPES[runtimeId],
  })));
}

export function parseUpdateRuntimeRequirements(info) {
  const metadata = info?.relayerManagedRuntimes;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("App update is missing managed runtime metadata.");
  }
  for (const runtimeId of Object.keys(REQUIREMENTS)) {
    if (typeof metadata[runtimeId] !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata[runtimeId])) {
      throw new Error("App update managed runtime metadata is invalid.");
    }
  }
  if (Object.keys(metadata).sort().join(",") !== Object.keys(REQUIREMENTS).sort().join(",")) {
    throw new Error("App update managed runtime metadata is invalid.");
  }
  return Object.freeze({ claude: `claude@${metadata.claude}`, codex: `codex@${metadata.codex}` });
}
