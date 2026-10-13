// PROV-002 (superseded results are inert) and PROV-007 (connect is all-or-nothing), driven
// through the real provider composition. The fake product server keeps the app server's
// catalog contract: a publish names the connection generation its result started with, a
// lifecycle event advances it in the same write, and a missing or stale one is refused.
import { describe, expect, it, vi } from "vitest";

import { createHarnessReadinessCoordinator } from "../desktop/main/services/harness-readiness.mjs";
import { createProviderAdapterRegistry } from "../desktop/main/providers/provider-adapter-contract.mjs";
import { createProviderComposition } from "../desktop/main/providers/provider-composition.mjs";
import { createProviderExecutionAccessBroker } from "../desktop/main/services/graphcomplete-runtime.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function coded(code) {
  return Object.assign(new Error(code), { code });
}

const model = {
  id: "agent-model", executionModel: "agent-model", label: "Agent model", description: "",
  visible: true, availability: "available", unavailableReason: null, availabilityNotice: null,
  isDefault: true, replacementModelId: null, upgradeInfo: null, supportedEfforts: [],
  defaultEffort: null, inputModalities: ["text"], supportsPersonality: false,
  serviceTiers: [], defaultServiceTier: null,
};

function catalog(definition, status = "available") {
  return {
    provider: { id: definition.id, label: definition.label, status, unavailableReason: status === "unavailable" ? "Unavailable." : null },
    models: status === "available" ? [model] : [],
    systemFamily: { id: definition.id, label: definition.label, modelIds: [] },
  };
}

// The app server's provider rows and catalog publishes.
function productServer(definitions = []) {
  const rows = new Map(definitions.map((definition) => [definition.id, {
    definition: structuredClone(definition), generation: 1, connected: false,
  }]));
  const published = [];
  const server = {
    rows,
    published,
    // Every publish that reached the server, refused or not.
    attempts: [],
    loadFails: false,
    loseNextResponse: null,
    // Every publish fails before reaching the store, as when the app server is unreachable.
    publishFails: false,
    // Fails only the next n publishes, as when one request is lost.
    failNextPublishes: 0,
    // The next publish of this lifecycle event loses its answer at once, but commits only when
    // the test calls commitDelayed(): a request still in flight on the app server.
    delayNextCommit: null,
    commitDelayed: null,
    // The next refusal's answer is lost: the client sees a transport error.
    loseNextRefusal: false,
    // The next publish of this lifecycle event fails before it reaches the store.
    failNextEvent: null,
    failedPublishes: 0,
    // Stalls the next definition save after it is reached, holding the provider queue.
    holdNextSave: null,
    refused: 0,
    connected: (id) => rows.get(id)?.connected ?? null,
    store: {
      async load() {
        if (server.loadFails) throw new Error("app server unreachable");
        return [...rows.values()].map(({ definition, generation }) => ({ ...structuredClone(definition), connectionGeneration: generation }));
      },
      async save(next) {
        const hold = server.holdNextSave;
        server.holdNextSave = null;
        if (hold) {
          hold.reached.resolve();
          await hold.release.promise;
        }
        for (const definition of next) {
          const row = rows.get(definition.id);
          const { connectionGeneration: _ignored, ...stored } = definition;
          if (!row) rows.set(definition.id, { definition: stored, generation: 1, connected: false });
          else {
            if (row.definition.lifecycleState !== stored.lifecycleState) row.generation += 1;
            row.definition = stored;
          }
        }
      },
      async createWithCatalog(definition, discovered) {
        if (rows.has(definition.id)) throw coded("provider_definition_exists");
        rows.set(definition.id, {
          definition: structuredClone(definition), generation: 1, connected: discovered.provider.status === "available",
        });
        published.push({ providerId: definition.id, connected: discovered.provider.status === "available", created: true });
        if (server.loseNextResponse === "create") {
          server.loseNextResponse = null;
          throw new Error("socket hang up");
        }
      },
    },
    async publishCatalog(snapshot, { connectionGeneration, connectionEvent } = {}) {
      if (server.publishFails || server.failNextPublishes > 0) {
        if (server.failNextPublishes > 0) server.failNextPublishes -= 1;
        server.failedPublishes += 1;
        throw new Error("app server unreachable");
      }
      server.attempts.push({ providerId: snapshot.providerId, connectionGeneration, connectionEvent });
      if (!Number.isSafeInteger(connectionGeneration)) throw coded("invalid_request");
      const row = rows.get(snapshot.providerId);
      if (!row) throw coded("provider_unknown");
      if (row.definition.lifecycleState !== "active") throw coded("provider_not_active");
      if (server.failNextEvent && server.failNextEvent === connectionEvent) {
        server.failNextEvent = null;
        server.failedPublishes += 1;
        throw new Error("app server unreachable");
      }
      if (server.delayNextCommit && server.delayNextCommit === connectionEvent) {
        server.delayNextCommit = null;
        server.commitDelayed = () => server.publishCatalog(snapshot, { connectionGeneration, connectionEvent });
        throw new Error("socket hang up");
      }
      if (connectionGeneration !== row.generation) {
        server.refused += 1;
        if (server.loseNextRefusal) {
          server.loseNextRefusal = false;
          throw new Error("socket hang up");
        }
        throw coded("provider_connection_superseded");
      }
      if (connectionEvent) row.generation += 1;
      row.connected = snapshot.connected;
      published.push({ ...snapshot, connectionGeneration, connectionEvent });
      if (server.loseNextResponse === connectionEvent) {
        server.loseNextResponse = null;
        throw new Error("socket hang up");
      }
    },
  };
  return server;
}

function credentialFile(entries = []) {
  const values = new Map(entries);
  return {
    values,
    async get(reference) { return values.get(reference) ?? null; },
    async set(reference, value) { values.set(reference, structuredClone(value)); },
    async delete(reference) { values.delete(reference); },
    async listReferences() { return [...values.keys()]; },
  };
}

const managedDefinition = {
  id: "managed-work", adapterId: "fake-managed", label: "Work", endpoint: null,
  accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active", removedAt: null,
};

// A managed-login provider whose upstream account the test controls. Each runtime is one
// app-server process: its catalog reads the account, and `holdNextDiscover` stalls the next
// discovery after it has read. The login lives in the provider's home, so wiping that home
// (removeRuntimeState) signs the account out. A turn's execution access hands it the home.
function managedWorld({ activationFails = false } = {}) {
  const world = {
    account: "connected",
    activationFails,
    runtimes: [],
    holdNextDiscover: null,
    homeWipes: 0,
    holdNextDependencies: null,
    // Holds the next login() after it starts, as a browser sign-in flow being set up.
    holdNextLogin: null,
    // The account check hangs until its signal aborts, as a stuck `auth status` child does.
    accountHangs: false,
    catalogUnavailable: false,
    // Holds the next discovery before it reads the account, so the read can land mid-sign-in.
    gateNextDiscover: null,
  };
  world.removeRuntimeState = vi.fn(async () => {
    world.homeWipes += 1;
    world.account = "disconnected";
    return true;
  });
  world.runtimeDependencies = async () => {
    const hold = world.holdNextDependencies;
    world.holdNextDependencies = null;
    if (hold) {
      hold.reached.resolve();
      await hold.release.promise;
    }
    return {};
  };
  const create = ({ definition }) => {
    if (world.activationFails) throw new Error("managed runtime unavailable");
    const runtime = {
      definition,
      closed: false,
      discoveries: 0,
      credentials: {
        login: vi.fn(async () => {
          const hold = world.holdNextLogin;
          world.holdNextLogin = null;
          if (hold) {
            hold.reached.resolve();
            await hold.release.promise;
          }
          return { authUrl: "https://login.example.test/work" };
        }),
        account: vi.fn(async ({ signal } = {}) => {
          if (world.accountHangs) {
            await new Promise((resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
            });
          }
          return { status: world.account };
        }),
        logout: vi.fn(async () => { world.account = "disconnected"; return { status: "disconnected" }; }),
      },
      catalog: {
        providerId: definition.id,
        discover: async () => {
          runtime.discoveries += 1;
          const gate = world.gateNextDiscover;
          world.gateNextDiscover = null;
          if (gate) {
            gate.reached.resolve();
            await gate.release.promise;
          }
          const status = world.catalogUnavailable ? "unavailable"
            : world.account === "connected" ? "available" : "disconnected";
          const hold = world.holdNextDiscover;
          world.holdNextDiscover = null;
          if (hold) {
            hold.reached.resolve();
            await hold.release.promise;
          }
          const snapshot = catalog(definition, status);
          if (world.catalogModels !== undefined) snapshot.models = world.catalogModels;
          return snapshot;
        },
      },
      executionAccess: async () => {
        if (runtime.closed) throw new Error("runtime closed");
        if (world.account !== "connected") throw new Error("not connected");
        return {
          kind: "managed-runtime", runtimeId: "codex", version: "1", executable: "/bin/codex",
          environment: { CODEX_HOME: `/runtime/${definition.id}/codex-home` },
        };
      },
      close: vi.fn(async () => { runtime.closed = true; }),
    };
    world.runtimes.push(runtime);
    return runtime;
  };
  world.registry = createProviderAdapterRegistry([{
    adapterId: "fake-managed", implementationVersion: "1", label: "Managed", accessContract: "managed-runtime@1",
    defaultEndpoint: null, connection: { mode: "managed-login", fields: [] }, create,
  }]);
  world.hold = () => {
    const hold = { reached: deferred(), release: deferred() };
    world.holdNextDiscover = hold;
    return hold;
  };
  return world;
}

