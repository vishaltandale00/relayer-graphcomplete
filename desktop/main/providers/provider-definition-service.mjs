import { randomUUID } from "node:crypto";
import { withProviderRetry } from "./provider-retry.mjs";
import { providerDiagnosticDetails } from "./provider-diagnostics-log.mjs";

function publicDescriptor(descriptor) {
  return Object.freeze({
    adapterId: descriptor.adapterId,
    implementationVersion: descriptor.implementationVersion,
    label: descriptor.label,
    accessContract: descriptor.accessContract,
    defaultEndpoint: descriptor.defaultEndpoint,
    endpointEditableDuringCreation: descriptor.endpointEditableDuringCreation,
    connection: descriptor.connection,
    catalog: descriptor.catalog,
  });
}

function publicDefinition(definition) {
  return Object.freeze({ ...definition });
}

export class ProviderDefinitionService {
  constructor({
    registry,
    definitionStore,
    credentialStore,
    runtimeDependencies = () => ({}),
    publishCatalog = async () => {},
    canRemove = async () => ({ allowed: true }),
    idGenerator = randomUUID,
    initialRuntimes = new Map(),
    retry = {},
    diagnostics = null,
    onRuntimeReady = () => {},
    onRuntimeRemoved = () => {},
    onRuntimeChanged = () => {},
    removeRuntimeState = async () => false,
    providerStatuses = null,
  }) {
    if (!registry || !definitionStore || !credentialStore) throw new Error("ProviderDefinitionService requires registry and stores.");
    this.registry = registry;
    this.definitionStore = definitionStore;
    this.credentialStore = credentialStore;
    this.runtimeDependencies = runtimeDependencies;
    this.publishCatalog = publishCatalog;
    this.canRemove = canRemove;
    this.idGenerator = idGenerator;
    this.retry = retry;
    this.diagnostics = diagnostics;
    this.onRuntimeReady = onRuntimeReady;
    this.onRuntimeRemoved = onRuntimeRemoved;
    this.onRuntimeChanged = onRuntimeChanged;
    this.removeRuntimeState = removeRuntimeState;
    this.providerStatuses = providerStatuses;
    this.definitions = null;
    this.runtimes = new Map(initialRuntimes);
    this.pendingConnections = new Map();
    this.activeExecutions = new Map();
    this.statusOverrides = new Map();
    this.queue = Promise.resolve();
  }

  adapters() { return this.registry.list().map(publicDescriptor); }

