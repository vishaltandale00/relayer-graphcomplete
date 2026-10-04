import { runInNewContext } from "node:vm";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { captureInstalledUpdateState, captureElectronRenderer, driveElectronUpdateCanary } from "../desktop/release/electron-cdp-canary.mjs";
import { waitForCanaryRuntimeStaging } from "../desktop/release/canary-runtime-staging.mjs";

afterEach(() => vi.unstubAllGlobals());

const disconnectedCodex = { id: "codex", adapterId: "codex-subscription", lifecycleState: "active", connected: false };

async function stagingFixture(root) {
  const manifest = Buffer.from("version: 0.2.37\nrelayerManagedRuntimes:\n  codex: 0.159.3\n  claude: 0.3.286\n");
  const publicationReceiptPath = join(root, "publication.json");
  const publication = { schemaVersion: 2, channel: "preview", target: "macos-arm64", version: "0.2.37",
    manifest: { key: "desktop/macos/arm64/beta-mac.yml", size: manifest.length,
      sha256: createHash("sha256").update(manifest).digest("hex") } };
  await writeFile(publicationReceiptPath, JSON.stringify(publication));
  const pendingDirectory = join(root, "managed-runtimes", ".pending-app-updates", "0.2.37");
  await mkdir(pendingDirectory, { recursive: true });
  const pending = { schemaVersion: 2, appVersion: "0.2.37", runtimeId: "codex", target: "macos-arm64",
    recipeId: "codex@0.159.3", installation: "01234567-89ab-cdef-0123-456789abcdef" };
  return {
    options: { profileDirectory: root, publicationReceiptPath, targetKey: "macos-arm64", targetVersion: "0.2.37",
      definitions: [disconnectedCodex], timeoutMs: 1000, pollIntervalMs: 10,
      fetchImpl: async () => new Response(manifest) },
    writePending: (changes = {}) => writeFile(join(pendingDirectory, "codex-macos-arm64.json"), JSON.stringify({ ...pending, ...changes })),
  };
}

