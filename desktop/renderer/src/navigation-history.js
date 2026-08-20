const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_LAYER_CACHE_LIMIT = 50;

function requiredId(value, name) {
  if (value == null) throw new TypeError(`${name} is required`);
  return String(value);
}

function optionalId(value) {
  return value == null ? null : String(value);
}

function normalizePath(path) {
  if (!Array.isArray(path)) throw new TypeError("navigationPath must be an array");
  return Object.freeze(path.map((step, index) => Object.freeze({
    layerId: requiredId(step?.layerId, `navigationPath[${index}].layerId`),
    viaActionId: optionalId(step?.viaActionId),
  })));
}

export function normalizeNavigationEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new TypeError("navigation entry must be an object");
  }
  return Object.freeze({
    threadId: requiredId(entry.threadId, "threadId"),
    turnId: requiredId(entry.turnId, "turnId"),
    navigationPath: normalizePath(entry.navigationPath),
    selectedNodeId: optionalId(entry.selectedNodeId),
  });
}

export function navigationEntriesEqual(left, right) {
  if (!left || !right) return false;
  if (!Array.isArray(left.navigationPath) || !Array.isArray(right.navigationPath)) return false;
  if (
    String(left.threadId) !== String(right.threadId)
    || String(left.turnId) !== String(right.turnId)
    || optionalId(left.selectedNodeId) !== optionalId(right.selectedNodeId)
    || left.navigationPath?.length !== right.navigationPath?.length
  ) return false;
  return left.navigationPath.every((step, index) => {
    const candidate = right.navigationPath[index];
    return String(step.layerId) === String(candidate?.layerId)
      && optionalId(step.viaActionId) === optionalId(candidate?.viaActionId);
  });
}

function positiveLimit(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Creates one in-memory history authority for one product or Eval workspace.
 * `go()` only inspects a destination. The caller resolves that presentation
 * off-screen and calls `commit()` after it is ready, keeping async navigation
 * atomic and making intervening navigation invalidate an older transition.
 */
export function createNavigationHistory({
  limit = DEFAULT_HISTORY_LIMIT,
  destinationMetadata = () => null,
} = {}) {
  positiveLimit(limit, "history limit");
  if (typeof destinationMetadata !== "function") {
    throw new TypeError("destinationMetadata must be a function");
  }

  const authority = Symbol("navigation-history-authority");
  let entries = [];
  let index = -1;
  let revision = 0;
  let transitionGeneration = 0;

  function current() {
    return index < 0 ? null : entries[index];
  }

  function destination(delta) {
    if (!Number.isInteger(delta) || delta === 0 || index < 0) return null;
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= entries.length) return null;
    const entry = entries[targetIndex];
    return Object.freeze({
      delta,
      direction: delta < 0 ? "back" : "forward",
      index: targetIndex,
      entry,
      metadata: destinationMetadata(entry, Object.freeze({
        delta,
        direction: delta < 0 ? "back" : "forward",
        index: targetIndex,
      })),
    });
  }

  function replaceCurrent(entry) {
    if (index < 0) throw new Error("navigation history must be seeded before replacement");
    const normalized = normalizeNavigationEntry(entry);
    if (navigationEntriesEqual(current(), normalized)) return false;
    entries = entries.map((candidate, candidateIndex) => (
      candidateIndex === index ? normalized : candidate
    ));
    revision += 1;
    return true;
  }

  function transitionIsCurrent(transition) {
    return transition?.authority === authority
      && transition.revision === revision
      && transition.transitionGeneration === transitionGeneration
      && transition.sourceIndex === index
      && transition.index >= 0
      && transition.index < entries.length
      && entries[transition.index] === transition.entry;
  }

  return Object.freeze({
    get limit() {
      return limit;
    },
    get size() {
      return entries.length;
    },
    get index() {
      return index;
    },
    get current() {
      return current();
    },
    get canGoBack() {
      return index > 0;
    },
    get canGoForward() {
      return index >= 0 && index < entries.length - 1;
    },
    entries() {
      return [...entries];
    },
    seed(entry) {
      if (entries.length) return false;
      entries = [normalizeNavigationEntry(entry)];
      index = 0;
      revision += 1;
      return true;
    },
    push(entry) {
      if (index < 0) throw new Error("navigation history must be seeded before push");
      const normalized = normalizeNavigationEntry(entry);
      if (navigationEntriesEqual(current(), normalized)) return false;
      entries = [...entries.slice(0, index + 1), normalized];
      if (entries.length > limit) entries = entries.slice(entries.length - limit);
      index = entries.length - 1;
      revision += 1;
      return true;
    },
    replaceCurrent,
    replaceSelection(selectedNodeId) {
      if (index < 0) throw new Error("navigation history must be seeded before replacement");
      return replaceCurrent({ ...current(), selectedNodeId });
    },
    destination,
    go(delta) {
      const target = destination(delta);
      if (!target) return null;
      transitionGeneration += 1;
      return Object.freeze({
        ...target,
        sourceIndex: index,
        revision,
        transitionGeneration,
        authority,
      });
    },
    cancelPending() {
      transitionGeneration += 1;
    },
    isCurrentTransition(transition) {
      return transitionIsCurrent(transition);
    },
    commit(transition) {
      if (!transitionIsCurrent(transition)) return false;
      index = transition.index;
      revision += 1;
      return true;
    },
  });
}

