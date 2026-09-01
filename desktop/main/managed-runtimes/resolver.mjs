export function createManagedRuntimeResolver(installer) {
  if (!installer || typeof installer.installed !== "function" || typeof installer.prepare !== "function") {
    throw new Error("Managed runtime resolver requires an installer.");
  }
  const cache = new Map();

  function remember(recipeId, operation) {
    const entry = { promise: null };
    entry.promise = Promise.resolve(operation).catch((error) => {
      if (cache.get(recipeId) === entry) cache.delete(recipeId);
      throw error;
    });
    cache.set(recipeId, entry);
    return entry.promise;
  }

  return Object.freeze({
    get(recipeId) {
      const existing = cache.get(recipeId);
      if (existing) return existing.promise;
      return remember(recipeId, installer.installed(recipeId));
    },
    prepare(recipeId) {
      cache.delete(recipeId);
      return remember(recipeId, installer.prepare(recipeId));
    },
    invalidate(recipeId) {
      cache.delete(recipeId);
    },
  });
}
