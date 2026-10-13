import { describe, expect, it, vi } from "vitest";

import {
  createHarnessReadinessCoordinator,
  createPostUpgradeReadiness,
  startPostUpgradeReadiness,
} from "../desktop/main/services/harness-readiness.mjs";
import { managedRecipeInstalled, managedRecipeSupported } from "../desktop/main/managed-runtimes/resolver.mjs";
import { resolveManagedRuntimeRecipe } from "../desktop/main/managed-runtimes/recipes.mjs";
import { checkPrimeManagedRuntime } from "../desktop/main/services/prime-managed-runtime.mjs";

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

  it("publishes still-current routes from an overlapping batch when only one harness is superseded", async () => {
    let finishPrime;
    const primePending = new Promise((resolve) => { finishPrime = resolve; });
    const codex = configuration("codex-basic", "codex.basic", "openai-api");
    const prime = {
      ...configuration("prime-agent-basic", "prime.agent", "openai-api"),
      modelRules: { allow: [{ adapterId: "openai-api", modelIdRegex: "^prime-" }], deny: [] },
    };
    const published = [];
    const coordinator = createHarnessReadinessCoordinator({
      configurations: new Map([[codex.name, codex], [prime.name, prime]]),
      digestConfiguration: ({ name }) => `sha256:${name}`,
      runtimeRequirements: {},
      prepareRecipe: async () => null,
      checkers: {
        "codex.basic": async () => ({ available: true }),
        "prime.agent": async () => primePending,
      },
      publishAvailability: async (updates) => { published.push(updates); },
    });
    const providerDefinition = { id: "work", adapterId: "openai-api", accessContract: "secret@1" };
    const overlapping = coordinator.evaluate({
      trigger: "reconnect",
      providerDefinition,
      models: [{ id: "codex-model" }, { id: "prime-model" }],
    });
    await Promise.resolve();
    const codexOnly = coordinator.evaluate({
      trigger: "reconnect",
      providerDefinition,
      models: [{ id: "codex-model" }],
    });
    await codexOnly;
    finishPrime({ available: true });

    await expect(overlapping).resolves.toMatchObject({ readyHarnessIds: ["prime-agent-basic"] });
    expect(published).toEqual([
      [{ harnessId: "codex-basic", configurationDigest: "sha256:codex-basic", generation: 2, available: true, unavailableReason: null }],
      [{ harnessId: "prime-agent-basic", configurationDigest: "sha256:prime-agent-basic", generation: 1, available: true, unavailableReason: null }],
    ]);
  });

  // PR #576 review: quitting stops the background post-upgrade evaluation. It then starts no
  // preparation and no repair, and a preparation already running publishes nothing, so a
  // cancelled evaluation never clears the app server's due mark.
  it("stops the post-upgrade evaluation for shutdown before it prepares or publishes", async () => {
    const configurations = new Map([["codex-basic", configuration("codex-basic", "codex.basic", "openai-api")]]);
    let releasePrepare;
    const prepareRecipe = vi.fn(() => new Promise((resolve) => { releasePrepare = resolve; }));
    const publishAvailability = vi.fn(async () => {});
    const readiness = createHarnessReadinessCoordinator({
      configurations,
      digestConfiguration: ({ name }) => `sha256:${name}`,
      runtimeRequirements: { "codex.basic": { runtimeId: "codex", recipeId: "codex@0.147.0" } },
      prepareRecipe,
      checkers: { "codex.basic": async () => ({ available: true }) },
      publishAvailability,
      recipeInstalled: async () => true,
    });
    const providers = [{
      providerDefinition: { id: "work", adapterId: "openai-api", accessContract: "secret@1" },
      models: [{ id: "gpt-work", visible: true, availability: "available" }],
    }];

    // Stopped while it still reads the due marks: nothing starts.
    let releaseMarks;
    const repairProviders = vi.fn(async () => {});
    const early = startPostUpgradeReadiness({
      readiness,
      updatesDue: () => new Promise((resolve) => { releaseMarks = resolve; }),
      routes: async () => providers,
      repairProviders,
    });
    await vi.waitFor(() => expect(releaseMarks).toBeTypeOf("function"));
    early.stop();
    releaseMarks(["codex-basic"]);
    await expect(early.evaluation).resolves.toBeNull();
    expect(repairProviders).not.toHaveBeenCalled();
    expect(prepareRecipe).not.toHaveBeenCalled();

    // Stopped while preparing: the preparation's result is not published.
    const late = startPostUpgradeReadiness({
      readiness, updatesDue: async () => ["codex-basic"], routes: async () => providers,
    });
    await vi.waitFor(() => expect(prepareRecipe).toHaveBeenCalledOnce());
    late.stop();
    releasePrepare({ recipeId: "codex@0.147.0" });
    await late.evaluation;
    expect(publishAvailability).not.toHaveBeenCalled();
  });

  it.each([
    ["connected eligible router", [{ id: "qwen", visible: true, available: true }], "secret@1", true],
    ["no published models", [], "secret@1", false],
    ["unavailable model", [{ id: "qwen", available: false }], "secret@1", false],
    ["wrong access contract", [{ id: "qwen" }], "managed-runtime@1", false],
    ["unsupported target", [{ id: "qwen", available: true }], "secret@1", false, "macos-x64"],
  ])("recovers absent Prime only for a current route: %s", async (_, models, accessContract, expected, target = "macos-arm64") => {
    const runtimes = { validate: async (recipeId) => {
      resolveManagedRuntimeRecipe(recipeId, target);
      throw Object.assign(new Error("not installed"), { code: "managed_runtime_not_installed" });
    } };
    const due = new Set(["prime-agent-basic"]);
    const prepareRecipe = vi.fn(async () => ({ runtimeId: "prime" }));
    const publishAvailability = vi.fn(async (results) => {
      for (const { harnessId } of results) due.delete(harnessId);
    });
    const readiness = createHarnessReadinessCoordinator({
      configurations: new Map([["prime-agent-basic", configuration("prime-agent-basic", "prime.agent", "openrouter")]]),
      digestConfiguration: () => "sha256:prime-upgraded",
      runtimeRequirements: { "prime.agent": { runtimeId: "prime", recipeId: "prime@0.8.1" } },
      prepareRecipe, checkers: { "prime.agent": async () => ({ available: true }) },
      publishAvailability,
      recipeInstalled: (id) => managedRecipeInstalled(runtimes, id),
      recipeSupported: (id) => managedRecipeSupported(runtimes, id),
    });
    const repairProviders = vi.fn(async () => {});
    const request = { readiness, updatesDue: async () => [...due], repairProviders,
      routes: async () => [{ providerDefinition: { id: "router", adapterId: "openrouter", accessContract }, models }],
    };
    await startPostUpgradeReadiness(request).evaluation;
    expect(prepareRecipe).toHaveBeenCalledTimes(expected ? 1 : 0);
    expect(publishAvailability).toHaveBeenCalledTimes(expected ? 1 : 0);
    expect(repairProviders).not.toHaveBeenCalled();
    await startPostUpgradeReadiness(request).evaluation;
    expect(prepareRecipe).toHaveBeenCalledTimes(expected ? 1 : 0);
  });

  function postUpgradeFixture({ checker, prepare } = {}) {
    const configurations = new Map([["codex-basic", configuration("codex-basic", "codex.basic", "openai-api")]]);
    const publishAvailability = vi.fn(async () => {});
    const prepareRecipe = vi.fn(prepare ?? (async (recipeId) => ({ recipeId })));
    const readiness = createHarnessReadinessCoordinator({
      configurations,
      digestConfiguration: ({ name }) => `sha256:${name}`,
      runtimeRequirements: { "codex.basic": { runtimeId: "codex", recipeId: "codex@0.147.0" } },
      prepareRecipe,
      checkers: { "codex.basic": checker ?? (async () => ({ available: true })) },
      publishAvailability,
      recipeInstalled: async () => true,
    });
    const providers = [{
      providerDefinition: { id: "work", adapterId: "openai-api", accessContract: "secret@1" },
      models: [{ id: "gpt-work", visible: true, availability: "available" }],
    }];
    return { readiness, publishAvailability, prepareRecipe, providers };
  }

  // PR #607 review: a stop that lands while the evaluation waits behind an earlier
  // publication still records nothing.
  it("rechecks the stop after waiting for the publication queue", async () => {
    const { readiness, publishAvailability, providers } = postUpgradeFixture();
    let releaseEarlier;
    publishAvailability.mockImplementationOnce(() => new Promise((resolve) => { releaseEarlier = resolve; }));
    const earlier = readiness.evaluate({
      trigger: "connect", providerDefinition: providers[0].providerDefinition, models: providers[0].models,
    });
    await vi.waitFor(() => expect(publishAvailability).toHaveBeenCalledOnce());
    const upgrade = startPostUpgradeReadiness({
      readiness, updatesDue: async () => ["codex-basic"], routes: async () => providers,
    });
    // Let it pass its checks and queue behind the earlier publication.
    await new Promise((resolve) => setTimeout(resolve, 20));
    upgrade.stop();
    releaseEarlier();
    await earlier;
    await upgrade.evaluation;
    expect(publishAvailability).toHaveBeenCalledOnce();
  });

  // PR #607 review: a stop reaches a readiness checker that is still running, so a stalled
  // probe cannot hold shutdown.
  it("passes the stop to a running readiness checker", async () => {
    let checkerSignal;
    const { readiness, publishAvailability, providers } = postUpgradeFixture({
      checker: ({ signal }) => {
        checkerSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const upgrade = startPostUpgradeReadiness({
      readiness, updatesDue: async () => ["codex-basic"], routes: async () => providers,
    });
    await vi.waitFor(() => expect(checkerSignal).toBeInstanceOf(AbortSignal));
    upgrade.stop();
    await expect(upgrade.evaluation).resolves.not.toHaveProperty("routeResults.0");
    expect(publishAvailability).not.toHaveBeenCalled();
  });

  it("stops waiting for a Prime kernel probe when the evaluation stops", async () => {
    const controller = new AbortController();
    const probeManagedKernel = vi.fn(() => new Promise(() => {}));
    const checking = checkPrimeManagedRuntime({
      runtime: { runtimeId: "prime", executable: "/managed/python", moduleUrl: "file:///managed/prime.mjs" },
      importPrimeAgent: async () => ({ MANAGED_KERNEL_VERSION: 1, probeManagedKernel }),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(probeManagedKernel).toHaveBeenCalledOnce());
    controller.abort(new DOMException("stopped", "AbortError"));
    await expect(checking).rejects.toMatchObject({ name: "AbortError" });
  });

  // PR #607 review: declining the quit ("Keep downloading") must not leave the post-upgrade
  // evaluation stopped for good; accepting it stops the evaluation.
  it("restarts the post-upgrade evaluation when quitting is declined", async () => {
    const { readiness, publishAvailability, providers } = postUpgradeFixture();
    let releaseMarks;
    const marks = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseMarks = resolve; }))
      .mockImplementation(async () => ["codex-basic"]);
    const composition = {
      readinessRoutes: async () => providers,
      repairFailedActivations: vi.fn(async () => []),
    };
    const upgrade = createPostUpgradeReadiness({
      readiness, updatesDue: marks, composition, recipeForAdapter: () => "codex@0.147.0",
    });
    upgrade.start();
    await vi.waitFor(() => expect(releaseMarks).toBeTypeOf("function"));
    await expect(upgrade.confirmQuit(async () => false)).resolves.toBe(false);
    releaseMarks(["codex-basic"]);
    await upgrade.evaluation;
    expect(publishAvailability).toHaveBeenCalledOnce();

    // Accepted: it stays stopped, and a finished evaluation is not restarted either.
    await expect(upgrade.confirmQuit(async () => true)).resolves.toBe(true);
    await upgrade.stopForShutdown();
    expect(publishAvailability).toHaveBeenCalledOnce();
  });

  // PR #607 review: the stop reaches provider recovery, so a stalled recovery discovery
  // cannot hold shutdown.
  it("forwards the stop into provider recovery", async () => {
    const { readiness, providers } = postUpgradeFixture();
    let recoverySignal;
    const composition = {
      readinessRoutes: async () => providers,
      repairFailedActivations: vi.fn((_recipeIds, { signal } = {}) => {
        recoverySignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    };
    const upgrade = createPostUpgradeReadiness({
      readiness, updatesDue: async () => ["codex-basic"], composition, recipeForAdapter: () => "codex@0.147.0",
    });
    upgrade.start();
    await vi.waitFor(() => expect(composition.repairFailedActivations).toHaveBeenCalledOnce());
    expect(composition.repairFailedActivations).toHaveBeenCalledWith(["codex@0.147.0"], expect.objectContaining({
      recipeForAdapter: expect.any(Function), signal: expect.any(AbortSignal),
    }));
    const cancelInstallerOperations = vi.fn(async () => {});
    await upgrade.stopForShutdown(cancelInstallerOperations);
    expect(recoverySignal.aborted).toBe(true);
    expect(cancelInstallerOperations).toHaveBeenCalledOnce();
  });
});


describe("readiness route lifetime at asynchronous boundaries", () => {
  it.each(["target lookup", "checker", "publication queue"])("drops a provider authorization superseded during %s", async boundary => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    let reached; const entered = new Promise(resolve => { reached = resolve; });
    const controller = new AbortController();
    const publishAvailability = vi.fn(async () => {});
    const prepareRecipe = vi.fn(async () => ({}));
    const readiness = createHarnessReadinessCoordinator({
      configurations: new Map([["prime-agent-basic", configuration("prime-agent-basic", "prime.agent", "openrouter")]]),
      digestConfiguration: () => "sha256:prime", runtimeRequirements: { "prime.agent": { recipeId: "prime@0.8.1" } },
      recipeInstalled: async () => false,
      recipeSupported: async () => { if (boundary === "target lookup") { reached(); await gate; } return true; },
      prepareRecipe,
      checkers: { "prime.agent": async () => { if (boundary === "checker") { reached(); await gate; } return { available: true }; } },
      publishAvailability,
    });
    const route = { providerDefinition: { id: "router", adapterId: "openrouter", accessContract: "secret@1" }, models: [{ id: "qwen" }],
      connectionGeneration: 1, signal: controller.signal, isCurrent: () => !controller.signal.aborted };
    let prior;
    if (boundary === "publication queue") {
      publishAvailability.mockImplementationOnce(async () => { reached(); await gate; });
      prior = readiness.evaluate({ trigger: "connect", providerDefinition: route.providerDefinition, models: route.models });
      await entered;
    }
    const evaluation = readiness.evaluateRecipeUpdate({ updatesDue: ["prime-agent-basic"], providers: [route] });
    if (boundary === "publication queue") await vi.waitFor(() => expect(prepareRecipe).toHaveBeenCalledTimes(2));
    else await entered;
    controller.abort(new Error("provider superseded")); release();
    await prior; await expect(evaluation).resolves.toEqual({ readyHarnessIds: [], routeResults: [] });
    expect(publishAvailability).toHaveBeenCalledTimes(boundary === "publication queue" ? 1 : 0);
    if (boundary === "target lookup") expect(prepareRecipe).not.toHaveBeenCalled();
  });
});


