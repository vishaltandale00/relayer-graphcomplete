import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexCredentialAdapter } from "../desktop/main/credentials/codex-credential-adapter.mjs";
import { CredentialAdapter } from "../desktop/main/credentials/credential-adapter.mjs";
import { createSettingsStore } from "../desktop/main/services/settings-store.mjs";
import { createDesktopUpdater } from "../desktop/main/services/updater.mjs";
import { addLocalThread, interactionForThread, responseNodesForThread } from "../desktop/renderer/src/thread-model.js";

describe("desktop skeleton", () => {
  it("exposes Codex setup, New thread, and updates without a harness selector", async () => {
    const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
    const desktopMain = await readFile(new URL("../desktop/main/index.mjs", import.meta.url), "utf8");
    const packageManifest = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const desktopManifest = await readFile(new URL("../desktop/package.json", import.meta.url), "utf8");
    const packaging = await readFile(new URL("../desktop/packaging/electron-builder.mjs", import.meta.url), "utf8");
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
    expect(html).toContain('id="disconnectCodex"');
    expect(html).toContain('id="updateChannel"');
    expect(html).toContain("relayer-logo");
    expect(html).toContain('class="settings-view hidden"');
    expect(html).toContain('type="module" src="./src/main.js"');
    expect(html).not.toContain("<dialog");
    expect(html.toLowerCase()).not.toContain("harness selector");
    expect(desktopMain).not.toContain("PrimeAgentThreadRunner");
    expect(desktopMain).not.toContain("RelayerAppServer");
    expect(packageManifest).not.toContain("@openai/codex-sdk");
    expect(desktopManifest).not.toContain("prime-agent");
    expect(desktopManifest).not.toContain("@openai/codex-sdk");
    expect(desktopManifest).toContain('"main": "main/index.mjs"');
    expect(JSON.parse(packageManifest).workspaces).toEqual(["desktop"]);
    expect(JSON.parse(packageManifest).devDependencies).not.toHaveProperty("@openai/codex");
    expect(JSON.parse(packageManifest).devDependencies).not.toHaveProperty("electron-updater");
    expect(packageManifest).toContain("desktop/packaging/electron-builder.mjs");
    expect(packaging).toContain('"macos/entitlements.mac.plist"');
    expect(packaging).toContain('"!packaging/**/*"');
    expect(prd).toContain('src="assets/product-walkthrough.html"');
    expect(prd).toContain('document: \'docs/prd/index.html\'');
    expect(prdServer).toContain('join(prdDirectory, "comments.json")');
    expect(packageManifest).not.toContain('"marked"');
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
      spawnProcess: () => child,
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
        failedChild.kill = vi.fn(() => { failedChild.killed = true; });
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
        return failedChild;
      },
    });
    expect(await failingClient.account()).toMatchObject({ status: "unavailable", error: "initialize failed" });
    expect(await failingClient.account()).toMatchObject({ status: "unavailable", error: "initialize failed" });
    expect(failedStarts).toBe(2);
  });

  it("drives the packaged update lifecycle through one state service", async () => {
    const autoUpdater = Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      setFeedURL: vi.fn(),
      quitAndInstall: vi.fn(),
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
    expect(updater.setChannel("preview")).toMatchObject({ phase: "idle", channel: "preview" });
    autoUpdater.emit("checking-for-update");
    expect(() => updater.setChannel("stable")).toThrow("Finish the current update");
    autoUpdater.emit("update-available", { version: "0.1.1" });
    expect(() => updater.setChannel("stable")).toThrow("Finish the current update");
    await updater.download();
    autoUpdater.emit("update-downloaded", { version: "0.1.1" });
    updater.install();

    expect(states.map((state) => state.phase)).toEqual(["failed", "idle", "checking", "available", "ready"]);
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({ channel: "beta" }));
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
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
});
