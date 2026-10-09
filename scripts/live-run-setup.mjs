/**
 * Provider, runtime, and route setup shared by the opt-in live runs. Each live run spends real
 * inference and is excluded from `npm run check`; this module only prepares what they run on.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createManagedRuntimeInstaller } from "../desktop/main/managed-runtimes/installer.mjs";
import { createManagedRuntimeResolver } from "../desktop/main/managed-runtimes/resolver.mjs";
import {
  productionHarnessRuntimeDescriptor,
  productionProviderAdapterRegistry,
} from "../desktop/main/providers/provider-adapter-registry.mjs";
import { createHarnessReadinessCoordinator } from "../desktop/main/services/harness-readiness.mjs";
import {
  PRIME_AGENT_ASSET_SHA256,
  inspectPrimeAgentRuntime,
  requirePrimeAgentRuntime,
  selectPrimeAgentDependencyClosureSha256,
} from "../desktop/main/services/prime-agent-runtime.mjs";
import {
  assemblePrimeManagedRuntime,
  checkPrimeManagedRuntime,
  createPrimeReviewedTreeCopier,
} from "../desktop/main/services/prime-managed-runtime.mjs";
import { HARNESS_MANAGED_RUNTIME_REQUIREMENTS } from "../desktop/shared/managed-runtime-requirements.mjs";
import { digestHarnessConfiguration, loadHarnessConfigurations } from "@relayer/harness-host";

import { liveRunProfileNames, resolveRunProfile } from "./recursive-live-run-model.mjs";
import { productRequest } from "./recursive-live-run-transport.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** Reads one named run profile, validated against the harness it selects. */
export async function readProfile(path, name) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`The live run needs ${path}. Copy live-run.example.json to it and fill it in.`);
  }
  const document = JSON.parse(raw);
  if (!name) {
    const known = liveRunProfileNames(document);
    throw new Error(`Select a run profile with --profile. ${path} defines: ${known.join(", ") || "none"}.`);
  }
  const harness = String(document?.runs?.[name]?.harness ?? "").trim();
  if (!harness) throw new Error(`${path} run ${name} needs harness.`);
  const configurationPath = join(repositoryRoot, "harnesses", `${harness}.yaml`);
  const configurations = await loadHarnessConfigurations([configurationPath]);
  const configuration = configurations.get(harness);
  const implementation = configuration?.implementation;
  if (implementation === undefined) throw new Error(`${configurationPath} does not define harness ${harness}.`);
  return {
    profile: resolveRunProfile(document, name, { implementation, path }),
    configurationPath,
    harnessConfigurationDigest: digestHarnessConfiguration(configuration),
  };
}

/** Reads the provenance of the exact executable this run will spend money through. */
export function codexVersion(executable) {
  try {
    return execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`Could not read a version from ${executable}: ${error?.message ?? error}`);
  }
}

/**
 * Leases one real provider execution, over the two contracts the desktop supports.
 *
 * A subscription resolves to the managed runtime environment that isolates the provider
 * login. A key resolves to the secret contract. Only a Codex harness carries a runtime
 * descriptor: Prime reaches its provider directly and needs exactly the key field.
 */
export function providerExecution(profile) {
  const secret = profile.contract === "secret@1";
  const runtime = profile.codexExecutable === undefined
    ? undefined
    : {
      runtimeId: "codex",
      version: codexVersion(profile.codexExecutable),
      executable: profile.codexExecutable,
      environment: {
        CODEX_HOME: profile.codexHome,
        RELAYER_CODEX_BINARY: profile.codexExecutable,
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      },
    };
  const definition = {
    id: profile.providerId,
    adapterId: profile.adapterId,
    accessContract: profile.contract,
    ...(secret ? { endpoint: profile.endpoint } : {}),
  };
  return async () => ({
    definition,
    descriptor: {
      adapterId: definition.adapterId,
      accessContract: definition.accessContract,
      // Harnesses admit an adapter only at the implementation version they map, so the
      // lease carries the production adapter's version rather than a fixed one.
      implementationVersion: productionProviderAdapterRegistry.get(definition.adapterId).implementationVersion,
    },
    runtime: {
      async executionAccess() {
        if (!secret) return { kind: "managed-runtime", ...runtime };
        return {
          kind: "secret",
          endpoint: profile.endpoint,
          fields: { "api-key": profile.apiKey },
          ...(runtime === undefined ? {} : { runtime }),
        };
      },
    },
    async release() {},
  });
}

/**
 * Gives the harness host the Prime environment the desktop sets for it: the host-owned
 * Relayer Python client that bounded Prime kernels import, and the vendored runtime's
 * provenance. Inspection fails here, before any inference, if the Prime assets are not
 * the reviewed ones.
 */
