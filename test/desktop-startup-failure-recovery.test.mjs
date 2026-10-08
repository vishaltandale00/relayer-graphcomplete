import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopAuthenticatedErrorReporting } from "../desktop/main/services/authenticated-error-reporting.mjs";
import { completeDesktopStartupWindow, reportDesktopStartupFailure, recoverDesktopStartupFailure } from "../desktop/main/services/startup-failure-recovery.mjs";
import { trackStartupErrorReport } from "../desktop/main/services/startup-report-status.mjs";
import { createWindowFactory } from "../desktop/main/window.mjs";

const resources = [];
afterEach(async () => { vi.useRealTimers(); for (const dispose of resources.splice(0)) await dispose(); });
const held = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function fixture({ signedIn = true, offline = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "relayer-startup-recovery-"));
  const queuePath = join(directory, "queue.json");
  const sent = [];
  const reporting = await createDesktopAuthenticatedErrorReporting({
    queuePath, encrypt: async (value) => Buffer.from(value).toString("base64"),
    decrypt: async (value) => Buffer.from(value, "base64").toString(),
    releaseIdentity: { release: "startup-test", environment: "preview", os: "windows", architecture: "x64" },
    transport: { enable: async () => {}, disable: async () => {}, send: async (event) => {
      if (offline) throw new Error("offline"); sent.push(event);
    } },
  });
  let identity = signedIn ? { generation: 1, subject: "auth0|startup-person" } : null;
  if (identity) await reporting.account.transitionIdentity(identity);
  const account = { telemetryIdentity: () => identity };
  resources.push(async () => { await reporting.close(); await rm(directory, { recursive: true, force: true }); });
  const error = new Error("ERR_FAILED (-2) loading 'http://127.0.0.1:58702/private?token=secret'");
  error.stack = "Error: private startup\n    at open (/private/person/desktop/main/window.mjs:10:3)";
  return { reporting, sent, account, queuePath, error, startupStage: "window-load",
    accountStartup: Promise.resolve(signedIn ? { status: "signed-in", subject: identity.subject } : { status: "signed-out" }),
    setIdentity: async (value) => { identity = value; await reporting.account.transitionIdentity(value); } };
}

