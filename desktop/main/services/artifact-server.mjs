// The server invoke for web app artifacts (PRD 6.6.6, ADR 0014). Opening an app
// artifact reuses a server that already answers its ready URL, or starts the
// node's command in the thread folder. No model runs and nothing is written to
// the graph. The first run of a command in a thread needs the user's approval;
// a server Relayer started stops once no viewer has shown it for its idle timeout.
import { execFile, spawn as spawnProcess, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { withConventionalPathKey } from "../../shared/codex-runtime-environment.mjs";

const LOG_LIMIT = 64 * 1024;
const DEFAULT_IDLE_MINUTES = 60;
const STARTUP_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 400;
// An agent-declared command gets only what a shell needs, never the desktop's credentials,
// tokens or agent sockets. Names compare case-insensitively, as Windows names do.
const ALLOWED_ENV = new Set(["path", "home", "user", "logname", "shell", "lang", "term", "tmpdir", "tz", "systemroot", "comspec", "pathext", "temp", "tmp", "userprofile"]);
const PATH_MARKER = "__RELAYER_LOGIN_PATH__";

/**
 * The user's tool paths (npm, node) as their macOS login shell sets them, so a server
 * starts even when Relayer was opened from Finder. Only PATH is taken: whatever else
 * the user's startup files export never reaches the agent's command.
 */
export function loginShellPath(env) {
  return new Promise((done) => {
    execFile("/bin/zsh", ["-lc", `printf '\\n${PATH_MARKER}%s' "$PATH"`], { env, timeout: 5000 }, (error, stdout) => {
      const path = error ? "" : String(stdout).split(PATH_MARKER).pop().trim();
      done(path || null);
    });
  });
}

export const commandDigest = (command) => createHash("sha256").update(command).digest("hex");

/**
 * Seatbelt profile for `ask` and `auto` threads: like the agents' workspace-write
 * mode, the command may read and use the network but write only in the thread
 * folder and temporary space.
 */
export function serverSandboxProfile({ folder, temporary }) {
  const quote = (path) => JSON.stringify(path);
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${quote(folder)}) (subpath ${quote(temporary)}) (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (subpath "/dev/fd"))`,
    // System services write for the caller; deny the ones that would carry writes or
    // launches outside the sandbox: preferences, Launch Services, Apple Events and launchd jobs.
    '(deny mach-lookup (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent") (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.lsd.mapdb") (global-name "com.apple.lsd.modifydb"))',
    "(deny appleevent-send)",
    '(deny process-exec (literal "/bin/launchctl") (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/usr/bin/defaults"))',
  ].join("\n");
}

/** localhost and 127.0.0.1 on one port are the same server. */
function loopbackEndpoint(url) {
  const parsed = new URL(url);
  const host = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ? "loopback" : parsed.hostname;
  return `${parsed.protocol}//${host}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
}

function readyUrlOf(server, sourceUrl) {
  return String(server?.readyUrl ?? sourceUrl);
}

/**
 * `fetch` answers whether a ready URL responds; `spawn` and `platform` are injectable
 * for tests. Grants are kept in `grantsPath` as { threadId: [commandDigest] }.
 */
