import { describe, expect, it, vi } from "vitest";

import { createHarnessReadinessCoordinator } from "../desktop/main/services/harness-readiness.mjs";

function configuration(name, implementation, adapterId) {
  return {
    schemaVersion: 1,
    name,
    implementation,
    implementationVersion: 1,
    permissionBindings: { auto: {} },
    modelRules: { allow: [{ adapterId, modelIdRegex: ".*" }], deny: [] },
    executionAccessContracts: ["secret@1"],
    settings: {},
  };
}

describe("production harness readiness", () => {
  it("prepares shared recipes once and publishes independent compatible route results", async () => {
    const configurations = new Map([
      ["codex-basic", configuration("codex-basic", "codex.basic", "openai-api")],
      ["prime-agent-basic", configuration("prime-agent-basic", "prime.agent", "openai-api")],
      ["prime-agent-deep", configuration("prime-agent-deep", "prime.agent", "openai-api")],
      ["claude-basic", configuration("claude-basic", "claude.basic", "anthropic-api")],
    ]);
    const prepareRecipe = vi.fn(async (recipeId) => ({ recipeId, executable: `/managed/${recipeId}` }));
    const publishAvailability = vi.fn(async () => {});
    const coordinator = createHarnessReadinessCoordinator({
      configurations,
      digestConfiguration: ({ name }) => `sha256:${name}`,
      runtimeRequirements: {
        "codex.basic": { runtimeId: "codex", recipeId: "codex@0.147.0" },
        "claude.basic": { runtimeId: "claude", recipeId: "claude@0.3.250" },
      },
      prepareRecipe,
      checkers: {
        "codex.basic": async ({ runtime }) => ({ available: runtime.recipeId === "codex@0.147.0" }),
        "claude.basic": async () => ({ available: true }),
        "prime.agent": async () => ({
          available: false,
          reason: { code: "prime_managed_kernel_unavailable", message: "Prime is unavailable." },
        }),
      },
      publishAvailability,
    });

    const result = await coordinator.evaluate({
      trigger: "connect",
      providerDefinition: { id: "work", adapterId: "openai-api", accessContract: "secret@1" },
      models: [{ id: "gpt-work", visible: true, availability: "available" }],
    });

    expect(prepareRecipe).toHaveBeenCalledTimes(1);
    expect(prepareRecipe).toHaveBeenCalledWith("codex@0.147.0");
    expect(result.readyHarnessIds).toEqual(["codex-basic"]);
    expect(publishAvailability).toHaveBeenCalledWith([
      { harnessId: "codex-basic", configurationDigest: "sha256:codex-basic", generation: 1, available: true, unavailableReason: null },
      { harnessId: "prime-agent-basic", configurationDigest: "sha256:prime-agent-basic", generation: 1, available: false, unavailableReason: { code: "prime_managed_kernel_unavailable", message: "Prime is unavailable." } },
      { harnessId: "prime-agent-deep", configurationDigest: "sha256:prime-agent-deep", generation: 1, available: false, unavailableReason: { code: "prime_managed_kernel_unavailable", message: "Prime is unavailable." } },
    ]);
  });

  it("requires a readiness checker for every loaded production implementation", () => {
    expect(() => createHarnessReadinessCoordinator({
      configurations: new Map([["codex-basic", configuration("codex-basic", "codex.basic", "openai-api")]]),
      digestConfiguration: () => "sha256:codex-basic",
      runtimeRequirements: { "codex.basic": { runtimeId: "codex", recipeId: "codex@0.147.0" } },
      prepareRecipe: async () => ({}),
      checkers: {},
      publishAvailability: async () => {},
    })).toThrow("codex.basic has no production readiness checker");
  });

  it("does not run readiness for background, settings, picker, or send triggers", async () => {
    const prepareRecipe = vi.fn();
    const publishAvailability = vi.fn();
    const coordinator = createHarnessReadinessCoordinator({
      configurations: new Map([["codex-basic", configuration("codex-basic", "codex.basic", "openai-api")]]),
      digestConfiguration: () => "sha256:codex-basic",
      runtimeRequirements: { "codex.basic": { runtimeId: "codex", recipeId: "codex@0.147.0" } },
      prepareRecipe,
      checkers: { "codex.basic": async () => ({ available: true }) },
      publishAvailability,
    });

    for (const trigger of ["background", "settings-open", "picker", "send"]) {
      await expect(coordinator.evaluate({
        trigger,
        providerDefinition: { id: "work", adapterId: "openai-api", accessContract: "secret@1" },
        models: [{ id: "gpt-work", visible: true, availability: "available" }],
      })).resolves.toEqual({ readyHarnessIds: [], routeResults: [] });
    }
    expect(prepareRecipe).not.toHaveBeenCalled();
    expect(publishAvailability).not.toHaveBeenCalled();
  });

  it("requires both the access contract and exact model rule before preparing a route", async () => {
    const prepareRecipe = vi.fn(async () => ({ runtimeId: "codex" }));
    const publishAvailability = vi.fn(async () => {});
    const coordinator = createHarnessReadinessCoordinator({
      configurations: new Map([["codex-basic", configuration("codex-basic", "codex.basic", "openai-api")]]),
      digestConfiguration: () => "sha256:codex-basic",
      runtimeRequirements: { "codex.basic": { runtimeId: "codex", recipeId: "codex@0.147.0" } },
      prepareRecipe,
      checkers: { "codex.basic": async () => ({ available: true }) },
      publishAvailability,
    });

    await coordinator.evaluate({
      trigger: "connect",
      providerDefinition: { id: "work", adapterId: "openai-api", accessContract: "managed-runtime@1" },
      models: [{ id: "gpt-work", visible: true, availability: "available" }],
    });
    await coordinator.evaluate({
      trigger: "connect",
      providerDefinition: { id: "work", adapterId: "anthropic-api", accessContract: "secret@1" },
      models: [{ id: "gpt-work", visible: true, availability: "available" }],
    });

    expect(prepareRecipe).not.toHaveBeenCalled();
    expect(publishAvailability).not.toHaveBeenCalled();
  });

  it("drops a late readiness result after a newer evaluation starts for the same harness", async () => {
    let finishFirst;
    const first = new Promise((resolve) => { finishFirst = resolve; });
    const prepareRecipe = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ runtimeId: "codex" });
    const publishAvailability = vi.fn(async () => {});
    const coordinator = createHarnessReadinessCoordinator({
      configurations: new Map([["codex-basic", configuration("codex-basic", "codex.basic", "openai-api")]]),
      digestConfiguration: () => "sha256:codex-basic",
      runtimeRequirements: { "codex.basic": { runtimeId: "codex", recipeId: "codex@0.147.0" } },
      prepareRecipe,
      checkers: { "codex.basic": async () => ({ available: true }) },
      publishAvailability,
    });
    const request = {
      trigger: "reconnect",
      providerDefinition: { id: "work", adapterId: "openai-api", accessContract: "secret@1" },
      models: [{ id: "gpt-work", visible: true, availability: "available" }],
    };
    const oldEvaluation = coordinator.evaluate(request);
    const newEvaluation = coordinator.evaluate(request);
    await newEvaluation;
    finishFirst({ runtimeId: "codex" });
    await expect(oldEvaluation).resolves.toEqual({ readyHarnessIds: [], routeResults: [] });
    expect(publishAvailability).toHaveBeenCalledTimes(1);
    expect(publishAvailability.mock.calls[0][0][0].generation).toBe(2);
  });

  it("serializes publication so an older HTTP write cannot land after a newer generation", async () => {
    let finishFirstPublish;
    const firstPublish = new Promise((resolve) => { finishFirstPublish = resolve; });
    const published = [];
    const coordinator = createHarnessReadinessCoordinator({
      configurations: new Map([["codex-basic", configuration("codex-basic", "codex.basic", "openai-api")]]),
      digestConfiguration: () => "sha256:codex-basic",
      runtimeRequirements: { "codex.basic": { runtimeId: "codex", recipeId: "codex@0.147.0" } },
      prepareRecipe: async () => ({ runtimeId: "codex" }),
      checkers: { "codex.basic": async () => ({ available: true }) },
      publishAvailability: async (updates) => {
        published.push(updates[0].generation);
        if (updates[0].generation === 1) await firstPublish;
      },
    });
    const request = {
      trigger: "reconnect",
      providerDefinition: { id: "work", adapterId: "openai-api", accessContract: "secret@1" },
      models: [{ id: "gpt-work", visible: true, availability: "available" }],
    };

    const oldEvaluation = coordinator.evaluate(request);
    await vi.waitFor(() => expect(published).toEqual([1]));
    const newEvaluation = coordinator.evaluate(request);
    await Promise.resolve();
    expect(published).toEqual([1]);
    finishFirstPublish();

    await expect(oldEvaluation).resolves.toEqual({ readyHarnessIds: [], routeResults: [] });
    await expect(newEvaluation).resolves.toMatchObject({ readyHarnessIds: ["codex-basic"] });
    expect(published).toEqual([1, 2]);
  });
});
