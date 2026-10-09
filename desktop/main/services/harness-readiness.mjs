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

function routeCurrent(route) {
  return !route.signal?.aborted && route.isCurrent?.() !== false;
}

function modelAvailable(model) {
  return model?.visible !== false
    && model?.available !== false
    && model?.availability !== "unavailable";
}

// #556: after startup, one background evaluation of the routes an upgrade left pending.
// It returns at once; startup never waits for the evaluation, and a failure only reports.
//
// A managed provider whose activation failed on a broken runtime publishes no models, so it
// has no route to evaluate. repairProviders first recovers such providers as Repair does,
// for the installed recipes this step would evaluate, without evaluating their routes.
//
// stop() fences it for shutdown: after it, the step starts no repair or preparation, and a
// preparation already running publishes nothing, so the app server's due mark stays for
// the next start. A preparation that started is an installer operation, which the quit
// guard sees and cancels.
export function startPostUpgradeReadiness({
  readiness,
  updatesDue,
  recipeUpdates = [],
  routes,
  repairProviders = null,
  onError = () => {},
}) {
  const controller = new AbortController();
  const { signal } = controller;
  const evaluation = Promise.resolve().then(async () => {
    let due = await updatesDue();
    let settled = [];
    if (signal.aborted) return null;
    if (repairProviders) {
      const { recipeIds } = await readiness.recipeUpdateTargets({ updatesDue: due, recipeUpdates });
      if (signal.aborted) return null;
      if (recipeIds.length > 0) {
        const mark = readiness.publicationMark();
        await repairProviders(recipeIds, { signal });
        // A harness another evaluation published since, such as a Connect, has had its
        // one evaluation, whether a due mark or a newly activated recipe selected it.
        settled = readiness.publishedSince(mark);
        due = await updatesDue();
        if (signal.aborted) return null;
      }
    }
    const providers = await routes();
    if (signal.aborted) return null;
    return await readiness.evaluateRecipeUpdate({
      updatesDue: due, recipeUpdates, providers, skipHarnessIds: settled, signal,
    });
  }).catch((error) => {
    if (!signal.aborted) onError(error);
    return null;
  });
  return Object.freeze({
    evaluation,
    stop() { controller.abort(new DOMException("Relayer is shutting down.", "AbortError")); },
  });
}

// The post-upgrade evaluation as Desktop and Eval run it. It recovers failed managed providers
// through the composition, forwarding the stop signal, so no recovery outlives a stop.
//
// confirmQuit(confirm) stops the evaluation before the quit guard looks, so no preparation
// starts behind its check; if the user declines the quit, an evaluation that had not
// finished starts again. stopForShutdown(cancel) stops it, cancels installer operations it
// started, and waits for it to settle.
export function createPostUpgradeReadiness({
  readiness,
  updatesDue,
  recipeUpdates = [],
  composition,
  recipeForAdapter,
  onError = () => {},
}) {
  let current = null;
  let finished = true;
  function start() {
    const run = startPostUpgradeReadiness({
      readiness,
      updatesDue,
      recipeUpdates,
      routes: () => composition.readinessRoutes(),
      repairProviders: (recipeIds, { signal } = {}) => (
        composition.repairFailedActivations(recipeIds, { recipeForAdapter, signal })
      ),
      onError,
    });
    current = run;
    finished = false;
    run.evaluation.finally(() => { if (current === run) finished = true; });
    return run;
  }
  return Object.freeze({
    start,
    get evaluation() { return current?.evaluation ?? Promise.resolve(null); },
    async confirmQuit(confirm) {
      const unfinished = current !== null && !finished;
      current?.stop();
      const accepted = await confirm();
      if (!accepted && unfinished) start();
      return accepted;
    },
    async stopForShutdown(cancelInstallerOperations) {
      current?.stop();
      await cancelInstallerOperations?.();
      await current?.evaluation;
    },
  });
}