export function createArtifactServerRunner({
  grantsPath,
  spawn = spawnProcess,
  fetchImpl = globalThis.fetch,
  platform = process.platform,
  environment = process.env,
  resolveLoginPath = loginShellPath,
  runSync = spawnSync,
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
  minuteMs = 60_000,
} = {}) {
  const servers = new Map();
  // One start per server at a time; a second open waits for it instead of starting another.
  const starting = new Map();
  let grants = null;
  let loginPath = null;

  async function loadGrants() {
    if (grants) return grants;
    try { grants = JSON.parse(await readFile(grantsPath, "utf8")); } catch { grants = {}; }
    return grants;
  }

  async function approved(threadId, command) {
    return (await loadGrants())[threadId]?.includes(commandDigest(command)) ?? false;
  }

  async function approve(threadId, command) {
    const all = await loadGrants();
    all[threadId] = [...new Set([...(all[threadId] ?? []), commandDigest(command)])];
    await writeFile(grantsPath, JSON.stringify(all), { mode: 0o600 });
  }

  async function answers(url) {
    try {
      const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(1500) });
      await response.body?.cancel().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The command runs in its own process group; stop every process it started, even after
   * the shell exits. Resolves once the group is gone, forcing it after a grace period.
   */
  function killGroup(child, { graceMs = 3000 } = {}) {
    if (!child?.pid) return Promise.resolve();
    if (platform === "win32") {
      killWindowsTree(child.pid);
      return Promise.resolve();
    }
    const signal = (name) => { try { process.kill(-child.pid, name); return true; } catch { return false; } };
    if (!signal("SIGTERM")) return Promise.resolve();
    return new Promise((done) => {
      const deadline = Date.now() + graceMs;
      const poll = () => {
        if (!signal(0)) return done();
        if (Date.now() >= deadline) { signal("SIGKILL"); return done(); }
        setTimeout(poll, 100).unref?.();
      };
      poll();
    });
  }

  /**
   * Windows has no process groups: the server (node under npm) is a descendant of the
   * shell. taskkill ends the shell's whole tree while the shell still holds it, and
   * returns once it is gone.
   */
  function killWindowsTree(pid) {
    if (!pid) return;
    try { runSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 }); } catch {}
  }

  function stop(key) {
    const server = servers.get(key);
    if (!server) return Promise.resolve();
    servers.delete(key);
    clearTimeout(server.idleTimer);
    return killGroup(server.child);
  }

  async function launch({ key, endpoints, folder, permissionProfileId, command, readyUrl, idleMinutes, onLog }) {
    const env = withConventionalPathKey(Object.fromEntries(Object.entries(environment)
      .filter(([name]) => ALLOWED_ENV.has(name.toLowerCase()) || name.startsWith("LC_"))), { platform });
    if (platform === "darwin") {
      loginPath ??= resolveLoginPath(env);
      env.PATH = [(await loginPath) ?? env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
    }
    const shell = platform === "win32" ? [env.ComSpec || "cmd.exe", "/d", "/s", "/c", command] : ["/bin/sh", "-c", command];
    let [file, ...args] = shell;
    if (permissionProfileId !== "full") {
      if (platform !== "darwin") {
        return { state: "failed", log: "This thread's permission profile confines commands, and Relayer can confine a server only on macOS. Use the Full access profile to run it here." };
      }
      const profile = serverSandboxProfile({ folder: await realpath(folder), temporary: await realpath(tmpdir()) });
      file = "/usr/bin/sandbox-exec";
      args = ["-p", profile, ...shell];
    }
    const child = spawn(file, args, { cwd: folder, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const server = { child, log: "", endpoints, idleMinutes, viewers: 0, idleTimer: null };
    servers.set(key, server);
    // The log streams to the starting card only until startup ends; after that it is
    // kept (bounded) but no longer forwarded.
    let forward = onLog;
    const append = (chunk) => {
      const text = String(chunk);
      server.log = (server.log + text).slice(-LOG_LIMIT);
      forward?.(text);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const exited = new Promise((done) => {
      child.once("exit", (code, signal) => done({ code, signal }));
      child.once("error", (error) => { append(`${error.message}\n`); done({ code: -1, signal: null }); });
    });
    const deadline = Date.now() + startupTimeoutMs;
    try {
    while (Date.now() < deadline) {
      const ended = await Promise.race([exited, new Promise((done) => setTimeout(() => done(null), READY_POLL_MS))]);
      if (ended) {
        if (servers.get(key) === server) servers.delete(key);
        killGroup(child);
        return { state: "failed", log: `${server.log}\nThe command exited${ended.code === null ? ` (${ended.signal})` : ` with code ${ended.code}`} before ${readyUrl} answered.`.trim() };
      }
      if (await answers(readyUrl)) return { state: "ready", started: true };
    }
    if (servers.get(key) === server) stop(key);
    else killGroup(child);
    return { state: "failed", log: `${server.log}\nNo answer from ${readyUrl} after ${Math.round(startupTimeoutMs / 1000)} s.`.trim() };
    } finally {
      forward = null;
    }
  }

  return {
    /**
     * Make an app artifact's server available. Returns ready, approval-required or
     * failed. `approve: true` records the user's approval for this thread first.
     */
    async ensure({ threadId, nodeId, folder, permissionProfileId, server, sourceUrl, approve: approving = false, onLog }) {
      const command = String(server.command);
      const readyUrl = readyUrlOf(server, sourceUrl);
      const key = `${threadId}:${commandDigest(command)}`;
      // Another thread's app on the same address is a different app; never show it here.
      // This thread's own earlier server there (a revised command, or one that died) is replaced.
      // A server holds both the address it is shown at and the one it answers readiness on.
      const endpoints = [...new Set([readyUrl, String(sourceUrl)].map(loopbackEndpoint))];
      for (const [other, entry] of [...servers.entries()]) {
        const shared = entry.endpoints.find((endpoint) => endpoints.includes(endpoint));
        if (other === key || !shared) continue;
        const exited = entry.child.exitCode !== null || entry.child.signalCode !== null;
        // Wait for it to go, so the replacement is never confused with the old server.
        if (exited || other.startsWith(`${threadId}:`)) { await stop(other); continue; }
        return { state: "failed", log: `Another thread's app is already serving ${shared}. Close it there, or give this app another port.` };
      }
      await starting.get(key)?.catch(() => {});
      const running = servers.get(key);
      if (running && await answers(readyUrl)) {
        clearTimeout(running.idleTimer);
        running.viewers += 1;
        return { state: "ready", started: false, key };
      }
      // A server the user or another tool started is used as it is, and never stopped.
      if (!running && await answers(readyUrl)) return { state: "ready", started: false, key: null };
      if (approving) await approve(threadId, command);
      if (!(await approved(threadId, command))) return { state: "approval-required", command, folder, permissionProfileId };
      if (starting.has(key)) return this.ensure({ threadId, nodeId, folder, permissionProfileId, server, sourceUrl, onLog });
      if (servers.get(key)) await stop(key);
      const launching = launch({ key, endpoints, folder, permissionProfileId, command, readyUrl, idleMinutes: server.idleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES, onLog });
      starting.set(key, launching);
      let result;
      try { result = await launching; } finally { if (starting.get(key) === launching) starting.delete(key); }
      const started = servers.get(key);
      if (result.state === "ready" && started) started.viewers += 1;
      return { ...result, key: result.state === "ready" && started ? key : null };
    },

    /** A viewer stopped showing the server; start its idle timer when none still does. */
    release(key) {
      const server = key ? servers.get(key) : null;
      if (!server) return;
      server.viewers = Math.max(0, server.viewers - 1);
      if (server.viewers > 0) return;
      clearTimeout(server.idleTimer);
      server.idleTimer = setTimeout(() => stop(key), server.idleMinutes * minuteMs);
      server.idleTimer.unref?.();
    },

    /** Stop every server Relayer started when the app quits, waiting for each to exit. */
    stopAll() {
      return Promise.all([...servers.keys()].map((key) => stop(key)));
    },

    /** On process exit nothing can wait: kill every group at once. */
    killAllNow() {
      for (const server of servers.values()) {
        if (platform === "win32") killWindowsTree(server.child.pid);
        else try { process.kill(-server.child.pid, "SIGKILL"); } catch {}
      }
      servers.clear();
    },

    running: () => [...servers.keys()],
  };
}