export async function preparePrimeEnvironment() {
  const pythonClientRoot = join(repositoryRoot, "python", "relayer-graph", "src");
  const inspection = requirePrimeAgentRuntime(await inspectPrimeAgentRuntime({
    appPath: repositoryRoot,
    harnessDirectory: join(repositoryRoot, "harnesses"),
    manifestPath: join(repositoryRoot, "vendor", "prime-agent", "manifest.json"),
    pythonClientRoot,
  }));
  process.env.RELAYER_PRIME_PYTHON_CLIENT_ROOT = pythonClientRoot;
  process.env.RELAYER_PRIME_RUNTIME_PROVENANCE = JSON.stringify(inspection.diagnostics);
}

/**
 * The desktop's managed-runtime installer over a repository-local cache, so Prime runs
 * from the same prepared runtime the app gives it. Codex runs from the profile's own
 * executable instead, so it needs no recipe here.
 */
export function managedRuntimeResolver() {
  return createManagedRuntimeResolver(createManagedRuntimeInstaller({
    root: join(repositoryRoot, ".relayer", "live", "managed-runtimes"),
    assembleRecipe: async (context) => {
      if (context.recipe.runtimeId !== "prime") return;
      await assemblePrimeManagedRuntime(context, {
        copyReviewedTrees: createPrimeReviewedTreeCopier({
          appRoot: repositoryRoot,
          pythonClientRoot: join(repositoryRoot, "python", "relayer-graph", "src"),
          expectedClosureSha256: selectPrimeAgentDependencyClosureSha256({
            isPackaged: false,
            javascriptContract: context.recipe.runtimeContract.javascript,
          }),
          expectedPythonClientSha256: PRIME_AGENT_ASSET_SHA256.pythonPackageTree,
        }),
      });
    },
  }));
}

/**
 * Makes the profile's provider and model routable the way the desktop does after a
 * connect: the provider definition and its catalog, then harness readiness, then the
 * family the thread selects. Product routing matches a provider's access contract to
 * the harness, and a harness starts unavailable until readiness publishes it.
 */
export async function prepareRoute({ session, productServer, runtime, resolver, profile }) {
  const { providerId, modelId } = profile;
  const catalog = {
    providerId,
    label: providerId,
    connected: true,
    models: [{
      id: modelId,
      label: modelId,
      order: 0,
      visible: true,
      available: true,
      providerDefault: true,
      metadata: {},
    }],
    systemFamily: { key: providerId, name: providerId, modelIds: [modelId] },
  };
  if (profile.contract === "secret@1" && providerId !== "codex") {
    // A key-based provider is created with its catalog in one commit, as a desktop
    // connect creates it. The key itself stays with the execution lease.
    const response = await fetch(new URL("/api/internal/provider-definitions/staged", session.origin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.cookie.value}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        definition: {
          id: providerId,
          adapterId: profile.adapterId,
          label: providerId,
          endpoint: profile.endpoint,
          accessContract: profile.contract,
          credentialReference: `provider:${providerId}`,
          lifecycleState: "active",
          removedAt: null,
        },
        catalog,
      }),
    });
    if (!response.ok) {
      throw new Error(`Provider creation failed (${response.status}): ${await response.text()}`);
    }
  } else {
    await productServer.seedProviderCatalog(catalog);
  }

  const prime = profile.implementation === "prime.agent";
  const requirement = HARNESS_MANAGED_RUNTIME_REQUIREMENTS[profile.implementation];
  const readiness = createHarnessReadinessCoordinator({
    configurations: runtime.session.configurations,
    digestConfiguration: runtime.session.digestConfiguration,
    runtimeRequirements: prime ? { [profile.implementation]: requirement } : {},
    prepareRecipe: async (recipeId) => productionHarnessRuntimeDescriptor(await resolver.prepare(recipeId)),
    checkers: {
      [profile.implementation]: prime
        ? ({ runtime: prepared }) => checkPrimeManagedRuntime({ runtime: prepared })
        // The operator supplies the Codex executable; resolveRunProfile required it.
        : async () => ({ available: true }),
    },
    publishAvailability: (updates) => productServer.publishHarnessReadiness(updates),
  });
  const { readyHarnessIds, routeResults } = await readiness.evaluate({
    trigger: "connect",
    providerDefinition: { id: providerId, adapterId: profile.adapterId, accessContract: profile.contract },
    models: [{ id: modelId, visible: true, available: true }],
  });
  if (!readyHarnessIds.includes(profile.harness)) {
    const reason = routeResults.find(({ harnessId }) => harnessId === profile.harness)?.unavailableReason;
    throw new Error(`Harness ${profile.harness} is not ready for ${providerId}/${modelId}${reason ? `: ${reason.code}` : ""}.`);
  }

  const family = await productRequest(session, "/api/model-families", {
    method: "POST",
    body: JSON.stringify({
      name: "Live run models",
      enabled: true,
      members: [{ providerId, modelId }],
    }),
  });
  await productRequest(session, "/api/model-selection/validate", {
    method: "POST",
    body: JSON.stringify({ harnessId: profile.harness, familyId: family.id, providerId, modelId }),
  });
  return family;
}
