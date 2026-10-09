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

// A completion failure that settled the pending attempt. The browser leg is
// over, so its outcome belongs back in Relayer. Owned by this module rather
// than stamped onto the provider's error: a frozen error cannot be marked, and
// marking after cleanup lets a cleanup rejection replace the real failure.
export class TerminalConnectionFailure extends Error {
  constructor(cause) {
    super(cause instanceof Error ? cause.message : String(cause ?? "Provider connection failed."));
    this.name = "TerminalConnectionFailure";
    this.cause = cause;
  }
}

// Only a failure that settled the attempt is terminal. An unknown connection
// never had one, and a transient failure leaves the attempt live.
export function isTerminalConnectionFailure(error) {
  return error instanceof TerminalConnectionFailure;
}

// A managed adapter collapses every runtime, process, protocol, and parse
// failure into one `unavailable` result or a thrown check, so a failed check
// is not evidence that the browser login is still in progress: a missing
// executable reads exactly like a slow one. Tolerate a short run of them, so a
// hiccup mid-login costs nothing, then settle and release the provider name
// for the retry. Only `disconnected` means the login is genuinely still open.
export const MAX_TRANSIENT_ACCOUNT_CHECKS = 3;

// How long a cancel waits for its account check before treating the outcome as unknown. The
// check holds the provider queue, so it must end even when the native check hangs.
export const ACCOUNT_CHECK_TIMEOUT_MS = 10_000;

// The app server owns each provider's connection generation (PROV-002). A new provider
// starts here; reconnect completion, sign-out and removal advance it.
export const FIRST_CONNECTION_GENERATION = 1;
// The app server's refusal of a publish from an older connection generation.
const CONNECTION_SUPERSEDED = "provider_connection_superseded";

// A staged create whose outcome is unknown: the store gave no answer, and reading it back
// failed too. Its durable leftovers stay for startup reconciliation, which keeps them only
// if the definition committed (F2).
export class ProviderPersistenceUnknown extends Error {
  constructor(cause) {
    super(cause instanceof Error ? cause.message : String(cause ?? "Provider creation outcome is unknown."));
    this.name = "ProviderPersistenceUnknown";
    this.cause = cause;
  }
}

// The disconnected catalog a sign-out commits with the next connection generation.
function signedOutCatalog(definition) {
  return {
    provider: { id: definition.id, label: definition.label, status: "disconnected", unavailableReason: null },
    models: [],
    systemFamily: { id: definition.id, label: definition.label, modelIds: [] },
  };
}

export class ProviderDefinitionService {
  constructor({
    registry,
    definitionStore,
    credentialStore,
    runtimeDependencies = () => ({}),
    prepareRuntime = async () => null,
    evaluateReadiness = async () => null,
    publishCatalog = async () => {},
    canRemove = async () => ({ allowed: true }),
    idGenerator = randomUUID,
    initialRuntimes = new Map(),
    retry = {},
    maxTransientAccountChecks = MAX_TRANSIENT_ACCOUNT_CHECKS,
    accountCheckTimeoutMs = ACCOUNT_CHECK_TIMEOUT_MS,
    diagnostics = null,
    onRuntimeReady = () => {},
    onRuntimeRemoved = () => {},
    onRuntimeChanged = () => {},
    onRuntimeUnavailable = () => {},
    removeRuntimeState = async () => false,
    providerStatuses = null,
  }) {
    if (!registry || !definitionStore || !credentialStore) throw new Error("ProviderDefinitionService requires registry and stores.");
    this.registry = registry;
    this.definitionStore = definitionStore;
    this.credentialStore = credentialStore;
    this.runtimeDependencies = runtimeDependencies;
    this.prepareRuntime = prepareRuntime;
    this.evaluateReadiness = evaluateReadiness;
    this.publishCatalog = publishCatalog;
    this.canRemove = canRemove;
    this.idGenerator = idGenerator;
    this.retry = retry;
    this.maxTransientAccountChecks = maxTransientAccountChecks;
    this.accountCheckTimeoutMs = accountCheckTimeoutMs;
    this.diagnostics = diagnostics;
    this.onRuntimeReady = onRuntimeReady;
    this.onRuntimeRemoved = onRuntimeRemoved;
    this.onRuntimeChanged = onRuntimeChanged;
    this.onRuntimeUnavailable = onRuntimeUnavailable;
    this.removeRuntimeState = removeRuntimeState;
    this.providerStatuses = providerStatuses;
    this.definitions = null;
    this.runtimes = new Map(initialRuntimes);
    this.pendingConnections = new Map();
    this.preparingConnections = new Map();
    this.activeExecutions = new Map();
    this.statusOverrides = new Map();
    // Generations learned after load. Kept apart from this.definitions, which queued
    // operations replace wholesale, so a resync outside the queue is never lost.
    this.connectionGenerations = new Map();
    // Providers with a lifecycle write whose answer was lost. It may still commit on the app
    // server, so an advance in their generation proves nothing about a later write. A later
    // answered write that advances the generation clears it: every lost write carried an older
    // or equal generation, which the app server now refuses.
    this.unansweredLifecycleWrites = new Set();
    // Reconnects past their first check that are not pending yet: they are preparing the runtime
    // or starting the sign-in on it. Counted per provider.
    this.reconnectPreparations = new Map();
    // Providers signed out locally whose signed-out state the app server has not recorded. It
    // may still read them connected, so new provider access is refused until it hears the
    // account's state: a recorded sign-out, a completed reconnect, or a published catalog.
    this.unrecordedSignOuts = new Set();
    this.queue = Promise.resolve();
    this.nextPreparationOrder = 1;
    this.lifecycleTasks = new Set();
    this.closing = false;
    this.closePromise = null;
  }

  adapters() { return this.registry.list().map(publicDescriptor); }

