// Validation codes that mean "never installed here", the normal state of an unused harness,
// rather than a broken installation.
export const MANAGED_RUNTIME_ABSENT_CODES = Object.freeze(new Set([
  "managed_runtime_not_installed",
  "managed_runtime_unsupported_target",
]));

// Whether a recipe has an installation on this machine, valid or not. A broken or
// mismatched installation counts, so the post-upgrade evaluation repairs it; an absent
// one does not. First-install authorization also requires a supported recipe and provider route.
export async function managedRecipeInstalled(runtimes, recipeId) {
  try {
    await runtimes.validate(recipeId);
    return true;
  } catch (error) {
    return !MANAGED_RUNTIME_ABSENT_CODES.has(error?.code);
  }
}

// Support is distinct from installation: a current provider can authorize a missing
// recipe, but cannot create a recipe for an unsupported platform.
export async function managedRecipeSupported(runtimes, recipeId) {
  try {
    await runtimes.validate(recipeId);
    return true;
  } catch (error) {
    return error?.code !== "managed_runtime_unsupported_target";
  }
}

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
    validate(recipeId) {
      if (typeof installer.validate !== "function") throw new Error("Managed runtime installer does not support local validation.");
      return installer.validate(recipeId);
    },
    get(recipeId) {
      const existing = cache.get(recipeId);
      if (existing) return existing.promise;
      return remember(recipeId, installer.installed(recipeId));
    },
    prepare(recipeId, options) {
      cache.delete(recipeId);
      return remember(recipeId, installer.prepare(recipeId, options));
    },
    invalidate(recipeId) {
      cache.delete(recipeId);
    },
  });
}
