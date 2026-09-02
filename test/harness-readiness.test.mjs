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

const providerDefinition = { id: "work", adapterId: "openai-api", accessContract: "secret@1" };
const models = [{ id: "gpt-work", visible: true, availability: "available" }];
const runtimeRequirements = {
  "codex.basic": { runtimeId: "codex", recipeId: "codex@0.147.0" },
  "claude.basic": { runtimeId: "claude", recipeId: "claude@0.3.250" },
};

function singleCodexCoordinator(overrides = {}) {
  const prepareRecipe = overrides.prepareRecipe ?? vi.fn(async () => ({ runtimeId: "codex" }));
  const publishAvailability = overrides.publishAvailability ?? vi.fn(async () => {});
  const coordinator = createHarnessReadinessCoordinator({
    configurations: new Map([["codex-basic", configuration("codex-basic", "codex.basic", "openai-api")]]),
    digestConfiguration: () => "sha256:codex-basic",
    runtimeRequirements: { "codex.basic": { runtimeId: "codex", recipeId: "codex@0.147.0" } },
    prepareRecipe,
    checkers: overrides.checkers ?? { "codex.basic": async () => ({ available: true }) },
    publishAvailability,
  });
  return { coordinator, prepareRecipe, publishAvailability };
}

describe("production harness readiness", () => {
  it("requires connected triggers, matching contracts, exact model rules, and a production checker before preparing routes", async () => {
    const cases = [
      [
        "loading an implementation without a readiness checker fails fast",
        async () => {
          let buildError = null;
          try {
            singleCodexCoordinator({ checkers: {} });
          } catch (error) {
            buildError = error;
          }
          return { buildError: buildError?.message ?? null };
        },
        (outcome, label) => {
          expect.soft(outcome.buildError, `${label}: the coordinator must refuse to start`).toBe("codex.basic has no production readiness checker.");
        },
      ],
      [
        "background, settings, picker, and send triggers never run readiness",
        async () => {
          const outcomes = [];
          for (const trigger of ["background", "settings-open", "picker", "send"]) {
            const { coordinator, prepareRecipe, publishAvailability } = singleCodexCoordinator();
            const result = await coordinator.evaluate({ trigger, providerDefinition, models });
            outcomes.push({ trigger, result, prepareCalls: prepareRecipe.mock.calls.length, publishCalls: publishAvailability.mock.calls.length });
          }
          return outcomes;
        },
        (outcomes, label) => {
          for (const outcome of outcomes) {
            expect.soft(outcome.result, `${label}: ${outcome.trigger} resolves empty`).toEqual({ readyHarnessIds: [], routeResults: [] });
            expect.soft(outcome.prepareCalls + outcome.publishCalls, `${label}: ${outcome.trigger} touches no recipe or publication`).toBe(0);
          }
        },
      ],
      [
        "a provider without the bound access contract prepares nothing",
        async () => {
          const { coordinator, prepareRecipe, publishAvailability } = singleCodexCoordinator();
          await coordinator.evaluate({
            trigger: "connect",
            providerDefinition: { id: "work", adapterId: "openai-api", accessContract: "managed-runtime@1" },
            models,
          });
          return { prepareCalls: prepareRecipe.mock.calls.length, publishCalls: publishAvailability.mock.calls.length };
        },
        (outcome, label) => {
          expect.soft(outcome.prepareCalls + outcome.publishCalls, `${label}: contract mismatch never reaches recipe preparation`).toBe(0);
        },
      ],
      [
        "a provider without the exact model-rule adapter prepares nothing",
        async () => {
          const { coordinator, prepareRecipe, publishAvailability } = singleCodexCoordinator();
          await coordinator.evaluate({
            trigger: "connect",
            providerDefinition: { id: "work", adapterId: "anthropic-api", accessContract: "secret@1" },
            models,
          });
          return { prepareCalls: prepareRecipe.mock.calls.length, publishCalls: publishAvailability.mock.calls.length };
        },
        (outcome, label) => {
          expect.soft(outcome.prepareCalls + outcome.publishCalls, `${label}: adapter mismatch never reaches recipe preparation`).toBe(0);
        },
      ],
      [
        "a connected evaluation prepares the shared recipe once and publishes independent compatible route results",
        async () => {
          const prepareRecipe = vi.fn(async (recipeId) => ({ recipeId, executable: `/managed/${recipeId}` }));
          const publishAvailability = vi.fn(async () => {});
          const coordinator = createHarnessReadinessCoordinator({
            configurations: new Map([
              ["codex-basic", configuration("codex-basic", "codex.basic", "openai-api")],
              ["prime-agent-basic", configuration("prime-agent-basic", "prime.agent", "openai-api")],
              ["prime-agent-deep", configuration("prime-agent-deep", "prime.agent", "openai-api")],
              ["claude-basic", configuration("claude-basic", "claude.basic", "anthropic-api")],
            ]),
            digestConfiguration: ({ name }) => `sha256:${name}`,
            runtimeRequirements,
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
          const result = await coordinator.evaluate({ trigger: "connect", providerDefinition, models });
          return { result, prepareCalls: prepareRecipe.mock.calls, publishCalls: publishAvailability.mock.calls };
        },
        (outcome, label) => {
          expect.soft(outcome.prepareCalls, `${label}: the shared codex recipe is prepared exactly once`).toEqual([["codex@0.147.0"]]);
          expect.soft(outcome.result.readyHarnessIds, `${label}: only the compatible codex route becomes ready`).toEqual(["codex-basic"]);
          expect.soft(outcome.publishCalls, `${label}: every independent compatible route result is published`).toEqual([[[
            { harnessId: "codex-basic", configurationDigest: "sha256:codex-basic", generation: 1, available: true, unavailableReason: null },
            { harnessId: "prime-agent-basic", configurationDigest: "sha256:prime-agent-basic", generation: 1, available: false, unavailableReason: { code: "prime_managed_kernel_unavailable", message: "Prime is unavailable." } },
            { harnessId: "prime-agent-deep", configurationDigest: "sha256:prime-agent-deep", generation: 1, available: false, unavailableReason: { code: "prime_managed_kernel_unavailable", message: "Prime is unavailable." } },
          ]]]);
        },
      ],
    ];
    expect(cases).toHaveLength(5);
    for (const [label, scenario, assert] of cases) {
      assert(await scenario(), label);
    }
  });

  it("supersedes stale generations and serializes publication so old writes never land last", async () => {
    const request = { trigger: "reconnect", providerDefinition, models };

    // Checkpoint 1: a late readiness result is dropped once a newer
    // evaluation has started for the same harness.
    let finishFirst;
    const first = new Promise((resolve) => { finishFirst = resolve; });
    const lateRace = singleCodexCoordinator({
      prepareRecipe: vi.fn()
        .mockImplementationOnce(() => first)
        .mockResolvedValueOnce({ runtimeId: "codex" }),
    });
    const oldEvaluation = lateRace.coordinator.evaluate(request);
    const newEvaluation = lateRace.coordinator.evaluate(request);
    await newEvaluation;
    finishFirst({ runtimeId: "codex" });
    await expect(oldEvaluation, "late readiness result: the superseded evaluation resolves empty").resolves.toEqual({ readyHarnessIds: [], routeResults: [] });
    expect(lateRace.publishAvailability, "late readiness result: only the newer generation publishes").toHaveBeenCalledTimes(1);
    expect(lateRace.publishAvailability.mock.calls[0][0][0].generation, "late readiness result: publication carries the fresh generation").toBe(2);

    // Checkpoint 2: publication is serialized so an older HTTP write cannot
    // land after a newer generation.
    let finishFirstPublish;
    const firstPublish = new Promise((resolve) => { finishFirstPublish = resolve; });
    const published = [];
    const serialized = singleCodexCoordinator({
      publishAvailability: async (updates) => {
        published.push(updates[0].generation);
        if (updates[0].generation === 1) await firstPublish;
      },
    });
    const serializedOld = serialized.coordinator.evaluate(request);
    await vi.waitFor(() => expect(published, "serialized publication: the first generation starts writing").toEqual([1]));
    const serializedNew = serialized.coordinator.evaluate(request);
    await Promise.resolve();
    expect(published, "serialized publication: the newer generation waits for the older write").toEqual([1]);
    finishFirstPublish();
    await expect(serializedOld, "serialized publication: the superseded evaluation resolves empty").resolves.toEqual({ readyHarnessIds: [], routeResults: [] });
    await expect(serializedNew, "serialized publication: the fresh evaluation stays ready").resolves.toMatchObject({ readyHarnessIds: ["codex-basic"] });
    expect(published, "serialized publication: generations land in order").toEqual([1, 2]);

    // Checkpoint 3: an overlapping batch still publishes the routes that
    // remain current when only one harness is superseded.
    let finishPrime;
    const primePending = new Promise((resolve) => { finishPrime = resolve; });
    const codex = configuration("codex-basic", "codex.basic", "openai-api");
    const prime = {
      ...configuration("prime-agent-basic", "prime.agent", "openai-api"),
      modelRules: { allow: [{ adapterId: "openai-api", modelIdRegex: "^prime-" }], deny: [] },
    };
    const overlappingBatch = [];
    const overlapCoordinator = createHarnessReadinessCoordinator({
      configurations: new Map([[codex.name, codex], [prime.name, prime]]),
      digestConfiguration: ({ name }) => `sha256:${name}`,
      runtimeRequirements: {},
      prepareRecipe: async () => null,
      checkers: {
        "codex.basic": async () => ({ available: true }),
        "prime.agent": async () => primePending,
      },
      publishAvailability: async (updates) => { overlappingBatch.push(updates); },
    });
    const overlapping = overlapCoordinator.evaluate({
      trigger: "reconnect",
      providerDefinition,
      models: [{ id: "codex-model" }, { id: "prime-model" }],
    });
    await Promise.resolve();
    const codexOnly = overlapCoordinator.evaluate({
      trigger: "reconnect",
      providerDefinition,
      models: [{ id: "codex-model" }],
    });
    await codexOnly;
    finishPrime({ available: true });
    await expect(overlapping, "overlapping batch: the superseded batch still resolves its own ready routes").resolves.toMatchObject({ readyHarnessIds: ["prime-agent-basic"] });
    expect(overlappingBatch, "overlapping batch: only still-current routes are published, newest generation first").toEqual([
      [{ harnessId: "codex-basic", configurationDigest: "sha256:codex-basic", generation: 2, available: true, unavailableReason: null }],
      [{ harnessId: "prime-agent-basic", configurationDigest: "sha256:prime-agent-basic", generation: 1, available: true, unavailableReason: null }],
    ]);
  });
});