function compose({
  registry, server, credentials = credentialFile(), prepareRuntime, evaluateReadiness, diagnostics = null,
  removeRuntimeState, runtimeDependencies, accountCheckTimeoutMs,
}) {
  return createProviderComposition({
    registry,
    definitionStore: server.store,
    credentialStore: credentials,
    publishCatalog: (snapshot, options) => server.publishCatalog(snapshot, options),
    // Settings reads each provider's connection from the app server.
    providerStatuses: async () => new Map([...server.rows].map(([id, row]) => [id, { connected: row.connected }])),
    prepareRuntime,
    evaluateReadiness,
    removeRuntimeState,
    runtimeDependencies,
    accountCheckTimeoutMs,
    diagnostics,
    modelCatalogOptions: { backgroundIntervalMs: 60_000 },
  });
}

describe("PROV-002: a superseded provider result is inert", () => {
  // F3: a refresh requested during recovery used to capture the recovery adapter when it was
  // requested. It then ran after the recovery and overwrote "connected" with "could not be
  // activated". The adapter is now resolved when the refresh runs.
  it("keeps a recovered provider connected when a refresh requested during recovery runs after it", async () => {
    const definition = {
      id: "recoverable", adapterId: "recoverable-api", label: "Recoverable", endpoint: "https://recover.example/v1",
      accessContract: "secret@1", credentialReference: "provider:recoverable", lifecycleState: "active", removedAt: null,
    };
    let runtimeReady = false;
    const installing = deferred();
    const installStarted = deferred();
    const server = productServer([definition]);
    const composition = compose({
      server,
      credentials: credentialFile([["provider:recoverable", { key: "opaque" }]]),
      registry: createProviderAdapterRegistry([{
        adapterId: "recoverable-api", implementationVersion: "1", label: "Recoverable API",
        accessContract: "secret@1", defaultEndpoint: "https://recover.example/v1",
        connection: { mode: "secret-fields", fields: [{ id: "key", label: "Key", kind: "secret" }] },
        create: ({ definition: created }) => {
          if (!runtimeReady) throw new Error("managed runtime unavailable");
          return { providerId: created.id, discover: async () => catalog(created), close: async () => {} };
        },
      }]),
      // The managed runtime is missing after an update: activation fails and recovery installs it.
      prepareRuntime: async () => { installStarted.resolve(); await installing.promise; runtimeReady = true; },
    });
    try {
      await composition.start();
      expect(server.connected("recoverable")).toBe(false);

      // "Refresh models" starts the recovery; Settings reopens while the runtime installs.
      const explicit = composition.modelCatalog.explicitRefresh("recoverable");
      await installStarted.promise;
      const reopened = composition.modelCatalog.settingsOpened();
      installing.resolve();
      await explicit;
      await reopened;

      expect(server.published.filter(({ providerId }) => providerId === "recoverable").at(-1))
        .toMatchObject({ connected: true });
      expect(server.connected("recoverable")).toBe(true);
    } finally {
      await composition.close();
    }
  });

  // F4: a cancelled reconnect used to unregister the catalog adapter of a provider that stays
  // active. Explicit refresh then threw "Unknown model provider" and background refresh
  // skipped it.
  it("keeps a catalog adapter for an active provider whose reconnect is cancelled", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server });
    try {
      await composition.start();
      await composition.providerDefinitions.logout(managedDefinition.id);
      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      expect(pending).toMatchObject({ status: "pending" });
      await expect(composition.providerDefinitions.cancelConnection(pending.connectionId)).resolves.toBe(true);
      // The reconnect's login ran in the live runtime, so that runtime closed with it.
      expect(world.runtimes[0].closed).toBe(true);

      world.account = "connected";
      await expect(composition.modelCatalog.explicitRefresh(managedDefinition.id)).resolves.toMatchObject({
        provider: { status: "available" },
      });
      expect(server.connected(managedDefinition.id)).toBe(true);
    } finally {
      await composition.close();
    }
  });

  it("falls back to the recovery adapter when a cancelled reconnect cannot restart the runtime", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server });
    try {
      await composition.start();
      await composition.providerDefinitions.logout(managedDefinition.id);
      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      world.activationFails = true;
      await composition.providerDefinitions.cancelConnection(pending.connectionId);
      expect(await composition.providerDefinitions.list()).toEqual([expect.objectContaining({
        id: managedDefinition.id,
        unavailableReason: expect.objectContaining({ code: "provider_activation_failed" }),
      })]);

      // The recovery adapter's explicit refresh activates the provider again.
      world.activationFails = false;
      world.account = "connected";
      await composition.modelCatalog.explicitRefresh(managedDefinition.id);
      expect(server.connected(managedDefinition.id)).toBe(true);
    } finally {
      await composition.close();
    }
  });

  // The user signs out while a reconnect is pending. The reconnect started under the older
  // generation, so its completion is refused and changes nothing. The next reconnect lands.
  it("refuses a reconnect a later sign-out superseded, then lets the next one land", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server });
    try {
      await composition.start();
      await composition.providerDefinitions.logout(managedDefinition.id);
      const first = await composition.providerDefinitions.reconnect(managedDefinition.id);
      await composition.providerDefinitions.logout(managedDefinition.id);
      world.account = "connected";
      await expect(composition.providerDefinitions.completeConnection(first.connectionId))
        .rejects.toThrow("provider_connection_superseded");
      expect(server.connected(managedDefinition.id)).toBe(false);

      const second = await composition.providerDefinitions.reconnect(managedDefinition.id);
      await expect(composition.providerDefinitions.completeConnection(second.connectionId))
        .resolves.toMatchObject({ status: "connected" });
      expect(server.connected(managedDefinition.id)).toBe(true);
      // Two sign-outs, the refused reconnect's settle recording signed out, and the reconnect.
      expect(server.rows.get(managedDefinition.id).generation).toBe(5);
    } finally {
      await composition.close();
    }
  });

  // CR-V1: a refresh discovered "disconnected" after sign-out, then stalled. A completed
  // reconnect published "connected" directly. The stalled result then published over it.
  it("drops a refresh that discovered before a reconnect completed", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server });
    try {
      await composition.start();
      await composition.providerDefinitions.logout(managedDefinition.id);
      expect(server.connected(managedDefinition.id)).toBe(false);

      const stalled = world.hold();
      const reopened = composition.modelCatalog.settingsOpened();
      await stalled.reached.promise;

      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      world.account = "connected";
      await expect(composition.providerDefinitions.completeConnection(pending.connectionId))
        .resolves.toMatchObject({ status: "connected" });
      expect(server.connected(managedDefinition.id)).toBe(true);

      stalled.release.resolve();
      const [stale] = await reopened;
      expect(server.connected(managedDefinition.id)).toBe(true);
      expect(server.published.at(-1)).toMatchObject({ connected: true, connectionEvent: "reconnected" });
      expect(stale).toBeNull();
      // Direct reconnect publication does not resurrect the previous generation cache.
      expect(await composition.readinessRoutes()).toEqual([]);
      await composition.modelCatalog.settingsOpened();
      expect(await composition.readinessRoutes()).toHaveLength(1);
    } finally {
      await composition.close();
    }
  });

  // A lifecycle write can commit although its response is lost. The app server then refuses
  // the next refresh as stale, and the refresh learns the current generation so later ones land.
  it("relearns a generation the app server advanced behind a lost response", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const diagnostics = { write: vi.fn(async () => {}) };
    const composition = compose({ registry: world.registry, server, diagnostics });
    try {
      await composition.start();
      server.loseNextResponse = "signed-out";
      await composition.providerDefinitions.logout(managedDefinition.id);
      expect(diagnostics.write).toHaveBeenCalledWith(expect.objectContaining({
        category: "provider_logout_catalog_refresh_failed",
      }));
      // The app server advanced; this process did not hear about it.
      expect(server.rows.get(managedDefinition.id).generation).toBe(2);
      expect(server.connected(managedDefinition.id)).toBe(false);

      // A refresh after it, logout's own or the first explicit one, is refused and relearns
      // the generation; the next one lands.
      world.account = "connected";
      await composition.modelCatalog.explicitRefresh(managedDefinition.id);
      await composition.modelCatalog.explicitRefresh(managedDefinition.id);
      expect(server.refused).toBeGreaterThan(0);
      expect(composition.providerDefinitions.connectionGeneration(managedDefinition.id)).toBe(2);
      expect(server.connected(managedDefinition.id)).toBe(true);
    } finally {
      await composition.close();
    }
  });

  // CR-V7: logout awaited its own refresh inside the provider queue. That refresh was queued
  // behind an explicit refresh through the recovery adapter, which waited for the provider
  // queue. Neither returned.
  it("signs out while an explicit recovery is queued behind another refresh", async () => {
    const world = managedWorld({ activationFails: true });
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server });
    try {
      // The startup refresh through the recovery adapter holds its publish.
      const publish = server.publishCatalog;
      const startupPublish = deferred();
      let held = false;
      server.publishCatalog = async (...args) => {
        if (!held) { held = true; await startupPublish.promise; }
        return publish(...args);
      };
      const started = composition.start();
      await vi.waitFor(() => expect(held).toBe(true));
      const explicit = composition.modelCatalog.explicitRefresh(managedDefinition.id);

      world.activationFails = false;
      const logout = composition.providerDefinitions.logout(managedDefinition.id);
      await vi.waitFor(() => expect(world.runtimes).toHaveLength(1));
      startupPublish.resolve();
      await started;

      const outcome = await Promise.race([
        logout.then(() => "returned"),
        new Promise((resolve) => { setTimeout(() => resolve("deadlocked"), 2_000).unref?.(); }),
      ]);
      expect(outcome).toBe("returned");
      await explicit;
      expect(server.connected(managedDefinition.id)).toBe(false);
    } finally {
      await composition.close();
    }
  });

  // L1: recovery through the recovery adapter used to discover through the runtime a pending
  // reconnect was signing in.
  it("does not recover through the runtime of a pending reconnect", async () => {
    const world = managedWorld({ activationFails: true });
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server });
    try {
      await composition.start();
      world.activationFails = false;
      world.account = "disconnected";
      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      const [reconnecting] = world.runtimes;

      await composition.modelCatalog.explicitRefresh(managedDefinition.id);
      expect(reconnecting.discoveries).toBe(0);
      expect(server.connected(managedDefinition.id)).toBe(false);

      world.account = "connected";
      await expect(composition.providerDefinitions.completeConnection(pending.connectionId))
        .resolves.toMatchObject({ status: "connected" });
      await composition.modelCatalog.explicitRefresh(managedDefinition.id);
      expect(reconnecting.discoveries).toBe(2);
      expect(server.connected(managedDefinition.id)).toBe(true);
    } finally {
      await composition.close();
    }
  });

  // P3: a refresh during a pending reconnect discovered through the runtime the reconnect
  // reuses and published "connected". Cancelling the reconnect wiped the login but superseded
  // nothing, so the app server kept admitting turns that Settings showed as signed out.
  it("runs no refresh while a reconnect is pending, so a cancelled reconnect leaves the app server signed out", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    try {
      await composition.start();
      await composition.providerDefinitions.logout(managedDefinition.id);
      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      // The browser sign-in finished; the poll has not seen it yet. The user reopens Settings.
      world.account = "connected";
      const refreshed = await composition.modelCatalog.settingsOpened();
      expect(server.connected(managedDefinition.id)).toBe(false);
      expect(refreshed).toEqual([null]);
      expect(await composition.readinessRoutes()).toEqual([]);

      await composition.providerDefinitions.cancelConnection(pending.connectionId);
      expect(world.homeWipes).toBe(1);
      expect(server.connected(managedDefinition.id)).toBe(false);
      expect((await composition.providerDefinitions.list())[0]).toMatchObject({
        connected: false,
        unavailableReason: expect.objectContaining({ code: "provider_logged_out" }),
      });
    } finally {
      await composition.close();
    }
  });

  // A sign-out whose publish failed left the app server reading connected. A reconnect then
  // started and was cancelled: the cancel wiped the login but recorded nothing, so Rust kept
  // admitting turns with no login until some later refresh.
  it("records signed out in the app server when a reconnect is cancelled after a failed sign-out", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    try {
      await composition.start();
      server.publishFails = true;
      await composition.providerDefinitions.logout(managedDefinition.id);
      await vi.waitFor(() => expect(server.failedPublishes).toBe(2), { timeout: 5_000 });
      server.publishFails = false;
      expect(server.connected(managedDefinition.id)).toBe(true);

      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      await composition.providerDefinitions.cancelConnection(pending.connectionId);
      expect(server.connected(managedDefinition.id)).toBe(false);
      expect(server.published.at(-1)).toMatchObject({ connected: false, connectionEvent: "signed-out" });
      expect(composition.providerDefinitions.connectionGeneration(managedDefinition.id))
        .toBe(server.rows.get(managedDefinition.id).generation);
    } finally {
      await composition.close();
    }
  });

  // The cancel could not record signed out: the app server was unreachable. It may still read
  // the provider connected, so the cancel keeps the login and the reconnect's runtime rather
  // than leaving the app server admitting turns with no login.
  it("keeps the login when a cancelled reconnect cannot record signed out", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    try {
      await composition.start();
      await composition.providerDefinitions.logout(managedDefinition.id);
      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      world.account = "connected";
      server.publishFails = true;
      await expect(composition.providerDefinitions.cancelConnection(pending.connectionId)).resolves.toBe(true);
      server.publishFails = false;
      expect(world.homeWipes).toBe(0);
      expect(world.account).toBe("connected");
      expect(world.runtimes[0].closed).toBe(false);
      expect(composition.providerDefinitions.pendingConnections.has(managedDefinition.id)).toBe(false);
      // Settings follows the app server, and the next refresh settles the state.
      await composition.modelCatalog.explicitRefresh(managedDefinition.id);
      expect(server.connected(managedDefinition.id)).toBe(true);
      expect((await composition.providerDefinitions.list())[0]).toMatchObject({ connected: true, unavailableReason: null });
    } finally {
      await composition.close();
    }
  });

  // An explicit refresh passed its generation check, then awaited the readiness evaluation that
  // precedes its publish. A reconnect started meanwhile. The refresh published anyway, while
  // the reconnect was pending.
  it("publishes no explicit refresh whose readiness evaluation outlasted the start of a reconnect", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    let holdReadiness = null;
    const composition = compose({
      registry: world.registry, server, removeRuntimeState: world.removeRuntimeState,
      evaluateReadiness: async ({ trigger }) => {
        const hold = holdReadiness;
        if (trigger !== "explicit-repair" || !hold) return null;
        holdReadiness = null;
        hold.reached.resolve();
        await hold.release.promise;
        return null;
      },
    });
    try {
      await composition.start();
      await composition.providerDefinitions.logout(managedDefinition.id);
      world.account = "connected"; // Fresh discovery is connected; disconnected refreshes do not evaluate readiness.
      const readiness = { reached: deferred(), release: deferred() };
      holdReadiness = readiness;
      const explicit = composition.modelCatalog.explicitRefresh(managedDefinition.id);
      await readiness.reached.promise;
      const attempts = server.attempts.length;
      await composition.providerDefinitions.reconnect(managedDefinition.id);
      readiness.release.resolve();
      await expect(explicit).resolves.toBeNull();
      expect(server.attempts.length).toBe(attempts);
    } finally {
      await composition.close();
    }
  });

  // The user signed out while a reconnect was pending, and the app server answered. The browser
  // sign-in then finished, and the reconnect was refused as superseded. Its settle could not
  // record signed out again, so it kept the new login as an unknown outcome; the next refresh
  // then published connected over the user's confirmed sign-out.
  it("keeps a confirmed sign-out when a superseded reconnect cannot record signed out again", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    try {
      await composition.start();
      await composition.providerDefinitions.logout(managedDefinition.id);
      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      await composition.providerDefinitions.logout(managedDefinition.id);
      world.account = "connected";
      server.failNextEvent = "signed-out";
      await expect(composition.providerDefinitions.completeConnection(pending.connectionId))
        .rejects.toThrow("provider_connection_superseded");
      expect(world.homeWipes).toBe(1);
      await composition.modelCatalog.explicitRefresh(managedDefinition.id);
      expect(server.connected(managedDefinition.id)).toBe(false);
      expect((await composition.providerDefinitions.list())[0]).toMatchObject({
        connected: false,
        unavailableReason: expect.objectContaining({ code: "provider_logged_out" }),
      });
    } finally {
      await composition.close();
    }
  });

  // A refresh resolved its generation before a reconnect started and read the account after
  // the browser sign-in. It reached its publish only after the reconnect was cancelled. The
  // cancel moved nothing, so the refresh published "connected" over the wiped login.
  // A reconnect became pending only after prepareRuntime and login() returned. A refresh in
  // that interval ran through the runtime the reconnect was starting its sign-in on.
  it("runs no refresh while a reconnect prepares its runtime or starts its sign-in", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    let holdPrepare = null;
    const composition = compose({
      registry: world.registry, server, removeRuntimeState: world.removeRuntimeState,
      prepareRuntime: async () => {
        const hold = holdPrepare;
        holdPrepare = null;
        if (!hold) return;
        hold.reached.resolve();
        await hold.release.promise;
      },
    });
    const preparing = { reached: deferred(), release: deferred() };
    const login = { reached: deferred(), release: deferred() };
    try {
      await composition.start();
      await composition.providerDefinitions.logout(managedDefinition.id);
      await vi.waitFor(() => expect(world.runtimes[0].discoveries).toBe(2), { timeout: 5_000 });
      holdPrepare = preparing;
      world.holdNextLogin = login;
      const reconnecting = composition.providerDefinitions.reconnect(managedDefinition.id);
      reconnecting.catch(() => undefined);

      await preparing.reached.promise;
      expect(await composition.readinessRoutes()).toEqual([]);
      await expect(composition.modelCatalog.settingsOpened()).resolves.toEqual([null]);
      preparing.release.resolve();
      await login.reached.promise;
      expect(await composition.readinessRoutes()).toEqual([]);
      await expect(composition.modelCatalog.settingsOpened()).resolves.toEqual([null]);
      expect(world.runtimes[0].discoveries).toBe(2);

      // A reconnect whose sign-in fails before it is pending leaves the provider refreshable.
      login.release.reject(new Error("login failed"));
      await expect(reconnecting).rejects.toThrow("login failed");
      await composition.modelCatalog.settingsOpened();
      expect(world.runtimes[0].discoveries).toBe(3);
    } finally {
      // close() waits for the reconnect, so a failed assertion must not leave it held.
      preparing.release.resolve();
      login.release.reject(new Error("login failed"));
      await composition.close();
    }
  });

  it("drops a refresh that straddles a cancelled reconnect", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    try {
      await composition.start();
      await composition.providerDefinitions.logout(managedDefinition.id);

      const gate = { reached: deferred(), release: deferred() };
      world.gateNextDiscover = gate;
      const reopened = composition.modelCatalog.settingsOpened();
      await gate.reached.promise;

      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      world.account = "connected";
      const stalled = world.hold();
      gate.release.resolve();
      await stalled.reached.promise;
      await composition.providerDefinitions.cancelConnection(pending.connectionId);
      stalled.release.resolve();

      const [straddled] = await reopened;
      expect(server.connected(managedDefinition.id)).toBe(false);
      expect(straddled).toBeNull();
      expect(world.homeWipes).toBe(1);
    } finally {
      await composition.close();
    }
  });

  // P4: a reconnect whose publish committed but whose answer was lost settled as failed. Its
  // cancel then wiped the login the app server had just recorded as connected.
  it("adopts a reconnect the app server committed before its answer was lost", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    try {
      await composition.start();
      await composition.providerDefinitions.logout(managedDefinition.id);
      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      world.account = "connected";
      server.loseNextResponse = "reconnected";
      await expect(composition.providerDefinitions.completeConnection(pending.connectionId))
        .resolves.toMatchObject({ status: "connected" });

      expect(world.homeWipes).toBe(0);
      expect(world.account).toBe("connected");
      expect(server.rows.get(managedDefinition.id).generation).toBe(3);
      expect(composition.providerDefinitions.connectionGeneration(managedDefinition.id)).toBe(3);
      expect((await composition.providerDefinitions.list())[0]).toMatchObject({ connected: true, unavailableReason: null });
      // The next refresh lands at the adopted generation.
      const refused = server.refused;
      await composition.modelCatalog.explicitRefresh(managedDefinition.id);
      expect(server.refused).toBe(refused);
      expect(server.connected(managedDefinition.id)).toBe(true);
    } finally {
      await composition.close();
    }
  });

  // An unanswered publish is adopted only when it provably committed. A publish that failed
  // before the write, a discovery that failed before any publish, and a reconnect a sign-out
  // superseded while its refusal's answer was lost all settle as failed, as before. Only the
  // reconnect's own publish fails, so the settle records signed out and wipes the login.
  it("settles a reconnect whose unanswered publish did not commit", async () => {
    for (const failure of ["publish", "discovery", "superseded"]) {
      const world = managedWorld();
      const server = productServer([managedDefinition]);
      const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
      try {
        await composition.start();
        await composition.providerDefinitions.logout(managedDefinition.id);
        const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
        if (failure === "superseded") await composition.providerDefinitions.logout(managedDefinition.id);
        world.account = "connected";
        if (failure === "discovery") {
          world.catalogUnavailable = true;
          server.loadFails = true;
        } else {
          server.failNextPublishes = 1;
        }
        await expect(composition.providerDefinitions.completeConnection(pending.connectionId))
          .rejects.toMatchObject({ name: "TerminalConnectionFailure" });
        server.loadFails = false;
        expect(world.homeWipes, failure).toBe(1);
        expect(server.connected(managedDefinition.id), failure).toBe(false);
        expect((await composition.providerDefinitions.list())[0], failure).toMatchObject({
          connected: false,
          unavailableReason: expect.objectContaining({ code: "provider_logged_out" }),
        });
      } finally {
        await composition.close();
      }
    }
  });

  // Adoption needs proof. A sign-out during the reconnect whose publish failed, or a baseline
  // the reconnect could not read, leaves an advance unexplained: the login is kept, but the
  // reconnect is neither adopted nor wiped. A coded refusal is certain and settles as failed.
  it("neither adopts nor wipes a reconnect whose unanswered publish cannot be proven", async () => {
    for (const doubt of ["unanswered-sign-out", "unread-baseline"]) {
      const world = managedWorld();
      const server = productServer([managedDefinition]);
      const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
      try {
        await composition.start();
        let pending;
        if (doubt === "unanswered-sign-out") {
          await composition.providerDefinitions.logout(managedDefinition.id);
          pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
          // The sign-out's publish fails before it commits; the reconnect then commits.
          server.publishFails = true;
          await composition.providerDefinitions.logout(managedDefinition.id);
          await vi.waitFor(() => expect(server.failedPublishes).toBe(1), { timeout: 5_000 });
          server.publishFails = false;
          server.loseNextResponse = "reconnected";
        } else {
          // A sign-out committed behind a lost answer, and the reconnect cannot read the
          // generation it starts from. Its publish then fails before it commits.
          server.loseNextResponse = "signed-out";
          await composition.providerDefinitions.logout(managedDefinition.id);
          server.loadFails = true;
          pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
          server.loadFails = false;
          server.publishFails = true;
        }
        world.account = "connected";
        await expect(composition.providerDefinitions.completeConnection(pending.connectionId), doubt)
          .rejects.toMatchObject({ name: "TerminalConnectionFailure" });
        server.publishFails = false;
        expect(world.homeWipes, doubt).toBe(0);
        expect(world.account, doubt).toBe("connected");
        expect(server.connected(managedDefinition.id), doubt).toBe(doubt === "unanswered-sign-out");
      } finally {
        await composition.close();
      }
    }
  });

  // A sign-out's request lost its answer but was still in flight, and committed only after the
  // next reconnect read its baseline. The reconnect's publish was then refused, and that answer
  // was lost too. The generation reads one past the baseline, but the sign-out moved it, not
  // the reconnect. An unanswered lifecycle write makes any advance unproven.
  it("does not adopt a reconnect when an earlier unanswered sign-out may have moved the generation", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    try {
      await composition.start();
      server.delayNextCommit = "signed-out";
      await composition.providerDefinitions.logout(managedDefinition.id);
      // Logout's follow-up refresh publishes the signed-out account at the unchanged generation.
      await vi.waitFor(() => expect(server.connected(managedDefinition.id)).toBe(false), { timeout: 5_000 });
      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      await server.commitDelayed();
      expect(server.rows.get(managedDefinition.id).generation).toBe(2);

      world.account = "connected";
      server.loseNextRefusal = true;
      await expect(composition.providerDefinitions.completeConnection(pending.connectionId))
        .rejects.toMatchObject({ name: "TerminalConnectionFailure" });
      expect(server.connected(managedDefinition.id)).toBe(false);
      expect(world.homeWipes).toBe(0);
    } finally {
      await composition.close();
    }
  });

  // An answered sign-out ends that doubt: the lost write carried an older generation, which the
  // app server now refuses. A later reconnect whose answer is lost is adopted again.
  it("adopts a reconnect again once an answered sign-out supersedes an unanswered one", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    try {
      await composition.start();
      server.loseNextResponse = "signed-out";
      await composition.providerDefinitions.logout(managedDefinition.id);
      await composition.providerDefinitions.logout(managedDefinition.id);
      expect(server.rows.get(managedDefinition.id).generation).toBe(3);
      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      world.account = "connected";
      server.loseNextResponse = "reconnected";
      await expect(composition.providerDefinitions.completeConnection(pending.connectionId))
        .resolves.toMatchObject({ status: "connected" });
      expect(server.connected(managedDefinition.id)).toBe(true);
    } finally {
      await composition.close();
    }
  });

  it("settles a reconnect the app server refused with a code it could not have committed", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    try {
      await composition.start();
      // The sign-out commits behind a lost answer; the reconnect's baseline read fails, so its
      // publish carries the older generation and the app server refuses it with a code.
      server.loseNextResponse = "signed-out";
      await composition.providerDefinitions.logout(managedDefinition.id);
      server.loadFails = true;
      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      server.loadFails = false;
      world.account = "connected";
      await expect(composition.providerDefinitions.completeConnection(pending.connectionId))
        .rejects.toThrow("provider_connection_superseded");
      expect(world.homeWipes).toBe(1);
      expect(server.connected(managedDefinition.id)).toBe(false);
    } finally {
      await composition.close();
    }
  });

  // When the generation cannot be read back either, the reconnect's outcome is unknown. The
  // login the app server may have committed and the runtime that signed it in are kept, and
  // the next refresh settles the state.
  it("keeps the login of a reconnect whose outcome is unknown", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    try {
      await composition.start();
      await composition.providerDefinitions.logout(managedDefinition.id);
      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      world.account = "connected";
      server.loseNextResponse = "reconnected";
      server.loadFails = true;
      await expect(composition.providerDefinitions.completeConnection(pending.connectionId))
        .rejects.toMatchObject({ name: "TerminalConnectionFailure" });
      expect(composition.providerDefinitions.pendingConnections.has(managedDefinition.id)).toBe(false);
      expect(world.homeWipes).toBe(0);
      expect(world.account).toBe("connected");
      expect(world.runtimes[0].closed).toBe(false);

      // The app server is reachable again. A refresh relearns the committed generation, and
      // the next one lands; Settings follows the app server.
      server.loadFails = false;
      await composition.modelCatalog.explicitRefresh(managedDefinition.id);
      await composition.modelCatalog.explicitRefresh(managedDefinition.id);
      expect(server.connected(managedDefinition.id)).toBe(true);
      expect((await composition.providerDefinitions.list())[0]).toMatchObject({ connected: true, unavailableReason: null });
    } finally {
      await composition.close();
    }
  });
});

