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
