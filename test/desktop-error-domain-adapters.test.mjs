import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWindowFactory } from "../desktop/main/window.mjs";
import { installElectronMainErrorAdapter } from "../desktop/main/services/electron-main-error-adapter.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function readyChild(message) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
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
  queueMicrotask(() => child.stdout.write(`${JSON.stringify(message)}\n`));
  return child;
}

function fixtureHarnessModule({ start = "return { url: 'http://127.0.0.1:43124', host: {}, close: async () => {}, forceClose: () => {} };" } = {}) {
  return `data:text/javascript,${encodeURIComponent(`
    export const digestHarnessConfiguration = () => "digest";
    export const createCodexBasicFactory = () => ({});
    export const loadHarnessConfigurations = async () => new Map();
    export const productHarnessImplementations = () => ({});
    export const startHarnessHost = async () => { ${start} };
  `)}`;
}

describe("desktop failure-domain adapters", () => {
  it("classifies an unhandled harness-host exception without forwarding its raw detail", async () => {
    const processTarget = new EventEmitter();
    const reporters = new Map();
    const issueErrorReporter = vi.fn((component) => {
      const reporter = { report: vi.fn(async () => ({ accepted: true, delivery: "sent" })), revoke: vi.fn() };
      reporters.set(component, reporter);
      return reporter;
    });
    const adapter = installElectronMainErrorAdapter({ processTarget, issueErrorReporter });
    const raw = new TypeError("private prompt");
    raw.stack = "TypeError: private prompt\n at host (/app.asar/node_modules/@relayer/harness-host/dist/index.js:10:2)";
    processTarget.emit("uncaughtExceptionMonitor", raw, "uncaughtException");
    await new Promise((resolve) => setImmediate(resolve));
    expect(reporters.get("node-harness-host").report).toHaveBeenCalledWith({
      code: "node_harness_host.unhandled_crash",
      exceptionClass: "TypeError",
      frames: [{ module: "packages/harness-host/dist/index.js", line: 10, column: 2 }],
    });
    expect(JSON.stringify(reporters.get("node-harness-host").report.mock.calls)).not.toContain("private prompt");
    expect(reporters.get("electron-main").report).not.toHaveBeenCalled();
    adapter.close();
    expect(reporters.get("node-harness-host").revoke).toHaveBeenCalledOnce();
  });

  it("does not let raw exception text impersonate the harness-host domain", async () => {
    const processTarget = new EventEmitter();
    const reporters = new Map();
    const issueErrorReporter = (component) => {
      const reporter = { report: vi.fn(async () => ({ accepted: true })), revoke: vi.fn() };
      reporters.set(component, reporter);
      return reporter;
    };
    const adapter = installElectronMainErrorAdapter({ processTarget, issueErrorReporter });
    const raw = new Error("private prompt mentions @relayer/harness-host/");
    raw.stack = "Error: private prompt mentions @relayer/harness-host/\n at boot (/repo/desktop/main/index.mjs:10:2)";

    processTarget.emit("uncaughtExceptionMonitor", raw, "uncaughtException");
    await new Promise((resolve) => setImmediate(resolve));

    expect(reporters.get("electron-main").report).toHaveBeenCalledWith({
      code: "electron_main.unhandled_crash",
      exceptionClass: "Error",
      frames: [{ module: "desktop/main/index.mjs", line: 10, column: 2 }],
    });
    expect(reporters.get("node-harness-host").report).not.toHaveBeenCalled();
    adapter.close();
  });

  it("reports a sanitized Rust graph-server startup failure and never issues host authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-startup-error-"));
    directories.push(directory);
    const report = vi.fn(async () => ({ accepted: true, delivery: "sent" }));
    const revoke = vi.fn();
    const issueErrorReporter = vi.fn(() => ({ report, revoke }));
    const child = readyChild(null);
    const service = new GraphCompleteRuntimeService({
      userDataDirectory: directory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [],
      harnessHostModuleUrl: fixtureHarnessModule(),
      issueErrorReporter,
      spawnProcess: () => {
        queueMicrotask(() => child.emit("error", new Error("spawn C:\\private\\graph failed")));
        return child;
      },
    });

    await expect(service.start()).rejects.toThrow("could not start");
    await new Promise((resolve) => setImmediate(resolve));
    expect(report).toHaveBeenCalledWith({
      code: "rust_graph_server.startup_failure",
      exceptionClass: "Error",
      frames: [],
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain("private");
    expect(issueErrorReporter).not.toHaveBeenCalledWith("node-harness-host", expect.anything());
    expect(revoke).toHaveBeenCalledOnce();
    await service.close().catch(() => undefined);
  });

  it("reports an unexpected Rust graph-server exit through its process-generation capability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-error-adapter-"));
    directories.push(directory);
    const reporters = new Map();
    const issueErrorReporter = vi.fn((component, generation) => {
      const reporter = { report: vi.fn(async () => ({ accepted: true, delivery: "sent" })), revoke: vi.fn() };
      reporters.set(component, reporter);
      return reporter;
    });
    const child = readyChild({ ready: true, url: "http://127.0.0.1:43125" });
    const service = new GraphCompleteRuntimeService({
      userDataDirectory: directory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [],
      harnessHostModuleUrl: fixtureHarnessModule(),
      issueErrorReporter,
      spawnProcess: () => child,
    });

    await service.start();
    expect(issueErrorReporter).toHaveBeenCalledWith("rust-graph-server", 1);
    child.exitCode = 17;
    child.emit("exit", 17, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(reporters.get("rust-graph-server").report).toHaveBeenCalledWith({
      code: "rust_graph_server.unexpected_exit",
      exceptionClass: null,
      frames: [],
    });
    expect(reporters.get("rust-graph-server").revoke).toHaveBeenCalledOnce();
    await service.close();
  });

  it("reports a sanitized Rust app-server startup failure without forwarding process detail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-app-startup-error-"));
    directories.push(directory);
    const report = vi.fn(async () => ({ accepted: true, delivery: "sent" }));
    const revoke = vi.fn();
    const child = readyChild(null);
    const service = new RelayerAppServerService({
      userDataDirectory: directory,
      binaryPath: "/test/bin/relayer-app-server",
      webDirectory: "/test/renderer",
      permissionCatalogPath: "/test/permissions.json",
      issueErrorReporter: () => ({ report, revoke }),
      spawnProcess: () => {
        queueMicrotask(() => child.emit("error", new TypeError("spawn /Users/person/private failed")));
        return child;
      },
    });

    await expect(service.start()).rejects.toThrow("could not start");
    await new Promise((resolve) => setImmediate(resolve));
    expect(report).toHaveBeenCalledWith({
      code: "rust_app_server.startup_failure",
      exceptionClass: "Error",
      frames: [],
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain("/Users/person/private");
    expect(revoke).toHaveBeenCalledOnce();
    await service.close();
  });

  it("reports an unexpected Rust app-server exit and revokes that process capability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-app-error-adapter-"));
    directories.push(directory);
    const report = vi.fn(async () => ({ accepted: true, delivery: "sent" }));
    const revoke = vi.fn();
    const issueErrorReporter = vi.fn(() => ({ report, revoke }));
    const child = readyChild({
      ready: true,
      origin: "http://127.0.0.1:43123",
      cookieName: "relayer_control",
    });
    const service = new RelayerAppServerService({
      userDataDirectory: directory,
      binaryPath: "/test/bin/relayer-app-server",
      webDirectory: "/test/renderer",
      permissionCatalogPath: "/test/permissions.json",
      issueErrorReporter,
      spawnProcess: () => child,
    });

    await service.start();
    expect(issueErrorReporter).toHaveBeenCalledWith("rust-app-server", 1);
    child.exitCode = 9;
    child.emit("exit", 9, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(report).toHaveBeenCalledWith({
      code: "rust_app_server.unexpected_exit",
      exceptionClass: null,
      frames: [],
    });
    expect(revoke).toHaveBeenCalledOnce();
    await service.close();
  });

  it("observes an Electron-main uncaught exception without forwarding the raw error and revokes on close", async () => {
    const processTarget = new EventEmitter();
    const report = vi.fn(async () => { throw new Error("reporting unavailable"); });
    const revoke = vi.fn();
    const issueErrorReporter = vi.fn(() => ({ report, revoke }));
    const adapter = installElectronMainErrorAdapter({
      processTarget,
      processGeneration: 3,
      issueErrorReporter,
    });
    const raw = Object.assign(new TypeError("private prompt and /Users/person/workspace"), {
      path: "/Users/person/workspace/private.txt",
    });

    processTarget.emit("uncaughtExceptionMonitor", raw, "uncaughtException");
    await new Promise((resolve) => setImmediate(resolve));

    expect(issueErrorReporter).toHaveBeenCalledWith("electron-main", 3);
    expect(report).toHaveBeenCalledWith({
      code: "electron_main.unhandled_crash",
      exceptionClass: "TypeError",
      frames: [],
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain("private prompt");
    adapter.close();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(processTarget.listenerCount("uncaughtExceptionMonitor")).toBe(0);
  });

  it("reports an unexpected renderer termination through a window-generation capability and revokes it on close", async () => {
    const report = vi.fn(async () => ({ accepted: true, delivery: "sent" }));
    const revoke = vi.fn();
    const issueErrorReporter = vi.fn(() => ({ report, revoke }));
    class FakeBrowserWindow extends EventEmitter {
      constructor() {
        super();
        this.webContents = Object.assign(new EventEmitter(), {
          setWindowOpenHandler: vi.fn(),
          session: { cookies: { set: vi.fn(async () => undefined) } },
        });
        this.loadURL = vi.fn(async () => undefined);
      }
    }
    const createWindow = createWindowFactory({
      BrowserWindow: FakeBrowserWindow,
      desktopDirectory: "/immutable-desktop",
      getAppearance: () => "dark",
      updater: { status: () => ({ phase: "development" }) },
      issueErrorReporter,
    });

    const window = await createWindow({
      origin: "http://127.0.0.1:4321/session",
      cookie: { name: "session", value: "private" },
    });
    expect(issueErrorReporter).toHaveBeenCalledWith("renderer", 1);
    window.webContents.emit("render-process-gone", {}, {
      reason: "crashed",
      exitCode: 137,
      rawMessage: "private renderer detail",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(report).toHaveBeenCalledWith({
      code: "renderer.unhandled_crash",
      exceptionClass: null,
      frames: [],
    });
    window.webContents.emit("ipc-message", {}, "relayer:renderer-unhandled-error", {
      code: "renderer.unhandled_crash",
      exceptionClass: "TypeError",
      frames: [{ module: "desktop/renderer/assets/app.js", line: 9, column: 2 }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(report).toHaveBeenCalledWith({
      code: "renderer.unhandled_crash",
      exceptionClass: "TypeError",
      frames: [{ module: "desktop/renderer/assets/app.js", line: 9, column: 2 }],
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain("private renderer detail");
    window.emit("closed");
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("revokes the reporter without touching webContents on a destroyed window", async () => {
    const revoke = vi.fn();
    // Electron destroys the window before emitting "closed", and the
    // webContents getter throws on a destroyed BrowserWindow. Reading it from
    // the closed handler raised an uncaught main-process exception.
    class DestroyedOnCloseBrowserWindow extends EventEmitter {
      constructor() {
        super();
        this.destroyed = false;
        this.contents = Object.assign(new EventEmitter(), {
          setWindowOpenHandler: vi.fn(),
          session: { cookies: { set: vi.fn(async () => undefined) } },
          isDestroyed: () => this.destroyed,
        });
        this.loadURL = vi.fn(async () => undefined);
      }

      get webContents() {
        if (this.destroyed) throw new TypeError("Object has been destroyed");
        return this.contents;
      }

      close() {
        this.destroyed = true;
        this.emit("closed");
      }
    }
    const createWindow = createWindowFactory({
      BrowserWindow: DestroyedOnCloseBrowserWindow,
      desktopDirectory: "/immutable-desktop",
      getAppearance: () => "dark",
      updater: { status: () => ({ phase: "development" }) },
      issueErrorReporter: () => ({ report: vi.fn(), revoke }),
    });

    const window = await createWindow({
      origin: "http://127.0.0.1:4321/session",
      cookie: { name: "session", value: "private" },
    });

    expect(() => window.close()).not.toThrow();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("revokes the prior renderer generation on replacement and ignores expected termination", async () => {
    const reporters = [
      { report: vi.fn(), revoke: vi.fn() },
      { report: vi.fn(), revoke: vi.fn() },
    ];
    class FakeBrowserWindow extends EventEmitter {
      constructor() {
        super();
        this.webContents = Object.assign(new EventEmitter(), {
          setWindowOpenHandler: vi.fn(),
          session: { cookies: { set: vi.fn(async () => undefined) } },
        });
        this.loadURL = vi.fn(async () => undefined);
      }
    }
    const issueErrorReporter = vi.fn((_component, generation) => reporters[generation - 1]);
    const createWindow = createWindowFactory({
      BrowserWindow: FakeBrowserWindow,
      desktopDirectory: "/immutable-desktop",
      getAppearance: () => "dark",
      updater: { status: () => ({ phase: "development" }) },
      issueErrorReporter,
    });
    const session = {
      origin: "http://127.0.0.1:4321/session",
      cookie: { name: "session", value: "private" },
    };

    const first = await createWindow(session);
    const second = await createWindow(session);
    expect(reporters[0].revoke).toHaveBeenCalledOnce();
    second.webContents.emit("render-process-gone", {}, { reason: "killed", exitCode: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(reporters[1].report).not.toHaveBeenCalled();
    first.emit("closed");
    expect(reporters[0].revoke).toHaveBeenCalledOnce();
    second.emit("closed");
    expect(reporters[1].revoke).toHaveBeenCalledOnce();
  });
});