describe("PROV-002: an unknown reconnect outcome keeps the reconnect's runtime", () => {
  // A reconnect of a provider whose activation failed creates its own runtime; the recovery
  // adapter stays registered until the reconnect commits. An unknown outcome registers the
  // reconnect's runtime, so automatic refreshes discover through the signed-in account.
  it("registers the runtime a reconnect created when its outcome is unknown", async () => {
    const world = managedWorld({ activationFails: true });
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    try {
      await composition.start();
      world.activationFails = false;
      world.account = "disconnected";
      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      world.account = "connected";
      server.loseNextResponse = "reconnected";
      server.loadFails = true;
      await expect(composition.providerDefinitions.completeConnection(pending.connectionId))
        .rejects.toMatchObject({ name: "TerminalConnectionFailure" });
      server.loadFails = false;
      const [created] = world.runtimes;
      expect(created.closed).toBe(false);
      await composition.modelCatalog.settingsOpened();
      await composition.modelCatalog.settingsOpened();
      expect(created.discoveries).toBeGreaterThan(0);
      expect(server.connected(managedDefinition.id)).toBe(true);
    } finally {
      await composition.close();
    }
  });
});

// PROV-004: remove, sign-out and reconnect never run under live native work. A turn's lease
// goes through the real execution-access broker, which hands the harness the provider home.
describe("PROV-004: provider lifecycle never runs under a turn's provider access", () => {
  const selection = { providerId: managedDefinition.id, adapterId: "fake-managed" };
  const contracts = ["managed-runtime@1"];

  // P1: Rust admitted a turn while the provider read connected. The user then signed out and
  // started a reconnect before the harness took its lease. The lease got the runtime the
  // reconnect was signing in, and cancelling the reconnect closed it and wiped its home.
  it("refuses a turn's provider access while a reconnect is pending", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    const service = composition.providerDefinitions;
    const broker = createProviderExecutionAccessBroker((id) => service.acquireExecution(id));
    try {
      await composition.start();
      await service.logout(managedDefinition.id);
      const pending = await service.reconnect(managedDefinition.id);
      world.account = "connected";
      await expect(broker.acquire(selection, contracts)).rejects.toThrow("Provider sign-in is pending.");
      expect(service.activeExecutions.size).toBe(0);
      await service.cancelConnection(pending.connectionId);

      // Once a reconnect completes, turns take their access again.
      const next = await service.reconnect(managedDefinition.id);
      world.account = "connected";
      await expect(service.completeConnection(next.connectionId)).resolves.toMatchObject({ status: "connected" });
      const lease = await broker.acquire(selection, contracts);
      expect(lease.access.environment.CODEX_HOME).toBe(`/runtime/${managedDefinition.id}/codex-home`);
      await lease.release();
    } finally {
      await composition.close();
    }
  });

  // The same race with a wide window: the sign-out's publish failed, so the app server kept
  // reading the provider connected and admitting turns through the whole reconnect.
  // A sign-out removed the local login but its publish failed, so the app server still read
  // the provider connected. A reconnect started and was cancelled while the app server stayed
  // unreachable. The cancel kept a login that did not exist, cleared the signed-out status and
  // let turns take provider access against the stale connected catalog.
  it("keeps admission blocked when a cancel after an unrecorded sign-out has no login to keep", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    const service = composition.providerDefinitions;
    try {
      await composition.start();
      server.publishFails = true;
      await service.logout(managedDefinition.id);
      await vi.waitFor(() => expect(server.failedPublishes).toBe(2), { timeout: 5_000 });
      expect(server.connected(managedDefinition.id)).toBe(true);
      const pending = await service.reconnect(managedDefinition.id);
      await service.cancelConnection(pending.connectionId);

      await expect(service.acquireExecution(managedDefinition.id)).rejects.toThrow("Provider is signed out.");
      expect(service.activeExecutions.size).toBe(0);
      expect((await service.list())[0]).toMatchObject({
        connected: false,
        unavailableReason: expect.objectContaining({ code: "provider_logged_out" }),
      });

      // Once the app server hears the account's state, the block ends.
      server.publishFails = false;
      await composition.modelCatalog.explicitRefresh(managedDefinition.id);
      expect(server.connected(managedDefinition.id)).toBe(false);
      world.account = "connected";
      const lease = await service.acquireExecution(managedDefinition.id);
      await lease.release();
    } finally {
      await composition.close();
    }
  });

  // A sign-out whose publish failed alone also blocks admission: the app server still reads the
  // provider connected, but the login is gone.
  // The cancel's account check had no signal or time limit. A check that hung held the
  // provider queue, and every later lifecycle action and lease waited behind it.
  it("bounds the cancel's account check, and keeps the login when it times out", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({
      registry: world.registry, server, removeRuntimeState: world.removeRuntimeState, accountCheckTimeoutMs: 50,
    });
    const service = composition.providerDefinitions;
    try {
      await composition.start();
      await service.logout(managedDefinition.id);
      const pending = await service.reconnect(managedDefinition.id);
      world.account = "connected";
      world.accountHangs = true;
      server.publishFails = true;
      const cancelled = service.cancelConnection(pending.connectionId);
      const outcome = await Promise.race([
        cancelled.then(() => "settled"),
        new Promise((resolve) => { setTimeout(() => resolve("stuck"), 2_000).unref?.(); }),
      ]);
      world.accountHangs = false;
      server.publishFails = false;
      expect(outcome).toBe("settled");
      // A check that times out cannot answer, so the outcome is unknown and the login stays.
      expect(world.homeWipes).toBe(0);
      expect(world.account).toBe("connected");
    } finally {
      world.accountHangs = false;
      await composition.close();
    }
  });

  // A failed sign-out fenced admission. A reconnect then committed, but its answer and the
  // generation read-back were both lost, so it kept its confirmed login as an unknown outcome.
  // The fence stayed, and every lease was refused although the account was signed in.
  it("lifts the admission fence when a reconnect with an unknown outcome keeps a confirmed login", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    const service = composition.providerDefinitions;
    try {
      await composition.start();
      server.publishFails = true;
      await service.logout(managedDefinition.id);
      await vi.waitFor(() => expect(server.failedPublishes).toBe(2), { timeout: 5_000 });
      server.publishFails = false;
      await expect(service.acquireExecution(managedDefinition.id)).rejects.toThrow("Provider is signed out.");

      const pending = await service.reconnect(managedDefinition.id);
      world.account = "connected";
      server.loseNextResponse = "reconnected";
      server.loadFails = true;
      await expect(service.completeConnection(pending.connectionId))
        .rejects.toMatchObject({ name: "TerminalConnectionFailure" });
      server.loadFails = false;
      const lease = await service.acquireExecution(managedDefinition.id);
      await lease.release();
    } finally {
      await composition.close();
    }
  });

  // The same fence after a cancel that kept a login its account check confirmed: the browser
  // sign-in had finished, but the cancel could not record signed out.
  it("lifts the admission fence when a cancel keeps a login its account check confirmed", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    const service = composition.providerDefinitions;
    try {
      await composition.start();
      server.publishFails = true;
      await service.logout(managedDefinition.id);
      await vi.waitFor(() => expect(server.failedPublishes).toBe(2), { timeout: 5_000 });
      const pending = await service.reconnect(managedDefinition.id);
      world.account = "connected";
      await service.cancelConnection(pending.connectionId);
      server.publishFails = false;
      expect(world.homeWipes).toBe(0);
      const lease = await service.acquireExecution(managedDefinition.id);
      await lease.release();
    } finally {
      await composition.close();
    }
  });

  it("refuses provider access after a sign-out the app server did not record", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    const service = composition.providerDefinitions;
    try {
      await composition.start();
      expect(await composition.readinessRoutes()).toHaveLength(1);
      server.publishFails = true;
      await service.logout(managedDefinition.id);
      await vi.waitFor(() => expect(server.failedPublishes).toBe(2), { timeout: 5_000 });
      await expect(service.acquireExecution(managedDefinition.id)).rejects.toThrow("Provider is signed out.");
      expect(await composition.readinessRoutes()).toEqual([]);
    } finally {
      await composition.close();
    }
  });

  // Found by the ProviderLeaseLifecycle model: a refresh read the account before a sign-out
  // whose publish failed, and published "connected" after it. That catalog does not record the
  // sign-out, so it must not end the block.
  it("keeps admission blocked when a refresh from before an unrecorded sign-out publishes connected", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    const service = composition.providerDefinitions;
    let followUp = null;
    try {
      await composition.start();
      const early = world.hold();
      const reopened = composition.modelCatalog.settingsOpened();
      await early.reached.promise;
      server.failNextEvent = "signed-out";
      await service.logout(managedDefinition.id);
      followUp = world.hold();
      early.release.resolve();
      await reopened;
      await followUp.reached.promise;
      expect(server.connected(managedDefinition.id)).toBe(true);
      await expect(service.acquireExecution(managedDefinition.id)).rejects.toThrow("Provider is signed out.");
      expect(await composition.readinessRoutes()).toEqual([]);
      followUp.release.resolve();
      await vi.waitFor(() => expect(server.connected(managedDefinition.id)).toBe(false), { timeout: 5_000 });
    } finally {
      followUp?.release.resolve();
      await composition.close();
    }
  });

  it("refuses access during a reconnect after a sign-out the app server never recorded", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    const service = composition.providerDefinitions;
    try {
      await composition.start();
      server.publishFails = true;
      await service.logout(managedDefinition.id);
      // Both the sign-out's publish and its follow-up refresh fail.
      await vi.waitFor(() => expect(server.failedPublishes).toBe(2), { timeout: 5_000 });
      expect(server.connected(managedDefinition.id)).toBe(true);
      server.publishFails = false;

      const pending = await service.reconnect(managedDefinition.id);
      await expect(service.acquireExecution(managedDefinition.id)).rejects.toThrow("Provider sign-in is pending.");
      await service.cancelConnection(pending.connectionId);
      expect(service.activeExecutions.size).toBe(0);
    } finally {
      await composition.close();
    }
  });

  // Settling a reconnect never closes or wipes a runtime a lease holds. The acquire guard makes
  // this unreachable, so the test holds the lease count directly: it guards the cancel itself.
  it("never closes or wipes a leased runtime when a reconnect settles", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    const service = composition.providerDefinitions;
    try {
      await composition.start();
      await service.logout(managedDefinition.id);
      const pending = await service.reconnect(managedDefinition.id);
      service.activeExecutions.set(managedDefinition.id, 1);
      await service.cancelConnection(pending.connectionId);
      expect(world.runtimes[0].closed).toBe(false);
      expect(world.homeWipes).toBe(0);
      expect(service.pendingConnections.has(managedDefinition.id)).toBe(false);
      service.activeExecutions.delete(managedDefinition.id);
    } finally {
      await composition.close();
    }
  });

  // Shutdown awaits the app server's close before it closes the providers. Leases requested in
  // that interval were still granted, and the provider teardown then closed their runtime.
  it("refuses provider access from the moment shutdown begins", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState });
    const service = composition.providerDefinitions;
    try {
      await composition.start();
      composition.beginShutdown();
      await expect(service.acquireExecution(managedDefinition.id)).rejects.toThrow("Provider setup is shutting down.");
      await expect(service.reconnect(managedDefinition.id)).rejects.toThrow("Provider setup is shutting down.");
      expect(service.activeExecutions.size).toBe(0);
    } finally {
      await composition.close();
    }
  });

  // P2: close() does not wait for the provider queue. A lease queued before shutdown ran after
  // it, and registered a runtime that nothing closed.
  it("refuses access once shutdown begins, and closes a runtime that finished starting after it", async () => {
    const world = managedWorld({ activationFails: true });
    const other = { ...managedDefinition, id: "other-work", label: "Other" };
    const server = productServer([managedDefinition, other]);
    const composition = compose({
      registry: world.registry, server, removeRuntimeState: world.removeRuntimeState,
      runtimeDependencies: world.runtimeDependencies,
    });
    const service = composition.providerDefinitions;
    await composition.start();
    expect(world.runtimes).toHaveLength(0);
    world.activationFails = false;

    // A lease starts its runtime; shutdown begins while the runtime's dependencies resolve.
    const dependencies = { reached: deferred(), release: deferred() };
    world.holdNextDependencies = dependencies;
    const starting = service.acquireExecution(managedDefinition.id);
    await dependencies.reached.promise;
    // A Settings action holds the provider queue, and another turn's lease waits behind it.
    const save = { reached: deferred(), release: deferred() };
    server.holdNextSave = save;
    const renaming = service.rename(other.id, "Other renamed");
    const queued = service.acquireExecution(other.id);
    const closing = composition.close();
    dependencies.release.resolve();
    await save.reached.promise;
    await closing;
    save.release.resolve();
    await renaming;

    await expect(starting).rejects.toThrow("Provider setup is shutting down.");
    await expect(queued).rejects.toThrow("Provider setup is shutting down.");
    await expect(service.acquireExecution(managedDefinition.id)).rejects.toThrow("Provider setup is shutting down.");
    // Only the lease that was already starting created a runtime, and it closed again.
    expect(world.runtimes).toHaveLength(1);
    expect(world.runtimes[0].closed).toBe(true);
    expect(service.runtimes.size).toBe(0);
    expect(service.activeExecutions.size).toBe(0);
  });
});

