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

function fixtureHarnessModule() {
  return `data:text/javascript,${encodeURIComponent(`
    export const digestHarnessConfiguration = () => "digest";
    export const createCodexBasicFactory = () => ({});
    export const loadHarnessConfigurations = async () => new Map();
    export const productHarnessImplementations = () => ({});
    export const startHarnessHost = async () => ({ url: 'http://127.0.0.1:43124', host: {}, close: async () => {}, forceClose: () => {} });
  `)}`;
}

function reporterMap() {
  const reporters = new Map();
  const issueErrorReporter = vi.fn((component) => {
    const reporter = { report: vi.fn(async () => ({ accepted: true, delivery: "sent" })), revoke: vi.fn() };
    reporters.set(component, reporter);
    return reporter;
  });
  return { reporters, issueErrorReporter };
}

describe("desktop failure-domain adapters", () => {
  it("classifies main and Rust failures into sealed domains without forwarding raw detail", async () => {
    // Electron-main adapter: harness-host classification, impersonation
    // rejection, and uncaught-exception containment with generation authority.
    {
      const processTarget = new EventEmitter();
      const { reporters, issueErrorReporter } = reporterMap();
      const adapter = installElectronMainErrorAdapter({ processTarget, issueErrorReporter });
      const raw = new TypeError("private prompt");
      raw.stack = "TypeError: private prompt\n at host (/app.asar/node_modules/@relayer/harness-host/dist/index.js:10:2)";
      processTarget.emit("uncaughtExceptionMonitor", raw, "uncaughtException");
      await new Promise((resolve) => setImmediate(resolve));
      expect(reporters.get("node-harness-host").report, "harness-host stack classified to the harness-host domain").toHaveBeenCalledWith({
        code: "node_harness_host.unhandled_crash",
        exceptionClass: "TypeError",
        frames: [{ module: "packages/harness-host/dist/index.js", line: 10, column: 2 }],
      });
      expect(JSON.stringify(reporters.get("node-harness-host").report.mock.calls), "no raw harness-host prompt forwarded").not.toContain("private prompt");
      expect(reporters.get("electron-main").report, "electron-main reporter untouched for harness-host stacks").not.toHaveBeenCalled();
      adapter.close();
      expect(reporters.get("node-harness-host").revoke, "harness-host reporter revoked on adapter close").toHaveBeenCalledOnce();
    }
    {
      const processTarget = new EventEmitter();
      const { reporters, issueErrorReporter } = reporterMap();
      const adapter = installElectronMainErrorAdapter({ processTarget, issueErrorReporter });
      const raw = new Error("private prompt mentions @relayer/harness-host/");
      raw.stack = "Error: private prompt mentions @relayer/harness-host/\n at boot (/repo/desktop/main/index.mjs:10:2)";

      processTarget.emit("uncaughtExceptionMonitor", raw, "uncaughtException");
      await new Promise((resolve) => setImmediate(resolve));

      expect(reporters.get("electron-main").report, "raw text cannot impersonate the harness-host domain").toHaveBeenCalledWith({
        code: "electron_main.unhandled_crash",
        exceptionClass: "Error",
        frames: [{ module: "desktop/main/index.mjs", line: 10, column: 2 }],
      });
      expect(reporters.get("node-harness-host").report, "no harness-host report for impersonating text").not.toHaveBeenCalled();
      adapter.close();
    }
    {
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

      expect(issueErrorReporter, "electron-main capability issued for the process generation").toHaveBeenCalledWith("electron-main", 3);
      expect(report, "uncaught exception reported without raw error or path").toHaveBeenCalledWith({
        code: "electron_main.unhandled_crash",
        exceptionClass: "TypeError",
        frames: [],
      });
      expect(JSON.stringify(report.mock.calls), "no raw main-process detail forwarded").not.toContain("private prompt");
      adapter.close();
      expect(revoke, "main authority revoked on close").toHaveBeenCalledTimes(2);
      expect(processTarget.listenerCount("uncaughtExceptionMonitor"), "monitor listener removed").toBe(0);
    }

    // Rust services: startup failures and unexpected exits report through
    // process-generation capabilities with sanitized payloads.
    const rustCases = [
      ["graph server startup failure", "graph", "startup", new Error("spawn C:\\private\\graph failed")],
      ["graph server unexpected exit", "graph", "exit", null],
      ["app server startup failure", "app", "startup", new TypeError("spawn /Users/person/private failed")],
      ["app server unexpected exit", "app", "exit", null],
    ];
    expect(rustCases, "rust failure-domain inventory").toHaveLength(4);
    for (const [label, serviceKind, mode, spawnError] of rustCases) {
      const directory = await mkdtemp(join(tmpdir(), `relayer-${serviceKind}-${mode}-error-adapter-`));
      directories.push(directory);
      const { reporters, issueErrorReporter } = reporterMap();
      const readyMessage = serviceKind === "graph"
        ? { ready: true, url: "http://127.0.0.1:43125" }
        : { ready: true, origin: "http://127.0.0.1:43123", cookieName: "relayer_control" };
      const child = readyChild(readyMessage);
      const serviceOptions = serviceKind === "graph" ? {
        userDataDirectory: directory,
        graphServerBinary: "/test/bin/relayer-graph-server",
        configurationPaths: [],
        harnessHostModuleUrl: fixtureHarnessModule(),
        issueErrorReporter,
        spawnProcess: () => {
          if (spawnError) queueMicrotask(() => child.emit("error", spawnError));
          return child;
        },
      } : {
        userDataDirectory: directory,
        binaryPath: "/test/bin/relayer-app-server",
        webDirectory: "/test/renderer",
        permissionCatalogPath: "/test/permissions.json",
        issueErrorReporter,
        spawnProcess: () => {
          if (spawnError) queueMicrotask(() => child.emit("error", spawnError));
          return child;
        },
      };
      const service = serviceKind === "graph"
        ? new GraphCompleteRuntimeService(serviceOptions)
        : new RelayerAppServerService(serviceOptions);
      const component = serviceKind === "graph" ? "rust-graph-server" : "rust-app-server";
      const domain = serviceKind === "graph" ? "rust_graph_server" : "rust_app_server";

      if (mode === "startup") {
        await expect(service.start(), `${label}: start fails closed`).rejects.toThrow("could not start");
        await new Promise((resolve) => setImmediate(resolve));
        const reporter = reporters.get(component);
        expect(reporter.report, `${label}: sanitized startup report`).toHaveBeenCalledWith({
          code: `${domain}.startup_failure`,
          exceptionClass: "Error",
          frames: [],
        });
        expect(JSON.stringify(reporter.report.mock.calls), `${label}: no spawn detail forwarded`).not.toContain("private");
      } else {
        await service.start();
        expect(issueErrorReporter, `${label}: capability issued for process generation 1`).toHaveBeenCalledWith(component, 1);
        child.exitCode = serviceKind === "graph" ? 17 : 9;
        child.emit("exit", child.exitCode, null);
        await new Promise((resolve) => setImmediate(resolve));
        const reporter = reporters.get(component);
        expect(reporter.report, `${label}: sanitized exit report`).toHaveBeenCalledWith({
          code: `${domain}.unexpected_exit`,
          exceptionClass: null,
          frames: [],
        });
      }
      if (serviceKind === "graph") {
        expect(issueErrorReporter, `${label}: graph runtime never issues host authority`)
          .not.toHaveBeenCalledWith("node-harness-host", expect.anything());
      }
      expect(reporters.get(component).revoke, `${label}: process capability revoked`).toHaveBeenCalledOnce();
      await service.close().catch(() => undefined);
    }
  }, 20_000);

  it("reports renderer failures through window-generation capabilities and revokes them per window", async () => {
    // Crash and IPC-forwarded reports under one window capability.
    {
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
        openExternal: vi.fn(async () => undefined),
        issueErrorReporter,
      });

      const window = await createWindow({
        origin: "http://127.0.0.1:4321/session",
        cookie: { name: "session", value: "private" },
      });
      expect(issueErrorReporter, "renderer capability issued for window generation 1").toHaveBeenCalledWith("renderer", 1);
      window.webContents.emit("render-process-gone", {}, {
        reason: "crashed",
        exitCode: 137,
        rawMessage: "private renderer detail",
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(report, "renderer crash reported without raw detail").toHaveBeenCalledWith({
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
      expect(report, "renderer IPC-forwarded typed report").toHaveBeenCalledWith({
        code: "renderer.unhandled_crash",
        exceptionClass: "TypeError",
        frames: [{ module: "desktop/renderer/assets/app.js", line: 9, column: 2 }],
      });
      expect(JSON.stringify(report.mock.calls), "no raw renderer crash detail forwarded").not.toContain("private renderer detail");
      window.emit("closed");
      expect(revoke, "window capability revoked on close").toHaveBeenCalledOnce();
    }

    // Electron destroys the window before emitting "closed", and the
    // webContents getter throws on a destroyed BrowserWindow; revoke must not
    // touch webContents.
    {
      const revoke = vi.fn();
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
        openExternal: vi.fn(async () => undefined),
        issueErrorReporter: () => ({ report: vi.fn(), revoke }),
      });

      const window = await createWindow({
        origin: "http://127.0.0.1:4321/session",
        cookie: { name: "session", value: "private" },
      });

      expect(() => window.close(), "destroyed window closes without reading webContents").not.toThrow();
      expect(revoke, "destroyed window capability revoked").toHaveBeenCalledOnce();
    }

    // A replacement window revokes the prior generation; an expected
    // termination reports nothing.
    {
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
        openExternal: vi.fn(async () => undefined),
        issueErrorReporter,
      });
      const session = {
        origin: "http://127.0.0.1:4321/session",
        cookie: { name: "session", value: "private" },
      };

      const first = await createWindow(session);
      const second = await createWindow(session);
      expect(reporters[0].revoke, "prior renderer generation revoked on replacement").toHaveBeenCalledOnce();
      second.webContents.emit("render-process-gone", {}, { reason: "killed", exitCode: 0 });
      await new Promise((resolve) => setImmediate(resolve));
      expect(reporters[1].report, "expected termination reports nothing").not.toHaveBeenCalled();
      first.emit("closed");
      expect(reporters[0].revoke, "replaced window close does not double-revoke").toHaveBeenCalledOnce();
      second.emit("closed");
      expect(reporters[1].revoke, "current window capability revoked on close").toHaveBeenCalledOnce();
    }
  });
});