it.each(["prepare", "checker", "publication queue"].flatMap(boundary => [false, true].map(allLost => [boundary, allLost])))
  ("retains every eligible route during %s (allLost=%s)", async (boundary, allLost) => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    let reached; const entered = new Promise(resolve => { reached = resolve; });
    const controllers = [new AbortController(), new AbortController()];
    const routes = controllers.map((controller, index) => ({ providerDefinition: { id: `router-${index}`, adapterId: "openrouter", accessContract: "secret@1" },
      models: [{ id: "qwen" }], connectionGeneration: 1, signal: controller.signal, isCurrent: () => !controller.signal.aborted }));
    let held = boundary !== "publication queue";
    let preparationSignal;
    const prepareRecipe = vi.fn(async (_recipe, options) => {
      if (held && boundary === "prepare") { preparationSignal = options.signal; reached(); await gate; }
      return {};
    });
    const checker = vi.fn(async ({ signal }) => {
      if (held && boundary === "checker") { preparationSignal = signal; reached(); await gate; }
      return { available: true };
    });
    const publishAvailability = vi.fn(async () => {});
    const readiness = createHarnessReadinessCoordinator({ configurations: new Map([["prime-agent-basic", configuration("prime-agent-basic", "prime.agent", "openrouter")]]),
      digestConfiguration: () => "sha256:prime", runtimeRequirements: { "prime.agent": { recipeId: "prime@0.8.1" } },
      prepareRecipe, checkers: { "prime.agent": checker }, publishAvailability });
    let prior;
    if (boundary === "publication queue") {
      publishAvailability.mockImplementationOnce(async () => { reached(); await gate; });
      prior = readiness.evaluate({ trigger: "connect", providerDefinition: routes[0].providerDefinition, models: routes[0].models });
      await entered; held = true;
    }
    const evaluation = readiness.evaluate({ trigger: "recipe-update", providers: routes });
    if (boundary === "publication queue") await vi.waitFor(() => expect(checker).toHaveBeenCalledTimes(2));
    else await entered;
    controllers[0].abort();
    if (allLost) controllers[1].abort();
    if (preparationSignal) expect(preparationSignal.aborted).toBe(allLost);
    release(); await prior;
    const result = await evaluation;
    if (allLost) {
      expect(result.readyHarnessIds).toEqual([]);
      expect(publishAvailability).toHaveBeenCalledTimes(prior ? 1 : 0);
    } else {
      expect(result.readyHarnessIds).toEqual(["prime-agent-basic"]);
      expect(publishAvailability.mock.calls.at(-1)[0][0].providerConnections).toEqual([{ providerId: "router-1", generation: 1, modelIds: ["qwen"] }]);
      expect(prepareRecipe).toHaveBeenCalledTimes(prior ? 2 : 1);
      expect(checker).toHaveBeenCalledTimes(prior ? 2 : 1);
    }
  });