  async evaluateCatalogReadiness(id, models, trigger) {
    const definition = await this.#initialize().then((definitions) => (
      definitions.find((item) => item.id === id && item.lifecycleState === "active")
    ));
    if (!definition) throw new Error("Unknown active provider definition.");
    return this.evaluateReadiness({
      trigger,
      providerDefinition: publicDefinition(definition),
      models,
    });
  }

  /** Whether this provider's runtime could not be activated in this process. */
  activationFailed(id) {
    return this.statusOverrides.get(id)?.unavailableReason?.code === "provider_activation_failed";
  }

  async activeDefinitions() {
    return (await this.#initialize())
      .filter(({ lifecycleState }) => lifecycleState === "active")
      .map(publicDefinition);
  }

  async #initialize() {
    if (this.definitions === null) this.definitions = await this.definitionStore.load();
    return this.definitions;
  }

  /**
   * The connection generation a provider result starting now is tied to (PROV-002), or null
   * when the provider is not active. Its result has an effect only while this is unchanged.
   */
  connectionGeneration(id) {
    const definition = this.definitions?.find((item) => item.id === id);
    if (!definition || definition.lifecycleState !== "active") return null;
    return Math.max(
      definition.connectionGeneration ?? FIRST_CONNECTION_GENERATION,
      this.connectionGenerations.get(id) ?? FIRST_CONNECTION_GENERATION,
    );
  }

  /**
   * The connection generation a catalog refresh starting now carries, or null when it must not
   * run. A pending reconnect owns the provider's next state: a refresh would discover through
   * the runtime that reconnect is signing in, and an automatic result must not stand for the
   * user's sign-in (PROV-002). The refresh skips, or drops a result it already has.
   */
  refreshGeneration(id) {
    if (this.pendingConnections.has(id) || this.reconnectPreparations.has(id)) return null;
    return this.connectionGeneration(id);
  }

  // A saved connected catalog cannot authorize setup after a local sign-out whose
  // publication failed. Refresh may still run to record the signed-out state.
  readinessGeneration(id) {
    if (this.unrecordedSignOuts.has(id)) return null;
    return this.refreshGeneration(id);
  }

  /**
   * The app server accepted a catalog for this provider. A catalog that is not connected
   * records the signed-out state, so provider access may resume. A connected one does not: its
   * discovery may have read the account before a sign-out whose own publish failed.
   */
  catalogPublished(id, { connected } = {}) {
    if (connected !== true) this.unrecordedSignOuts.delete(id);
  }

  /** Rereads a generation the app server refused as stale. Generations only increase. */
  async resyncConnectionGeneration(id) {
    const stored = (await this.definitionStore.load()).find((item) => item.id === id);
    if (Number.isSafeInteger(stored?.connectionGeneration)) this.#recordGeneration(id, stored.connectionGeneration);
  }

  #recordGeneration(id, generation) {
    if (generation > (this.connectionGenerations.get(id) ?? 0)) this.connectionGenerations.set(id, generation);
  }

  // A lifecycle publish the app server refused because this process held an older
  // generation, for example after a lost response. Learn the current one.
  async #relearnAfterRefusal(id, error) {
    if (error?.code !== CONNECTION_SUPERSEDED) return false;
    try { await this.resyncConnectionGeneration(id); } catch { return false; }
    return true;
  }

  async list({ includeTombstones = false } = {}) {
    const definitions = await this.#initialize();
    const statuses = this.providerStatuses ? await this.providerStatuses() : null;
    return definitions
      .filter(({ lifecycleState }) => includeTombstones || lifecycleState !== "tombstoned")
      .map((definition) => {
        const override = this.statusOverrides.get(definition.id);
        if (statuses === null && !override) return publicDefinition(definition);
        const status = statuses instanceof Map ? statuses.get(definition.id) : statuses?.[definition.id];
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

  #activeDefinition(id) {
    const definition = this.definitions.find((item) => item.id === id);
    if (!definition || definition.lifecycleState !== "active") {
      throw new Error("Unknown active provider definition.");
    }
    return definition;
  }

  #reconnectableDefinition(id) {
    const definition = this.#activeDefinition(id);
    const descriptor = this.registry.get(definition.adapterId);
    if (descriptor.connection.mode === "secret-fields") throw new Error("API provider definitions do not support reconnect.");
    if (this.activeExecutions.has(id)) {
      throw new Error("Provider cannot reconnect while interactions are running.");
    }
    if (this.pendingConnections.has(id)) throw new Error("Provider reconnect is already pending.");
    return definition;
  }

  #assertUniqueLabel(label, exceptId = null, preparationOrder = null) {
    const normalized = label.trim().toLowerCase();
    if (this.definitions.some((definition) => definition.id !== exceptId
      && definition.lifecycleState !== "tombstoned"
      && definition.label.toLowerCase() === normalized)) {
      throw new Error("An active provider definition already uses that name.");
    }
    if ([...this.pendingConnections.values()].some(({ candidate }) => (
      candidate.id !== exceptId && candidate.label.toLowerCase() === normalized
    ))) throw new Error("A pending provider connection already uses that name.");
    if ([...this.preparingConnections.values()].some(({ candidate, order }) => (
      candidate?.id !== exceptId
      && candidate?.label.toLowerCase() === normalized
      && (preparationOrder === null || order < preparationOrder)
    ))) throw new Error("A preparing provider connection already uses that name.");
  }

  connect(input, options = {}) {
    if (this.closing) return Promise.reject(new Error("Provider setup is shutting down."));
    return this.#trackLifecycle(this.#connect(input, options));
  }

  #trackLifecycle(task) {
    this.lifecycleTasks.add(task);
    void task.finally(() => this.lifecycleTasks.delete(task)).catch(() => undefined);
    return task;
  }

  async #connect({ connectionId, harnessId, adapterId, label, endpoint, fields = {} }, { signal } = {}) {
    const id = String(connectionId ?? this.idGenerator()).trim().toLowerCase();
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)) {
      throw new Error("Provider connection requires a stable connection id.");
    }
    if (this.preparingConnections.has(id)) throw new Error("Provider connection id is already in use.");
    const descriptor = this.registry.get(adapterId);
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
    const preparation = {
      cancelled: false,
      cancellable: true,
      candidate,
      order: this.nextPreparationOrder++,
    };
    this.preparingConnections.set(id, preparation);
    let runtime;
    let credentialStored = false;
    try {
      await this.#serialized(async () => {
        await this.#initialize();
        signal?.throwIfAborted();
        if (preparation.cancelled) throw new Error("Provider connection was cancelled.");
        this.#assertUniqueLabel(label, id, preparation.order);
        if (this.definitions.some((definition) => definition.id === id)
          || this.pendingConnections.has(id)) {
          throw new Error("Provider connection id is already in use.");
        }
      });
      await this.prepareRuntime(Object.freeze({
        harnessId: harnessId ?? null,
        adapterId,
        providerDefinition: publicDefinition(candidate),
      }));
      signal?.throwIfAborted();
      if (preparation.cancelled) throw new Error("Provider connection was cancelled.");
      return await this.#serialized(async () => {
        signal?.throwIfAborted();
        if (preparation.cancelled) throw new Error("Provider connection was cancelled.");
        this.#assertUniqueLabel(label, id, preparation.order);
        if (this.definitions.some((definition) => definition.id === id)
          || this.pendingConnections.has(id)) {
          throw new Error("Provider connection id is already in use.");
        }
        runtime = this.registry.create(candidate, {
          ...await this.runtimeDependencies(candidate),
          secrets: fields,
        });
        if (descriptor.connection.mode === "managed-login") {
          const login = await runtime.credentials.login({ signal });
          signal?.throwIfAborted();
          if (preparation.cancelled) throw new Error("Provider connection was cancelled.");
          this.pendingConnections.set(id, { candidate, runtime, login });
          return Object.freeze({
            status: "pending",
            connectionId: id,
            providerDefinition: publicDefinition(candidate),
            login: Object.freeze({ ...(login ?? {}) }),
          });
        }
        const catalog = await this.#discover(runtime, signal);
        signal?.throwIfAborted();
        if (preparation.cancelled) throw new Error("Provider connection was cancelled.");
        if (catalog.provider?.status === "unavailable") throw new Error(catalog.provider.unavailableReason ?? "Provider is unavailable.");
        await this.evaluateReadiness({
          trigger: "connect",
          providerDefinition: publicDefinition(candidate),
          models: catalog.models ?? [],
        });
        signal?.throwIfAborted();
        if (preparation.cancelled) throw new Error("Provider connection was cancelled.");
        // Past this point the provider commit may perform atomic persistence
        // that cannot truthfully be reported to the renderer as cancelled.
        preparation.cancellable = false;
        // The credential precedes the commit so a committed definition always has it; a
        // failure below removes it again (PROV-007).
        if (credentialReference) {
          await this.credentialStore.set(credentialReference, fields);
          credentialStored = true;
        }
        await this.#persistNewProvider(candidate, catalog, signal);
        await this.#activateCommitted(candidate, runtime);
        return Object.freeze({ status: "connected", providerDefinition: publicDefinition(candidate) });
      });
    } catch (error) {
      await this.diagnostics?.write({
        category: "provider_connection_failed",
        adapterId,
        providerId: id,
        ...providerDiagnosticDetails(error),
      }).catch(() => undefined);
      // An unknown outcome keeps the credential and runtime state for startup to reconcile.
      const unknown = error instanceof ProviderPersistenceUnknown;
      try { await runtime?.close?.(); } catch { /* preserve the connection failure */ }
      if (runtime && !unknown) {
        try { await this.removeRuntimeState(candidate); } catch { /* preserve the connection failure */ }
      }
      if (credentialStored && !unknown) {
        try { await this.credentialStore.delete(credentialReference); } catch { /* preserve the connection failure */ }
      }
      throw error;
    } finally {
      this.preparingConnections.delete(id);
    }
  }

  /**
   * Persists a new provider's definition with its first catalog. Nothing publishes for the
   * provider before its definition exists (PROV-007). Once this returns, the definition is
   * durable and the connection stands.
   */
  async #persistNewProvider(candidate, catalog, signal) {
    if (typeof this.definitionStore.createWithCatalog !== "function") {
      await this.definitionStore.save([...this.definitions, candidate]);
      this.definitions.push({ ...candidate, connectionGeneration: FIRST_CONNECTION_GENERATION });
      // The definition exists, so the connection succeeded. A first catalog that fails to
      // publish is left to the next refresh, as any failed refresh is.
      await Promise.resolve()
        .then(() => this.publishCatalog(catalog, { signal, connectionGeneration: FIRST_CONNECTION_GENERATION }))
        .catch(() => undefined);
      return;
    }
    let generation = FIRST_CONNECTION_GENERATION;
    try {
      await this.definitionStore.createWithCatalog(candidate, catalog, { signal });
    } catch (error) {
      // A refusal carries the store's code and committed nothing.
      if (typeof error?.code === "string") throw error;
      // No answer: the create may have committed before its response was lost (F2). Read
      // the store back, and adopt the definition if it is there. A create the app server
      // commits only after this read is not caught here; its definition then activates
      // without a credential and shows the recovery state until it is removed.
      let stored;
      try {
        stored = await this.definitionStore.load();
      } catch {
        throw new ProviderPersistenceUnknown(error);
      }
      const committed = stored.find((item) => item.id === candidate.id && item.lifecycleState === "active");
      if (!committed) throw error;
      generation = committed.connectionGeneration ?? FIRST_CONNECTION_GENERATION;
    }
    this.definitions.push({ ...candidate, connectionGeneration: generation });
  }

  /**
   * Registers the runtime and catalog adapter of a committed connection. The adapter exists
   * only once the definition does (PROV-007). A registration failure cannot undo the commit,
   * so, as for a failed startup activation, the provider keeps the recovery adapter.
   */
  async #activateCommitted(definition, runtime) {
    this.runtimes.set(definition.id, runtime);
    try {
      await this.onRuntimeReady(definition, runtime);
    } catch (error) {
      if (this.runtimes.get(definition.id) === runtime) this.runtimes.delete(definition.id);
      try { await runtime.close?.(); } catch { /* the registration failure is reported */ }
      await this.#markUnavailable(definition, error);
    }
  }

  // The recovery state of a provider whose runtime could not be registered: its status says
  // so, and its recovery adapter's explicit refresh retries the activation.
  async #markUnavailable(definition, error) {
    this.statusOverrides.set(definition.id, {
      connected: false,
      unavailableReason: {
        code: "provider_activation_failed",
        message: "The provider could not be activated.",
      },
    });
    try { await this.onRuntimeUnavailable(definition, error); } catch (publicationError) {
      await this.diagnostics?.write({
        category: "provider_activation_status_publish_failed",
        adapterId: definition.adapterId,
        providerId: definition.id,
        ...providerDiagnosticDetails(publicationError),
      }).catch(() => undefined);
    }
    await this.diagnostics?.write({
      category: "provider_activation_failed",
      adapterId: definition.adapterId,
      providerId: definition.id,
      ...providerDiagnosticDetails(error),
    }).catch(() => undefined);
  }

  async #discover(runtime, signal) {
    const catalogAdapter = runtime.catalog ?? runtime;
    return withProviderRetry(
      () => catalogAdapter.connect?.({ signal }) ?? catalogAdapter.discover({ signal }),
      { ...this.retry, signal },
    );
  }

  async completeConnection(connectionId, { signal } = {}) {
    // Build the failure before cleanup runs, so cleanup cannot replace it.
    const settle = async (cause) => {
      const failure = new TerminalConnectionFailure(cause);
      try {
        await this.#cancelPendingConnection(connectionId);
      } catch {
        // The connection failure is the outcome; a cleanup problem cannot
        // become the reported one.
      }
      return failure;
    };
    return this.#serialized(async () => {
      const pending = this.pendingConnections.get(connectionId);
      if (!pending) throw new Error("Unknown pending provider connection.");
      signal?.throwIfAborted();
      // completeConnection is the caller's poll. "pending" is how this contract
      // says keep polling, so a connect whose account check has not succeeded
      // yet stays pending instead of rejecting: rejecting ends the caller's
      // loop and releases its ownership while this attempt still holds the
      // provider name, which then blocks the retry.
      const stillPending = (retrying) => Object.freeze({
        status: "pending",
        connectionId,
        providerDefinition: publicDefinition(pending.candidate),
        login: Object.freeze({ ...(pending.login ?? {}) }),
        retrying,
      });
      const settleFailedCheck = async (cause, category) => {
        await this.diagnostics?.write({
          category,
          adapterId: pending.candidate.adapterId,
          providerId: pending.candidate.id,
          ...providerDiagnosticDetails(cause),
        }).catch(() => undefined);
        return settle(cause);
      };
      // Never hold the provider queue behind setup: cancellation and sign-out must work
      // while an installer/probe runs. Its outcome cannot publish a connected catalog.
      if (pending.preparation && !pending.preparation.settled) return stillPending("runtime-preparing");
      if (pending.preparation?.failed) {
        throw await settleFailedCheck(pending.preparation.error, "managed_provider_reconnect_failed");
      }
      let account;
      try {
        account = await pending.runtime.credentials.account({ signal });
      } catch (error) {
        // An abort is the caller withdrawing the check, not a provider fault,
        // so it settles at once rather than spending the budget.
        const aborted = signal?.aborted === true || error?.name === "AbortError";
        if (!aborted && pending.reconnect !== true && this.#toleratesFailedCheck(pending)) {
          return stillPending("account-check-failed");
        }
        throw await settleFailedCheck(
          error,
          pending.reconnect === true ? "managed_provider_reconnect_failed" : "provider_connection_failed",
        );
      }
      if (account?.status !== "connected") {
        if (account?.status === "unavailable") {
          if (pending.reconnect !== true && this.#toleratesFailedCheck(pending)) {
            return stillPending("login-unavailable");
          }
          throw await settleFailedCheck(
            new Error("Provider login is unavailable."),
            pending.reconnect === true ? "managed_provider_reconnect_failed" : "provider_connection_failed",
          );
        }
        // The login is genuinely still open. A later hiccup starts its own
        // budget rather than inheriting this attempt's history.
        pending.failedChecks = 0;
        return Object.freeze({
          status: "pending",
          connectionId,
          providerDefinition: publicDefinition(pending.candidate),
          login: Object.freeze({ ...(pending.login ?? {}) }),
        });
      }
      // Set once the reconnect's publish is sent: only that write can commit the reconnect.
      let publishing = false;
      try {
        const catalog = await this.#discover(pending.runtime, signal);
        if (catalog.provider?.status === "unavailable") throw new Error(catalog.provider.unavailableReason ?? "Provider is unavailable.");
        await this.evaluateReadiness({
          trigger: pending.reconnect === true ? "reconnect" : "connect",
          providerDefinition: publicDefinition(pending.candidate),
          models: catalog.models ?? [],
        });
        if (pending.reconnect === true) {
          // The reconnect's catalog and the next connection generation commit together, so
          // every result still in flight from before it is inert (PROV-002). A reconnect a
          // later lifecycle action superseded is refused here and changes nothing.
          publishing = true;
          await this.publishCatalog(catalog, {
            signal,
            connectionGeneration: pending.generation,
            connectionEvent: "reconnected",
          });
          this.#recordGeneration(connectionId, pending.generation + 1);
          this.unansweredLifecycleWrites.delete(connectionId);
        } else {
          await this.#persistNewProvider(pending.candidate, catalog, signal);
        }
      } catch (error) {
        await this.diagnostics?.write({
          category: "managed_provider_catalog_failed",
          adapterId: pending.candidate.adapterId,
          providerId: pending.candidate.id,
          ...providerDiagnosticDetails(error),
        }).catch(() => undefined);
        // A later lifecycle action superseded this reconnect. It settles as failed, and the
        // next attempt starts from the app server's generation.
        if (pending.reconnect === true) await this.#relearnAfterRefusal(connectionId, error);
        if (error instanceof ProviderPersistenceUnknown) {
          // Keep the runtime state; startup keeps it only if the definition committed.
          this.pendingConnections.delete(connectionId);
          this.runtimes.delete(connectionId);
          try { await pending.runtime.close?.(); } catch { /* preserve the connection failure */ }
          throw new TerminalConnectionFailure(error);
        }
        // A publish with no answer may have committed before its response was lost, the
        // reconnect's counterpart of F2. Cancelling would wipe the login the app server just
        // recorded, so read the generation back first.
        const unanswered = pending.reconnect === true && publishing && typeof error?.code !== "string";
        const outcome = unanswered ? await this.#reconnectOutcome(connectionId, pending) : "refused";
        if (unanswered) this.unansweredLifecycleWrites.add(connectionId);
        if (outcome === "unknown") {
          // The app server may have committed the login, so nothing is wiped: the reconnect's
          // runtime stays the provider's own, and Settings follows the app server. The next
          // refresh relearns the generation if it advanced, then publishes the account's state.
          this.pendingConnections.delete(connectionId);
          this.statusOverrides.delete(connectionId);
          // This completion confirmed the account signed in before it published, so a login
          // exists again: an unrecorded sign-out no longer fences provider access.
          this.unrecordedSignOuts.delete(connectionId);
          await this.#activateCommitted(pending.candidate, pending.runtime);
          throw new TerminalConnectionFailure(error);
        }
        if (outcome !== "committed") throw await settle(error);
      }
      this.pendingConnections.delete(connectionId);
      if (pending.reconnect === true) {
        this.statusOverrides.delete(connectionId);
        this.unrecordedSignOuts.delete(connectionId);
      }
      // Only a committed connection registers its catalog adapter (PROV-002, PROV-007).
      await this.#activateCommitted(pending.candidate, pending.runtime);
      return Object.freeze({ status: "connected", providerDefinition: publicDefinition(pending.candidate) });
    });
  }

  // Whether a reconnect whose publish got no answer committed. The app server advances the
  // generation by one when it commits the reconnect, and refuses it once anything else has
  // advanced it. So the reconnect committed exactly when the generation now reads one past the
  // baseline it started from, provided that baseline was read from the app server and no
  // lifecycle write is unanswered: none before the reconnect whose request may still land,
  // and no sign-out during it. completeConnection holds the provider queue, so nothing else
  // here can advance it. A sign-out the app server answered makes the reconnect's refusal certain.
  // A generation that did not move means the publish never committed. Any other advance, an
  // unanswered sign-out, or a failed read is "unknown": the login may be committed and is kept.
  // (In this process only a removal could advance the generation by more than one, and a
  // removal leaves the provider inactive, which reads as refused; the exact check is defensive.)
  async #reconnectOutcome(id, pending) {
    if (pending.superseded) return "refused";
    let stored;
    try {
      stored = (await this.definitionStore.load()).find((item) => item.id === id);
    } catch {
      return "unknown";
    }
    if (stored?.lifecycleState !== "active" || !Number.isSafeInteger(stored.connectionGeneration)
      || stored.connectionGeneration <= pending.generation) return "refused";
    this.#recordGeneration(id, stored.connectionGeneration);
    if (!pending.baselineRead || pending.doubtful
      || stored.connectionGeneration !== pending.generation + 1) return "unknown";
    return "committed";
  }

  // Counts consecutive checks that could not reach a verdict. Returns whether
  // this attempt may stay pending; exhausting the budget settles it, which
  // releases the reserved provider name so the retry is admitted.
  #toleratesFailedCheck(pending) {
    pending.failedChecks = (pending.failedChecks ?? 0) + 1;
    return pending.failedChecks < this.maxTransientAccountChecks;
  }

  async cancelConnection(connectionId) {
    const preparation = this.preparingConnections.get(connectionId);
    if (preparation) {
      if (!preparation.cancellable) return false;
      preparation.cancelled = true;
      return true;
    }
    return this.#serialized(() => this.#cancelPendingConnection(connectionId));
  }

  async #cancelPendingConnection(connectionId) {
    const pending = this.pendingConnections.get(connectionId);
    if (!pending) return false;
    this.pendingConnections.delete(connectionId);
    const signedOut = () => {
      this.statusOverrides.set(connectionId, {
        connected: false,
        unavailableReason: {
          code: "provider_logged_out",
          message: "The provider is signed out.",
        },
      });
    };
    if (pending.reconnect === true && this.activeExecutions.has(connectionId)) {
      // A runtime a lease holds is never closed or wiped under its turn (PROV-004). While a
      // reconnect is pending acquireExecution refuses, and a reconnect never starts under a
      // lease, so this only guards the invariant. The runtime stays the provider's own.
      signedOut();
      return true;
    }
    if (pending.reconnect === true) {
      // The cancel wipes the login, so it records signed out with the next generation, as
      // sign-out does. That corrects an app server a failed sign-out publish left reading
      // connected, and makes stale any refresh that resolved its generation before the
      // reconnect and read the account mid-sign-in. It commits before the wipe, so the app
      // server never reads connected over a home with no login.
      const recorded = !this.closing && await this.#commitSignedOut(pending.candidate, {
        onFailure: (error) => this.diagnostics?.write({
          category: "provider_reconnect_cancel_sign_out_failed",
          adapterId: pending.candidate.adapterId,
          providerId: connectionId,
          ...providerDiagnosticDetails(error),
        }).catch(() => undefined),
      });
      // A sign-out the app server answered while this reconnect was pending already recorded
      // signed out, and no refresh runs while it is pending. Nothing is unknown: the confirmed
      // sign-out stands, so the reconnect's login is wiped even when this record fails.
      // Keeping needs a login to keep. An account that reads signed out has none, for example
      // after a sign-out whose publish failed: the cancel then tears down as usual, and new
      // provider access stays refused until the app server hears the signed-out state. A check
      // that cannot answer leaves the outcome unknown, which keeps any login.
      let keepLogin = !recorded && !pending.superseded;
      if (keepLogin && !this.closing) {
        let account = null;
        // Bounded: the check holds the provider queue. A timeout cannot answer, so it is unknown.
        const signal = AbortSignal.timeout(this.accountCheckTimeoutMs);
        const timedOut = new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        timedOut.catch(() => undefined);
        try {
          account = await Promise.race([pending.runtime.credentials.account({ signal }), timedOut]);
        } catch { /* unknown */ }
        if (account?.status === "disconnected") {
          keepLogin = false;
          this.unrecordedSignOuts.add(connectionId);
        } else if (account?.status === "connected") {
          // A confirmed login ends any fence from an earlier unrecorded sign-out.
          this.unrecordedSignOuts.delete(connectionId);
        }
      }
      if (keepLogin) {
        // The app server may still read connected, so wiping the login would leave it
        // admitting turns with none. As for an unknown reconnect outcome, the login and the
        // reconnect's runtime are kept, Settings follows the app server, and the next refresh
        // settles the state. During shutdown, close() closes the runtime.
        if (!this.closing) {
          this.statusOverrides.delete(connectionId);
          await this.#activateCommitted(pending.candidate, pending.runtime);
        }
        return true;
      }
      if (this.runtimes.get(connectionId) === pending.runtime) this.runtimes.delete(connectionId);
      await Promise.allSettled([
        pending.runtime.close?.(),
        this.removeRuntimeState(pending.candidate),
      ]);
      // A cancelled or failed reconnect leaves the active provider with a catalog adapter
      // (F4). A reconnect that created its runtime never replaced the recovery adapter, so
      // that one stays. A reconnect that reused the live runtime closed it above; a fresh
      // runtime takes its place, or the recovery adapter if none can start.
      if (pending.createdRuntime !== true && !this.closing
        && this.definitions?.some((item) => item.id === connectionId && item.lifecycleState === "active")) {
        try {
          // A runtime that finishes starting after close() began is closed again (#runtimeFor).
          await this.#runtimeFor(pending.candidate);
        } catch (error) {
          // The recovery adapter now stands in, and the status says so.
          if (!this.closing) await this.#markUnavailable(pending.candidate, error);
          return true;
        }
      }
      signedOut();
      return true;
    }
    this.runtimes.delete(connectionId);
    // Independent teardown stages. Run sequentially, a rejecting close() would
    // skip runtime-state and credential removal while the runtime is already
    // gone from both collections that could revisit it, stranding exactly the
    // state this cleanup exists to reclaim. The reconnect branch above settles
    // its stages for the same reason.
    await Promise.allSettled([
      pending.runtime.close?.(),
      this.removeRuntimeState(pending.candidate),
      pending.candidate.credentialReference
        ? this.credentialStore.delete(pending.candidate.credentialReference)
        : undefined,
    ]);
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
      if (this.activeExecutions.has(id)) {
        throw new Error("Provider cannot be signed out while interactions are running.");
      }
      const runtime = await this.#runtimeFor(definition);
      if (typeof runtime.credentials?.logout !== "function") throw new Error("Provider logout is unavailable.");
      // A pending reconnect this sign-out may supersede. Only a sign-out the app server
      // answered proves the reconnect can no longer commit; an unanswered one may or may not
      // have advanced the generation (#reconnectOutcome).
      const reconnecting = this.pendingConnections.get(id);
      const pendingReconnect = reconnecting?.reconnect === true ? reconnecting : null;
      const account = await runtime.credentials.logout({ signal });
      this.statusOverrides.set(id, {
        connected: false,
        unavailableReason: {
          code: "provider_logged_out",
          message: "The provider is signed out.",
        },
      });
      const logoutFailed = (error) => this.diagnostics?.write({
        category: "provider_logout_catalog_refresh_failed",
        adapterId: definition.adapterId,
        providerId: id,
        ...providerDiagnosticDetails(error),
      }).catch(() => undefined);
      if (await this.#commitSignedOut(definition, { signal, onFailure: logoutFailed })) {
        if (pendingReconnect) pendingReconnect.superseded = true;
      } else {
        this.unrecordedSignOuts.add(id);
        if (pendingReconnect) pendingReconnect.doubtful = true;
      }
      // The follow-up refresh runs behind this queue, not inside it. Awaiting it here would
      // deadlock behind an explicit refresh that is waiting for this queue (CR-V7).
      Promise.resolve()
        .then(() => this.onRuntimeChanged(definition, runtime))
        .catch(logoutFailed);
      return Object.freeze({ ...(account ?? { status: "disconnected" }) });
    });
  }

  /**
   * Commits the signed-out state with the next connection generation, so every result still in
   * flight from the signed-in account is inert (PROV-002). A user action, so a refusal rereads
   * the generation and retries once. Returns whether the app server answered; a failure is
   * only reported, and the next refresh publishes the account's state.
   */
  async #commitSignedOut(definition, { signal, onFailure }) {
    const signOut = async () => {
      const generation = this.connectionGeneration(definition.id);
      await this.publishCatalog(signedOutCatalog(definition), {
        signal,
        connectionGeneration: generation,
        connectionEvent: "signed-out",
      });
      this.#recordGeneration(definition.id, generation + 1);
    };
    try {
      try {
        await signOut();
      } catch (error) {
        if (!await this.#relearnAfterRefusal(definition.id, error)) throw error;
        await signOut();
      }
      this.unansweredLifecycleWrites.delete(definition.id);
      this.unrecordedSignOuts.delete(definition.id);
      return true;
    } catch (error) {
      if (typeof error?.code !== "string") this.unansweredLifecycleWrites.add(definition.id);
      await onFailure(error);
      return false;
    }
  }

  reconnect(id, options = {}) {
    if (this.closing) return Promise.reject(new Error("Provider setup is shutting down."));
    return this.#trackLifecycle(this.#reconnect(id, options));
  }

  async #reconnect(id, options = {}) {
    let preparing = false;
    try {
      return await this.#reconnectPrepared(id, options, () => {
        // From here the reconnect prepares the runtime and starts its sign-in on it, before it
        // is pending. No refresh runs through that runtime meanwhile (refreshGeneration).
        preparing = true;
        this.reconnectPreparations.set(id, (this.reconnectPreparations.get(id) ?? 0) + 1);
      });
    } finally {
      if (preparing) {
        const remaining = (this.reconnectPreparations.get(id) ?? 1) - 1;
        if (remaining > 0) this.reconnectPreparations.set(id, remaining);
        else this.reconnectPreparations.delete(id);
      }
    }
  }

  async #reconnectPrepared(id, { signal } = {}, beginPreparation) {
    const preparedDefinition = await this.#serialized(async () => {
      await this.#initialize();
      signal?.throwIfAborted();
      if (this.closing) throw new Error("Provider setup is shutting down.");
      const definition = publicDefinition(this.#reconnectableDefinition(id));
      beginPreparation();
      return definition;
    });
    // An installed adapter can start browser login while its update/repair probe runs.
    // Missing runtimes still need installation before their native login can start.
    const preparation = { settled: false, failed: false, error: null };
    const preparingRuntime = this.#trackLifecycle(Promise.resolve().then(() => {
      signal?.throwIfAborted();
      if (this.closing) throw new Error("Provider setup is shutting down.");
      return this.prepareRuntime(Object.freeze({
        harnessId: null,
        adapterId: preparedDefinition.adapterId,
        providerDefinition: preparedDefinition,
      }));
    }).then(
      () => { preparation.settled = true; },
      (error) => { preparation.error = error; preparation.failed = true; preparation.settled = true; },
    ));
    if (!this.runtimes.has(id)) {
      await preparingRuntime;
      if (preparation.failed) throw preparation.error;
    }
    signal?.throwIfAborted();
    if (this.closing) throw new Error("Provider setup is shutting down.");
    return this.#serialized(async () => {
      await this.#initialize();
      signal?.throwIfAborted();
      if (this.closing) throw new Error("Provider setup is shutting down.");
      const definition = this.#reconnectableDefinition(id);
      let runtime = this.runtimes.get(id);
      const createdRuntime = !runtime;
      if (!runtime) {
        runtime = this.registry.create(definition, {
          ...await this.runtimeDependencies(definition),
          secrets: {},
        });
      }
      if (typeof runtime.credentials?.login !== "function") throw new Error("Provider reconnect is unavailable.");
      let login;
      try {
        login = await runtime.credentials.login({ signal });
        if (this.closing) throw new Error("Provider setup is shutting down.");
      } catch (error) {
        if (createdRuntime) {
          try { await runtime.close?.(); } catch { /* preserve the login failure */ }
        }
        throw error;
      }
      // The generation this reconnect starts with, read from the app server; completing the
      // reconnect advances it.
      // A reconnect whose publish later gets no answer can adopt its commit only from a baseline
      // it read here (#reconnectOutcome).
      let baselineRead = true;
      try { await this.resyncConnectionGeneration(id); } catch { baselineRead = false; /* the known one stands */ }
      this.runtimes.set(id, runtime);
      this.pendingConnections.set(id, {
        candidate: definition,
        runtime,
        login,
        reconnect: true,
        createdRuntime,
        preparation,
        generation: this.connectionGeneration(id),
        baselineRead,
        // A sign-out the app server answered while this reconnect is pending: it refuses it.
        superseded: false,
        // A lifecycle write whose answer was lost, before or during this reconnect: it may
        // still commit, so an advance does not prove this reconnect's publish committed.
        doubtful: this.unansweredLifecycleWrites.has(id),
      });
      this.statusOverrides.set(id, {
        connected: false,
        unavailableReason: {
          code: "provider_login_pending",
          message: "Provider sign-in is pending.",
        },
      });
      return Object.freeze({
        status: "pending",
        connectionId: id,
        providerDefinition: publicDefinition(definition),
        login: Object.freeze({ ...(login ?? {}) }),
      });
    });
  }

  async acquireExecution(id) {
    if (this.closing) throw new Error("Provider setup is shutting down.");
    return this.#serialized(async () => {
      await this.#initialize();
      // close() does not wait for this queue, so a lease requested before shutdown may run
      // after it. It must not start a runtime nothing would close.
      if (this.closing) throw new Error("Provider setup is shutting down.");
      const definition = this.definitions.find((item) => item.id === id);
      if (!definition || definition.lifecycleState !== "active") throw new Error("Provider is unavailable for new interactions.");
      // A pending reconnect owns the runtime it is signing in, and settling that reconnect may
      // close it and wipe the provider home. The turn is refused until it settles (PROV-004).
      if (this.pendingConnections.has(id) || this.reconnectPreparations.has(id)) {
        throw new Error("Provider sign-in is pending.");
      }
      // Signed out locally while the app server may still read it connected.
      if (this.unrecordedSignOuts.has(id)) throw new Error("Provider is signed out.");
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
            await this.#finalizeDrainedRemoval(id);
          });
        },
        // The lease owner has durably recorded that the work using this access ended. A
        // removal the store refused while that work still counted as running can finish now.
        acknowledge: async () => {
          await this.#serialized(() => this.#finalizeDrainedRemoval(id));
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
    const discard = async () => {
      try { await this.onRuntimeRemoved(definition); } catch { /* preserve the original failure */ }
      try { await runtime.close?.(); } catch { /* preserve the original failure */ }
    };
    try {
      await this.onRuntimeReady(definition, runtime);
    } catch (error) {
      await discard();
      throw error;
    }
    // close() does not wait for the provider queue, so it may already have closed and cleared
    // the runtimes. A runtime registered now would outlive it.
    if (this.closing) {
      await discard();
      throw new Error("Provider setup is shutting down.");
    }
    this.runtimes.set(definition.id, runtime);
    this.statusOverrides.delete(definition.id);
    return runtime;
  }

  recoverUnavailable(id, options = {}) {
    if (this.closing) return Promise.reject(new Error("Provider setup is shutting down."));
    return this.#trackLifecycle(this.#recoverUnavailable(id, options));
  }

  async #recoverUnavailable(id, { signal } = {}) {
    const preparedDefinition = await this.#serialized(async () => {
      await this.#initialize();
      signal?.throwIfAborted();
      if (this.closing) throw new Error("Provider setup is shutting down.");
      return publicDefinition(this.#activeDefinition(id));
    });
    await this.prepareRuntime(Object.freeze({
      harnessId: null,
      adapterId: preparedDefinition.adapterId,
      providerDefinition: preparedDefinition,
    }));
    signal?.throwIfAborted();
    if (this.closing) throw new Error("Provider setup is shutting down.");
    return this.#serialized(async () => {
      await this.#initialize();
      signal?.throwIfAborted();
      if (this.closing) throw new Error("Provider setup is shutting down.");
      const definition = this.#activeDefinition(id);
      // A pending reconnect owns the provider's next runtime. Recovery must not discover
      // through the runtime that reconnect is signing in (L1).
      if (this.pendingConnections.has(id)) throw new Error("Provider reconnect is pending.");
      const runtime = await this.#runtimeFor(definition);
      return this.#discover(runtime, signal);
    });
  }

  async activate() {
    return this.#serialized(async () => {
      await this.#initialize();
      for (const definition of this.definitions.filter(({ lifecycleState }) => lifecycleState === "active")) {
        try {
          await this.#runtimeFor(definition);
        } catch (error) {
          if (!this.closing) await this.#markUnavailable(definition, error);
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
      // removal_pending blocks new attempts through this provider at once, so
      // a pending reconnect can no longer complete. Only its entry goes: its
      // runtime is the one in this.runtimes, which admitted turns may still
      // lease, and it closes with the rest of the teardown.
      this.pendingConnections.delete(id);
      const pending = next.find((item) => item.id === id);
      if (!this.activeExecutions.has(id)) await this.#finalizeRemoval(definition);
      return publicDefinition(this.definitions.find((item) => item.id === id) ?? pending);
    });
  }

  /**
   * Retries every removal whose provider has no running lease. Called when an owner
   * acknowledges a lease the harness host no longer tracks.
   */
  async finalizeDrainedRemovals() {
    await this.#serialized(async () => {
      await this.#initialize();
      for (const { id } of this.definitions.filter(({ lifecycleState }) => lifecycleState === "removal_pending")) {
        await this.#finalizeDrainedRemoval(id);
      }
    });
  }

  async #finalizeDrainedRemoval(id) {
    const current = this.definitions.find((item) => item.id === id);
    if (!this.activeExecutions.has(id) && current?.lifecycleState === "removal_pending") {
      await this.#finalizeRemoval(current);
    }
  }

  /**
   * Tombstones a drained provider. Returns false, leaving it `removal_pending`, while the
   * store still records an execution attempt through it as running; that attempt's
   * acknowledgement retries.
   */
  async #finalizeRemoval(definition) {
    const next = this.definitions.map((item) => item.id === definition.id ? {
      ...item,
      credentialReference: null,
      lifecycleState: "tombstoned",
      removedAt: new Date().toISOString(),
    } : item);
    try {
      await this.definitionStore.save(next);
    } catch (error) {
      if (error?.code === "provider_execution_drain_incomplete") return false;
      throw error;
    }
    this.definitions = next;
    // The authoritative tombstone must commit before destructive cleanup. If a
    // durable running attempt still references this provider, the store rejects
    // above and the runtime and credentials remain usable by that attempt.
    await this.runtimes.get(definition.id)?.close?.().catch(() => undefined);
    this.runtimes.delete(definition.id);
    await this.onRuntimeRemoved(definition);
    await this.removeRuntimeState(definition);
    if (definition.credentialReference) await this.credentialStore.delete(definition.credentialReference);
    return true;
  }

  /**
   * Finishes removals and cleanup left by the previous run. Each pending removal is attempted
   * on its own, and credential and runtime-state cleanup run even if one fails. A failure is
   * recorded, never thrown, so it cannot stop Relayer from starting or other providers from
   * activating. A removal that fails or is deferred before its tombstone stays pending for the
   * next start; cleanup that fails after the tombstone is swept by the next start's cleanup.
   */
  async reconcileStartup() {
    return this.#serialized(async () => {
      await this.#initialize();
      for (const definition of this.definitions.filter(({ lifecycleState }) => lifecycleState === "removal_pending")) {
        try {
          if (!await this.#finalizeRemoval(definition)) {
            await this.#recordStartupCleanupFailure("provider_removal_startup_deferred", null, definition.id, definition.adapterId);
          }
        } catch (error) {
          await this.#recordStartupCleanupFailure("provider_removal_startup_failed", error, definition.id, definition.adapterId);
        }
      }
      try {
        await this.removeRuntimeState.reconcile?.(this.definitions);
      } catch (error) {
        await this.#recordStartupCleanupFailure("provider_runtime_state_startup_cleanup_failed", error);
      }
      if (typeof this.credentialStore.listReferences === "function") {
        const retained = new Set(this.definitions.flatMap((definition) => (
          definition.lifecycleState !== "tombstoned" && definition.credentialReference
            ? [definition.credentialReference]
            : []
        )));
        let references = [];
        try {
          references = await this.credentialStore.listReferences();
        } catch (error) {
          await this.#recordStartupCleanupFailure("provider_credential_startup_cleanup_failed", error);
        }
        for (const reference of references) {
          if (retained.has(reference)) continue;
          try {
            await this.credentialStore.delete(reference);
          } catch (error) {
            await this.#recordStartupCleanupFailure(
              "provider_credential_startup_cleanup_failed",
              error,
              reference.startsWith("provider:") ? reference.slice("provider:".length) : null,
            );
          }
        }
      }
    });
  }

  async #recordStartupCleanupFailure(category, error, providerId = null, adapterId = null) {
    await this.diagnostics?.write({
      category,
      ...(providerId === null ? {} : { providerId }),
      ...(adapterId === null ? {} : { adapterId }),
      ...(error === null ? {} : providerDiagnosticDetails(error)),
    }).catch(() => undefined);
  }

  /**
   * Refuses new provider access, connects and reconnects from now on. Shutdown calls it before
   * it awaits the app server, so no turn is admitted onto a runtime that close() then closes.
   */
  beginShutdown() {
    this.closing = true;
    for (const preparation of this.preparingConnections.values()) {
      if (preparation.cancellable) preparation.cancelled = true;
    }
  }

  async close() {
    this.closePromise ??= (async () => {
      this.beginShutdown();
      await Promise.allSettled([...this.lifecycleTasks]);
      const runtimes = new Set([
        ...this.runtimes.values(),
        ...[...this.pendingConnections.values()].map(({ runtime }) => runtime),
      ]);
      await Promise.allSettled([...runtimes].map((runtime) => runtime.close?.()));
      this.runtimes.clear();
      this.pendingConnections.clear();
      this.preparingConnections.clear();
    })();
    await this.closePromise;
  }
}
