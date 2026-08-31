import {
  sanitizeModelCatalogSnapshot,
  toProductCatalogSnapshot,
  unavailableModelCatalogSnapshot,
} from "./model-catalog-adapter.mjs";
import { withProviderRetry } from "../providers/provider-retry.mjs";
import { providerDiagnosticDetails } from "../providers/provider-diagnostics-log.mjs";

const REFRESH_REASONS = new Set(["startup", "background", "provider-change", "settings-open", "explicit", "pre-inference"]);

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function waitForRefresh(entry, signal) {
  const waiter = Symbol("model-catalog-refresh-waiter");
  entry.waiters.add(waiter);
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = (aborted) => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      entry.waiters.delete(waiter);
      if (aborted && !entry.settled && entry.waiters.size === 0) {
        entry.controller.abort(signal?.reason);
      }
      return true;
    };
    const onAbort = () => {
      if (!cleanup(true)) return;
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    entry.promise.then(
      (value) => { if (cleanup(false)) resolve(value); },
      (error) => { if (cleanup(false)) reject(error); },
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export class ModelCatalogService {
  constructor({
    adapters,
    publishSnapshot,
    retry = {},
    diagnostics = null,
    backgroundIntervalMs = 15 * 60 * 1000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    isOnline = () => true,
  }) {
    if (!Array.isArray(adapters)) throw new Error("ModelCatalogService requires an adapter array.");
    if (typeof publishSnapshot !== "function") throw new Error("ModelCatalogService requires a snapshot publisher.");
    this.adapters = new Map();
    for (const adapter of adapters) {
      if (!adapter?.providerId || typeof adapter.discover !== "function") throw new Error("Invalid model catalog adapter.");
      if (this.adapters.has(adapter.providerId)) throw new Error(`Duplicate model catalog adapter: ${adapter.providerId}`);
      this.adapters.set(adapter.providerId, adapter);
    }
    this.publishSnapshot = publishSnapshot;
    this.retry = retry;
    this.diagnostics = diagnostics;
    this.refreshQueues = new Map();
    this.backgroundIntervalMs = backgroundIntervalMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.isOnline = isOnline;
    this.online = true;
    this.outageProviders = new Set();
    this.backgroundTimer = null;
    this.closed = false;
  }

  register(adapter) {
    if (!adapter?.providerId || typeof adapter.discover !== "function") throw new Error("Invalid model catalog adapter.");
    const existing = this.adapters.get(adapter.providerId);
    if (existing && existing !== adapter) throw new Error(`Duplicate model catalog adapter: ${adapter.providerId}`);
    this.adapters.set(adapter.providerId, adapter);
  }

  unregister(providerId) { this.adapters.delete(providerId); }

  async refresh(providerId, reason = "explicit", { signal } = {}) {
    throwIfAborted(signal);
    if (!this.online || !this.isOnline()) throw new Error("Device is offline.");
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error(`Unknown model provider: ${providerId}`);
    if (!REFRESH_REASONS.has(reason)) throw new Error(`Unknown model-catalog refresh reason: ${reason}`);

    const inFlight = this.refreshQueues.get(providerId);
    if (reason === "pre-inference" && inFlight && !inFlight.controller.signal.aborted) {
      return waitForRefresh(inFlight, signal);
    }
    const previous = inFlight?.promise ?? Promise.resolve();
    const controller = new AbortController();
    const entry = { controller, promise: undefined, settled: false, waiters: new Set() };
    const operation = previous.catch(() => undefined).then(async () => {
      const operationSignal = controller.signal;
      throwIfAborted(operationSignal);
      let snapshot;
      try {
        snapshot = sanitizeModelCatalogSnapshot(await withProviderRetry(
          ({ signal }) => adapter.discover({ signal, reason }),
          { ...this.retry, signal: operationSignal },
        ));
      } catch (error) {
        await this.diagnostics?.write({
          category: "provider_catalog_refresh_failed",
          providerId,
          reason,
          ...providerDiagnosticDetails(error),
        }).catch(() => undefined);
        const code = String(error?.code ?? "");
        const status = Number(error?.status);
        const outage = status >= 500 && status <= 599
          || ["transport", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(code);
        if (outage && this.online && this.isOnline()) {
          this.outageProviders.add(providerId);
          await this.publishSnapshot(toProductCatalogSnapshot(unavailableModelCatalogSnapshot(
            adapter,
            "Provider could not be reached",
            "provider_temporarily_unavailable",
          )), Object.freeze({ reason, signal: operationSignal }));
        }
        throw error;
      }
      throwIfAborted(operationSignal);
      await this.publishSnapshot(
        toProductCatalogSnapshot(snapshot),
        Object.freeze({ reason, signal: operationSignal }),
      );
      this.outageProviders.delete(providerId);
      throwIfAborted(operationSignal);
      return snapshot;
    }).finally(() => {
      entry.settled = true;
      if (this.refreshQueues.get(providerId) === entry) this.refreshQueues.delete(providerId);
    });
    entry.promise = operation;
    this.refreshQueues.set(providerId, entry);
    return waitForRefresh(entry, signal);
  }

  refreshAll(reason, options) {
    return Promise.all([...this.adapters.keys()].map((providerId) => (
      this.refresh(providerId, reason, options)
    )));
  }

  async startup() {
    const results = await Promise.allSettled([...this.adapters.keys()].map((providerId) => (
      this.refresh(providerId, "startup")
    )));
    this.#scheduleBackgroundRefresh();
    return results;
  }

  #scheduleBackgroundRefresh() {
    if (this.closed || this.backgroundTimer !== null) return;
    this.backgroundTimer = this.setTimer(async () => {
      this.backgroundTimer = null;
      if (this.closed) return;
      await Promise.allSettled([...this.adapters.keys()].map((providerId) => (
        this.refresh(providerId, "background")
      )));
      this.#scheduleBackgroundRefresh();
    }, this.backgroundIntervalMs);
    this.backgroundTimer?.unref?.();
  }

  async close() {
    this.closed = true;
    if (this.backgroundTimer !== null) this.clearTimer(this.backgroundTimer);
    this.backgroundTimer = null;
    for (const entry of this.refreshQueues.values()) entry.controller.abort(new Error("Model catalog service closed."));
    await Promise.allSettled([...this.refreshQueues.values()].map(({ promise }) => promise));
  }

  /** @deprecated Send admission resolves persisted catalog state; use background or explicit refresh. */
  beforeInference({ providerId, signal } = {}) {
    return providerId
      ? this.refresh(providerId, "pre-inference", { signal })
      : this.refreshAll("pre-inference", { signal });
  }
  providerChanged(providerId) { return this.refresh(providerId, "provider-change"); }
  settingsOpened() { return this.refreshAll("settings-open"); }
  explicitRefresh(providerId) {
    return providerId === undefined ? this.refreshAll("explicit") : this.refresh(providerId, "explicit");
  }
  connectivityChanged(online) {
    const wasOnline = this.online;
    this.online = online === true;
    if (!wasOnline && this.online) {
      return Promise.allSettled([...this.outageProviders].map((providerId) => (
        this.refresh(providerId, "background")
      )));
    }
    return Promise.resolve([]);
  }
}