describe("PROV-007: connect is all-or-nothing", () => {
  const apiDescriptor = (discover) => ({
    adapterId: "fake-api", implementationVersion: "1", label: "Fake API",
    accessContract: "secret@1", defaultEndpoint: "https://fake.example/v1",
    connection: { mode: "secret-fields", fields: [{ id: "api-key", label: "API key", kind: "secret" }] },
    create: ({ definition }) => ({
      providerId: definition.id,
      discover: () => discover(definition),
      close: vi.fn(async () => {}),
    }),
  });

  it("publishes nothing and registers no adapter before the definition exists, and a refused create leaves nothing", async () => {
    const server = productServer();
    const credentials = credentialFile();
    const commit = deferred();
    server.store.createWithCatalog = async () => {
      await commit.promise;
      throw coded("provider_definition_invalid");
    };
    const composition = compose({
      server,
      credentials,
      registry: createProviderAdapterRegistry([apiDescriptor(async (definition) => catalog(definition))]),
    });
    try {
      await composition.start();
      const connecting = composition.providerDefinitions.connect({
        connectionId: "work-api", adapterId: "fake-api", label: "Work API", fields: { "api-key": "opaque" },
      });
      await vi.waitFor(() => expect(credentials.values.has("provider:work-api")).toBe(true));
      // Settings opens while the create is in flight.
      await composition.modelCatalog.settingsOpened();
      expect(server.attempts).toEqual([]);
      await expect(composition.modelCatalog.explicitRefresh("work-api")).rejects.toThrow("Unknown model provider");

      commit.resolve();
      await expect(connecting).rejects.toThrow("provider_definition_invalid");
      expect(server.rows.size).toBe(0);
      expect(credentials.values.size).toBe(0);
      await composition.modelCatalog.settingsOpened();
      expect(server.attempts).toEqual([]);
      await expect(composition.modelCatalog.explicitRefresh("work-api")).rejects.toThrow("Unknown model provider");
    } finally {
      await composition.close();
    }
  });

  it("leaves nothing behind for a connect cancelled during discovery", async () => {
    const server = productServer();
    const credentials = credentialFile();
    const discovering = deferred();
    const release = deferred();
    const composition = compose({
      server,
      credentials,
      registry: createProviderAdapterRegistry([apiDescriptor(async (definition) => {
        discovering.resolve();
        await release.promise;
        return catalog(definition);
      })]),
    });
    try {
      await composition.start();
      const connecting = composition.providerDefinitions.connect({
        connectionId: "work-api", adapterId: "fake-api", label: "Work API", fields: { "api-key": "opaque" },
      });
      await discovering.promise;
      await expect(composition.providerDefinitions.cancelConnection("work-api")).resolves.toBe(true);
      release.resolve();
      await expect(connecting).rejects.toThrow("cancelled");
      expect(server.rows.size).toBe(0);
      expect(credentials.values.size).toBe(0);
      expect(server.attempts).toEqual([]);
      await expect(composition.modelCatalog.explicitRefresh("work-api")).rejects.toThrow("Unknown model provider");
    } finally {
      await composition.close();
    }
  });

  // F2: the app server committed the create but its response was lost. The rollback used to
  // delete the credential of a provider the app server keeps active.
  it("adopts a create that committed before its response was lost", async () => {
    const server = productServer();
    const credentials = credentialFile();
    server.loseNextResponse = "create";
    const composition = compose({
      server,
      credentials,
      registry: createProviderAdapterRegistry([apiDescriptor(async (definition) => catalog(definition))]),
    });
    try {
      await composition.start();
      await expect(composition.providerDefinitions.connect({
        connectionId: "work-api", adapterId: "fake-api", label: "Work API", fields: { "api-key": "opaque" },
      })).resolves.toMatchObject({ status: "connected" });
      expect(credentials.values.get("provider:work-api")).toEqual({ "api-key": "opaque" });
      await composition.modelCatalog.explicitRefresh("work-api");
      expect(server.connected("work-api")).toBe(true);
    } finally {
      await composition.close();
    }
  });

  it("leaves an unknown create outcome to startup, which keeps the credential only for a committed definition", async () => {
    for (const committed of [true, false]) {
      const server = productServer();
      const credentials = credentialFile();
      const registry = createProviderAdapterRegistry([apiDescriptor(async (definition) => catalog(definition))]);
      const first = compose({ server, credentials, registry });
      await first.start();
      const create = server.store.createWithCatalog;
      server.store.createWithCatalog = async (...args) => {
        if (committed) await create(...args);
        server.loadFails = true;
        throw new Error("app server stopped");
      };
      await expect(first.providerDefinitions.connect({
        connectionId: "work-api", adapterId: "fake-api", label: "Work API", fields: { "api-key": "opaque" },
      })).rejects.toThrow("app server stopped");
      expect(credentials.values.has("provider:work-api")).toBe(true);
      await first.close();

      // The next launch reconciles against the app server's definitions.
      server.loadFails = false;
      const next = compose({ server, credentials, registry });
      await next.start();
      expect(credentials.values.has("provider:work-api")).toBe(committed);
      if (committed) {
        await next.modelCatalog.explicitRefresh("work-api");
        expect(server.connected("work-api")).toBe(true);
      }
      await next.close();
    }
  });
});