export function normalizeLayerCacheIdentity(identity) {
  if (!identity || typeof identity !== "object") {
    throw new TypeError("layer cache identity must be an object");
  }
  return Object.freeze({
    threadId: requiredId(identity.threadId, "threadId"),
    turnId: requiredId(identity.turnId, "turnId"),
    layerId: requiredId(identity.layerId, "layerId"),
  });
}

function layerCacheKey(identity) {
  const normalized = normalizeLayerCacheIdentity(identity);
  return { normalized, key: JSON.stringify([
    normalized.threadId,
    normalized.turnId,
    normalized.layerId,
  ]) };
}

/**
 * Window-local read-through LRU for immutable accepted descendant layers.
 * Embedded root layers stay outside this cache. Callers decide whether a
 * loaded value is accepted/cacheable via `isCacheable`.
 */
export function createAcceptedLayerCache({
  limit = DEFAULT_LAYER_CACHE_LIMIT,
  isCacheable = (layer) => layer != null,
} = {}) {
  positiveLimit(limit, "layer cache limit");
  if (typeof isCacheable !== "function") throw new TypeError("isCacheable must be a function");

  const resolved = new Map();
  const inFlight = new Map();
  const keyGenerations = new Map();
  let protectedKeys = new Set();
  let cacheGeneration = 0;

  function enforceLimit() {
    while (resolved.size > limit) {
      const evictableKey = [...resolved.keys()].find((key) => !protectedKeys.has(key));
      if (evictableKey == null) break;
      resolved.delete(evictableKey);
    }
  }

  function getRecord(key) {
    const record = resolved.get(key);
    if (!record) return null;
    resolved.delete(key);
    resolved.set(key, record);
    return record;
  }

  function set(identity, value) {
    if (!isCacheable(value)) return false;
    const { normalized, key } = layerCacheKey(identity);
    resolved.delete(key);
    resolved.set(key, { identity: normalized, value });
    enforceLimit();
    return true;
  }

  return Object.freeze({
    get limit() {
      return limit;
    },
    get size() {
      return resolved.size;
    },
    get inFlightSize() {
      return inFlight.size;
    },
    has(identity) {
      return resolved.has(layerCacheKey(identity).key);
    },
    get(identity) {
      return getRecord(layerCacheKey(identity).key)?.value;
    },
    set,
    delete(identity) {
      const { key } = layerCacheKey(identity);
      keyGenerations.set(key, (keyGenerations.get(key) || 0) + 1);
      inFlight.delete(key);
      return resolved.delete(key);
    },
    clear() {
      cacheGeneration += 1;
      resolved.clear();
      inFlight.clear();
      keyGenerations.clear();
      protectedKeys = new Set();
    },
    setProtected(identities) {
      if (!Array.isArray(identities)) throw new TypeError("protected identities must be an array");
      protectedKeys = new Set(identities.map((identity) => layerCacheKey(identity).key));
      enforceLimit();
    },
    identities() {
      return [...resolved.values()].map(({ identity }) => identity);
    },
    getOrLoad(identity, load) {
      if (typeof load !== "function") throw new TypeError("layer loader must be a function");
      const { normalized, key } = layerCacheKey(identity);
      const cached = getRecord(key);
      if (cached) return Promise.resolve(cached.value);
      const pending = inFlight.get(key);
      if (pending) return pending;

      const requestCacheGeneration = cacheGeneration;
      const requestKeyGeneration = keyGenerations.get(key) || 0;
      const request = Promise.resolve()
        .then(() => load(normalized))
        .then((value) => {
          if (inFlight.get(key) === request) inFlight.delete(key);
          if (
            cacheGeneration === requestCacheGeneration
            && (keyGenerations.get(key) || 0) === requestKeyGeneration
          ) set(normalized, value);
          return value;
        }, (error) => {
          if (inFlight.get(key) === request) inFlight.delete(key);
          throw error;
        });
      inFlight.set(key, request);
      return request;
    },
  });
}

export function createLatestRequestGate() {
  const authority = Symbol("latest-request-gate");
  let requestId = 0;
  let generation = 0;
  return Object.freeze({
    begin() {
      return Object.freeze({ authority, requestId: ++requestId, generation });
    },
    invalidate() {
      generation += 1;
    },
    isCurrent(token) {
      return token?.authority === authority
        && token.requestId === requestId
        && token.generation === generation;
    },
  });
}
