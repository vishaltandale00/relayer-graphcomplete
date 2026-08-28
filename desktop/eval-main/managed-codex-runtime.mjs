import { resolve } from "node:path";

import { createManagedRuntimeInstaller } from "../main/managed-runtimes/installer.mjs";
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