export function createHarnessReadinessCoordinator({
  configurations,
  digestConfiguration,
  runtimeRequirements,
  prepareRecipe,
  checkers,
  publishAvailability,
  // Whether a recipe has an installation on disk, valid or not (managedRecipeInstalled).
  // Only the post-upgrade evaluation asks, and it refuses to run without it.
  recipeInstalled = null,
  recipeSupported = async () => false,
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
  // The generation of each harness's last result the app server accepted in this process.
  const publishedGenerations = new Map();

  function routeProviders(configuration, providers) {
    return providers.filter((route) => {
      const { providerDefinition, models = [] } = route;
      return routeCurrent(route)
        && configuration.executionAccessContracts?.includes(providerDefinition.accessContract)
        && models.some((model) => modelAvailable(model) && harnessAllowsModel(configuration.modelRules, {
          adapterId: providerDefinition.adapterId, modelId: model.id,
        }));
    });
  }

  // A shared preparation or check stays authorized while any original eligible route lives.
  function routeGuard(routes, signal) {
    const controller = new AbortController();
    const sources = [...new Set([signal, ...routes.map((route) => route.signal)].filter(Boolean))];
    const isCurrent = () => !signal?.aborted && routes.some(routeCurrent);
    const check = () => { if (!isCurrent()) controller.abort(signal?.reason ?? new DOMException("Provider routes changed.", "AbortError")); };
    for (const source of sources) source.addEventListener("abort", check);
    check();
    return { signal: sources.length ? controller.signal : undefined, isCurrent,
      dispose: () => { for (const source of sources) source.removeEventListener("abort", check); } };
  }

  async function evaluate({ trigger, providerDefinition, models = [], providers, harnessIds, signal }) {
    if (!READINESS_TRIGGERS.has(trigger)) return Object.freeze({ readyHarnessIds: [], routeResults: [] });
    const routes = providers ?? [{ providerDefinition, models }];
    const named = harnessIds ? new Set(harnessIds) : null;
    const candidates = [];
    const candidateRoutes = new Map();
    for (const configuration of configurations.values()) {
      if (named && !named.has(configuration.name)) continue;
      const eligible = routeProviders(configuration, routes);
      if (eligible.length === 0) continue;
      candidates.push(configuration);
      candidateRoutes.set(configuration.name, eligible);
    }
    if (candidates.length === 0 || signal?.aborted) return Object.freeze({ readyHarnessIds: [], routeResults: [] });
    const currentGeneration = ++generation;
    const recipes = new Map();
    const recipeRoutes = new Map();
    const guards = new Map(candidates.map(({ name }) => [name, routeGuard(candidateRoutes.get(name), signal)]));
    const recipeGuards = [];
    try {
      for (const configuration of candidates) {
        harnessGenerations.set(configuration.name, currentGeneration);
        const recipeId = runtimeRequirements[configuration.implementation]?.recipeId;
        if (recipeId) recipeRoutes.set(recipeId, [...(recipeRoutes.get(recipeId) ?? []), ...candidateRoutes.get(configuration.name)]);
      }
      for (const [recipeId, recipeConsumers] of recipeRoutes) {
        const guard = routeGuard(recipeConsumers, signal);
        recipeGuards.push(guard);
        // Unscoped Connect/Reconnect keep their existing preparation call shape.
        recipes.set(recipeId, !guard.isCurrent() ? Promise.reject(guard.signal?.reason)
          : prepareRecipe(recipeId, ...(guard.signal ? [{ signal: guard.signal }] : [])));
      }
      const routeResults = await Promise.all(candidates.map(async (configuration) => {
        const requirement = runtimeRequirements[configuration.implementation];
        const guard = guards.get(configuration.name);
        let result;
        try {
          const runtime = requirement ? await recipes.get(requirement.recipeId) : null;
          if (!guard.isCurrent()) return null;
          result = await checkers[configuration.implementation]({ configuration, runtime,
            ...(guard.signal ? { signal: guard.signal } : {}),
          });
          if (result?.available !== true && result?.available !== false) throw new Error("Harness readiness checker returned an invalid result.");
        } catch (error) {
          if (!guard.isCurrent()) return null;
          result = { available: false, reason: unavailableReason(error) };
          await diagnostics?.write({ level: "error", category: "harness_readiness_failed",
            ...(trigger === "recipe-update" ? { trigger } : { providerId: candidateRoutes.get(configuration.name).find(routeCurrent).providerDefinition.id }),
            harnessId: configuration.name, code: result.reason.code,
          }).catch(() => undefined);
        }
        return { harnessId: configuration.name, configurationDigest: digestConfiguration(configuration), generation: currentGeneration,
          available: result.available, unavailableReason: result.available ? null : (result.reason ?? unavailableReason()),
        };
      }));
      const current = ({ harnessId }) => harnessGenerations.get(harnessId) === currentGeneration && guards.get(harnessId).isCurrent();
      const currentRouteResults = routeResults.filter((result) => result !== null).filter(current);
      if (currentRouteResults.length === 0 || signal?.aborted) return Object.freeze({ readyHarnessIds: [], routeResults: [] });
      const publish = publication.catch(() => undefined).then(async () => {
        if (signal?.aborted) return [];
        const publishable = currentRouteResults.filter(current).map((result) => {
          const configuration = configurations.get(result.harnessId);
          const connections = candidateRoutes.get(result.harnessId).filter(routeCurrent)
            .filter((route) => route.connectionGeneration !== undefined).map((route) => ({
              providerId: route.providerDefinition.id, generation: route.connectionGeneration,
              modelIds: route.models.filter((model) => modelAvailable(model) && harnessAllowsModel(configuration.modelRules, {
                adapterId: route.providerDefinition.adapterId, modelId: model.id,
              })).map(({ id }) => id),
            }));
          return Object.freeze({ ...result, ...(candidateRoutes.get(result.harnessId).some(route => route.connectionGeneration !== undefined) ? { providerConnections: connections } : {}) });
        });
        if (publishable.length === 0) return [];
        const accepted = [];
        if (publishable.some(result => result.providerConnections)) {
          // Each guarded harness commits independently: one expired route cannot roll back
          // another harness's valid result in the backend transaction.
          for (const result of publishable) {
            const guard = guards.get(result.harnessId);
            if (!current(result)) continue;
            try {
              await publishAvailability([result], ...(guard.signal ? [{ signal: guard.signal }] : []));
            } catch (error) {
              if (!guard.isCurrent() || error?.code === "provider_connection_superseded") continue;
              throw error;
            }
            publishedGenerations.set(result.harnessId, currentGeneration);
            accepted.push(result);
          }
        } else {
          await publishAvailability(publishable, ...(signal ? [{ signal }] : []));
          accepted.push(...publishable);
        }
        for (const { harnessId } of accepted) publishedGenerations.set(harnessId, currentGeneration);
        return accepted.filter(current);
      });
      publication = publish;
      const published = await publish;
      return Object.freeze({ readyHarnessIds: published.filter(({ available }) => available).map(({ harnessId }) => harnessId), routeResults: published });
    } finally {
      for (const guard of [...guards.values(), ...recipeGuards]) guard.dispose();
    }
  }

  // #556: after an upgrade, one evaluation through the recipe-update trigger covers every
  // harness whose digest the app server marked due, and every harness whose runtime recipe
  // was newly activated. The app server clears its mark when the result commits.
  // An absent recipe is prepared only for a due harness with a currently published
  // eligible provider route. Failed managed-provider recovery still requires an installation.
  // The harnesses the post-upgrade step evaluates, and the installed recipes they run.
  async function recipeUpdateTargets({ updatesDue = [], recipeUpdates = [], providers = [] }) {
    if (typeof recipeInstalled !== "function") {
      throw new Error("The post-upgrade readiness evaluation requires an installed-recipe check.");
    }
    const due = new Set(updatesDue);
    const activated = new Set(recipeUpdates);
    const harnessIds = [];
    const recipeIds = new Set();
    for (const configuration of configurations.values()) {
      const { name, implementation } = configuration;
      const recipeId = runtimeRequirements[implementation]?.recipeId;
      if (!due.has(name) && !activated.has(recipeId)) continue;
      if (recipeId && !await recipeInstalled(recipeId)) {
        if (routeProviders(configuration, providers).length === 0 || !await recipeSupported(recipeId)) continue;
      }
      harnessIds.push(name);
      if (recipeId) recipeIds.add(recipeId);
    }
    return Object.freeze({ harnessIds: Object.freeze(harnessIds), recipeIds: Object.freeze([...recipeIds]) });
  }

  async function evaluateRecipeUpdate({
    updatesDue = [], recipeUpdates = [], providers = [], skipHarnessIds = [], signal,
  }) {
    const skipped = new Set(skipHarnessIds);
    const harnessIds = (await recipeUpdateTargets({ updatesDue, recipeUpdates, providers })).harnessIds
      .filter((harnessId) => !skipped.has(harnessId));
    if (harnessIds.length === 0) return Object.freeze({ readyHarnessIds: [], routeResults: [] });
    return evaluate({ trigger: "recipe-update", providers, harnessIds, signal });
  }

  // A point in evaluation order, and the harnesses published by evaluations started after it.
  const publicationMark = () => generation;
  const publishedSince = (mark) => [...publishedGenerations]
    .filter(([, published]) => published > mark)
    .map(([harnessId]) => harnessId);

  return Object.freeze({ evaluate, evaluateRecipeUpdate, recipeUpdateTargets, publicationMark, publishedSince });
}