describe("desktop startup reporting and native recovery", () => {
  it("a child exit during loadURL cannot become a successful desktop startup", async () => {
    const loading = held();
    let fatal = false;
    let window;
    const revoke = vi.fn();
    class Window extends EventEmitter {
      constructor() { super(); window = this; this.webContents = new EventEmitter();
        this.webContents.session = { cookies: { set: async () => {} } };
        this.webContents.setWindowOpenHandler = vi.fn(); this.webContents.isDestroyed = () => false;
        this.loadURL = () => loading.promise;
        this.destroy = vi.fn(() => this.emit("closed"));
      }
    }
    const createWindow = createWindowFactory({ BrowserWindow: Window, desktopDirectory: "/app", getAppearance: () => "light",
      updater: { status: () => ({ phase: "development" }) }, openExternal: vi.fn(), issueErrorReporter: () => ({ revoke }) });
    const startup = completeDesktopStartupWindow({ createWindow, productSession: {
      origin: "http://127.0.0.1:1234", cookie: { name: "control", value: "local" },
    }, hasFatalServiceFailure: () => fatal });
    const assertion = expect(startup).rejects.toThrow("local service stopped during startup");
    await new Promise(setImmediate);
    fatal = true;
    loading.resolve();
    await assertion;
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
  });


  it("report deadline revokes the real reporter so a late transport failure cannot queue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-startup-report-deadline-"));
    const queuePath = join(directory, "queue.json");
    const sending = held();
    const send = vi.fn(async () => { await sending.promise; throw new Error("offline"); });
    const reporting = await createDesktopAuthenticatedErrorReporting({ queuePath,
      encrypt: async (value) => Buffer.from(value).toString("base64"), decrypt: async (value) => Buffer.from(value, "base64").toString(),
      releaseIdentity: { release: "startup-test", environment: "preview", os: "windows", architecture: "x64" },
      transport: { enable: async () => {}, disable: async () => {}, send },
    });
    resources.push(async () => { sending.resolve(); await reporting.close(); await rm(directory, { recursive: true, force: true }); });
    await reporting.account.transitionIdentity({ generation: 1, subject: "auth0|budget" });
    vi.useFakeTimers();
    const report = reportDesktopStartupFailure({ error: new Error("load"), startupStage: "window-load", reporting,
      accountStartup: Promise.resolve({ status: "signed-in", subject: "auth0|budget" }),
      account: { telemetryIdentity: () => ({ generation: 1, subject: "auth0|budget" }) }, budgetMs: 25 });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(25);
    expect((await report).status).toBe("timeout");
    sending.resolve();
    vi.useRealTimers();
    await reporting.close();
    await expect(stat(queuePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("Retry remains bounded when service shutdown stalls", async () => {
    const calls = [];
    vi.useFakeTimers();
    const recovery = recoverDesktopStartupFailure({ error: new Error("startup"), startupStage: "initialization",
      showDialog: async () => ({ response: 0 }), shutdown: () => new Promise(() => {}), shutdownBudgetMs: 40,
      relaunch: () => calls.push("relaunch"), exit: () => calls.push("exit") });
    await vi.advanceTimersByTimeAsync(39);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await recovery;
    expect(calls).toEqual(["relaunch", "exit"]);
  });


  it("reports a caught loadURL error only after saved verification with no raw error fields", async () => {
    const f = await fixture({ signedIn: false });
    const saved = held();
    const attempt = reportDesktopStartupFailure({ ...f, accountStartup: saved.promise });
    expect(f.sent).toHaveLength(0);
    await f.setIdentity({ generation: 2, subject: "auth0|saved" });
    saved.resolve({ status: "signed-in", subject: "auth0|saved" });
    await attempt;
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ code: "electron_main.startup_failure", startupStage: "window-load", networkCode: "ERR_FAILED",
      frames: [{ module: "desktop/main/window.mjs", line: 10, column: 3 }] });
    expect(JSON.stringify(f.sent)).not.toMatch(/127\.0\.0\.1|private|person|secret|token/);
  });

  it.each(["signed-out", "uncertain"])("suppresses %s failures permanently even after later login", async (status) => {
    const f = await fixture({ signedIn: false });
    await reportDesktopStartupFailure({ ...f, accountStartup: Promise.resolve({ status }) });
    await f.setIdentity({ generation: 2, subject: "auth0|later" });
    expect(f.sent).toHaveLength(0);
    await expect(stat(f.queuePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deadline suppresses a saved identity that arrives late without a deferred queue record", async () => {
    const f = await fixture({ signedIn: false });
    const saved = held();
    vi.useFakeTimers();
    const report = reportDesktopStartupFailure({ ...f, accountStartup: saved.promise, budgetMs: 30 });
    await vi.advanceTimersByTimeAsync(30);
    expect((await report).status).toBe("timeout");
    vi.useRealTimers();
    await f.setIdentity({ generation: 2, subject: "auth0|late" });
    saved.resolve({ status: "signed-in", subject: "auth0|late" });
    await new Promise(setImmediate);
    expect(f.sent).toHaveLength(0);
    await expect(stat(f.queuePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("attributes an admitted child report through an aggregate cleanup wrapper", async () => {
    const f = await fixture();
    const child = new Error("child failure");
    const reporter = f.reporting.issueReporter({ component: "rust-graph-server", processGeneration: 1 });
    trackStartupErrorReport(child, reporter.report({ code: "rust_graph_server.startup_failure", exceptionClass: "Error", frames: [] }));
    await reportDesktopStartupFailure({ ...f, error: new AggregateError([child], "runtime cleanup failed") });
    expect(f.sent.map((event) => event.code)).toEqual(["rust_graph_server.startup_failure"]);
  });

  it("revocation while child attribution is pending suppresses main reporting", async () => {
    const f = await fixture();
    const child = held();
    trackStartupErrorReport(f.error, child.promise);
    const attempt = reportDesktopStartupFailure(f);
    await new Promise(setImmediate);
    await f.setIdentity(null);
    child.resolve({ accepted: false });
    await attempt;
    expect(f.sent).toHaveLength(0);
  });

  it("an offline authenticated startup event enters only the existing sealed queue", async () => {
    const f = await fixture({ offline: true });
    await reportDesktopStartupFailure(f);
    const envelope = JSON.parse(await readFile(f.queuePath, "utf8"));
    expect(Object.keys(envelope)).toEqual(["version", "sealed"]);
    expect(JSON.stringify(envelope)).not.toContain("electron_main.startup_failure");
    expect(JSON.parse(Buffer.from(envelope.sealed, "base64").toString()).records[0].event.code).toBe("electron_main.startup_failure");
  });

  it("load failure destroys the unusable window and retires its renderer reporter", async () => {
    const error = new Error("ERR_FAILED (-2) loading local workspace");
    const revoke = vi.fn();
    let window;
    class Window extends EventEmitter {
      constructor() { super(); window = this; this.webContents = new EventEmitter();
        this.webContents.session = { cookies: { set: vi.fn(async () => {}) } };
        this.webContents.setWindowOpenHandler = vi.fn();
        this.webContents.isDestroyed = () => false;
        this.destroy = vi.fn(() => this.emit("closed"));
        this.loadURL = vi.fn(async () => { throw error; });
      }
    }
    const createWindow = createWindowFactory({ BrowserWindow: Window, desktopDirectory: "/app", getAppearance: () => "light",
      updater: {}, openExternal: vi.fn(), issueErrorReporter: () => ({ revoke }) });
    await expect(createWindow({ origin: "http://127.0.0.1:1234", cookie: { name: "control", value: "local" } })).rejects.toBe(error);
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
    expect(window.webContents.listenerCount("ipc-message")).toBe(0);
  });

  it("Retry and Quit work without an account service and finish shutdown before relaunch", async () => {
    for (const response of [0, 1]) {
      const calls = [];
      const showDialog = vi.fn(async (options) => { expect(options.buttons).toEqual(["Retry", "Quit"]); return { response }; });
      await recoverDesktopStartupFailure({ error: new Error("private"), startupStage: "initialization", showDialog,
        shutdown: async () => { calls.push("shutdown"); }, relaunch: () => calls.push("relaunch"), exit: () => calls.push("exit") });
      expect(calls).toEqual(response === 0 ? ["shutdown", "relaunch", "exit"] : ["shutdown", "exit"]);
      expect(JSON.stringify(showDialog.mock.calls)).not.toContain("private");
    }
  });

  it.each(["verified", "cancelled", "timeout", "revoked"])("sign-in recovery waits for verification and handles %s", async (mode) => {
    const idle = held();
    const progress = held();
    let identity = null;
    const calls = [];
    let dialogs = 0;
    const account = {
      telemetryIdentity: () => identity,
      login: vi.fn(async () => ({ status: "signing-in" })),
      waitForIdle: vi.fn(() => idle.promise),
      cancelLogin: vi.fn(async () => { identity = null; }),
    };
    const showDialog = vi.fn((options) => {
      dialogs += 1;
      if (dialogs === 1) return Promise.resolve({ response: 1 });
      if (dialogs === 2) { options.signal.addEventListener("abort", () => progress.resolve({ response: 0 }), { once: true }); return progress.promise; }
      return Promise.resolve({ response: 2 });
    });
    vi.useFakeTimers();
    const recovery = recoverDesktopStartupFailure({ error: new Error("prelogin"), startupStage: "window-load", account,
      accountStartup: Promise.resolve({ status: "signed-out" }), showDialog,
      shutdown: async () => calls.push("shutdown"), relaunch: () => calls.push("relaunch"), exit: () => calls.push("exit"), loginBudgetMs: 50 });
    await vi.advanceTimersByTimeAsync(0);
    expect(account.login).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(50);
    else if (mode === "cancelled") progress.resolve({ response: 0 });
    else { identity = mode === "verified" ? { generation: 2, subject: "auth0|verified" } : null; idle.resolve({ status: "signed-in" }); }
    await recovery;
    expect(calls).toEqual(mode === "verified" ? ["shutdown", "relaunch", "exit"] : ["shutdown", "exit"]);
    if (mode !== "verified") expect(account.cancelLogin).toHaveBeenCalledOnce();
  });

  it("Quit interrupts a stalled browser launch, retires the attempt, and cannot relaunch later", async () => {
    const launch = held();
    const account = { telemetryIdentity: () => null, login: vi.fn(() => launch.promise), waitForIdle: vi.fn(), cancelLogin: vi.fn(async () => {}) };
    const calls = [];
    let dialogs = 0;
    await recoverDesktopStartupFailure({ error: new Error("load"), startupStage: "window-load", account,
      accountStartup: Promise.resolve({ status: "signed-out" }), showDialog: async () => ({ response: ++dialogs === 1 ? 1 : 1 }),
      shutdown: async () => calls.push("shutdown"), relaunch: () => calls.push("relaunch"), exit: () => calls.push("exit") });
    launch.resolve({ status: "signed-in" });
    await new Promise(setImmediate);
    expect(calls).toEqual(["shutdown", "exit"]);
    expect(account.cancelLogin).toHaveBeenCalledOnce();
    expect(account.waitForIdle).not.toHaveBeenCalled();
  });
});