// Login on the installed runtime must not wait for an upgrade's setup probe.
describe("reconnect setup overlap", () => {
  it("returns browser login while setup is held and publishes nothing until setup finishes", async () => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const setup = deferred();
    const started = deferred();
    const composition = compose({ registry: world.registry, server,
      prepareRuntime: async () => { started.resolve(); await setup.promise; },
    });
    let reconnecting;
    try {
      await composition.start();
      const published = server.published.length;
      reconnecting = composition.providerDefinitions.reconnect(managedDefinition.id);
      reconnecting.catch(() => undefined);
      await started.promise;
      await vi.waitFor(() => expect(world.runtimes[0].credentials.login).toHaveBeenCalledOnce(), { timeout: 200 });
      const pending = await reconnecting;
      expect(pending.status).toBe("pending");
      world.account = "connected";
      expect((await composition.providerDefinitions.completeConnection(pending.connectionId)).status).toBe("pending");
      expect(server.published).toHaveLength(published);
      setup.resolve();
      await vi.waitFor(async () => expect((await composition.providerDefinitions.completeConnection(pending.connectionId)).status).toBe("connected"));
    } finally { setup.resolve(); await reconnecting?.catch(() => undefined); await composition.close(); }
  });
});

describe("reconnect setup failure boundaries", () => {
  it.each([false, true])("keeps setup failure inert after cancellation=%s", async (cancel) => {
    const world = managedWorld();
    const server = productServer([managedDefinition]);
    const setup = deferred();
    const composition = compose({ registry: world.registry, server, removeRuntimeState: world.removeRuntimeState,
      prepareRuntime: () => setup.promise,
    });
    try {
      await composition.start();
      const pending = await composition.providerDefinitions.reconnect(managedDefinition.id);
      if (cancel) {
        await composition.providerDefinitions.cancelConnection(pending.connectionId);
        expect(server.connected(managedDefinition.id)).toBe(false);
      }
      setup.reject(new Error("setup failed"));
      await new Promise((resolve) => setImmediate(resolve));
      await expect(composition.providerDefinitions.completeConnection(pending.connectionId))
        .rejects.toThrow(cancel ? "Unknown pending" : "setup failed");
      expect(server.connected(managedDefinition.id)).toBe(false);
      expect(world.homeWipes).toBe(1);
    } finally { setup.resolve(); await composition.close(); }
  });

  it("waits for installation before starting login when activation failed", async () => {
    const world = managedWorld();
    world.activationFails = true;
    const server = productServer([managedDefinition]);
    const setup = deferred();
    const started = deferred();
    const composition = compose({ registry: world.registry, server,
      prepareRuntime: async () => { started.resolve(); await setup.promise; world.activationFails = false; },
    });
    let reconnecting;
    try {
      await composition.start();
      reconnecting = composition.providerDefinitions.reconnect(managedDefinition.id);
      reconnecting.catch(() => undefined);
      await started.promise;
      expect(world.runtimes).toHaveLength(0);
      setup.resolve();
      expect((await reconnecting).status).toBe("pending");
      expect(world.runtimes[0].credentials.login).toHaveBeenCalledOnce();
    } finally { setup.resolve(); await reconnecting?.catch(() => undefined); await composition.close(); }
  });
});


