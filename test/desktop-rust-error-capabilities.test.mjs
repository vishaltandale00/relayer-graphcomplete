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
  it("refreshes a running graph child across sign-in, replacement, and logout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-capability-refresh-"));
    directories.push(directory);
    const signedIn = capability("s");
    const replacement = capability("r");
    let nextCapability = null;
    const child = childFixture({ ready: true, url: "http://127.0.0.1:43125" });
    const service = new GraphCompleteRuntimeService({
      userDataDirectory: directory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [],
      harnessHostModuleUrl: harnessModule(),
      issueErrorCapability: () => nextCapability,
      spawnProcess: () => child,
    });

    await service.start();
    nextCapability = signedIn;
    await service.refreshErrorCapability();
    nextCapability = replacement;
    await service.refreshErrorCapability();
    nextCapability = null;
    await service.refreshErrorCapability();

    const updates = child.stdinText.trim().split("\n").slice(1).map((line) => JSON.parse(line));
    expect(updates.map((update) => update.capability?.authorization ?? null)).toEqual([
      null,
      signedIn.authorization,
      replacement.authorization,
      null,
    ]);
    expect(signedIn.revoke).toHaveBeenCalledOnce();
    expect(replacement.revoke).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    await service.close();
  });

  it("passes the graph-server capability only through private stdin and revokes it on close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-capability-"));
    directories.push(directory);
    const issued = capability("g");
    const issueErrorCapability = vi.fn(() => issued);
    const child = childFixture({ ready: true, url: "http://127.0.0.1:43125" });
    let spawnCall;
    const service = new GraphCompleteRuntimeService({
      userDataDirectory: directory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [],
      harnessHostModuleUrl: harnessModule(),
      issueErrorCapability,
      spawnProcess: (command, args, options) => {
        spawnCall = { command, args, options };
        return child;
      },
    });

    await service.start();
    expect(issueErrorCapability).toHaveBeenCalledWith("rust-graph-server", 1);
    expect(spawnCall.args).toContain("--authenticated-error-capability-stdin");
    expect(JSON.stringify(spawnCall)).not.toContain(issued.authorization);
    expect(JSON.stringify(spawnCall)).not.toContain(issued.endpoint);
    const bootstrap = JSON.parse(child.stdinText.trim().split("\n")[1]);
    expect(bootstrap).toEqual({
      schema: "relayer.authenticated-error-capability/v1",
      capability: { endpoint: issued.endpoint, authorization: issued.authorization },
    });

    await service.close();
    expect(issued.revoke).toHaveBeenCalledOnce();
  });

  it("rotates the app-server capability after an unexpected child restart without argv or env leakage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-app-capability-"));
    directories.push(directory);
    const capabilities = [capability("a"), capability("b")];
    const issueErrorCapability = vi.fn((_component, generation) => capabilities[generation - 1]);
    const children = [
      childFixture({ ready: true, origin: "http://127.0.0.1:43126", cookieName: "relayer_control" }),
      childFixture({ ready: true, origin: "http://127.0.0.1:43127", cookieName: "relayer_control" }),
    ];
    const spawnCalls = [];
    const service = new RelayerAppServerService({
      userDataDirectory: directory,
      binaryPath: "/test/bin/relayer-app-server",
      webDirectory: directory,
      permissionCatalogPath: "/test/permissions.json",
      issueErrorCapability,
      spawnProcess: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return children[spawnCalls.length - 1];
      },
    });

    await service.start();
    children[0].exitCode = 17;
    children[0].emit("exit", 17, null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(capabilities[0].revoke).toHaveBeenCalledOnce();
    await service.start();

    expect(issueErrorCapability.mock.calls).toEqual([
      ["rust-app-server", 1],
      ["rust-app-server", 2],
    ]);
    for (const [index, call] of spawnCalls.entries()) {
      expect(call.args).toContain("--authenticated-error-capability-stdin");
      expect(JSON.stringify(call)).not.toContain(capabilities[index].authorization);
      expect(JSON.stringify(call)).not.toContain(capabilities[index].endpoint);
      const lines = children[index].stdinText.trim().split("\n");
      expect(JSON.parse(lines[1])).toEqual({
        schema: "relayer.authenticated-error-capability/v1",
        capability: {
          endpoint: capabilities[index].endpoint,
          authorization: capabilities[index].authorization,
        },
      });
    }

    await service.close();
    expect(capabilities[1].revoke).toHaveBeenCalledOnce();
  });

  it("refreshes a running app-server capability without restarting the child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-app-capability-refresh-"));
    directories.push(directory);
    const signedIn = capability("i");
    let nextCapability = null;
    const child = childFixture({
      ready: true, origin: "http://127.0.0.1:43126", cookieName: "relayer_control",
    });
    const service = new RelayerAppServerService({
      userDataDirectory: directory,
      binaryPath: "/test/bin/relayer-app-server",
      webDirectory: directory,
      permissionCatalogPath: "/test/permissions.json",
      issueErrorCapability: () => nextCapability,
      spawnProcess: () => child,
    });

    await service.start();
    nextCapability = signedIn;
    await service.refreshErrorCapability();
    nextCapability = null;
    await service.refreshErrorCapability();

    const updates = child.stdinText.trim().split("\n").slice(1).map((line) => JSON.parse(line));
    expect(updates.map((update) => update.capability?.authorization ?? null)).toEqual([
      null,
      signedIn.authorization,
      null,
    ]);
    expect(signedIn.revoke).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    await service.close();
  });
});
