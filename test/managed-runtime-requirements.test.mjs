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
  it("maps every active provider adapter to its code-owned harness runtime", () => {
    expect(HARNESS_MANAGED_RUNTIME_REQUIREMENTS).toEqual({
      "claude.basic": { runtimeId: "claude", recipeId: RELEASE_MANAGED_RUNTIME_RECIPES.claude },
      "codex.basic": { runtimeId: "codex", recipeId: RELEASE_MANAGED_RUNTIME_RECIPES.codex },
    });
    expect(managedRuntimeRequirementForAdapter("anthropic-api")).toEqual({ runtimeId: "claude", recipeId: "claude@0.3.250" });
    expect(managedRuntimeRequirementForAdapter("claude-subscription")).toEqual({ runtimeId: "claude", recipeId: "claude@0.3.250" });
    for (const adapterId of ["codex-subscription", "openai-api", "openrouter", "vercel-ai-router"]) {
      expect(managedRuntimeRequirementForAdapter(adapterId)).toEqual({ runtimeId: "codex", recipeId: "codex@0.147.0" });
    }
  });

  it("deduplicates requirements for activated provider definitions", () => {
    expect(activeProviderRuntimeRequirements([
      { adapterId: "openai-api", lifecycleState: "active" },
      { adapterId: "codex-subscription", lifecycleState: "active" },
      { adapterId: "anthropic-api", lifecycleState: "active" },
      { adapterId: "claude-subscription", lifecycleState: "tombstoned" },
    ])).toEqual([
      { runtimeId: "claude", recipeId: "claude@0.3.250" },
      { runtimeId: "codex", recipeId: "codex@0.147.0" },
    ]);
  });

  it("accepts only exact, complete update metadata", () => {
    expect(parseUpdateRuntimeRequirements({ relayerManagedRuntimes: RELEASE_MANAGED_RUNTIME_REQUIREMENTS }))
      .toEqual(RELEASE_MANAGED_RUNTIME_RECIPES);
    expect(() => parseUpdateRuntimeRequirements({ relayerManagedRuntimes: { codex: "latest" } }))
      .toThrow("managed runtime metadata");
    expect(parseUpdateRuntimeRequirements({ relayerManagedRuntimes: { claude: "0.4.0", codex: "0.148.0" } }))
      .toEqual({ claude: "claude@0.4.0", codex: "codex@0.148.0" });
  });
});