describe("Prime setup retains its provider authorization", () => {
  it.each(["explicit-repair", "recipe-update"].flatMap(trigger => ["logout", "remove", "reconnect", "catalog disconnect", "catalog replacement", "unchanged catalog"].map(change => [trigger, change])))
    ("fences %s preparation on %s with the correct publication outcome", async (trigger, change) => {
      const world = managedWorld();
      const server = productServer([managedDefinition]);
      const preparing = deferred();
      const release = deferred();
      const due = new Set(["prime-agent-basic"]);
      const publishAvailability = vi.fn(async updates => { for (const update of updates) due.delete(update.harnessId); });
      const readiness = createHarnessReadinessCoordinator({
        configurations: new Map([["prime-agent-basic", { name: "prime-agent-basic", implementation: "prime.agent",
          executionAccessContracts: ["managed-runtime@1"], modelRules: { allow: [{ adapterId: managedDefinition.adapterId, modelIdRegex: ".*" }], deny: [] } }]]),
        digestConfiguration: () => "sha256:prime", runtimeRequirements: { "prime.agent": { recipeId: "prime@0.8.1" } },
        recipeInstalled: async () => false, recipeSupported: async () => true,
        prepareRecipe: async (_recipe, { signal }) => {
          preparing.resolve(signal);
          await Promise.race([release.promise, new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
          signal.throwIfAborted();
          return {};
        },
        checkers: { "prime.agent": vi.fn(async () => ({ available: true })) }, publishAvailability,
      });
      const composition = compose({ registry: world.registry, server, evaluateReadiness: request => readiness.evaluate(request) });
      try {
        await composition.start();
        const evaluation = trigger === "explicit-repair" ? composition.modelCatalog.explicitRefresh(managedDefinition.id)
          : readiness.evaluateRecipeUpdate({ updatesDue: [...due], providers: await composition.readinessRoutes() });
        const signal = await preparing.promise;
        if (change === "unchanged catalog") {
          if (trigger === "recipe-update") await composition.modelCatalog.refresh(managedDefinition.id, "background");
          else composition.providerDefinitions.catalogPublished(managedDefinition.id, { connected: true, models: [model] });
        }
        else if (change === "catalog replacement") {
          // Catalogs can change models without changing the connection generation.
          const generation = composition.providerDefinitions.connectionGeneration(managedDefinition.id);
          if (trigger === "recipe-update") { world.catalogModels = []; await composition.modelCatalog.refresh(managedDefinition.id, "background"); }
          else { await server.publishCatalog({ providerId: managedDefinition.id, connected: true, models: [] }, { connectionGeneration: generation }); composition.providerDefinitions.catalogPublished(managedDefinition.id, { connected: true }); }
          expect(composition.providerDefinitions.connectionGeneration(managedDefinition.id)).toBe(generation);
        }
        else if (change === "catalog disconnect") {
          world.account = "disconnected";
          if (trigger === "recipe-update") await composition.modelCatalog.refresh(managedDefinition.id, "background");
          else {
            // Same-provider refreshes queue behind this explicit refresh. Exercise the exact
            // committed-catalog callback for an independently recorded disconnection instead.
            await server.publishCatalog({ providerId: managedDefinition.id, connected: false }, { connectionGeneration: composition.providerDefinitions.connectionGeneration(managedDefinition.id) });
            composition.providerDefinitions.catalogPublished(managedDefinition.id, { connected: false });
          }
        }
        else await composition.providerDefinitions[change](managedDefinition.id);
        expect(signal.aborted).toBe(change !== "unchanged catalog");
        release.resolve();
        await evaluation;
        expect(publishAvailability).toHaveBeenCalledTimes(change === "unchanged catalog" ? 1 : 0);
        expect([...due]).toEqual(change === "unchanged catalog" ? [] : ["prime-agent-basic"]);
      } finally { release.resolve(); await composition.close(); }
    });

  it("refuses fresh setup while a signed-out catalog commit is pending", async () => {
    const world = managedWorld(); const server = productServer([managedDefinition]);
    const evaluateReadiness = vi.fn(); const composition = compose({ registry: world.registry, server, evaluateReadiness });
    let release; const gate = new Promise(resolve => { release = resolve; });
    let reached; const entered = new Promise(resolve => { reached = resolve; });
    const originalPublish = server.publishCatalog;
    try {
      await composition.start();
      const generation = composition.providerDefinitions.connectionGeneration(managedDefinition.id);
      server.publishCatalog = async (snapshot, options) => { if (options?.connectionEvent === "signed-out") { reached(); await gate; } return originalPublish(snapshot, options); };
      const logout = composition.providerDefinitions.logout(managedDefinition.id);
      await entered;
      // A catalog discovered before logout can answer while its sign-out commit awaits.
      composition.providerDefinitions.catalogPublished(managedDefinition.id, { connected: true });
      expect(composition.providerDefinitions.refreshGeneration(managedDefinition.id)).toBeNull();
      expect(await composition.readinessRoutes()).toEqual([]);
      await composition.providerDefinitions.evaluateCatalogReadiness(managedDefinition.id, [model], "explicit-repair", { connectionGeneration: generation });
      expect(evaluateReadiness).not.toHaveBeenCalled();
      release(); await logout;
    } finally { release(); await composition.close(); }
  });

  it("does not lend a new generation to old discovery models", async () => {
    const world = managedWorld(); const server = productServer([managedDefinition]);
    const evaluateReadiness = vi.fn(); const composition = compose({ registry: world.registry, server, evaluateReadiness });
    try {
      await composition.start();
      const generation = composition.providerDefinitions.connectionGeneration(managedDefinition.id);
      await composition.providerDefinitions.logout(managedDefinition.id);
      await composition.providerDefinitions.evaluateCatalogReadiness(managedDefinition.id, [model], "explicit-repair", { connectionGeneration: generation });
      expect(evaluateReadiness).not.toHaveBeenCalled();
    } finally { await composition.close(); }
  });
});
