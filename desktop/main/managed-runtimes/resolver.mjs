import semver from "semver";

export function createManagedRuntimeResolver(installer) {
  if (!installer || typeof installer.installed !== "function" || typeof installer.ensure !== "function") {
    throw new Error("Managed runtime resolver requires an installer.");
  }
  const cache = new Map();

  function remember(runtimeId, minimumVersion, operation) {
    const entry = { minimumVersion, promise: null };
    entry.promise = Promise.resolve(operation).catch((error) => {
      if (cache.get(runtimeId) === entry) cache.delete(runtimeId);
      throw error;
    });
    cache.set(runtimeId, entry);
    return entry.promise;
  }

  return Object.freeze({
    get(runtimeId, minimumVersion) {
      const existing = cache.get(runtimeId);
      if (existing && semver.gte(existing.minimumVersion, minimumVersion)) return existing.promise;
      return remember(runtimeId, minimumVersion, installer.installed(runtimeId, minimumVersion));
    },
    prepare(runtimeId, minimumVersion) {
      cache.delete(runtimeId);
      return remember(runtimeId, minimumVersion, installer.ensure(runtimeId, minimumVersion));
    },
    invalidate(runtimeId) {
      cache.delete(runtimeId);
    },
  });
}

export async function bootstrapLegacyManagedRuntimes({ definitions, requirementForAdapter, resolver }) {
  const requirements = new Map();
  for (const definition of definitions) {
    if (definition?.lifecycleState !== "active") continue;
    const requirement = requirementForAdapter(definition.adapterId);
    const existing = requirements.get(requirement.runtimeId);
    if (!existing || semver.gt(requirement.minimumVersion, existing.minimumVersion)) {
      requirements.set(requirement.runtimeId, requirement);
    }
  }
  const bootstrapped = [];
  for (const requirement of requirements.values()) {
    try {
      await resolver.get(requirement.runtimeId, requirement.minimumVersion);
    } catch {
      bootstrapped.push(await resolver.prepare(requirement.runtimeId, requirement.minimumVersion));
    }
  }
  return Object.freeze(bootstrapped);
}
