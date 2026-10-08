// ART-009: the server invoke reuses, asks once, starts, reports failure, stops when
// idle and records nothing (PRD 6.6.6). Real processes against the fixture app.
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createArtifactServerRunner } from "../desktop/main/services/artifact-server.mjs";

const fixture = resolve(import.meta.dirname, "fixtures", "artifact-viewer", "thread-folder");
// Relayer confines Ask and Auto commands only on macOS and refuses them elsewhere, so
// the lifecycle tests run confined there and with Full access on other platforms.
const PROFILE = process.platform === "darwin" ? "auto" : "full";
const cleanup = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function setup(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "relayer-artifact-server-"));
  const folder = join(directory, "thread");
  await cp(fixture, folder, { recursive: true });
  const runner = createArtifactServerRunner({ grantsPath: join(directory, "grants.json"), startupTimeoutMs: 15_000, ...options });
  cleanup.push(async () => { await runner.stopAll(); await rm(directory, { recursive: true, force: true }); });
  return { directory, folder, runner };
}

const answers = (url) => fetch(url, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
const until = async (check, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return true; await new Promise((done) => setTimeout(done, 100)); }
  return false;
};

describe("the server invoke (ART-009)", () => {
  it("asks once per thread, starts the app confined to its folder, then reuses it", async () => {
    const { directory, folder, runner } = await setup();
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const server = { command: `node app/server.mjs ${port}` };
    const request = { threadId: 7, nodeId: 3, folder, permissionProfileId: PROFILE, server, sourceUrl: url };

    expect(await runner.ensure(request)).toMatchObject({ state: "approval-required", command: server.command });
    expect(await answers(url)).toBe(false);
    const log = [];
    const started = await runner.ensure({ ...request, approve: true, onLog: (text) => log.push(text) });
    expect(started).toMatchObject({ state: "ready", started: true });
    expect(log.join("")).toContain(`Order desk listening on ${url}`);
    expect(await (await fetch(url)).text()).toContain("Today's orders");

    const again = await runner.ensure(request);
    expect(again).toMatchObject({ state: "ready", started: false });
    // The approval is remembered for the thread, not for another one.
    const later = createArtifactServerRunner({ grantsPath: join(directory, "grants.json") });
    expect((await later.ensure({ ...request, sourceUrl: `http://127.0.0.1:${await freePort()}/`, server: { ...server, command: `${server.command} ` } })).state).toBe("approval-required");
    runner.stopAll();
    expect(await until(async () => !(await answers(url)))).toBe(true);
  });

  it("uses a server that already answers, needs no approval, and never stops it", async () => {
    const { folder, runner } = await setup();
    const outside = createServer((_request, response) => response.end("already running"));
    await new Promise((done) => outside.listen(0, "127.0.0.1", done));
    cleanup.push(() => new Promise((done) => outside.close(done)));
    const url = `http://127.0.0.1:${outside.address().port}/`;
    const result = await runner.ensure({ threadId: 7, nodeId: 3, folder, permissionProfileId: PROFILE, server: { command: "npm run dev" }, sourceUrl: url });
    expect(result).toEqual({ state: "ready", started: false, key: null });
    runner.release(result.key);
    runner.stopAll();
    expect(await answers(url)).toBe(true);
  });

  it("reports a failing command with its log", async () => {
    const { folder, runner } = await setup();
    const port = await freePort();
    const result = await runner.ensure({
      threadId: 7, nodeId: 4, folder, permissionProfileId: PROFILE, approve: true,
      server: { command: "node -e \"console.error('boom: missing config'); process.exit(3)\"" }, sourceUrl: `http://127.0.0.1:${port}/`,
    });
    expect(result.state).toBe("failed");
    expect(result.log).toContain("boom: missing config");
    expect(result.log).toContain("exited with code 3");
  });

  it.runIf(process.platform === "darwin")("confines ask and auto commands to the thread folder", async () => {
    const { folder, runner } = await setup();
    const outside = join(homedir(), `.relayer-sandbox-probe-${process.pid}`);
    const result = await runner.ensure({
      threadId: 7, nodeId: 5, folder, permissionProfileId: "auto", approve: true, sourceUrl: `http://127.0.0.1:${await freePort()}/`,
      server: { command: `node -e "require('fs').writeFileSync('inside.txt','ok'); require('fs').writeFileSync('${outside}','x')"` },
    });
    expect(result.state).toBe("failed");
    expect(result.log).toMatch(/EPERM|operation not permitted/iu);
    expect((await stat(join(folder, "inside.txt"))).isFile()).toBe(true);
    await expect(stat(outside)).rejects.toThrow();
  });

  it("starts one server when two opens overlap", async () => {
    const { folder, runner } = await setup();
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const request = { threadId: 11, nodeId: 3, folder, permissionProfileId: PROFILE, approve: true, server: { command: `node app/server.mjs ${port}` }, sourceUrl: url };
    const [first, second] = await Promise.all([runner.ensure(request), runner.ensure(request)]);
    expect([first.state, second.state]).toEqual(["ready", "ready"]);
    expect(runner.running()).toHaveLength(1);
    runner.stopAll();
    expect(await until(async () => !(await answers(url)))).toBe(true);
  });

  it("shows another thread's server on the same address as a conflict, not as this app", async () => {
    const { folder, runner } = await setup();
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    expect((await runner.ensure({ threadId: 12, nodeId: 3, folder, permissionProfileId: PROFILE, approve: true, server: { command: `node app/server.mjs ${port}` }, sourceUrl: url })).state).toBe("ready");
    const other = await runner.ensure({ threadId: 13, nodeId: 3, folder, permissionProfileId: PROFILE, approve: true, server: { command: `node app/server.mjs ${port}` }, sourceUrl: url });
    expect(other.state).toBe("failed");
    expect(other.log).toContain("Another thread's app is already serving");
    // Review: the address the app is shown at is held too, not only its ready URL.
    const ready = `http://127.0.0.1:${await freePort()}/`;
    const shown = await runner.ensure({ threadId: 14, nodeId: 3, folder, permissionProfileId: PROFILE, approve: true, server: { command: "npm run dev", readyUrl: ready }, sourceUrl: url });
    expect(shown.log).toContain(`Another thread's app is already serving http://loopback:${port}`);
  });

  it("treats localhost and 127.0.0.1 on one port as the same server", async () => {
    const { folder, runner } = await setup();
    const port = await freePort();
    expect((await runner.ensure({ threadId: 17, nodeId: 3, folder, permissionProfileId: PROFILE, approve: true, server: { command: `node app/server.mjs ${port}` }, sourceUrl: `http://127.0.0.1:${port}/` })).state).toBe("ready");
    const alias = await runner.ensure({ threadId: 18, nodeId: 3, folder, permissionProfileId: PROFILE, approve: true, server: { command: "npm run dev" }, sourceUrl: `http://localhost:${port}/` });
    expect(alias.state).toBe("failed");
    expect(alias.log).toContain("Another thread's app is already serving");
  });

  it("replaces the same thread's earlier server when its command changes", async () => {
    const { folder, runner } = await setup();
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const request = { threadId: 15, nodeId: 3, folder, permissionProfileId: PROFILE, approve: true, sourceUrl: url };
    expect((await runner.ensure({ ...request, server: { command: `node app/server.mjs ${port}` } })).state).toBe("ready");
    const revised = await runner.ensure({ ...request, server: { command: `node ./app/server.mjs ${port}` } });
    expect(revised.state).toBe("ready");
    expect(runner.running()).toHaveLength(1);
  });

  it.runIf(process.platform === "darwin")("keeps confined commands from writing through system services", async () => {
    const { folder, runner } = await setup();
    const domain = `ai.relayer.sandbox-probe-${process.pid}`;
    const result = await runner.ensure({
      threadId: 14, nodeId: 3, folder, permissionProfileId: "auto", approve: true, sourceUrl: `http://127.0.0.1:${await freePort()}/`,
      server: { command: `defaults write ${domain} probe -string x; echo "defaults exit $?"; exit 1` },
    });
    expect(result.log).toMatch(/defaults exit [1-9]/u);
    await expect(stat(join(homedir(), "Library", "Preferences", `${domain}.plist`))).rejects.toThrow();
  });

  it("starts Full access servers on Windows with its own shell", async () => {
    const calls = [];
    const { EventEmitter } = await import("node:events");
    const spawn = (file, args, options) => {
      calls.push({ file, args, path: options.env.Path, keys: Object.keys(options.env) });
      const child = Object.assign(new EventEmitter(), { pid: 1234, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() });
      setTimeout(() => { child.exitCode = 1; child.emit("exit", 1, null); }, 10);
      return child;
    };
    const { folder, runner } = await setup({ platform: "win32", spawn, environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe", Path: "C:\\Windows;C:\\Program Files\\nodejs" } });
    await runner.ensure({ threadId: 16, nodeId: 3, folder, permissionProfileId: "full", approve: true, server: { command: "npm run dev" }, sourceUrl: `http://127.0.0.1:${await freePort()}/` });
    expect(calls[0]).toMatchObject({ file: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/s", "/c", "npm run dev"] });
    // Review: Windows' own Path survives as it is, so ordinary commands resolve.
    expect(calls[0].path).toBe("C:\\Windows;C:\\Program Files\\nodejs");
    expect(calls[0].keys).not.toContain("PATH");
  });

  it("gives commands only a shell's environment, never the desktop's credentials", async () => {
    const { folder, runner } = await setup({ environment: { ...process.env, GITHUB_PAT: "ghp_secret", DATABASE_URL: "postgres://u:p@h/db", SSH_AUTH_SOCK: "/tmp/agent.sock" } });
    const result = await runner.ensure({
      threadId: 19, nodeId: 3, folder, permissionProfileId: PROFILE, approve: true, sourceUrl: `http://127.0.0.1:${await freePort()}/`,
      server: { command: "node -e \"console.log('leaked=' + [process.env.GITHUB_PAT, process.env.DATABASE_URL, process.env.SSH_AUTH_SOCK].filter(Boolean).length); process.exit(1)\"" },
    });
    expect(result.log).toContain("leaked=0");
  });

  it.runIf(process.platform === "darwin")("takes only PATH from the user's login shell, never what else it exports", async () => {
    const { directory, folder } = await setup();
    const home = join(directory, "home");
    await mkdir(join(home, "tools"), { recursive: true });
    await writeFile(join(home, ".zprofile"), 'echo "profile noise"\nexport GITHUB_PAT=from-profile\nexport PATH="$HOME/tools:$PATH"\n');
    const profiled = createArtifactServerRunner({ grantsPath: join(directory, "grants-2.json"), environment: { ...process.env, HOME: home } });
    cleanup.push(() => profiled.stopAll());
    const result = await profiled.ensure({
      threadId: 20, nodeId: 3, folder, permissionProfileId: PROFILE, approve: true, sourceUrl: `http://127.0.0.1:${await freePort()}/`,
      server: { command: "node -e \"console.log('token=' + (process.env.GITHUB_PAT ?? 'none') + ' tools=' + process.env.PATH.split(':').includes(process.env.HOME + '/tools')); process.exit(1)\"" },
    });
    expect(result.log).toContain("token=none tools=true");
  });

  it("refuses to run a confined command where it cannot be confined", async () => {
    const { folder, runner } = await setup({ platform: "linux" });
    const result = await runner.ensure({ threadId: 7, nodeId: 3, folder, permissionProfileId: "auto", approve: true, server: { command: "npm run dev" }, sourceUrl: `http://127.0.0.1:${await freePort()}/` });
    expect(result.state).toBe("failed");
    expect(result.log).toContain("only on macOS");
  });

  it("stops a server it started once no viewer has shown it for the idle timeout", async () => {
    const { folder, runner } = await setup({ minuteMs: 300 });
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const request = { threadId: 9, nodeId: 3, folder, permissionProfileId: PROFILE, approve: true, server: { command: `node app/server.mjs ${port}`, idleTimeoutMinutes: 1 }, sourceUrl: url };
    const first = await runner.ensure(request);
    const second = await runner.ensure(request);
    runner.release(first.key);
    await new Promise((done) => setTimeout(done, 600));
    expect(await answers(url)).toBe(true);
    runner.release(second.key);
    expect(await until(async () => !(await answers(url)))).toBe(true);
    expect(runner.running()).toEqual([]);
  });
});