it("waits for the incoming runtime receipt and staging teardown before permitting native restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "relayer-canary-staging-"));
  try {
    const fixture = await stagingFixture(root);
    const staging = join(root, "managed-runtimes", ".staging", "codex-update-fixture");
    await mkdir(staging, { recursive: true });
    let settled = false;
    const waiting = waitForCanaryRuntimeStaging(fixture.options).then(() => { settled = true; });
    await fixture.writePending();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    await rm(staging, { recursive: true });
    await waiting;
    expect(settled).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects a staged receipt for a different recipe instead of permitting restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "relayer-canary-staging-"));
  try {
    const fixture = await stagingFixture(root);
    await fixture.writePending({ recipeId: "codex@0.159.2" });
    await expect(waitForCanaryRuntimeStaging(fixture.options)).rejects.toThrow(/does not match the incoming/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("fails the real driver before install if managed staging never settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "relayer-canary-staging-"));
  const driver = cdpFixture({ seedStartup: true, startupAlreadyComplete: true, providerDefinitions: [disconnectedCodex] });
  try {
    const fixture = await stagingFixture(root);
    await expect(driveElectronUpdateCanary({ port: 9229, targetVersion: "0.2.37",
      availableScreenshotPath: join(root, "available.png"), readyScreenshotPath: join(root, "ready.png"), timeoutMs: 60,
      runtimeStaging: fixture.options,
    })).rejects.toThrow(/Timed out waiting for managed runtime staging/);
    expect(driver.downloads()).toBe(1);
    expect(driver.installs()).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects changed Preview metadata and connected profiles at the staging authority boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "relayer-canary-staging-"));
  try {
    const fixture = await stagingFixture(root);
    await expect(waitForCanaryRuntimeStaging({ ...fixture.options,
      fetchImpl: async () => new Response("changed manifest"),
    })).rejects.toThrow(/does not match its publication receipt/);
    await expect(waitForCanaryRuntimeStaging({ ...fixture.options,
      definitions: [{ ...disconnectedCodex, connected: true }],
    })).rejects.toThrow(/isolated disconnected-provider profile/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function installedRenderer() {
  const element = () => ({
    classList: { add() {}, remove() {} }, style: { setProperty() {} },
    click() {}, scrollIntoView() {}, contains: () => true,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
  });
  const section = element();
  section.querySelector = () => ({ textContent: "Application updates" });
  const elements = new Map([
    ["#appShell", element()], ["#settingsView", element()],
    ["#currentVersion", { textContent: "Current version 0.2.37" }],
    ["#updateStatus", { textContent: "Up to date" }],
    ["#updateChannel", { value: "preview" }],
  ]);
  elements.get("#settingsView").querySelectorAll = () => [section];
  return {
    document: {
      body: element(), querySelector: (selector) => elements.get(selector) || null,
      elementFromPoint: () => ({ tagName: "SECTION", id: "updates", className: "settings-section" }),
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  };
}

function cdpFixture({ neverReady = false, seedStartup = false, startupAlreadyComplete = false, unansweredMethod, unansweredExpression, delayedDownloadMs = 0, neverOpen = false, providerDefinitions } = {}) {
  const sockets = [];
  let markDownloadStarted;
  const downloadStarted = new Promise((resolve) => { markDownloadStarted = resolve; });
  let rendererReads = 0;
  let screenshots = 0;
  let startupReads = 0;
  let startupComplete = startupAlreadyComplete;
  let downloadComplete = false;
  let installs = 0;
  let manualChecks = 0;
  let downloads = 0;
  let channelChanges = 0;
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => [
    { type: "page", webSocketDebuggerUrl: "ws://canary-fixture" },
  ] }));
  vi.stubGlobal("WebSocket", class extends EventTarget {
    constructor() {
      super();
      sockets.push(this);
      if (!neverOpen) queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(text) {
      const { id, method, params } = JSON.parse(text);
      if (method === unansweredMethod) return;
      let result = {};
      if (method === "Runtime.evaluate") {
        if (seedStartup && params.expression.startsWith("window.relayerDesktop")) {
          try {
            const updater = {
              status() {
                startupReads += 1;
                if (startupReads >= 3) startupComplete = true;
                return {
                  phase: downloadComplete ? "ready" : startupComplete ? "available" : startupReads === 1 ? "idle" : "checking",
                  version: "0.2.30", channel: "preview", availableVersion: "0.2.37",
                };
              },
              setChannel() { channelChanges += 1; },
              check() {
                if (!startupComplete) throw new Error("Seed startup discovery still pending");
                manualChecks += 1;
              },
              download() { downloads += 1; downloadComplete = true; markDownloadStarted(); },
              install() {
                if (!startupComplete || !downloadComplete) throw new Error("No verified update is ready to install.");
                installs += 1;
              },
            };
            result = { result: { value: runInNewContext(params.expression, { window: { relayerDesktop: {
              updater, providers: { status: () => ({ definitions: providerDefinitions }) },
            } } }) } };
          } catch (error) {
            result = { exceptionDetails: { exception: { description: error.message } } };
          }
        } else if (params.expression.startsWith("window.relayerDesktop")) {
          result = { result: { value: { phase: "idle", version: "0.2.37", channel: "preview" } } };
        } else if (seedStartup) {
          result = { result: { value: {
            visible: true, title: downloadComplete ? "Ready to restart" : "Update available",
            detail: downloadComplete ? "Ready to restart" : "Version 0.2.37 available",
          } } };
        } else {
          rendererReads += 1;
          const context = neverReady || rendererReads === 1
            ? { document: { body: null, querySelector: () => null } }
            : installedRenderer();
          try {
            result = { result: { value: runInNewContext(params.expression, context) } };
          } catch (error) {
            result = { exceptionDetails: { exception: { description: error.message } } };
          }
        }
      } else if (method === "Page.captureScreenshot") {
        screenshots += 1;
        result = { data: Buffer.from("captured-after-ready").toString("base64") };
      }
      if (params?.expression === unansweredExpression && unansweredExpression) return;
      const respond = () => this.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ id, result }),
      }));
      if (delayedDownloadMs && params?.expression === "window.relayerDesktop.updater.download()") {
        setTimeout(respond, delayedDownloadMs);
      } else {
        queueMicrotask(respond);
      }
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.dispatchEvent(new Event("close"));
    }
  });
  return {
    downloadStarted,
    close: () => sockets.forEach((socket) => socket.close()),
    rendererReads: () => rendererReads, screenshots: () => screenshots,
    installs: () => installs, downloads: () => downloads, manualChecks: () => manualChecks, channelChanges: () => channelChanges,
  };
}