it("commits another guarded harness when a dispatched result loses its only route", async () => {
  const first = new AbortController(); const second = new AbortController();
  let reached; const entered = new Promise(resolve => { reached = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const due = new Set(["prime-agent-basic", "codex-basic"]);
  const publishAvailability = vi.fn(async updates => {
    if (updates[0].harnessId === "prime-agent-basic") { reached(); await gate; }
    for (const update of updates) {
      if (update.providerConnections.every(({ providerId }) => providerId === "router-0" && first.signal.aborted)) {
        throw Object.assign(new Error("stale provider"), { code: "provider_connection_superseded" });
      }
      due.delete(update.harnessId);
    }
  });
  const readiness = createHarnessReadinessCoordinator({
    configurations: new Map([["prime-agent-basic", configuration("prime-agent-basic", "prime.agent", "openrouter")], ["codex-basic", configuration("codex-basic", "codex.basic", "openai-api")]]),
    digestConfiguration: ({ name }) => `sha256:${name}`, runtimeRequirements: { "prime.agent": { recipeId: "prime" }, "codex.basic": { recipeId: "codex" } },
    prepareRecipe: async () => ({}), checkers: { "prime.agent": async () => ({ available: true }), "codex.basic": async () => ({ available: true }) }, publishAvailability,
  });
  const providers = [first, second].map((controller, index) => ({ providerDefinition: { id: `router-${index}`, adapterId: index ? "openai-api" : "openrouter", accessContract: "secret@1" },
    models: [{ id: "work" }], connectionGeneration: 1, signal: controller.signal, isCurrent: () => !controller.signal.aborted }));
  const evaluation = readiness.evaluate({ trigger: "recipe-update", providers });
  await entered; first.abort(); release();
  expect((await evaluation).readyHarnessIds).toEqual(["codex-basic"]);
  expect([...due]).toEqual(["prime-agent-basic"]);
  expect(publishAvailability).toHaveBeenCalledTimes(2);
});


it("remembers a committed guarded result when a later independent publication fails", async () => {
  const accepted = [];
  const publishAvailability = vi.fn(async ([update]) => {
    if (update.harnessId === "codex-basic") throw new Error("backend unavailable");
    accepted.push(update.harnessId);
  });
  const readiness = createHarnessReadinessCoordinator({
    configurations: new Map([["prime-agent-basic", configuration("prime-agent-basic", "prime.agent", "openrouter")], ["codex-basic", configuration("codex-basic", "codex.basic", "openrouter")]]),
    digestConfiguration: ({ name }) => `sha256:${name}`, runtimeRequirements: {}, prepareRecipe: async () => ({}),
    checkers: { "prime.agent": async () => ({ available: true }), "codex.basic": async () => ({ available: true }) }, publishAvailability,
  });
  const mark = readiness.publicationMark();
  await expect(readiness.evaluate({ trigger: "recipe-update", providers: [{ providerDefinition: { id: "router", adapterId: "openrouter", accessContract: "secret@1" },
    models: [{ id: "qwen" }], connectionGeneration: 1, signal: new AbortController().signal, isCurrent: () => true }] })).rejects.toThrow("backend unavailable");
  expect(accepted).toEqual(["prime-agent-basic"]);
  expect(readiness.publishedSince(mark)).toEqual(accepted);
});
