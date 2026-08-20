import {
  sanitizeModelCatalogSnapshot,
  toProductCatalogSnapshot,
  unavailableModelCatalogSnapshot,
} from "./model-catalog-adapter.mjs";

const REFRESH_REASONS = new Set(["startup", "provider-change", "settings-open", "explicit", "pre-inference"]);

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

export class ModelCatalogService {
  constructor({ adapters, publishSnapshot }) {
    if (!Array.isArray(adapters) || adapters.length === 0) throw new Error("ModelCatalogService requires at least one adapter.");
    if (typeof publishSnapshot !== "function") throw new Error("ModelCatalogService requires a snapshot publisher.");
    this.adapters = new Map();
    for (const adapter of adapters) {
      if (!adapter?.providerId || typeof adapter.discover !== "function") throw new Error("Invalid model catalog adapter.");
      if (this.adapters.has(adapter.providerId)) throw new Error(`Duplicate model catalog adapter: ${adapter.providerId}`);
      this.adapters.set(adapter.providerId, adapter);
    }
    this.publishSnapshot = publishSnapshot;
    this.refreshQueues = new Map();
  }

  async refresh(providerId, reason = "explicit", { signal } = {}) {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error(`Unknown model provider: ${providerId}`);
    if (!REFRESH_REASONS.has(reason)) throw new Error(`Unknown model-catalog refresh reason: ${reason}`);

    const inFlight = this.refreshQueues.get(providerId);
    if (reason === "pre-inference" && inFlight) return inFlight;
    const previous = inFlight ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      throwIfAborted(signal);
      let snapshot;
      try {
        snapshot = sanitizeModelCatalogSnapshot(await adapter.discover({ signal }));
      } catch (error) {
        throwIfAborted(signal);
        snapshot = unavailableModelCatalogSnapshot(adapter, error);
      }
      throwIfAborted(signal);
      await this.publishSnapshot(
        toProductCatalogSnapshot(snapshot),
        Object.freeze({ reason, signal }),
      );
      throwIfAborted(signal);
      return snapshot;
    });
    this.refreshQueues.set(providerId, operation);
    try {
      return await operation;
    } finally {
      if (this.refreshQueues.get(providerId) === operation) this.refreshQueues.delete(providerId);
    }
  }

  refreshAll(reason, options) {
    return Promise.all([...this.adapters.keys()].map((providerId) => (
      this.refresh(providerId, reason, options)
    )));
  }

  startup() { return this.refreshAll("startup"); }
  beforeInference(options) { return this.refreshAll("pre-inference", options); }
  providerChanged(providerId) { return this.refresh(providerId, "provider-change"); }
  settingsOpened() { return this.refreshAll("settings-open"); }
  explicitRefresh(providerId) {
    return providerId === undefined ? this.refreshAll("explicit") : this.refresh(providerId, "explicit");
  }
}
