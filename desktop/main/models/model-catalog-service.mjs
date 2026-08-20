import {
  sanitizeModelCatalogSnapshot,
  toProductCatalogSnapshot,
  unavailableModelCatalogSnapshot,
} from "./model-catalog-adapter.mjs";

const REFRESH_REASONS = new Set(["startup", "provider-change", "settings-open", "explicit", "pre-inference"]);

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

  async refresh(providerId, reason = "explicit") {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error(`Unknown model provider: ${providerId}`);
    if (!REFRESH_REASONS.has(reason)) throw new Error(`Unknown model-catalog refresh reason: ${reason}`);

    const inFlight = this.refreshQueues.get(providerId);
    if (reason === "pre-inference" && inFlight) return inFlight;
    const previous = inFlight ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      let snapshot;
      try {
        snapshot = sanitizeModelCatalogSnapshot(await adapter.discover());
      } catch (error) {
        snapshot = unavailableModelCatalogSnapshot(adapter, error);
      }
      await this.publishSnapshot(toProductCatalogSnapshot(snapshot), Object.freeze({ reason }));
      return snapshot;
    });
    this.refreshQueues.set(providerId, operation);
    try {
      return await operation;
    } finally {
      if (this.refreshQueues.get(providerId) === operation) this.refreshQueues.delete(providerId);
    }
  }

  refreshAll(reason) {
    return Promise.all([...this.adapters.keys()].map((providerId) => this.refresh(providerId, reason)));
  }

  startup() { return this.refreshAll("startup"); }
  beforeInference() { return this.refreshAll("pre-inference"); }
  providerChanged(providerId) { return this.refresh(providerId, "provider-change"); }
  settingsOpened() { return this.refreshAll("settings-open"); }
  explicitRefresh(providerId) {
    return providerId === undefined ? this.refreshAll("explicit") : this.refresh(providerId, "explicit");
  }
}