  async #initialize() {
    if (this.definitions === null) this.definitions = await this.definitionStore.load();
    return this.definitions;
  }

  async list({ includeTombstones = false } = {}) {
    const definitions = await this.#initialize();
    const statuses = this.providerStatuses ? await this.providerStatuses() : null;
    return definitions
      .filter(({ lifecycleState }) => includeTombstones || lifecycleState !== "tombstoned")
      .map((definition) => {
        if (statuses === null) return publicDefinition(definition);
        const status = statuses instanceof Map ? statuses.get(definition.id) : statuses?.[definition.id];
        const override = this.statusOverrides.get(definition.id);
        return publicDefinition({
          ...definition,
          connected: override?.connected ?? (status?.connected === true),
          unavailableReason: override?.unavailableReason ?? (status
            ? status.unavailableReason ?? null
            : {
              code: "provider_status_unavailable",
              message: "The provider connection status is unavailable.",
            }),
        });
      });
  }

  #serialized(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  #assertUniqueLabel(label, exceptId = null) {
    const normalized = label.trim().toLowerCase();
    if (this.definitions.some((definition) => definition.id !== exceptId
      && definition.lifecycleState !== "tombstoned"
      && definition.label.toLowerCase() === normalized)) {
      throw new Error("An active provider definition already uses that name.");
    }
    if ([...this.pendingConnections.values()].some(({ candidate }) => (
      candidate.id !== exceptId && candidate.label.toLowerCase() === normalized
    ))) throw new Error("A pending provider connection already uses that name.");
  }

  async connect({ adapterId, label, endpoint, fields = {} }, { signal } = {}) {
    return this.#serialized(async () => {
      await this.#initialize();
      signal?.throwIfAborted();
      this.#assertUniqueLabel(label);
      const descriptor = this.registry.get(adapterId);
      const id = this.idGenerator().toLowerCase();
      const credentialReference = descriptor.accessContract === "secret@1" ? `provider:${id}` : null;
      const candidate = {
        id,
        adapterId,
        label: label.trim(),
        endpoint: endpoint ?? descriptor.defaultEndpoint,
        accessContract: descriptor.accessContract,
        credentialReference,
        lifecycleState: "active",
        removedAt: null,
      };
      let runtime;
      let credentialStored = false;
      let runtimeRegistrationAttempted = false;
      try {
        runtime = this.registry.create(candidate, {
          ...await this.runtimeDependencies(candidate),
          secrets: fields,
        });
        if (descriptor.connection.mode === "managed-login") {
          const login = await runtime.credentials.login({ signal });
          this.pendingConnections.set(id, { candidate, runtime, login });
          return Object.freeze({
            status: "pending",
            connectionId: id,
            providerDefinition: publicDefinition(candidate),
            login: Object.freeze({ ...(login ?? {}) }),
          });
        }
        const catalog = await this.#discover(runtime, signal);
        if (!catalog.models.some(({ visible }) => visible)) throw new Error("Provider did not report any visible models.");
        runtimeRegistrationAttempted = true;
        await this.onRuntimeReady(candidate, runtime);
        if (credentialReference) {
          await this.credentialStore.set(credentialReference, fields);
          credentialStored = true;
        }
        if (typeof this.definitionStore.createWithCatalog === "function") {
          await this.definitionStore.createWithCatalog(candidate, catalog, { signal });
          this.definitions.push(candidate);
        } else {
          await this.publishCatalog(catalog, { signal });
          await this.definitionStore.save([...this.definitions, candidate]);
          this.definitions.push(candidate);
        }
        this.runtimes.set(id, runtime);
        return Object.freeze({ status: "connected", providerDefinition: publicDefinition(candidate) });
      } catch (error) {
        await this.diagnostics?.write({
          category: "provider_connection_failed",
          adapterId,
          providerId: id,
          ...providerDiagnosticDetails(error),
        }).catch(() => undefined);
        if (runtimeRegistrationAttempted) {
          try { await this.onRuntimeRemoved(candidate); } catch { /* preserve the connection failure */ }
        }
        try { await runtime?.close?.(); } catch { /* preserve the connection failure */ }
        try { await this.removeRuntimeState(candidate); } catch { /* preserve the connection failure */ }
        if (credentialStored) {
          try { await this.credentialStore.delete(credentialReference); } catch { /* preserve the connection failure */ }
        }
        throw error;
      }
    });
  }

  async #discover(runtime, signal) {
    const catalogAdapter = runtime.catalog ?? runtime;
    return withProviderRetry(
      () => catalogAdapter.connect?.({ signal }) ?? catalogAdapter.discover({ signal }),
      { ...this.retry, signal },
    );
  }

  async completeConnection(connectionId, { signal } = {}) {
    return this.#serialized(async () => {
      const pending = this.pendingConnections.get(connectionId);
      if (!pending) throw new Error("Unknown pending provider connection.");
      signal?.throwIfAborted();
      const account = await pending.runtime.credentials.account({ signal });
      if (account?.status !== "connected") {
        if (account?.status === "unavailable") throw new Error("Provider login is unavailable.");
        return Object.freeze({
          status: "pending",
          connectionId,
          providerDefinition: publicDefinition(pending.candidate),
          login: Object.freeze({ ...(pending.login ?? {}) }),
        });
      }
      let runtimeRegistrationAttempted = false;
      try {
        const catalog = await this.#discover(pending.runtime, signal);
        if (!catalog.models.some(({ visible }) => visible)) throw new Error("Provider did not report any visible models.");
        runtimeRegistrationAttempted = true;
        await this.onRuntimeReady(pending.candidate, pending.runtime);
        if (typeof this.definitionStore.createWithCatalog === "function") {
          await this.definitionStore.createWithCatalog(pending.candidate, catalog, { signal });
          this.definitions.push(pending.candidate);
        } else {
          await this.publishCatalog(catalog, { signal });
          await this.definitionStore.save([...this.definitions, pending.candidate]);
          this.definitions.push(pending.candidate);
        }
        this.runtimes.set(connectionId, pending.runtime);
        this.pendingConnections.delete(connectionId);
        return Object.freeze({ status: "connected", providerDefinition: publicDefinition(pending.candidate) });
      } catch (error) {
        await this.diagnostics?.write({
          category: "managed_provider_catalog_failed",
          adapterId: pending.candidate.adapterId,
          providerId: pending.candidate.id,
          ...providerDiagnosticDetails(error),
        }).catch(() => undefined);
        if (runtimeRegistrationAttempted) {
          try { await this.onRuntimeRemoved(pending.candidate); } catch { /* preserve the connection failure */ }
        }
        await this.#cancelPendingConnection(connectionId);
        throw error;
      }
    });
  }

  async cancelConnection(connectionId) {
    return this.#serialized(() => this.#cancelPendingConnection(connectionId));
  }

  async #cancelPendingConnection(connectionId) {
    const pending = this.pendingConnections.get(connectionId);
    if (!pending) return false;
    this.pendingConnections.delete(connectionId);
    await pending.runtime.close?.();
    await this.removeRuntimeState(pending.candidate);
    if (pending.candidate.credentialReference) await this.credentialStore.delete(pending.candidate.credentialReference);
    return true;
  }

  async rename(id, label) {
    return this.#serialized(async () => {
      await this.#initialize();
      const definition = this.definitions.find((item) => item.id === id && item.lifecycleState !== "tombstoned");
      if (!definition) throw new Error("Unknown active provider definition.");
      this.#assertUniqueLabel(label, id);
      const next = this.definitions.map((item) => (
        item.id === id ? { ...item, label: label.trim() } : item
      ));
      await this.definitionStore.save(next);
      this.definitions = next;
      return publicDefinition(next.find((item) => item.id === id));
    });
  }

  async logout(id, { signal } = {}) {
    return this.#serialized(async () => {
      await this.#initialize();
      const definition = this.definitions.find((item) => item.id === id);
      if (!definition || definition.lifecycleState !== "active") throw new Error("Unknown active provider definition.");
      const descriptor = this.registry.get(definition.adapterId);
      if (descriptor.connection.mode === "secret-fields") throw new Error("API provider definitions do not support logout.");
      const runtime = await this.#runtimeFor(definition);
      if (typeof runtime.credentials?.logout !== "function") throw new Error("Provider logout is unavailable.");
      const account = await runtime.credentials.logout({ signal });
      this.statusOverrides.set(id, {
        connected: false,
        unavailableReason: {
          code: "provider_logged_out",
          message: "The provider is signed out.",
        },
      });
      try {
        await this.onRuntimeChanged(definition, runtime);
      } catch (error) {
        await this.diagnostics?.write({
          category: "provider_logout_catalog_refresh_failed",
          adapterId: definition.adapterId,
          providerId: id,
          ...providerDiagnosticDetails(error),
        }).catch(() => undefined);
      }
      return Object.freeze({ ...(account ?? { status: "disconnected" }) });
    });
  }

  async acquireExecution(id) {
    return this.#serialized(async () => {
      await this.#initialize();
      const definition = this.definitions.find((item) => item.id === id);
      if (!definition || definition.lifecycleState !== "active") throw new Error("Provider is unavailable for new interactions.");
      const runtime = await this.#runtimeFor(definition);
      const count = (this.activeExecutions.get(id) ?? 0) + 1;
      this.activeExecutions.set(id, count);
      let released = false;
      return Object.freeze({
        definition: publicDefinition(definition),
        descriptor: this.registry.get(definition.adapterId),
        runtime,
        release: async () => {
          if (released) return;
          released = true;
          await this.#serialized(async () => {
            const remaining = (this.activeExecutions.get(id) ?? 1) - 1;
            if (remaining > 0) this.activeExecutions.set(id, remaining);
            else this.activeExecutions.delete(id);
            const current = this.definitions.find((item) => item.id === id);
            if (remaining === 0 && current?.lifecycleState === "removal_pending") await this.#finalizeRemoval(current);
          });
        },
      });
    });
  }

  async #runtimeFor(definition) {
    let runtime = this.runtimes.get(definition.id);
    if (runtime) return runtime;
    const secrets = definition.credentialReference
      ? await this.credentialStore.get(definition.credentialReference)
      : {};
    if (definition.credentialReference && secrets === null) throw new Error("Provider credentials are unavailable.");
    runtime = this.registry.create(definition, {
      ...await this.runtimeDependencies(definition),
      secrets,
    });
    try {
      await this.onRuntimeReady(definition, runtime);
    } catch (error) {
      try { await this.onRuntimeRemoved(definition); } catch { /* preserve the registration failure */ }
      try { await runtime.close?.(); } catch { /* preserve the registration failure */ }
      throw error;
    }
    this.runtimes.set(definition.id, runtime);
    return runtime;
  }

  async activate() {
    return this.#serialized(async () => {
      await this.#initialize();
      for (const definition of this.definitions.filter(({ lifecycleState }) => lifecycleState === "active")) {
        try {
          await this.#runtimeFor(definition);
        } catch (error) {
          await this.diagnostics?.write({
            category: "provider_activation_failed",
            adapterId: definition.adapterId,
            providerId: definition.id,
            ...providerDiagnosticDetails(error),
          }).catch(() => undefined);
        }
      }
    });
  }

  async remove(id) {
    return this.#serialized(async () => {
      await this.#initialize();
      const definition = this.definitions.find((item) => item.id === id);
      if (!definition || definition.lifecycleState !== "active") throw new Error("Unknown active provider definition.");
      const guard = await this.canRemove(publicDefinition(definition));
      if (!guard?.allowed) throw new Error(guard?.reason || "Provider cannot be removed.");
      const next = this.definitions.map((item) => (
        item.id === id ? { ...item, lifecycleState: "removal_pending" } : item
      ));
      await this.definitionStore.save(next);
      this.definitions = next;
      const pending = next.find((item) => item.id === id);
      if (!this.activeExecutions.has(id)) await this.#finalizeRemoval(definition);
      return publicDefinition(this.definitions.find((item) => item.id === id) ?? pending);
    });
  }

  async #finalizeRemoval(definition) {
    const next = this.definitions.map((item) => item.id === definition.id ? {
      ...item,
      credentialReference: null,
      lifecycleState: "tombstoned",
      removedAt: new Date().toISOString(),
    } : item);
    await this.definitionStore.save(next);
    this.definitions = next;
    // The authoritative tombstone must commit before destructive cleanup. If a
    // durable running attempt still references this provider, the store rejects
    // above and the runtime and credentials remain usable by that attempt.
    await this.runtimes.get(definition.id)?.close?.().catch(() => undefined);
    this.runtimes.delete(definition.id);
    await this.onRuntimeRemoved(definition);
    await this.removeRuntimeState(definition);
    if (definition.credentialReference) await this.credentialStore.delete(definition.credentialReference);
  }

  async reconcileStartup() {
    return this.#serialized(async () => {
      await this.#initialize();
      for (const definition of this.definitions.filter(({ lifecycleState }) => lifecycleState === "removal_pending")) {
        await this.#finalizeRemoval(definition);
      }
      await this.removeRuntimeState.reconcile?.(this.definitions);
      if (typeof this.credentialStore.listReferences === "function") {
        const retained = new Set(this.definitions.flatMap((definition) => (
          definition.lifecycleState !== "tombstoned" && definition.credentialReference
            ? [definition.credentialReference]
            : []
        )));
        for (const reference of await this.credentialStore.listReferences()) {
          if (!retained.has(reference)) await this.credentialStore.delete(reference);
        }
      }
    });
  }

  async close() {
    await Promise.allSettled([
      ...[...this.runtimes.values()].map((runtime) => runtime.close?.()),
      ...[...this.pendingConnections.values()].map(({ runtime }) => runtime.close?.()),
    ]);
    this.runtimes.clear();
    this.pendingConnections.clear();
  }
}
