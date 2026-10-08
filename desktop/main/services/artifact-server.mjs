// The server invoke for web app artifacts (PRD 6.6.6, ADR 0014). Opening an app
// artifact reuses a server that already answers its ready URL, or starts the
// node's command in the thread folder. No model runs and nothing is written to
// the graph. The first run of a command in a thread needs the user's approval;
// a server Relayer started stops once no viewer has shown it for its idle timeout.
import { spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const LOG_LIMIT = 64 * 1024;
const DEFAULT_IDLE_MINUTES = 60;
const STARTUP_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 400;
// Secrets the desktop holds never reach agent-declared commands.
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|COOKIE|SESSION)/iu;

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
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
  minuteMs = 60_000,
} = {}) {
  const servers = new Map();
  // One start per server at a time; a second open waits for it instead of starting another.
  const starting = new Map();
  let grants = null;

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
    const signal = (name) => { try { process.kill(platform === "win32" ? child.pid : -child.pid, name); return true; } catch { return false; } };
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

  function stop(key) {
    const server = servers.get(key);
    if (!server) return Promise.resolve();
    servers.delete(key);
    clearTimeout(server.idleTimer);
    return killGroup(server.child);
  }

  async function launch({ key, folder, permissionProfileId, command, readyUrl, idleMinutes, onLog }) {
    const env = Object.fromEntries(Object.entries(environment).filter(([name]) => !SECRET_ENV.test(name) && !name.startsWith("RELAYER_")));
    // A login shell finds the user's tools (npm, node) even when Relayer was opened from Finder.
    env.PATH = [env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
    const shell = platform === "darwin" ? ["/bin/zsh", "-lc", command]
      : platform === "win32" ? [environment.ComSpec || "cmd.exe", "/d", "/s", "/c", command]
        : ["/bin/sh", "-c", command];
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
    const server = { child, log: "", readyUrl, idleMinutes, viewers: 0, idleTimer: null };
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
      const origin = loopbackEndpoint(readyUrl);
      for (const [other, entry] of [...servers.entries()]) {
        if (other === key || loopbackEndpoint(entry.readyUrl) !== origin) continue;
        const exited = entry.child.exitCode !== null || entry.child.signalCode !== null;
        if (exited || other.startsWith(`${threadId}:`)) { stop(other); continue; }
        return { state: "failed", log: `Another thread's app is already serving ${origin}. Close it there, or give this app another port.` };
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
      if (servers.get(key)) stop(key);
      const launching = launch({ key, folder, permissionProfileId, command, readyUrl, idleMinutes: server.idleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES, onLog });
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
        try { process.kill(platform === "win32" ? server.child.pid : -server.child.pid, "SIGKILL"); } catch {}
      }
      servers.clear();
    },

    running: () => [...servers.keys()],
  };
}
