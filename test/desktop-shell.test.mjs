import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CodexCredentialAdapter } from "../desktop/main/credentials/codex-credential-adapter.mjs";
import { CredentialAdapter } from "../desktop/main/credentials/credential-adapter.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { createSettingsStore } from "../desktop/main/services/settings-store.mjs";
import { createDesktopUpdater, resolveUpdateChannel } from "../desktop/main/services/updater.mjs";
import { claimPrimaryDesktopInstance } from "../desktop/main/single-instance.mjs";
import {
  DESKTOP_UPDATE_BASE_URL,
  packagedDesktopReleaseMetadata,
} from "../desktop/shared/release-metadata.mjs";
import { createDesktopBuilderConfig } from "../desktop/packaging/electron-builder.mjs";
import { verifyBundledAppServer } from "../desktop/packaging/verify-bundled-app-server.mjs";
import {
  DESKTOP_RELEASE,
  resolveDesktopReleaseContract,
} from "../desktop/release/contract.mjs";
import {
  desktopReleaseArtifactNames,
  verifyDesktopReleaseEvidence,
  writeDesktopReleaseEvidence,
} from "../desktop/release/artifacts.mjs";
import { finalizeDesktopUpdateArtifact } from "../desktop/release/finalize-update-artifact.mjs";
import {
  buildPutObjectArgs,
  classifyPreviewPointer,
  createPreviewPublicationPlan,
  preparePreviewManifest,
  publishDesktopPreview,
  validatePreviewCandidate,
  validatePreviewPublicationProvenance,
} from "../desktop/release/publish-preview.mjs";
import {
  classifyStablePointer,
  promoteDesktopStable,
  validateStablePromotionProvenance,
} from "../desktop/release/promote-stable.mjs";
import { apiUrl } from "../desktop/renderer/src/api.js";
import { addLocalThread, interactionForThread, responseNodesForThread } from "../desktop/renderer/src/thread-model.js";
import { workspaceModeCapabilities } from "../desktop/renderer/src/product-workspace/model.js";
import { productWorkspaceMarkup } from "../desktop/renderer/src/product-workspace/view.js";
import { graphEdgeSegment } from "../desktop/renderer/src/product-workspace/workspace.js";
import { isSafeMarkdownLink } from "../desktop/renderer/src/product-workspace/markdown.js";

