// Replays ProviderSettings.tla scenario traces against the real desktop
// provider service and IPC handlers.
//
// Each spec action maps to the real call it abstracts. The awaits the spec
// splits an operation at (prepareRuntime, login(), openExternal, account(),
// onRuntimeReady) are held on deferreds, so a step resumes exactly one of
// them. observe() reads the real objects back into the spec's variables (the
// refinement mapping), and the replay compares that with the trace's state
// after every step.
//
// The app-server side of the spec (model_providers.connected) is a fake here:
// this adapter checks the desktop main process, not SQLite.

import { registerDesktopIpc } from "../../desktop/main/ipc/register-ipc.mjs";
import { createProviderAdapterRegistry } from "../../desktop/main/providers/provider-adapter-contract.mjs";
import { ProviderDefinitionService } from "../../desktop/main/providers/provider-definition-service.mjs";

// Spec ids to real ids.
export const REAL_ID = Object.freeze({ P: "claude-work", N: "claude-personal" });
const RUNTIME_IDS = ["1", "2", "3"];
const EXECS = ["e1"];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// Runs every continuation that can run before the next step.
async function settle() {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

const specId = (realId) => Object.keys(REAL_ID).find((key) => REAL_ID[key] === realId);

export class ProviderSettingsWorld {
  constructor() {
    this.runtimes = [];
    this.sql = { connected: true };
    this.logoutRefreshes = true;
    this.holdRuntimeReady = false;
    this.runtimeReady = null;
    this.prepares = new Map();
    this.handoffs = new Map();
    this.ipc = { N: null, P: null };
    this.ipcDone = { N: false, P: false };
    this.completions = { N: null, P: null };
    this.cancels = { N: 0, P: 0 };
    this.bindingOwner = null;
    this.listeners = [];
    this.leases = new Map();
    this.stored = [{
      id: REAL_ID.P, adapterId: "fake-managed", label: "Claude Work", endpoint: null,
      accessContract: "managed-runtime@1", credentialReference: null,
      lifecycleState: "active", removedAt: null,
    }];
    const world = this;
    this.contents = {
      destroyed: false,
      isDestroyed() { return this.destroyed; },
      once(event, listener) {
        if (event === "destroyed") world.listeners.push({ listener, owner: world.bindingOwner, done: false });
      },
      removeListener(event, listener) {
        const entry = world.listeners.find((item) => item.listener === listener);
        if (entry) entry.done = true;
      },
    };
    const registry = createProviderAdapterRegistry([{
      adapterId: "fake-managed", implementationVersion: "1", label: "Managed",
      accessContract: "managed-runtime@1", defaultEndpoint: null,
      connection: { mode: "managed-login", fields: [] },
      create: ({ definition }) => world.#createRuntime(definition.id),
    }]);
    const initial = this.#createRuntime(REAL_ID.P);
    this.service = new ProviderDefinitionService({
      registry,
      initialRuntimes: new Map([[REAL_ID.P, initial]]),
      retry: { attempts: 1 },
      definitionStore: {
        load: async () => structuredClone(world.stored),
        save: async (next) => { world.stored = structuredClone(next); },
        createWithCatalog: async (candidate) => { world.stored.push(structuredClone(candidate)); },
      },
      credentialStore: { set: async () => {}, get: async () => ({}), delete: async () => {} },
      prepareRuntime: ({ providerDefinition }) => {
        const hold = deferred();
        world.prepares.set(specId(providerDefinition.id), hold);
        return hold.promise;
      },
      publishCatalog: async () => { world.sql.connected = true; },
      onRuntimeReady: () => {
        if (!world.holdRuntimeReady) return undefined;
        world.holdRuntimeReady = false;
        world.runtimeReady = deferred();
        return world.runtimeReady.promise;
      },
      onRuntimeChanged: async () => {
        if (!world.logoutRefreshes) throw new Error("catalog refresh failed");
        world.sql.connected = false;
      },
    });
    const cancelConnection = this.service.cancelConnection.bind(this.service);
    this.service.cancelConnection = (connectionId) => {
      const id = specId(connectionId);
      world.cancels[id] += 1;
      return cancelConnection(connectionId).finally(() => { world.cancels[id] -= 1; });
    };
    this.handlers = new Map();
    registerDesktopIpc({
      ipcMain: { handle: (channel, handler) => world.handlers.set(channel, handler) },
      dialog: {}, nativeTheme: {}, modelCatalog: {}, settings: {}, updater: {},
      shell: {
        openExternal: (url) => {
          const hold = deferred();
          world.handoffs.set(world.#runtimeByUrl(url).spec, hold);
          return hold.promise;
        },
      },
      providerDefinitions: this.service,
      presentWindow: () => {},
      getWindow: () => null,
      getAppearance: () => "dark",
      setAppearance: () => {},
    });
  }

  #createRuntime(realId) {
    const runtime = {
      id: String(this.runtimes.length + 1),
      spec: specId(realId),
      state: "open",
      login: null,
      account: null,
      failDiscover: false,
    };
    runtime.api = {
      credentials: {
        login: () => { runtime.login = deferred(); return runtime.login.promise; },
        account: () => { runtime.account = deferred(); return runtime.account.promise; },
        logout: async () => ({ status: "disconnected" }),
      },
      catalog: {
        discover: async () => {
          if (runtime.failDiscover) throw new Error("catalog discovery failed");
          return { provider: { id: realId }, models: [{ visible: true }] };
        },
      },
      close: async () => { runtime.state = "closed"; },
    };
    this.runtimes.push(runtime);
    return runtime.api;
  }

  #runtimeByUrl(url) {
    return this.runtimes.find((runtime) => url.endsWith(`/${runtime.id}`));
  }

  #runtimeOf(api) {
    return this.runtimes.find((runtime) => runtime.api === api);
  }

  #pendingRuntime(spec, field) {
    const runtime = this.runtimes.find((item) => item.spec === spec && item[field]);
    if (!runtime) throw new Error(`No ${field} call is waiting for ${spec}.`);
    const hold = runtime[field];
    runtime[field] = null;
    return { runtime, hold };
  }

  #call(channel, input) {
    const result = this.handlers.get(channel)({ sender: this.contents }, input);
    // A handler rejection is an outcome the next observe() reads, not a crash.
    result.catch(() => undefined);
    return result;
  }

  // Performs one spec action.
  async apply([name, ...args]) {
    switch (name) {
      case "ConnStart":
        this.ipc.N = this.#call("relayer:provider-connect", {
          connectionId: REAL_ID.N, adapterId: "fake-managed", label: "Claude Personal",
        });
        break;
      case "ConnS1":
        break; // the first serialized block already ran when ConnStart settled
      case "ConnS2":
      case "ReconS2": {
        const spec = name === "ConnS2" ? "N" : "P";
        this.prepares.get(spec).resolve(null);
        this.prepares.delete(spec);
        break;
      }
      case "ConnLogin":
      case "ReconLogin": {
        const { runtime, hold } = this.#pendingRuntime(name === "ConnLogin" ? "N" : "P", "login");
        if (name === "ConnLogin" || args[0] === "ok") {
          hold.resolve({ loginId: `login-${runtime.id}`, authUrl: `https://login.example.test/${runtime.id}` });
        } else {
          hold.reject(new Error("login failed"));
        }
        break;
      }
      case "ReconStart":
        this.ipc.P = this.#call("relayer:provider-reconnect", { id: REAL_ID.P });
        break;
      case "Handoff": {
        const [spec, outcome] = args;
        this.bindingOwner = spec;
        const hold = this.handoffs.get(spec);
        this.handoffs.delete(spec);
        if (outcome === "ok") hold.resolve();
        else hold.reject(new Error("openExternal failed"));
        await settle();
        this.bindingOwner = null;
        break;
      }
      case "IpcReturn":
        await Promise.allSettled([this.ipc[args[0]]]);
        this.ipcDone[args[0]] = true;
        break;
      case "RendererCancel":
        this.#call("relayer:provider-connect-cancel", { connectionId: REAL_ID[args[0]] });
        break;
      case "RunCancel":
        break; // a queued cancel runs as soon as the queue frees
      case "RendererDestroyed":
        this.contents.destroyed = true;
        for (const entry of this.listeners.filter((item) => !item.done)) {
          entry.done = true;
          entry.listener();
        }
        break;
      case "CompleteStart":
        this.completions[args[0]] = this.#call("relayer:provider-connect-complete", { connectionId: REAL_ID[args[0]] });
        break;
      case "CompleteFinish": {
        const [spec, outcome] = args;
        const { runtime, hold } = this.#pendingRuntime(spec, "account");
        if (outcome === "check_failed") hold.reject(new Error("account check failed"));
        else {
          runtime.failDiscover = outcome === "catalog_failed";
          hold.resolve({ status: outcome === "disconnected" ? "disconnected" : "connected" });
        }
        await settle();
        await Promise.allSettled([this.completions[spec]]);
        break;
      }
      case "ExecAdmit": {
        const definition = this.stored.find((item) => item.id === REAL_ID.P);
        if (!this.sql.connected || definition?.lifecycleState !== "active") {
          throw new Error("Rust admission would refuse this turn.");
        }
        this.leases.set(args[0], { admitted: true, lease: null });
        break;
      }
      case "ExecAcquire": {
        const entry = this.leases.get(args[0]);
        this.holdRuntimeReady = !this.service.runtimes.has(REAL_ID.P);
        entry.pending = this.service.acquireExecution(REAL_ID.P).then(
          (lease) => { entry.lease = lease; },
          () => { entry.refused = true; },
        );
        break;
      }
      case "ExecRegistered":
        this.runtimeReady.resolve();
        this.runtimeReady = null;
        break;
      case "ExecRelease": {
        const entry = this.leases.get(args[0]);
        await entry.lease.release();
        entry.lease = null;
        break;
      }
      case "Logout":
        this.logoutRefreshes = args[0] === "refreshed";
        await Promise.allSettled([this.#call("relayer:provider-logout", { id: REAL_ID.P })]);
        break;
      case "Remove":
        await Promise.allSettled([this.#call("relayer:provider-remove", { id: REAL_ID.P })]);
        break;
      default:
        throw new Error(`The trace adapter does not implement ${name}.`);
    }
    await settle();
  }

  // The refinement mapping: real objects read back as the spec's variables.
  observe() {
    const { service } = this;
    const definitions = service.definitions ?? this.stored;
    const defs = Object.fromEntries(Object.entries(REAL_ID).map(([spec, id]) => [
      spec, definitions.find((item) => item.id === id)?.lifecycleState ?? "absent",
    ]));
    const rmap = Object.fromEntries(Object.entries(REAL_ID).map(([spec, id]) => {
      const api = service.runtimes.get(id);
      return [spec, api ? Number(this.#runtimeOf(api).id) : 0];
    }));
    const rt = Object.fromEntries(RUNTIME_IDS.map((id) => [
      id, this.runtimes.find((runtime) => runtime.id === id)?.state ?? "unused",
    ]));
    const pend = Object.fromEntries(Object.entries(REAL_ID).map(([spec, id]) => {
      const pending = service.pendingConnections.get(id);
      return [spec, pending
        ? { kind: pending.reconnect ? "reconnect" : "connect", rt: Number(this.#runtimeOf(pending.runtime).id), fails: pending.failedChecks ?? 0 }
        : { kind: "none", rt: 0, fails: 0 }];
    }));
    const preparation = service.preparingConnections.get(REAL_ID.N);
    const code = service.statusOverrides.get(REAL_ID.P)?.unavailableReason?.code;
    const bound = Object.fromEntries(Object.keys(REAL_ID).map((spec) => [
      spec, this.listeners.some((entry) => entry.owner === spec && !entry.done),
    ]));
    const exec = Object.fromEntries(EXECS.map((execution) => {
      const lease = this.leases.get(execution)?.lease;
      return [execution, lease ? Number(this.#runtimeOf(lease.runtime).id) : null];
    }));
    return {
      defs, rmap, rt, pend, bound, exec,
      prep: preparation ? "cancellable" : "none",
      ...(preparation ? { cancelled: preparation.cancelled } : {}),
      override: { provider_logged_out: "logged_out", provider_login_pending: "login_pending" }[code] ?? "none",
      alive: !this.contents.destroyed,
      ipcDone: { ...this.ipcDone },
      cancelQ: Object.fromEntries(Object.keys(REAL_ID).map((spec) => [spec, this.cancels[spec] > 0])),
      closing: service.closing,
      sqlConnected: this.sql.connected,
    };
  }
}

// The same projection of a trace state from the model.
export function projectModelState(state) {
  return {
    defs: state.defs,
    rmap: state.rmap,
    rt: state.rt,
    pend: state.pend,
    bound: state.bound,
    exec: Object.fromEntries(EXECS.map((execution) => [
      execution, state.exec[execution].pc === "holding" ? state.exec[execution].rt : null,
    ])),
    prep: state.prep,
    ...(state.prep === "none" ? {} : { cancelled: state.cancelled }),
    override: state.override,
    alive: state.alive,
    ipcDone: state.ipcDone,
    cancelQ: state.cancelQ,
    closing: state.closing,
    sqlConnected: state.sqlConnected,
  };
}

// The spec's invariants over the shared projection.
export const PROMISES = Object.freeze({
  PendingAttemptIsOwned: (state) => Object.keys(REAL_ID).every((spec) => (
    state.pend[spec].kind === "none" || !state.ipcDone[spec]
    || (state.alive && state.bound[spec]) || state.cancelQ[spec]
  )),
  PendingReconnectIsForActiveProvider: (state) => (
    state.pend.P.kind !== "reconnect" || state.defs.P === "active"
  ),
  LeasedRuntimeStaysOpen: (state) => state.closing || EXECS.every((execution) => (
    state.exec[execution] === null || state.rt[String(state.exec[execution])] === "open"
  )),
});
