import { describe, expect, it } from "vitest";

import {
  activeProviderRuntimeRequirements,
  HARNESS_MANAGED_RUNTIME_REQUIREMENTS,
  managedRuntimeRequirementForAdapter,
  parseUpdateRuntimeRequirements,
  RELEASE_MANAGED_RUNTIME_RECIPES,
  RELEASE_MANAGED_RUNTIME_REQUIREMENTS,
} from "../desktop/shared/managed-runtime-requirements.mjs";

describe("managed runtime requirements", () => {
  it("maps adapters to code-owned runtimes, deduplicates active providers, and parses only exact update metadata", () => {
    expect(HARNESS_MANAGED_RUNTIME_REQUIREMENTS, "harness-to-runtime mapping").toEqual({
      "claude.basic": { runtimeId: "claude", recipeId: RELEASE_MANAGED_RUNTIME_RECIPES.claude },
      "codex.basic": { runtimeId: "codex", recipeId: RELEASE_MANAGED_RUNTIME_RECIPES.codex },
      "prime.agent": { runtimeId: "prime", recipeId: "prime@0.8.1" },
    });

    const adapterRows = [
      ["anthropic-api", { runtimeId: "claude", recipeId: "claude@0.3.250" }],
      ["claude-subscription", { runtimeId: "claude", recipeId: "claude@0.3.250" }],
      ["codex-subscription", { runtimeId: "codex", recipeId: "codex@0.147.0" }],
      ["openai-api", { runtimeId: "codex", recipeId: "codex@0.147.0" }],
      ["openrouter", { runtimeId: "codex", recipeId: "codex@0.147.0" }],
      ["vercel-ai-router", { runtimeId: "codex", recipeId: "codex@0.147.0" }],
    ];
    expect(adapterRows, "provider adapter mapping inventory").toHaveLength(6);
    for (const [adapterId, requirement] of adapterRows) {
      expect(managedRuntimeRequirementForAdapter(adapterId), `${adapterId} adapter requirement`)
        .toEqual(requirement);
    }

    expect(activeProviderRuntimeRequirements([
      { adapterId: "openai-api", lifecycleState: "active" },
      { adapterId: "codex-subscription", lifecycleState: "active" },
      { adapterId: "anthropic-api", lifecycleState: "active" },
      { adapterId: "claude-subscription", lifecycleState: "tombstoned" },
    ]), "active providers deduplicate to one requirement per runtime and drop tombstones").toEqual([
      { runtimeId: "claude", recipeId: "claude@0.3.250" },
      { runtimeId: "codex", recipeId: "codex@0.147.0" },
    ]);

    expect(parseUpdateRuntimeRequirements({ relayerManagedRuntimes: RELEASE_MANAGED_RUNTIME_REQUIREMENTS }),
      "release metadata parses to the release recipes").toEqual(RELEASE_MANAGED_RUNTIME_RECIPES);
    expect(() => parseUpdateRuntimeRequirements({ relayerManagedRuntimes: { codex: "latest" } }),
      "non-exact update metadata is rejected").toThrow("managed runtime metadata");
    expect(parseUpdateRuntimeRequirements({ relayerManagedRuntimes: { claude: "0.4.0", codex: "0.148.0" } }),
      "exact complete metadata parses per runtime").toEqual({ claude: "claude@0.4.0", codex: "codex@0.148.0" });
  });
});