describe("desktop skeleton", () => {
  it("keeps one desktop authority and presents its window on later launches", () => {
    const handlers = new Map();
    let window;
    const app = {
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn((event, handler) => handlers.set(event, handler)),
      quit: vi.fn(),
    };
    const primary = claimPrimaryDesktopInstance({ app, getWindow: () => window });
    expect(primary).not.toBeNull();
    expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();

    handlers.get("second-instance")();
    window = {
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    expect(primary.presentPendingWindow()).toBe(true);
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(primary.presentPendingWindow()).toBe(false);

    const secondaryApp = {
      requestSingleInstanceLock: vi.fn(() => false),
      on: vi.fn(),
      quit: vi.fn(),
    };
    expect(claimPrimaryDesktopInstance({ app: secondaryApp, getWindow: () => null })).toBeNull();
    expect(secondaryApp.quit).toHaveBeenCalledOnce();
    expect(secondaryApp.on).not.toHaveBeenCalled();
  });

  it("exposes Codex setup, New thread, and updates without a harness selector", async () => {
    const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
    const desktopMain = await readFile(new URL("../desktop/main/index.mjs", import.meta.url), "utf8");
    const packageManifest = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const desktopManifest = await readFile(new URL("../desktop/package.json", import.meta.url), "utf8");
    const packaging = await readFile(new URL("../desktop/packaging/electron-builder.mjs", import.meta.url), "utf8");
    const desktopWindow = await readFile(new URL("../desktop/main/window.mjs", import.meta.url), "utf8");
    const desktopIpc = await readFile(new URL("../desktop/main/ipc/register-ipc.mjs", import.meta.url), "utf8");
    const rendererMain = await readFile(new URL("../desktop/renderer/src/main.js", import.meta.url), "utf8");
    const threads = await readFile(new URL("../desktop/renderer/src/threads.js", import.meta.url), "utf8");
    const prd = await readFile(new URL("../docs/prd/index.html", import.meta.url), "utf8");
    const prdServer = await readFile(new URL("../docs/prd/server.mjs", import.meta.url), "utf8");
    expect(html).toContain("Connect a provider");
    expect(html).toContain("Codex");
    expect(html).toContain("New thread");
    expect(html).toContain("Application updates");
    expect(html).toContain('id="appearanceSelect"');
    expect(html).toContain('id="collapseSidebar"');
    expect(html).toContain('id="scopeButton"');
    expect(html).toContain('id="scopeMenu"');
    expect(html).toContain('id="createThread" title="Create thread and send" disabled');
    expect(html).toContain('id="disconnectCodex"');
    expect(html).toContain('id="updateChannel"');
    expect(html).toContain("relayer-logo");
    expect(html).toContain('class="settings-view hidden"');
    expect(html).toContain('type="module" src="./src/main.js"');
    expect(html).toContain("connect-src 'self'");
    expect(html).not.toContain("http://127.0.0.1:*");
    expect(html).not.toContain('id="stopRun"');
    expect(html).not.toContain('id="retryRun"');
    expect(apiUrl("/api/state")).toBe("/api/state");
    expect(html).not.toContain("<dialog");
    expect(html.toLowerCase()).not.toContain("harness selector");
    expect(desktopMain).not.toContain("PrimeAgentThreadRunner");
    expect(desktopMain).toContain("RelayerAppServerService");
    expect(desktopMain).toContain("productServer.start()");
    expect(desktopMain).toContain("productServer.close()");
    expect(desktopMain).toContain("Promise.allSettled");
    expect(desktopMain).toContain("Relayer app server stopped");
    expect(desktopMain).toContain("app.isPackaged");
    expect(desktopWindow).toContain('window.webContents.on("will-navigate"');
    expect(desktopWindow).toContain('window.webContents.on("will-redirect"');
    expect(desktopWindow).toContain('setWindowOpenHandler(() => ({ action: "deny" }))');
    expect(desktopIpc).toContain("onUpdateInstallFailure");
    expect(packageManifest).not.toContain("@openai/codex-sdk");
    expect(desktopManifest).not.toContain("prime-agent");
    expect(desktopManifest).not.toContain("@openai/codex-sdk");
    expect(desktopManifest).toContain('"main": "main/index.mjs"');
    expect(JSON.parse(packageManifest).workspaces).toEqual(["desktop", "packages/*"]);
    expect(JSON.parse(packageManifest).devDependencies).not.toHaveProperty("@openai/codex");
    expect(JSON.parse(packageManifest).devDependencies).not.toHaveProperty("electron-updater");
    expect(packageManifest).toContain("desktop/packaging/electron-builder.mjs");
    expect(JSON.parse(packageManifest).scripts).toMatchObject({
      "predesktop:pack": "npm run prepare:desktop-runtime",
      "predesktop:dist": "npm run prepare:desktop-runtime",
      "predesktop:dist:preview": "npm run prepare:desktop-runtime",
    });
    expect(packaging).toContain('"macos/entitlements.mac.plist"');
    expect(packaging).toContain('"!packaging/**/*"');
    expect(packaging).toContain('"target/aarch64-apple-darwin/release/relayer-app-server"');
    expect(packaging).toContain('afterPack: "desktop/packaging/verify-bundled-app-server.mjs"');
    expect(packaging).toContain('"packages/graph-client/dist"');
    expect(desktopMain).toContain('"graph-client", "index.js"');
    expect(desktopMain).toContain("codexBasicClientModuleUrl: graphClientModuleUrl");
    expect(desktopMain).toContain("codexPathOverride: bundledCodexBinary");
    expect(packaging).toContain('to: "renderer"');
    expect(threads).not.toContain("/messages");
    expect(threads).not.toContain("EventSource");
    expect(rendererMain).not.toContain("/messages");
    expect(rendererMain).not.toContain("/interrupt");
    expect(prd).toContain('src="assets/product-walkthrough.html"');
    expect(prd).toContain("App-server and persistence delivery checkpoint");
    expect(prd).toContain('class="requirement-row status-verified"');
    expect(prd).toContain('class="requirement-row status-open"');
    expect(prd).toContain("APP-001-E1");
    expect(prd).toContain("APP-001-E2");
    expect(prd).toContain("APP-001-E3");
    expect(prd).toContain('assets/evidence/app-server/thread-created.png');
    expect(prd).toContain('assets/evidence/app-server/thread-reopened.png');
    expect(prd).toContain('assets/evidence/app-server/packaged-startup.png');
    expect(prd).toContain('document: \'docs/prd/index.html\'');
    expect(prdServer).toContain('join(prdDirectory, "comments.json")');
    expect(packageManifest).not.toContain('"marked"');
  });

  it("keeps the Eval shell separate while reusing the production product workspace", async () => {
    const productPackaging = await readFile(new URL("../desktop/packaging/electron-builder.mjs", import.meta.url), "utf8");
    const evalPackaging = await readFile(new URL("../desktop/packaging/eval-electron-builder.mjs", import.meta.url), "utf8");
    const evalMain = await readFile(new URL("../desktop/eval-main/index.mjs", import.meta.url), "utf8");
    const evalDashboard = await readFile(new URL("../desktop/eval-renderer/index.html", import.meta.url), "utf8");
    const graphAdapter = await readFile(new URL("../desktop/renderer/src/graph.js", import.meta.url), "utf8");
    const navigation = await readFile(new URL("../desktop/renderer/src/navigation.js", import.meta.url), "utf8");

    expect(productPackaging).toContain('"!eval-main/**/*"');
    expect(productPackaging).toContain('"!eval-renderer/**/*"');
    expect(productPackaging).toContain('"!preload/eval-*.cjs"');
    expect(evalPackaging).toContain('appId: "ai.relayer.eval"');
    expect(evalPackaging).toContain('main: "eval-main/index.mjs"');
    expect(evalPackaging).toContain('"main/single-instance.mjs"');
    expect(evalPackaging).toContain('{ from: resolve(desktopRoot, "renderer"), to: "renderer" }');
    expect(evalPackaging).toContain('"packages/graph-client/dist"');
    expect(evalMain).toContain("GraphCompleteRuntimeService");
    expect(evalMain).toContain("RelayerAppServerService");
    expect(evalMain).toContain("allowHarnessOverride: true");
    expect(evalMain).toContain("enableReadOnlySession: true");
    expect(evalMain).toContain("productSession.readOnlyCookie");
    expect(evalMain).toContain("claimPrimaryDesktopInstance");
    expect(evalMain).toContain("createReviewWindow(executionId)");
    expect(evalDashboard).toContain("Test cases");
    expect(evalDashboard).toContain("Harnesses under test");
    expect(evalDashboard).toContain("Open a case for one specific harness in the production workspace.");
    expect(graphAdapter).toContain('mode: evalReview || query.get("review") === "1" ? "review" : "interactive"');
    expect(navigation).toContain("viewState.evalContext.cases");
    expect(workspaceModeCapabilities("review")).toEqual({
      canCompose: false,
      canNavigate: true,
      canInvokeMutatingActions: false,
    });
  });

  it("coalesces repeated first-thread submissions while creation is pending", async () => {
    const globalNames = ["document", "fetch", "history", "location", "localStorage", "window"];
    const originalGlobals = new Map(
      globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
    );
    const input = { value: "Build the first thread", disabled: false };
    const button = { disabled: false };
    const toastElement = {
      textContent: "",
      classList: { add: vi.fn(), remove: vi.fn() },
    };
    let rejectRequest;
    const fetch = vi.fn(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
    const elements = new Map([
      ["#newThreadPrompt", input],
      ["#createThread", button],
      ["#toast", toastElement],
    ]);
    Object.assign(globalThis, {
      document: { querySelector: (selector) => elements.get(selector) },
      fetch,
      history: { replaceState: vi.fn() },
      location: new URL("http://127.0.0.1:43123/"),
      localStorage: { setItem: vi.fn() },
      window: { GRAPHCOMPLETE_CONFIG: null, relayerDesktop: undefined },
    });
    vi.useFakeTimers();
    try {
      const { createFirstThread } = await import("../desktop/renderer/src/threads.js?submission-guard");
      const first = createFirstThread();
      const repeated = createFirstThread();
      expect(fetch).toHaveBeenCalledOnce();
      expect(input.disabled).toBe(true);
      expect(button.disabled).toBe(true);

      rejectRequest(new Error("test request stopped"));
      await Promise.all([first, repeated]);
      expect(fetch).toHaveBeenCalledOnce();
      expect(input.disabled).toBe(false);
      expect(button.disabled).toBe(false);
      expect(toastElement.textContent).toBe("test request stopped");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      for (const [name, descriptor] of originalGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  });

  it("starts and stops the Rust product server with an isolated profile and private session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-app-server-service-"));
    const invocations = [];
    let suppliedToken = "";
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(chunk, _encoding, callback) { suppliedToken += String(chunk); callback(); } }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      killed: false,
    });
    child.kill = vi.fn((signal) => {
      child.killed = true;
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    });
    const service = new RelayerAppServerService({
      userDataDirectory: directory,
      binaryPath: "/test/bin/relayer-app-server",
      webDirectory: "/test/renderer",
      enableReadOnlySession: true,
      spawnProcess: (binary, args, options) => {
        invocations.push({ binary, args, options });
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({
          ready: true,
          origin: "http://127.0.0.1:43123",
          cookieName: "relayer_control",
        })}\n`));
        return child;
      },
    });

    try {
      const firstStart = service.start();
      const duplicateStart = service.start();
      const [session, duplicateSession] = await Promise.all([firstStart, duplicateStart]);
      expect(duplicateSession).toBe(session);
      expect(session).toMatchObject({
        origin: "http://127.0.0.1:43123",
        cookie: { name: "relayer_control" },
      });
      expect(session.cookie.value).toMatch(/^[a-f0-9]{64}$/);
      expect(session.readOnlyCookie).toMatchObject({ name: "relayer_control" });
      expect(session.readOnlyCookie.value).toMatch(/^[a-f0-9]{64}$/);
      expect(session.readOnlyCookie.value).not.toBe(session.cookie.value);
      expect(invocations).toHaveLength(1);
      expect(invocations[0].binary).toBe("/test/bin/relayer-app-server");
      expect(invocations[0].args).toEqual([
        "--data-dir", join(directory, "product-data"),
        "--web-dir", "/test/renderer",
        "--port", "0",
        "--read-only-control-token-stdin",
      ]);
      expect(suppliedToken).toBe(`${session.cookie.value}\n${session.readOnlyCookie.value}\n`);
      expect(child.stdin.writableEnded).toBe(false);
      expect(invocations[0].args).not.toContain(session.cookie.value);
      expect(invocations[0].args).not.toContain(session.readOnlyCookie.value);
      expect((await stat(join(directory, "product-data"))).mode & 0o777).toBe(0o700);
      expect(await service.start()).toBe(session);
      await service.close();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      const neverSpawned = vi.fn();
      const closedWhilePreparing = new RelayerAppServerService({
        userDataDirectory: join(directory, "closed-while-preparing"),
        binaryPath: "/test/bin/should-not-start",
        webDirectory: "/test/renderer",
        spawnProcess: neverSpawned,
      });
      const pendingStart = closedWhilePreparing.start();
      await closedWhilePreparing.close();
      await expect(pendingStart).rejects.toThrow("shutting down");
      expect(neverSpawned).not.toHaveBeenCalled();

      const failedChild = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        killed: false,
        kill: vi.fn(function kill(signal) {
          this.killed = true;
          this.signalCode = signal;
          queueMicrotask(() => this.emit("exit", null, signal));
          return true;
        }),
      });
      const unavailable = new RelayerAppServerService({
        userDataDirectory: directory,
        binaryPath: "/missing/relayer-app-server",
        webDirectory: "/test/renderer",
        spawnProcess: () => {
          queueMicrotask(() => failedChild.emit("error", new Error("spawn ENOENT")));
          return failedChild;
        },
      });
      await expect(unavailable.start()).rejects.toThrow("could not start: spawn ENOENT");
      expect(failedChild.kill).toHaveBeenCalledWith("SIGTERM");

      const rejectedHandshakeChild = Object.assign(new EventEmitter(), {
        stdin: {
          on: vi.fn(),
          write: vi.fn(() => { throw new Error("control pipe closed"); }),
        },
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        killed: false,
        kill: vi.fn(function kill(signal) {
          this.killed = true;
          this.signalCode = signal;
          queueMicrotask(() => this.emit("exit", null, signal));
          return true;
        }),
      });
      const rejectedHandshake = new RelayerAppServerService({
        userDataDirectory: directory,
        binaryPath: "/test/bin/rejected-handshake",
        webDirectory: "/test/renderer",
        spawnProcess: () => rejectedHandshakeChild,
      });
      await expect(rejectedHandshake.start()).rejects.toThrow("control pipe closed");
      expect(rejectedHandshakeChild.kill).toHaveBeenCalledWith("SIGTERM");

      const remoteChild = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        killed: false,
        kill: vi.fn(function kill(signal) {
          this.killed = true;
          this.signalCode = signal;
          queueMicrotask(() => this.emit("exit", null, signal));
          return true;
        }),
      });
      const untrusted = new RelayerAppServerService({
        userDataDirectory: directory,
        binaryPath: "/test/bin/untrusted-server",
        webDirectory: "/test/renderer",
        spawnProcess: () => {
          queueMicrotask(() => remoteChild.stdout.write(`${JSON.stringify({
            ready: true,
            origin: "https://example.test",
            cookieName: "relayer_control",
          })}\n`));
          return remoteChild;
        },
      });
      await expect(untrusted.start()).rejects.toThrow("must use an authenticated 127.0.0.1 origin");
      expect(remoteChild.kill).toHaveBeenCalledWith("SIGTERM");

      const stubbornChild = Object.assign(new EventEmitter(), {
        stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
      });
      stubbornChild.kill = vi.fn((signal) => {
        if (signal === "SIGKILL") {
          stubbornChild.signalCode = signal;
          queueMicrotask(() => stubbornChild.emit("exit", null, signal));
        }
        return true;
      });
      const timedOut = new RelayerAppServerService({
        userDataDirectory: directory,
        binaryPath: "/test/bin/stubborn-server",
        webDirectory: "/test/renderer",
        startupTimeoutMs: 5,
        shutdownTimeoutMs: 5,
        spawnProcess: () => stubbornChild,
      });
      await expect(timedOut.start()).rejects.toThrow("did not become ready in time");
      expect(stubbornChild.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);

      const unexpectedStops = [];
      const crashingChild = Object.assign(new EventEmitter(), {
        stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        killed: false,
        kill: vi.fn(),
      });
      const crashing = new RelayerAppServerService({
        userDataDirectory: directory,
        binaryPath: "/test/bin/crashing-server",
        webDirectory: "/test/renderer",
        onUnexpectedStop: (event) => unexpectedStops.push(event),
        spawnProcess: () => {
          queueMicrotask(() => crashingChild.stdout.write(`${JSON.stringify({
            ready: true,
            origin: "http://127.0.0.1:43124",
            cookieName: "relayer_control",
          })}\n`));
          return crashingChild;
        },
      });
      await crashing.start();
      crashingChild.exitCode = 2;
      crashingChild.emit("exit", 2, null);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unexpectedStops).toEqual([{ code: 2, signal: null }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps graph authority off argv and reports a graph server that stops after readiness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-runtime-service-"));
    let suppliedToken = "";
    const unexpectedStops = [];
    const invocations = [];
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(chunk, _encoding, callback) { suppliedToken += String(chunk); callback(); } }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    });
    const service = new GraphCompleteRuntimeService({
      userDataDirectory: directory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [fileURLToPath(new URL("../harnesses/codex-basic.yaml", import.meta.url))],
      onUnexpectedStop: (event) => unexpectedStops.push(event),
      spawnProcess: (binary, args, options) => {
        invocations.push({ binary, args, options });
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ ready: true, url: "http://127.0.0.1:43125" })}\n`));
        return child;
      },
    });

    try {
      const session = await service.start();
      expect(session.controlToken).toMatch(/^[a-f0-9]{64}$/);
      expect(suppliedToken).toBe(`${session.controlToken}\n`);
      expect(invocations[0].args).not.toContain("--control-token");
      expect(invocations[0].args).not.toContain(session.controlToken);
      expect(invocations[0].options.stdio).toEqual(["pipe", "pipe", "pipe"]);

      child.exitCode = 9;
      child.emit("exit", 9, null);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unexpectedStops).toEqual([{ code: 9, signal: null }]);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("covers the provider authorization lifecycle and its retryable edge cases in one scenario", async () => {
    const methods = [];
    const accountEvents = [];
    let loginNumber = 0;
    let account = null;
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill: vi.fn() });
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(String(chunk));
      methods.push(request.method);
      if (request.method === "never-respond") { callback(); return; }
      const result = request.method === "account/login/start"
        ? { loginId: `login-${++loginNumber}`, authUrl: `https://example.test/login-${loginNumber}` }
        : request.method === "account/login/cancel" ? { status: "canceled" }
          : request.method === "account/read" ? { account }
            : {};
      if (request.id !== undefined) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
      callback();
    } });
    const client = new CodexCredentialAdapter({
      environment: { RELAYER_CODEX_BINARY: "/usr/bin/true", PATH: "" },
      spawnProcess: () => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
      onAccountChanged: (event) => accountEvents.push(event),
    });

    expect(client).toBeInstanceOf(CredentialAdapter);
    expect(client.providerId).toBe("codex");

    expect(await client.account()).toEqual({ status: "disconnected", account: null });

    const initial = client.login();
    const replacement = client.login();

    expect((await initial).loginId).toBe("login-1");
    expect((await replacement).loginId).toBe("login-2");
    expect(methods).toEqual([
      "initialize", "initialized", "account/read", "account/login/start",
      "account/login/cancel", "account/login/start",
    ]);

    child.stdout.write(`${JSON.stringify({ method: "account/login/completed", params: { loginId: "login-1" } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(accountEvents).toEqual([]);
    expect((await client.login()).loginId).toBe("login-3");
    expect(methods.slice(-2)).toEqual(["account/login/cancel", "account/login/start"]);

    account = { email: "person@example.test", planType: "test" };
    child.stdout.write(`${JSON.stringify({ method: "account/login/completed", params: { loginId: "login-3" } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(accountEvents.at(-1)).toMatchObject({ status: "changed" });
    expect(await client.account()).toEqual({ status: "connected", account });

    await expect(client.request("never-respond", {}, 5)).rejects.toThrow("Codex request timed out");
    const interrupted = client.request("never-respond", {}, 1_000);
    child.emit("exit", 1, null);
    await expect(interrupted).rejects.toThrow("Codex app-server stopped");
    expect(accountEvents.at(-1)).toMatchObject({ status: "unavailable" });

    let failedStarts = 0;
    const failingClient = new CodexCredentialAdapter({
      environment: { RELAYER_CODEX_BINARY: "/usr/bin/true", PATH: "" },
      spawnProcess: () => {
        failedStarts += 1;
        const failedChild = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          killed: false,
        });
        failedChild.kill = vi.fn((signal) => {
          failedChild.killed = true;
          failedChild.signalCode = signal;
          queueMicrotask(() => failedChild.emit("exit", null, signal));
          return true;
        });
        failedChild.stdin = new Writable({ write(chunk, _encoding, callback) {
          const request = JSON.parse(String(chunk));
          if (request.id !== undefined) {
            queueMicrotask(() => failedChild.stdout.write(`${JSON.stringify({
              id: request.id,
              error: { message: "initialize failed" },
            })}\n`));
          }
          callback();
        } });
        queueMicrotask(() => failedChild.emit("spawn"));
        return failedChild;
      },
    });
    expect(await failingClient.account()).toMatchObject({ status: "unavailable", error: "initialize failed" });
    expect(await failingClient.account()).toMatchObject({ status: "unavailable", error: "initialize failed" });
    expect(failedStarts).toBe(2);

    const stubbornCodex = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
    });
    stubbornCodex.stdin = new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(String(chunk));
      if (request.id !== undefined) {
        const result = request.method === "account/read" ? { account: null } : {};
        queueMicrotask(() => stubbornCodex.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
      }
      callback();
    } });
    stubbornCodex.kill = vi.fn((signal) => {
      if (signal === "SIGKILL") {
        stubbornCodex.signalCode = signal;
        queueMicrotask(() => stubbornCodex.emit("exit", null, signal));
      }
      return true;
    });
    const closingClient = new CodexCredentialAdapter({
      environment: { RELAYER_CODEX_BINARY: "/usr/bin/true", PATH: "" },
      shutdownTimeoutMs: 5,
      spawnProcess: () => {
        queueMicrotask(() => stubbornCodex.emit("spawn"));
        return stubbornCodex;
      },
    });
    expect(await closingClient.account()).toMatchObject({ status: "disconnected" });
    await closingClient.close();
    expect(stubbornCodex.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);

    const neverSpawned = vi.fn();
    const closedWhileDiscovering = new CodexCredentialAdapter({
      environment: { RELAYER_CODEX_BINARY: "/usr/bin/true", PATH: "" },
      spawnProcess: neverSpawned,
    });
    const pendingAccount = closedWhileDiscovering.account();
    await closedWhileDiscovering.close();
    await expect(pendingAccount).resolves.toMatchObject({
      status: "unavailable",
      error: "Codex app-server is shutting down.",
    });
    expect(neverSpawned).not.toHaveBeenCalled();

    const spawnErrorChild = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
    });
    spawnErrorChild.kill = vi.fn((signal) => {
      spawnErrorChild.signalCode = signal;
      queueMicrotask(() => spawnErrorChild.emit("close", null, signal));
      return true;
    });
    const spawnFailure = new CodexCredentialAdapter({
      environment: { RELAYER_CODEX_BINARY: "/usr/bin/true", PATH: "" },
      spawnProcess: () => {
        queueMicrotask(() => spawnErrorChild.emit("error", new Error("spawn EACCES")));
        return spawnErrorChild;
      },
    });
    await expect(spawnFailure.account()).resolves.toMatchObject({
      status: "unavailable",
      error: "spawn EACCES",
    });
    expect(spawnErrorChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("drives the packaged update lifecycle through one state service", async () => {
    expect(resolveUpdateChannel(undefined)).toBe("stable");
    expect(resolveUpdateChannel("stable")).toBe("stable");
    expect(resolveUpdateChannel("preview")).toBe("preview");
    expect(resolveUpdateChannel("invalid")).toBe("stable");
    expect(packagedDesktopReleaseMetadata({
      relayerArtifactMode: "release",
      relayerUpdateChannel: "preview",
      relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URL,
    })).toEqual({ channel: "preview", updateBaseUrl: DESKTOP_UPDATE_BASE_URL });
    expect(packagedDesktopReleaseMetadata({
      relayerArtifactMode: "release",
      relayerUpdateChannel: "stable",
      relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URL,
    })).toEqual({ channel: "stable", updateBaseUrl: DESKTOP_UPDATE_BASE_URL });
    for (const metadata of [
      { relayerArtifactMode: "development", relayerUpdateChannel: "preview", relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URL },
      { relayerArtifactMode: "release", relayerUpdateChannel: "beta", relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URL },
      { relayerArtifactMode: "release", relayerUpdateChannel: "preview", relayerUpdateBaseUrl: "https://example.test" },
    ]) {
      expect(packagedDesktopReleaseMetadata(metadata)).toBeNull();
    }

    const autoUpdater = Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      setFeedURL: vi.fn(),
      quitAndInstall: vi.fn(),
    });
    let selectedProviderChannel = null;
    Object.defineProperty(autoUpdater, "channel", {
      configurable: true,
      get: () => selectedProviderChannel,
      set(value) {
        selectedProviderChannel = value;
        // Match electron-updater: choosing a channel opts into downgrades.
        autoUpdater.allowDowngrade = true;
      },
    });
    const states = [];
    const updater = createDesktopUpdater({
      autoUpdater,
      app: { isPackaged: true, getVersion: () => "0.1.0" },
      updateBaseUrl: "https://updates.example.test/relayer",
      emit: (state) => states.push(state),
    });
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
    await expect(updater.check()).resolves.toMatchObject({ phase: "failed", error: "offline" });
    expect(autoUpdater.allowDowngrade).toBe(false);
    expect(updater.setChannel("preview")).toMatchObject({ phase: "idle", channel: "preview" });
    expect(autoUpdater.channel).toBe("beta");
    expect(autoUpdater.allowDowngrade).toBe(false);
    autoUpdater.emit("checking-for-update");
    expect(() => updater.setChannel("stable")).toThrow("Finish the current update");
    autoUpdater.emit("update-available", { version: "0.1.1" });
    expect(() => updater.setChannel("stable")).toThrow("Finish the current update");
    await updater.download();
    autoUpdater.emit("download-progress", { percent: 29.4 });
    autoUpdater.emit("download-progress", { percent: 100 });
    autoUpdater.emit("download-progress", { percent: 16.2 });
    autoUpdater.emit("download-progress", { percent: 92 });
    autoUpdater.emit("update-downloaded", { version: "0.1.1" });
    autoUpdater.emit("download-progress", { percent: 3 });
    updater.install();

    expect(states.filter((state) => state.phase === "downloading").map((state) => state.percent)).toEqual([29, 99, 99, 99]);
    expect(states.at(-1)).toMatchObject({ phase: "ready", percent: 100 });
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({ channel: "beta" }));
    expect(autoUpdater.allowDowngrade).toBe(false);
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("enforces one signed desktop release contract and seals its candidate artifacts", async () => {
    const releaseWorkflow = await readFile(new URL("../.github/workflows/desktop-signed-preview.yml", import.meta.url), "utf8");
    const stableWorkflow = await readFile(new URL("../.github/workflows/desktop-promote-stable.yml", import.meta.url), "utf8");
    expect(releaseWorkflow).toContain('if: startsWith(github.ref, \'refs/tags/desktop-v\')');
    expect(releaseWorkflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main');
    expect(releaseWorkflow).toContain("environment:\n      name: desktop-update-preview");
    expect(stableWorkflow).toContain("workflow_dispatch:");
    expect(stableWorkflow).toContain("name: desktop-update-stable-promotion");
    expect(stableWorkflow).toContain("DESKTOP_UPDATE_STABLE_ROLE_ARN");
    expect(stableWorkflow).toContain("--canary-evidence");
    const releaseEnvironment = {
      RELAYER_DESKTOP_RELEASE: "1",
      RELAYER_DESKTOP_CHANNEL: "preview",
      RELAYER_DESKTOP_UPDATE_BASE_URL: DESKTOP_RELEASE.updateBaseUrl,
      RELAYER_DESKTOP_SIGN_IDENTITY: "Developer ID Application: VISHAL TANDALE (NZ253AL7U6)",
      APPLE_API_KEY: "/tmp/AuthKey_TEST.p8",
      APPLE_API_KEY_ID: "TESTKEY",
      APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
    };
    const sourceCommit = "a".repeat(40);
    const contract = resolveDesktopReleaseContract({
      environment: releaseEnvironment,
      version: "0.2.0",
      sourceCommit,
    });
    expect(contract).toMatchObject({
      release: true,
      appId: "ai.relayer.desktop",
      version: "0.2.0",
      architecture: "arm64",
      minimumMacOSVersion: "13.0.0",
      channelName: "preview",
      providerChannel: "beta",
      manifestName: "beta-mac.yml",
      sourceCommit,
      appleTeamId: "NZ253AL7U6",
    });
    const builder = createDesktopBuilderConfig(contract);
    expect(builder).toMatchObject({
      appId: "ai.relayer.desktop",
      productName: "Relayer",
      forceCodeSigning: true,
      afterPack: "desktop/packaging/verify-bundled-app-server.mjs",
      afterSign: "desktop/release/verify-macos-app.mjs",
      mac: {
        identity: "VISHAL TANDALE (NZ253AL7U6)",
        minimumSystemVersion: "13.0.0",
        hardenedRuntime: true,
        notarize: true,
      },
      publish: [{ provider: "generic", url: DESKTOP_RELEASE.updateBaseUrl, channel: "beta" }],
    });
    // Electron 43's Squirrel.Mac implementation rejects valid numeric versions when
    // this native flag is enabled. Version monotonicity remains enforced by the
    // application updater above and by Preview publication.
    expect(builder.mac.extendInfo).toBeUndefined();

    const development = resolveDesktopReleaseContract({ environment: {}, version: "0.2.0" });
    expect(development).toMatchObject({
      release: false,
      appId: "ai.relayer.desktop.development",
      productName: "Relayer Dev",
      channelName: "development",
      signingMode: "unsigned",
    });

    const invalidCases = [
      [{ ...releaseEnvironment, RELAYER_DESKTOP_CHANNEL: "nightly" }, "0.2.0", sourceCommit, "stable or preview"],
      [releaseEnvironment, "0.1.0", sourceCommit, "0.2.0 or newer"],
      [{ ...releaseEnvironment, RELAYER_DESKTOP_UPDATE_BASE_URL: "https://example.test" }, "0.2.0", sourceCommit, "must be exactly"],
      [{ ...releaseEnvironment, RELAYER_DESKTOP_SIGN_IDENTITY: "Apple Development: Example" }, "0.2.0", sourceCommit, "Developer ID Application"],
      [{ ...releaseEnvironment, APPLE_API_KEY: "" }, "0.2.0", sourceCommit, "notarytool"],
      [{ ...releaseEnvironment, CSC_LINK: "/tmp/certificate.p12" }, "0.2.0", sourceCommit, "provided together"],
      [releaseEnvironment, "0.2.0", "short", "40-character"],
    ];
    for (const [environment, version, commit, message] of invalidCases) {
      expect(() => resolveDesktopReleaseContract({ environment, version, sourceCommit: commit })).toThrow(message);
    }

    const directory = await mkdtemp(join(tmpdir(), "relayer-release-contract-"));
    try {
      const appPath = join(directory, "Relayer.app");
      const bundledBinary = join(appPath, "Contents", "Resources", "bin", "relayer-app-server");
      const bundledGraphBinary = join(appPath, "Contents", "Resources", "bin", "relayer-graph-server");
      const bundledGraphClient = join(appPath, "Contents", "Resources", "graph-client", "index.js");
      const bundledMarked = join(appPath, "Contents", "Resources", "renderer", "vendor", "marked.umd.js");
      await mkdir(join(appPath, "Contents", "Resources", "bin"), { recursive: true });
      await mkdir(join(appPath, "Contents", "Resources", "graph-client"), { recursive: true });
      await mkdir(join(appPath, "Contents", "Resources", "renderer", "vendor"), { recursive: true });
      await Promise.all([
        writeFile(bundledBinary, "binary-fixture"),
        writeFile(bundledGraphBinary, "binary-fixture"),
        writeFile(bundledGraphClient, "client-fixture"),
        writeFile(bundledMarked, "marked-fixture"),
      ]);
      const packagedRuntimeEntries = () => [
        "main/single-instance.mjs",
        "node_modules/@relayer/graph-client/dist/index.js",
        "node_modules/@relayer/harness-host/dist/index.js",
        "node_modules/@relayer/eval-runner/dist/index.js",
      ];
      await expect(verifyBundledAppServer(appPath, {
        execute: async () => ({ stdout: "arm64\n", stderr: "" }),
        listPackageEntries: packagedRuntimeEntries,
      })).resolves.toEqual({ binaryPath: bundledBinary, architecture: "arm64" });
      await expect(verifyBundledAppServer(appPath, {
        execute: async () => ({ stdout: "x86_64\n", stderr: "" }),
        listPackageEntries: packagedRuntimeEntries,
      })).rejects.toThrow("must contain only arm64");
      await expect(verifyBundledAppServer(appPath, {
        execute: async () => ({ stdout: "arm64\n", stderr: "" }),
        listPackageEntries: () => packagedRuntimeEntries().filter((entry) => entry !== "node_modules/@relayer/graph-client/dist/index.js"),
      })).rejects.toThrow("missing node_modules/@relayer/graph-client/dist/index.js");

      const names = desktopReleaseArtifactNames(contract);
      const dmg = Buffer.from("signed-notarized-dmg-fixture");
      const originalZip = Buffer.from("electron-builder-zip-fixture");
      const finalZip = Buffer.from("one-app-final-update-zip-fixture");
      const originalZipSha512 = createHash("sha512").update(originalZip).digest("base64");
      const dmgSha512 = createHash("sha512").update(dmg).digest("base64");
      await Promise.all([
        writeFile(join(directory, names.dmg), dmg),
        writeFile(join(directory, names.zip), originalZip),
        writeFile(join(directory, names.manifest), [
          `version: ${contract.version}`,
          "files:",
          `  - url: ${names.zip}`,
          `    sha512: ${originalZipSha512}`,
          `    size: ${originalZip.length}`,
          `  - url: ${names.dmg}`,
          `    sha512: ${dmgSha512}`,
          `    size: ${dmg.length}`,
          `path: ${names.zip}`,
          `sha512: ${originalZipSha512}`,
          "",
        ].join("\n")),
      ]);
      await finalizeDesktopUpdateArtifact({
        appPath,
        contract,
        distRoot: directory,
        execute: async (_command, args) => {
          await writeFile(args.at(-1), finalZip);
          return { stdout: "", stderr: "" };
        },
        createBlockMap: async ({ outputPath }) => writeFile(outputPath, "blockmap-fixture"),
      });
      const written = await writeDesktopReleaseEvidence({ distRoot: directory, contract });
      expect(written.receipt).toMatchObject({
        version: "0.2.0",
        channel: "preview",
        sourceCommit,
        appleTeamId: "NZ253AL7U6",
      });
      expect(written.zip.sha512).toBe(createHash("sha512").update(finalZip).digest("base64"));
      await expect(verifyDesktopReleaseEvidence({ distRoot: directory, contract })).resolves.toMatchObject({
        names: { receipt: names.receipt, checksums: names.checksums },
      });
      await writeFile(join(directory, names.checksums), "tampered\n");
      await expect(verifyDesktopReleaseEvidence({ distRoot: directory, contract })).rejects.toThrow("checksum manifest");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("gates Preview publication on one immutable candidate and one monotonic pointer", () => {
    const version = "0.2.0";
    const sourceCommit = "b".repeat(40);
    const evidenceFor = (name, content) => ({
      name,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      sha512: createHash("sha512").update(content).digest("base64"),
    });
    const prefix = `Relayer-${version}-mac-arm64`;
    const dmg = evidenceFor(`${prefix}.dmg`, "notarized-dmg");
    const zip = evidenceFor(`${prefix}.zip`, "notarized-update-zip");
    const dmgBlockmap = evidenceFor(`${dmg.name}.blockmap`, "dmg-blockmap");
    const zipBlockmap = evidenceFor(`${zip.name}.blockmap`, "zip-blockmap");
    const releaseReceipt = {
      schemaVersion: 1,
      product: "Relayer",
      appId: DESKTOP_RELEASE.productionAppId,
      version,
      architecture: DESKTOP_RELEASE.architecture,
      minimumMacOSVersion: DESKTOP_RELEASE.minimumMacOSVersion,
      channel: "preview",
      manifest: "beta-mac.yml",
      updateBaseUrl: DESKTOP_RELEASE.updateBaseUrl,
      sourceCommit,
      appleTeamId: DESKTOP_RELEASE.appleTeamId,
      artifacts: [dmg, zip],
    };
    const checksumText = `${dmg.sha256}  ${dmg.name}\n${zip.sha256}  ${zip.name}\n`;
    const evidence = [
      dmg,
      dmgBlockmap,
      zip,
      zipBlockmap,
      evidenceFor(`${prefix}-SHA256SUMS.txt`, checksumText),
      evidenceFor(`${prefix}-RELEASE.json`, JSON.stringify(releaseReceipt)),
    ];

    expect(validatePreviewPublicationProvenance({
      GITHUB_SHA: sourceCommit,
      GITHUB_REF_NAME: `desktop-v${version}`,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    }, version)).toEqual({ sourceCommit, workflowRunId: "123", workflowRunAttempt: "2" });
    expect(() => validatePreviewPublicationProvenance({
      GITHUB_SHA: sourceCommit,
      GITHUB_REF_NAME: "desktop-v0.2.1",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    }, version)).toThrow(`desktop-v${version}`);

    expect(() => validatePreviewCandidate({
      releaseReceipt,
      checksumText,
      version,
      sourceCommit,
      artifactEvidence: evidence,
    })).not.toThrow();
    expect(() => validatePreviewCandidate({
      releaseReceipt,
      checksumText: checksumText.replace(dmg.sha256, "0".repeat(64)),
      version,
      sourceCommit,
      artifactEvidence: evidence,
    })).toThrow("checksum manifest");

    const manifestText = [
      `version: ${version}`,
      "files:",
      `  - url: ${zip.name}`,
      `    sha512: ${zip.sha512}`,
      `    size: ${zip.size}`,
      `    blockMapSize: ${zipBlockmap.size}`,
      `  - url: ${dmg.name}`,
      `    sha512: ${dmg.sha512}`,
      `    size: ${dmg.size}`,
      `    blockMapSize: ${dmgBlockmap.size}`,
      `path: ${zip.name}`,
      `sha512: ${zip.sha512}`,
      "",
    ].join("\n");
    const preparedManifest = preparePreviewManifest({ manifestText, version, artifactEvidence: evidence });
    expect(preparedManifest).toContain(`releases/${version}/${zip.name}`);
    expect(preparedManifest).toContain(`releases/${version}/${dmg.name}`);
    expect(createPreviewPublicationPlan({ version, evidence })).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: zip.name, key: `desktop/macos/arm64/releases/${version}/${zip.name}` }),
      expect.objectContaining({ name: dmg.name, key: `desktop/macos/arm64/releases/${version}/${dmg.name}` }),
    ]));
    expect(buildPutObjectArgs({
      bucket: "updates",
      key: `desktop/macos/arm64/releases/${version}/${zip.name}`,
      filePath: `/tmp/${zip.name}`,
      evidence: zip,
      ifNoneMatch: true,
      cacheControl: "immutable",
      sourceCommit,
    })).toEqual(expect.arrayContaining(["--if-none-match", "*", "--checksum-sha256"]));

    expect(classifyPreviewPointer({ version, manifestText: preparedManifest })).toEqual({ recovery: false });
    expect(classifyPreviewPointer({
      currentVersion: version,
      currentContent: preparedManifest,
      version,
      manifestText: preparedManifest,
    })).toEqual({ recovery: true });
    expect(() => classifyPreviewPointer({
      currentVersion: version,
      currentContent: "different bytes",
      version,
      manifestText: preparedManifest,
    })).toThrow("cannot be replaced");
    expect(() => classifyPreviewPointer({
      currentVersion: "0.2.1",
      currentContent: "newer",
      version,
      manifestText: preparedManifest,
    })).toThrow("must be newer");
    expect(validateStablePromotionProvenance({
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: sourceCommit,
      GITHUB_RUN_ID: "456",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_ACTOR: "release-operator",
      STABLE_PROMOTION_CONFIRMATION: `promote-${version}`,
    }, version)).toEqual({
      workflowCommit: sourceCommit,
      workflowRunId: "456",
      workflowRunAttempt: "1",
      actor: "release-operator",
    });
    expect(() => validateStablePromotionProvenance({
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: sourceCommit,
      GITHUB_RUN_ID: "456",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_ACTOR: "release-operator",
      STABLE_PROMOTION_CONFIRMATION: "promote-wrong-version",
    }, version)).toThrow(`promote-${version}`);
    expect(classifyStablePointer({ version, manifestText: preparedManifest })).toEqual({ recovery: false });
    expect(classifyStablePointer({
      currentVersion: version,
      currentContent: preparedManifest,
      version,
      manifestText: preparedManifest,
    })).toEqual({ recovery: true });
    expect(() => classifyStablePointer({
      currentVersion: version,
      currentContent: "different bytes",
      version,
      manifestText: preparedManifest,
    })).toThrow("cannot be replaced");
  });

  it("publishes one Preview candidate atomically and recovers without mutating live bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-preview-publication-"));
    try {
      const { version } = JSON.parse(await readFile(new URL("../desktop/package.json", import.meta.url), "utf8"));
      const sourceCommit = "c".repeat(40);
      const prefix = `Relayer-${version}-mac-arm64`;
      const contents = new Map([
        [`${prefix}.dmg`, Buffer.from("signed-notarized-dmg")],
        [`${prefix}.dmg.blockmap`, Buffer.from("dmg-blockmap")],
        [`${prefix}.zip`, Buffer.from("signed-notarized-update-zip")],
        [`${prefix}.zip.blockmap`, Buffer.from("zip-blockmap")],
      ]);
      const evidenceFor = (name) => {
        const content = contents.get(name);
        return {
          name,
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
          sha512: createHash("sha512").update(content).digest("base64"),
        };
      };
      const dmg = evidenceFor(`${prefix}.dmg`);
      const zip = evidenceFor(`${prefix}.zip`);
      const dmgBlockmap = evidenceFor(`${prefix}.dmg.blockmap`);
      const zipBlockmap = evidenceFor(`${prefix}.zip.blockmap`);
      const checksumText = `${dmg.sha256}  ${dmg.name}\n${zip.sha256}  ${zip.name}\n`;
      const releaseReceipt = {
        schemaVersion: 1,
        product: DESKTOP_RELEASE.productName,
        appId: DESKTOP_RELEASE.productionAppId,
        version,
        architecture: DESKTOP_RELEASE.architecture,
        minimumMacOSVersion: DESKTOP_RELEASE.minimumMacOSVersion,
        channel: "preview",
        manifest: "beta-mac.yml",
        updateBaseUrl: DESKTOP_RELEASE.updateBaseUrl,
        sourceCommit,
        appleTeamId: DESKTOP_RELEASE.appleTeamId,
        artifacts: [dmg, zip],
      };
      contents.set(`${prefix}-SHA256SUMS.txt`, Buffer.from(checksumText));
      contents.set(`${prefix}-RELEASE.json`, Buffer.from(JSON.stringify(releaseReceipt)));
      await Promise.all([...contents].map(([name, content]) => writeFile(join(directory, name), content)));
      await writeFile(join(directory, "beta-mac.yml"), [
        `version: ${version}`,
        "files:",
        `  - url: ${zip.name}`,
        `    sha512: ${zip.sha512}`,
        `    size: ${zip.size}`,
        `    blockMapSize: ${zipBlockmap.size}`,
        `  - url: ${dmg.name}`,
        `    sha512: ${dmg.sha512}`,
        `    size: ${dmg.size}`,
        `    blockMapSize: ${dmgBlockmap.size}`,
        `path: ${zip.name}`,
        `sha512: ${zip.sha512}`,
        "",
      ].join("\n"));

      const objects = new Map();
      const writes = [];
      const argument = (args, name) => args[args.indexOf(name) + 1];
      const execute = async (command, args) => {
        expect(command).toBe("aws");
        const operation = args[1];
        const key = argument(args, "--key");
        if (operation === "head-object") {
          const object = objects.get(key);
          if (!object) {
            const error = new Error("Not Found");
            error.stderr = "404 Not Found";
            throw error;
          }
          return { stdout: JSON.stringify({
            ContentLength: object.body.length,
            Metadata: object.metadata,
            ChecksumSHA256: object.checksumSha256,
            ETag: object.etag,
          }) };
        }
        if (operation === "get-object") {
          const object = objects.get(key);
          if (!object) throw new Error(`missing object ${key}`);
          await writeFile(args.at(-1), object.body);
          return { stdout: "{}" };
        }
        if (operation !== "put-object") throw new Error(`unexpected AWS operation ${operation}`);
        const existing = objects.get(key);
        if (args.includes("--if-none-match") && existing) throw new Error("PreconditionFailed");
        if (args.includes("--if-match") && existing?.etag !== argument(args, "--if-match")) {
          throw new Error("PreconditionFailed");
        }
        const body = await readFile(argument(args, "--body"));
        const metadata = Object.fromEntries(argument(args, "--metadata").split(",").map((item) => item.split("=")));
        const object = {
          body,
          metadata,
          checksumSha256: argument(args, "--checksum-sha256"),
          etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`,
        };
        objects.set(key, object);
        writes.push(key);
        return { stdout: JSON.stringify({ ETag: object.etag }) };
      };
      let failPublicArtifact = true;
      const fetchImpl = async (url) => {
        const parsed = new URL(url);
        const key = parsed.pathname.replace(/^\//, "");
        if (failPublicArtifact && key.endsWith(`/${zip.name}`)) {
          return new Response("temporarily unavailable", { status: 503 });
        }
        const object = objects.get(key);
        return object ? new Response(object.body, { status: 200 }) : new Response("missing", { status: 404 });
      };
      const environment = {
        GITHUB_SHA: sourceCommit,
        GITHUB_REF_NAME: `desktop-v${version}`,
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
      };
      const pointerKey = "desktop/macos/arm64/beta-mac.yml";
      const historyKey = `private/history/beta/${version}/beta-mac.yml`;
      const receiptKey = `private/receipts/preview/${version}.json`;

      await expect(publishDesktopPreview({
        bucket: "updates",
        distRoot: directory,
        environment,
        execute,
        fetchImpl,
      })).rejects.toThrow("Public update object is unavailable");
      expect(objects.has(pointerKey)).toBe(false);
      expect(objects.has(receiptKey)).toBe(false);

      failPublicArtifact = false;
      await expect(publishDesktopPreview({
        bucket: "updates",
        distRoot: directory,
        environment,
        execute,
        fetchImpl,
      })).resolves.toMatchObject({ receipt: { version, sourceCommit } });
      const releaseWriteIndexes = writes
        .map((key, index) => key.startsWith(`desktop/macos/arm64/releases/${version}/`) ? index : -1)
        .filter((index) => index >= 0);
      expect(writes.indexOf(pointerKey)).toBeGreaterThan(Math.max(...releaseWriteIndexes));
      expect(writes.indexOf(pointerKey)).toBeGreaterThan(writes.indexOf(historyKey));
      expect(writes.indexOf(receiptKey)).toBeGreaterThan(writes.indexOf(pointerKey));

      const writesAfterSuccess = [...writes];
      await expect(publishDesktopPreview({
        bucket: "updates",
        distRoot: directory,
        environment: { ...environment, GITHUB_RUN_ATTEMPT: "2" },
        execute,
        fetchImpl,
      })).resolves.toMatchObject({ receipt: { workflowRunAttempt: "1" } });
      expect(writes).toEqual(writesAfterSuccess);

      const installedScreenshot = Buffer.from("signed-app-installed-screenshot");
      const installedScreenshotName = "installed.png";
      await writeFile(join(directory, installedScreenshotName), installedScreenshot);
      const canaryEvidenceName = "signed-preview-canary.json";
      await writeFile(join(directory, canaryEvidenceName), JSON.stringify({
        schemaVersion: 1,
        capturedAt: "2026-08-18",
        environment: { host: "test-mac", architecture: "arm64", macOS: "15.6" },
        seed: { version: "0.2.2" },
        target: {
          version,
          sourceCommit,
          workflowRunId: "123",
          dmgSha256: dmg.sha256,
          zipSha256: zip.sha256,
        },
        productFlow: [
          { phase: "available", version: "0.2.2", availableVersion: version, channel: "preview", error: null },
          { phase: "installed-and-relaunched", version, channel: "preview", error: null },
        ],
        postUpdate: {
          installedVersion: version,
          running: true,
          codeSignatureVerified: true,
          channel: "preview",
          updateStatus: "idle",
        },
        screenshots: {
          installed: {
            file: installedScreenshotName,
            sha256: createHash("sha256").update(installedScreenshot).digest("hex"),
          },
        },
      }));
      const stableEnvironment = {
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: "d".repeat(40),
        GITHUB_RUN_ID: "456",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_ACTOR: "release-operator",
        STABLE_PROMOTION_CONFIRMATION: `promote-${version}`,
      };
      await expect(promoteDesktopStable({
        bucket: "updates",
        version,
        canaryEvidencePath: canaryEvidenceName,
        repositoryRoot: directory,
        environment: stableEnvironment,
        execute,
        fetchImpl,
      })).resolves.toMatchObject({
        receipt: {
          channel: "stable",
          version,
          sourceCommit,
          previewReceipt: { key: receiptKey },
          canaryEvidence: { repositoryPath: canaryEvidenceName },
        },
      });
      const stablePointerKey = "desktop/macos/arm64/latest-mac.yml";
      const stableHistoryKey = `private/history/latest/${version}/latest-mac.yml`;
      const stableReceiptKey = `private/receipts/stable/${version}.json`;
      expect(objects.get(stablePointerKey).body).toEqual(objects.get(pointerKey).body);
      expect(writes.indexOf(stablePointerKey)).toBeGreaterThan(writes.indexOf(stableHistoryKey));
      expect(writes.indexOf(stableReceiptKey)).toBeGreaterThan(writes.indexOf(stablePointerKey));

      const writesAfterPromotion = [...writes];
      await expect(promoteDesktopStable({
        bucket: "updates",
        version,
        canaryEvidencePath: canaryEvidenceName,
        repositoryRoot: directory,
        environment: { ...stableEnvironment, GITHUB_RUN_ID: "457", GITHUB_RUN_ATTEMPT: "2" },
        execute,
        fetchImpl,
      })).resolves.toMatchObject({ receipt: { promotion: { workflowRunId: "456" } } });
      expect(writes).toEqual(writesAfterPromotion);

      objects.get(`desktop/macos/arm64/releases/${version}/${zip.name}`).metadata.sha256 = "0".repeat(64);
      await expect(publishDesktopPreview({
        bucket: "updates",
        distRoot: directory,
        environment: { ...environment, GITHUB_RUN_ATTEMPT: "3" },
        execute,
        fetchImpl,
      })).rejects.toThrow("already exists with different evidence");
      expect(writes).toEqual(writesAfterPromotion);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps settings writes atomic and local thread graph state scoped to its owning thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-desktop-test-"));
    try {
      const settings = createSettingsStore(directory);
      await settings.write({ appearance: "light", updateChannel: "preview" });
      expect(await settings.read()).toEqual({ appearance: "light", updateChannel: "preview" });
      expect(await readdir(directory)).toEqual(["desktop-settings.json"]);

      const state = { projects: [], threads: [], nodes: [], edges: [], status: "idle" };
      let nextId = 0;
      const createId = () => `id-${++nextId}`;
      const first = addLocalThread(state, {
        selectedScope: { kind: "standalone" },
        prompt: "first prompt",
        title: "First",
        createId,
      });
      const second = addLocalThread(state, {
        selectedScope: { kind: "standalone" },
        prompt: "second prompt",
        title: "Second",
        createId,
      });
      expect(interactionForThread(state, first).summary).toBe("first prompt");
      expect(interactionForThread(state, second).summary).toBe("second prompt");

      state.nodes.push({ id: "response", metadata: { relayer: { responseLayerOwnerNodeId: first.rootNodeId } } });
      state.status = "submitted";
      expect(responseNodesForThread(state, first)).toEqual([]);
      state.status = "accepted";
      expect(responseNodesForThread(state, first).map((node) => node.id)).toEqual(["response"]);
      expect(responseNodesForThread(state, second)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses one product workspace implementation for interactive and eval-review contexts", async () => {
    const productAdapter = await readFile(new URL("../desktop/renderer/src/graph.js", import.meta.url), "utf8");
    const workspace = await readFile(new URL("../desktop/renderer/src/product-workspace/workspace.js", import.meta.url), "utf8");
    const productShell = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");

    expect(productAdapter).toContain("createProductWorkspace");
    expect(productAdapter).not.toContain("function physicsStep");
    expect(workspace).toContain("function physicsStep");
    expect(productShell).toContain('<section class="thread-view hidden" id="threadView"></section>');
    expect(productShell).not.toContain('id="graphStage"');
    expect(productWorkspaceMarkup()).toContain('id="graphStage"');
    expect(productWorkspaceMarkup()).toContain('id="closeInspector"');
    expect(workspaceModeCapabilities("interactive")).toEqual({
      canNavigate: true,
      canCompose: true,
      canInvokeMutatingActions: true,
    });
    expect(workspaceModeCapabilities("review")).toEqual({
      canNavigate: true,
      canCompose: false,
      canInvokeMutatingActions: false,
    });
    expect(() => workspaceModeCapabilities("comparison")).toThrow("Unknown product workspace mode");
  });

  it("anchors graph edges at icon boundaries and preserves dragged node positions", async () => {
    expect(graphEdgeSegment({ x: 10, y: 20 }, { x: 110, y: 20 }, 24)).toEqual({
      x1: 34,
      y1: 20,
      x2: 86,
      y2: 20,
    });

    const workspace = await readFile(new URL("../desktop/renderer/src/product-workspace/workspace.js", import.meta.url), "utf8");
    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(workspace).toContain("dragging.node.pinned = true");
    expect(workspace).toContain("node.pinned || dragging?.node.id === node.id");
    expect(styles).toContain("flex-direction:column");
    expect(styles).toContain("width:46px;height:46px");
  });

  it("renders node details as restricted Markdown without exposing internal kinds on graph cards", async () => {
    const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
    const workspace = await readFile(new URL("../desktop/renderer/src/product-workspace/workspace.js", import.meta.url), "utf8");
    const markdown = await readFile(new URL("../desktop/renderer/src/product-workspace/markdown.js", import.meta.url), "utf8");

    expect(html).toContain('<script src="./vendor/marked.umd.js"></script>');
    expect(workspace).toContain('renderMarkdown($("#detailContent")');
    expect(workspace).not.toContain('<small>${escapeHtml(node.kind)}</small>');
    expect(markdown).toContain("ALLOWED_MARKDOWN_ELEMENTS");
    expect(markdown).toContain("DANGEROUS_MARKDOWN_ELEMENTS");
    expect(isSafeMarkdownLink("https://relayerlabs.ai/docs")).toBe(true);
    expect(isSafeMarkdownLink("http://127.0.0.1:3000/help")).toBe(true);
    expect(isSafeMarkdownLink("javascript:alert(1)")).toBe(false);
    expect(isSafeMarkdownLink("data:text/html,bad")).toBe(false);
  });
});
