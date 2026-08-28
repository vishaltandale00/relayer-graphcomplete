import { resolve } from "node:path";

import { createManagedRuntimeInstaller } from "../main/managed-runtimes/installer.mjs";
import { CodexCredentialAdapter } from "../main/credentials/codex-credential-adapter.mjs";
import { CodexModelCatalogAdapter } from "../main/models/codex-model-catalog-adapter.mjs";
import { toProductCatalogSnapshot } from "../main/models/model-catalog-adapter.mjs";
import { managedRuntimeRequirementForHarness } from "../shared/managed-runtime-requirements.mjs";
import { withManagedCodexPath } from "../shared/codex-runtime-environment.mjs";

export function createEvalManagedCodexRuntime({
  root,
  developmentExecutable,
  enableMaintenance = true,
  environment = process.env,
  createInstaller = createManagedRuntimeInstaller,
} = {}) {
  let installer;
  let runtimePromise;

  const getInstaller = () => {
    installer ??= createInstaller({ root });
    return installer;
  };
  const load = async () => {
    if (developmentExecutable) {
      const executable = resolve(developmentExecutable);
      return Object.freeze({
        executable,
        environment: Object.freeze(withManagedCodexPath(environment, executable)),
      });
    }
    const requirement = managedRuntimeRequirementForHarness("codex.basic");
    const runtime = await getInstaller().ensure(requirement.runtimeId, requirement.minimumVersion);
    return Object.freeze({
      ...runtime,
      environment: Object.freeze(withManagedCodexPath(environment, runtime.executable)),
    });
  };

  return Object.freeze({
    resolve() {
      runtimePromise ??= load().catch((error) => {
        runtimePromise = undefined;
        throw error;
      });
      return runtimePromise;
    },
    activeOperations: () => installer?.activeOperations() ?? Object.freeze([]),
    cancelAll: (reason) => installer?.cancelAll(reason) ?? Promise.resolve(),
    pruneInactiveInstallations: () => enableMaintenance
      ? getInstaller().pruneInactiveInstallations()
      : Promise.resolve(Object.freeze({ removed: Object.freeze([]), failures: Object.freeze([]) })),
  });
}

export function createEvalCodexExecutionLease(resolveRuntime) {
  if (typeof resolveRuntime !== "function") {
    throw new TypeError("Eval Codex execution access requires a runtime resolver.");
  }
  return async (providerId) => {
    if (providerId !== "codex") throw new Error(`Eval has no execution adapter for ${providerId}.`);
    return Object.freeze({
      definition: Object.freeze({
        id: "codex",
        adapterId: "codex-subscription",
        accessContract: "managed-runtime@1",
      }),
      descriptor: Object.freeze({
        adapterId: "codex-subscription",
        accessContract: "managed-runtime@1",
        implementationVersion: "1",
      }),
      runtime: Object.freeze({
        async executionAccess({ signal } = {}) {
          signal?.throwIfAborted();
          const runtime = await resolveRuntime();
          signal?.throwIfAborted();
          return Object.freeze({
            kind: "managed-runtime",
            environment: runtime.environment,
          });
        },
      }),
      release: async () => {},
    });
  };
}

export function createEvalCodexCatalogProvisioner({
  productSession,
  resolveRuntime,
  fetchImpl = fetch,
  createCredentials = (environment) => new CodexCredentialAdapter({ environment }),
} = {}) {
  if (!productSession?.origin || !productSession?.cookie?.value) {
    throw new TypeError("Eval Codex catalog provisioning requires the product write session.");
  }
  if (typeof resolveRuntime !== "function") {
    throw new TypeError("Eval Codex catalog provisioning requires a runtime resolver.");
  }
  let provisioned;
  return async () => {
    provisioned ??= (async () => {
      const runtime = await resolveRuntime();
      const credentials = createCredentials(runtime.environment);
      try {
        const catalog = await new CodexModelCatalogAdapter({ credentials }).discover();
        if (catalog.provider.status !== "available" || catalog.models.length === 0) {
          throw new Error("Eval requires a connected managed Codex provider with at least one available model.");
        }
        await internalProductRequest(fetchImpl, productSession, "/api/internal/provider-definitions", {
          method: "PUT",
          body: [{
            id: "codex",
            adapterId: "codex-subscription",
            label: "Codex",
            endpoint: null,
            accessContract: "managed-runtime@1",
            credentialReference: null,
            lifecycleState: "active",
            removedAt: null,
          }],
        });
        await internalProductRequest(fetchImpl, productSession, "/api/internal/provider-catalog", {
          method: "PUT",
          body: toProductCatalogSnapshot(catalog),
        });
      } finally {
        await credentials.close();
      }
    })().catch((error) => {
      provisioned = undefined;
      throw error;
    });
    return provisioned;
  };
}

async function internalProductRequest(fetchImpl, session, path, { method, body }) {
  const response = await fetchImpl(new URL(path, session.origin), {
    method,
    headers: {
      Authorization: `Bearer ${session.cookie.value}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (response.ok) return;
  const detail = await response.json().catch(() => ({}));
  throw new Error(detail?.error?.message || detail?.error || `Eval provider catalog publication failed (${response.status}).`);
}