it("waits for the relaunched renderer body before inspecting and capturing installed Settings", async () => {
  const fixture = cdpFixture();
  const root = await mkdtemp(join(tmpdir(), "relayer-cdp-canary-"));
  try {
    const outputPath = join(root, "installed.png");
    await captureInstalledUpdateState({ port: 9230, outputPath, targetVersion: "0.2.37", timeoutMs: 1500 });
    expect(fixture.rendererReads()).toBeGreaterThan(1);
    expect(fixture.screenshots()).toBe(1);
    expect(await readFile(outputPath, "utf8")).toBe("captured-after-ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("fails closed without capturing evidence when the relaunched document never becomes ready", async () => {
  const fixture = cdpFixture({ neverReady: true });
  await expect(captureInstalledUpdateState({
    port: 9230, outputPath: "/unused-installed.png", targetVersion: "0.2.37", timeoutMs: 100,
  })).rejects.toThrow("Timed out waiting for visible updater evidence");
  expect(fixture.screenshots()).toBe(0);
});

it("drains saved-Preview startup discovery before driving the seed's manual download and install", async () => {
  const fixture = cdpFixture({ seedStartup: true });
  const root = await mkdtemp(join(tmpdir(), "relayer-cdp-canary-"));
  try {
    await driveElectronUpdateCanary({
      port: 9229, targetVersion: "0.2.37", availableScreenshotPath: join(root, "available.png"),
      readyScreenshotPath: join(root, "ready.png"), timeoutMs: 2000,
    });
    expect(fixture.manualChecks()).toBe(1);
    expect(fixture.channelChanges()).toBe(0);
    expect(fixture.installs()).toBe(1);
    expect(fixture.screenshots()).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("accepts startup discovery that finished before the driver attached without resetting the channel", async () => {
  const fixture = cdpFixture({ seedStartup: true, startupAlreadyComplete: true });
  const root = await mkdtemp(join(tmpdir(), "relayer-cdp-canary-"));
  try {
    await driveElectronUpdateCanary({
      port: 9229, targetVersion: "0.2.37", availableScreenshotPath: join(root, "available.png"),
      readyScreenshotPath: join(root, "ready.png"), timeoutMs: 1000,
    });
    expect(fixture.channelChanges()).toBe(0);
    expect(fixture.installs()).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function boundedResult(operation, fixture) {
  let timer;
  try {
    return await Promise.race([
      operation.then(() => "unexpected acceptance", (error) => error.message),
      new Promise((resolve) => { timer = setTimeout(() => resolve("runner exceeded its timeout"), 200); }),
    ]);
  } finally {
    clearTimeout(timer);
    fixture.close();
  }
}

it("fails closed when updater IPC never answers over a responsive DevTools socket", async () => {
  const fixture = cdpFixture({ unansweredMethod: "Runtime.evaluate" });
  const result = await boundedResult(captureInstalledUpdateState({
    port: 9230, outputPath: "/unused-installed.png", targetVersion: "0.2.37", timeoutMs: 50,
  }), fixture);
  expect(result).toMatch(/Timed out.*Runtime.evaluate/);
  expect(fixture.screenshots()).toBe(0);
});

it("does not write evidence when the screenshot command never answers", async () => {
  const fixture = cdpFixture({ unansweredMethod: "Page.captureScreenshot" });
  const result = await boundedResult(captureElectronRenderer({
    port: 9230, outputPath: "/unused-first-install.png", timeoutMs: 50,
  }), fixture);
  expect(result).toMatch(/Timed out.*Page.captureScreenshot/);
});

it("bounds a DevTools socket that never finishes opening", async () => {
  const fixture = cdpFixture({ neverOpen: true });
  const result = await boundedResult(captureElectronRenderer({
    port: 9230, outputPath: "/unused-first-install.png", timeoutMs: 50,
  }), fixture);
  expect(result).toMatch(/Timed out connecting to Electron DevTools/);
});

it("bounds discovery even when the local HTTP endpoint never answers", async () => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const result = await boundedResult(captureElectronRenderer({
    port: 9230, outputPath: "/unused-first-install.png", timeoutMs: 50,
  }), { close() {} });
  expect(result).toMatch(/Timed out connecting.*discovering Electron DevTools targets/);
});

it("does not retry a download or install after its CDP answer is lost", async () => {
  const fixture = cdpFixture({ seedStartup: true, startupAlreadyComplete: true,
    unansweredExpression: "window.relayerDesktop.updater.download()" });
  const root = await mkdtemp(join(tmpdir(), "relayer-cdp-canary-"));
  try {
    const result = await boundedResult(driveElectronUpdateCanary({
      port: 9229, targetVersion: "0.2.37", availableScreenshotPath: join(root, "available.png"),
      readyScreenshotPath: join(root, "ready.png"), timeoutMs: 50,
    }), fixture);
    expect(result).toMatch(/Timed out.*Runtime.evaluate/);
    expect(fixture.downloads()).toBe(1);
    expect(fixture.installs()).toBe(0);
    expect(fixture.screenshots()).toBe(1);
    await expect(readFile(join(root, "ready.png"))).rejects.toThrow(/ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["Runtime.enable", "Page.enable"])("bounds a missing %s handshake acknowledgement", async (unansweredMethod) => {
  const fixture = cdpFixture({ unansweredMethod });
  const result = await boundedResult(captureElectronRenderer({
    port: 9230, outputPath: "/unused-first-install.png", timeoutMs: 50,
  }), fixture);
  expect(result).toMatch(/Timed out connecting.*Electron DevTools command/);
  expect(fixture.screenshots()).toBe(0);
});

it("allows a real download answer after the observation cap within its full phase budget", async () => {
  vi.useFakeTimers();
  const fixture = cdpFixture({ seedStartup: true, startupAlreadyComplete: true, delayedDownloadMs: 31_000 });
  const root = await mkdtemp(join(tmpdir(), "relayer-cdp-canary-"));
  let outcome;
  try {
    let settled = false;
    outcome = driveElectronUpdateCanary({
      port: 9229, targetVersion: "0.2.37", availableScreenshotPath: join(root, "available.png"),
      readyScreenshotPath: join(root, "ready.png"), timeoutMs: 40_000,
    }).then(() => { settled = true; return "passed"; }, (error) => { settled = true; return error.message; });
    await fixture.downloadStarted;
    await vi.advanceTimersByTimeAsync(30_001);
    expect(settled).toBe(false);
    expect(fixture.downloads()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toBe("passed");
    expect(fixture.installs()).toBe(1);
    expect(fixture.screenshots()).toBe(2);
  } finally {
    fixture.close();
    if (outcome) await outcome;
    vi.clearAllTimers();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
