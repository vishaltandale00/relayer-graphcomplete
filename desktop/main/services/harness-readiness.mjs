import { harnessAllowsModel } from "@relayer/harness-host";

const READINESS_TRIGGERS = new Set(["connect", "reconnect", "explicit-repair", "recipe-update"]);

function unavailableReason(error) {
  const code = typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code)
    ? error.code
    : "harness_readiness_failed";
  return Object.freeze({
    code,
    message: "This execution configuration is currently unavailable.",
  });
}

function modelAvailable(model) {
  return model?.visible !== false
    && model?.available !== false
    && model?.availability !== "unavailable";
}

export function createHarnessReadinessCoordinator({
  configurations,
  digestConfiguration,
  runtimeRequirements,
  prepareRecipe,
  checkers,
  publishAvailability,
  diagnostics = null,
}) {
  if (!(configurations instanceof Map) || typeof digestConfiguration !== "function"
    || typeof prepareRecipe !== "function" || typeof publishAvailability !== "function") {
    throw new Error("Harness readiness requires configurations, preparation, and publication.");
  }
  const implementations = new Set([...configurations.values()].map(({ implementation }) => implementation));
  for (const implementation of implementations) {
    if (typeof checkers?.[implementation] !== "function") {
      throw new Error(`${implementation} has no production readiness checker.`);
    }
  }
  let generation = 0;
  const harnessGenerations = new Map();
  let publication = Promise.resolve();

  async function evaluate({ trigger, providerDefinition, models = [] }) {
    if (!READINESS_TRIGGERS.has(trigger)) {
      return Object.freeze({ readyHarnessIds: [], routeResults: [] });
    }
    const candidates = [...configurations.values()].filter((configuration) => (
      configuration.executionAccessContracts?.includes(providerDefinition.accessContract)
      && models.some((model) => modelAvailable(model) && harnessAllowsModel(configuration.modelRules, {
        adapterId: providerDefinition.adapterId,
        modelId: model.id,
      }))
    ));
    if (candidates.length === 0) {
      return Object.freeze({ readyHarnessIds: [], routeResults: [] });
    }
    const currentGeneration = ++generation;
    const recipes = new Map();
    for (const configuration of candidates) {
      harnessGenerations.set(configuration.name, currentGeneration);
      const requirement = runtimeRequirements[configuration.implementation];
      if (requirement && !recipes.has(requirement.recipeId)) {
        recipes.set(requirement.recipeId, Promise.resolve().then(() => prepareRecipe(requirement.recipeId)));
      }
    }
    const routeResults = await Promise.all(candidates.map(async (configuration) => {
      const requirement = runtimeRequirements[configuration.implementation];
      let result;
      try {
        const runtime = requirement ? await recipes.get(requirement.recipeId) : null;
        result = await checkers[configuration.implementation]({
          configuration,
          runtime,
        });
        if (result?.available !== true && result?.available !== false) {
          throw new Error("Harness readiness checker returned an invalid result.");
        }
      } catch (error) {
        result = { available: false, reason: unavailableReason(error) };
        await diagnostics?.write({
          level: "error",
          category: "harness_readiness_failed",
          providerId: providerDefinition.id,
          harnessId: configuration.name,
          code: result.reason.code,
        }).catch(() => undefined);
      }
      return Object.freeze({
        harnessId: configuration.name,
        configurationDigest: digestConfiguration(configuration),
        generation: currentGeneration,
        available: result.available,
        unavailableReason: result.available ? null : (result.reason ?? unavailableReason()),
      });
    }));
    const currentRouteResults = routeResults.filter(({ harnessId }) => (
      harnessGenerations.get(harnessId) === currentGeneration
    ));
    if (currentRouteResults.length === 0) {
      return Object.freeze({ readyHarnessIds: [], routeResults: [] });
    }
    const publish = publication.catch(() => undefined).then(async () => {
      const publishable = currentRouteResults.filter(({ harnessId }) => (
        harnessGenerations.get(harnessId) === currentGeneration
      ));
      if (publishable.length === 0) return [];
      await publishAvailability(publishable);
      return publishable.filter(({ harnessId }) => harnessGenerations.get(harnessId) === currentGeneration);
    });
    publication = publish;
    const published = await publish;
    if (published.length === 0) {
      return Object.freeze({ readyHarnessIds: [], routeResults: [] });
    }
    return Object.freeze({
      readyHarnessIds: published.filter(({ available }) => available).map(({ harnessId }) => harnessId),
      routeResults: published,
    });
  }

  return Object.freeze({ evaluate });
}
