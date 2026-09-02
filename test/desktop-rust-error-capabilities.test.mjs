import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function childFixture(ready) {
  let stdin = "";
  const child = Object.assign(new EventEmitter(), {
    stdin: new Writable({ write(chunk, _encoding, callback) { stdin += String(chunk); callback(); } }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(function kill(signal) {
      this.signalCode = signal;
      queueMicrotask(() => this.emit("exit", null, signal));
      return true;
    }),
  });
  Object.defineProperty(child, "stdinText", { get: () => stdin });
  queueMicrotask(() => child.stdout.write(`${JSON.stringify(ready)}\n`));
  return child;
}

function harnessModule() {
  return `data:text/javascript,${encodeURIComponent(`
    export const digestHarnessConfiguration = () => "digest";
    export const createCodexBasicFactory = () => ({});
    export const loadHarnessConfigurations = async () => new Map();
    export const productHarnessImplementations = () => ({});
    export const startHarnessHost = async () => ({
      url: "http://127.0.0.1:43124", host: {}, close: async () => {}, forceClose: async () => {},
    });
  `)}`;
}

function capability(suffix) {
  return {
    endpoint: "http://127.0.0.1:43123/v1/authenticated-errors/report",
    authorization: `Bearer ${suffix.repeat(43)}`,
    revoke: vi.fn(),
  };
}

describe("desktop Rust authenticated-error capabilities", () => {
  it("issues, refreshes, rotates, and revokes Rust error capabilities through private stdin only", async () => {
    // Graph server: a running child refreshes its capability across sign-in,
    // replacement, and logout without restarting.
    const graphRefreshDirectory = await mkdtemp(join(tmpdir(), "relayer-graph-capability-refresh-"));
    directories.push(graphRefreshDirectory);
    const signedInGraph = capability("s");
    const replacementGraph = capability("r");
    let nextGraphCapability = null;
    const graphRefreshChild = childFixture({ ready: true, url: "http://127.0.0.1:43125" });
    const graphRefreshService = new GraphCompleteRuntimeService({
      userDataDirectory: graphRefreshDirectory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [],
      harnessHostModuleUrl: harnessModule(),
      issueErrorCapability: () => nextGraphCapability,
      spawnProcess: () => graphRefreshChild,
    });

    await graphRefreshService.start();
    nextGraphCapability = signedInGraph;
    await graphRefreshService.refreshErrorCapability();
    nextGraphCapability = replacementGraph;
    await graphRefreshService.refreshErrorCapability();
    nextGraphCapability = null;
    await graphRefreshService.refreshErrorCapability();

    const graphUpdates = graphRefreshChild.stdinText.trim().split("\n").slice(1).map((line) => JSON.parse(line));
    expect(graphUpdates.map((update) => update.capability?.authorization ?? null), "graph capability refreshed over stdin without restart").toEqual([
      null,
      signedInGraph.authorization,
      replacementGraph.authorization,
      null,
    ]);
    expect(signedInGraph.revoke, "superseded graph capability revoked").toHaveBeenCalledOnce();
    expect(replacementGraph.revoke, "logged-out graph capability revoked").toHaveBeenCalledOnce();
    expect(graphRefreshChild.kill, "graph child never restarted for refresh").not.toHaveBeenCalled();
    await graphRefreshService.close();

    // Graph server: the capability travels only through private stdin, never
    // argv or env, and is revoked on close.
    const graphTransportDirectory = await mkdtemp(join(tmpdir(), "relayer-graph-capability-"));
    directories.push(graphTransportDirectory);
    const issuedGraph = capability("g");
    const issueGraphCapability = vi.fn(() => issuedGraph);
    const graphTransportChild = childFixture({ ready: true, url: "http://127.0.0.1:43125" });
    let graphSpawnCall;
    const graphTransportService = new GraphCompleteRuntimeService({
      userDataDirectory: graphTransportDirectory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [],
      harnessHostModuleUrl: harnessModule(),
      issueErrorCapability: issueGraphCapability,
      spawnProcess: (command, args, options) => {
        graphSpawnCall = { command, args, options };
        return graphTransportChild;
      },
    });

    await graphTransportService.start();
    expect(issueGraphCapability, "graph capability issued for process generation 1").toHaveBeenCalledWith("rust-graph-server", 1);
    expect(graphSpawnCall.args, "graph capability stdin flag").toContain("--authenticated-error-capability-stdin");
    expect(JSON.stringify(graphSpawnCall), "graph authorization absent from argv and env").not.toContain(issuedGraph.authorization);
    expect(JSON.stringify(graphSpawnCall), "graph endpoint absent from argv and env").not.toContain(issuedGraph.endpoint);
    const graphBootstrap = JSON.parse(graphTransportChild.stdinText.trim().split("\n")[1]);
    expect(graphBootstrap, "graph capability bootstrap schema").toEqual({
      schema: "relayer.authenticated-error-capability/v1",
      capability: { endpoint: issuedGraph.endpoint, authorization: issuedGraph.authorization },
    });

    await graphTransportService.close();
    expect(issuedGraph.revoke, "graph capability revoked on close").toHaveBeenCalledOnce();

    // App server: an unexpected child restart rotates the capability with the
    // process generation, again without argv or env leakage.
    const appRestartDirectory = await mkdtemp(join(tmpdir(), "relayer-app-capability-"));
    directories.push(appRestartDirectory);
    const appCapabilities = [capability("a"), capability("b")];
    const issueAppCapability = vi.fn((_component, generation) => appCapabilities[generation - 1]);
    const appChildren = [
      childFixture({ ready: true, origin: "http://127.0.0.1:43126", cookieName: "relayer_control" }),
      childFixture({ ready: true, origin: "http://127.0.0.1:43127", cookieName: "relayer_control" }),
    ];
    const appSpawnCalls = [];
    const appRestartService = new RelayerAppServerService({
      userDataDirectory: appRestartDirectory,
      binaryPath: "/test/bin/relayer-app-server",
      webDirectory: appRestartDirectory,
      permissionCatalogPath: "/test/permissions.json",
      issueErrorCapability: issueAppCapability,
      spawnProcess: (command, args, options) => {
        appSpawnCalls.push({ command, args, options });
        return appChildren[appSpawnCalls.length - 1];
      },
    });

    await appRestartService.start();
    appChildren[0].exitCode = 17;
    appChildren[0].emit("exit", 17, null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(appCapabilities[0].revoke, "crashed generation's capability revoked").toHaveBeenCalledOnce();
    await appRestartService.start();

    expect(issueAppCapability.mock.calls, "capability rotates with the process generation").toEqual([
      ["rust-app-server", 1],
      ["rust-app-server", 2],
    ]);
    for (const [index, call] of appSpawnCalls.entries()) {
      expect(call.args, `app spawn ${index + 1} capability stdin flag`).toContain("--authenticated-error-capability-stdin");
      expect(JSON.stringify(call), `app spawn ${index + 1} authorization absent from argv and env`).not.toContain(appCapabilities[index].authorization);
      expect(JSON.stringify(call), `app spawn ${index + 1} endpoint absent from argv and env`).not.toContain(appCapabilities[index].endpoint);
      const lines = appChildren[index].stdinText.trim().split("\n");
      expect(JSON.parse(lines[1]), `app spawn ${index + 1} capability bootstrap schema`).toEqual({
        schema: "relayer.authenticated-error-capability/v1",
        capability: {
          endpoint: appCapabilities[index].endpoint,
          authorization: appCapabilities[index].authorization,
        },
      });
    }

    await appRestartService.close();
    expect(appCapabilities[1].revoke, "final app capability revoked on close").toHaveBeenCalledOnce();

    // App server: a running child refreshes its capability without restart.
    const appRefreshDirectory = await mkdtemp(join(tmpdir(), "relayer-app-capability-refresh-"));
    directories.push(appRefreshDirectory);
    const signedInApp = capability("i");
    let nextAppCapability = null;
    const appRefreshChild = childFixture({
      ready: true, origin: "http://127.0.0.1:43126", cookieName: "relayer_control",
    });
    const appRefreshService = new RelayerAppServerService({
      userDataDirectory: appRefreshDirectory,
      binaryPath: "/test/bin/relayer-app-server",
      webDirectory: appRefreshDirectory,
      permissionCatalogPath: "/test/permissions.json",
      issueErrorCapability: () => nextAppCapability,
      spawnProcess: () => appRefreshChild,
    });

    await appRefreshService.start();
    nextAppCapability = signedInApp;
    await appRefreshService.refreshErrorCapability();
    nextAppCapability = null;
    await appRefreshService.refreshErrorCapability();

    const appUpdates = appRefreshChild.stdinText.trim().split("\n").slice(1).map((line) => JSON.parse(line));
    expect(appUpdates.map((update) => update.capability?.authorization ?? null), "app capability refreshed over stdin without restart").toEqual([
      null,
      signedInApp.authorization,
      null,
    ]);
    expect(signedInApp.revoke, "logged-out app capability revoked").toHaveBeenCalledOnce();
    expect(appRefreshChild.kill, "app child never restarted for refresh").not.toHaveBeenCalled();
    await appRefreshService.close();
  }, 20_000);
});
