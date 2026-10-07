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
    `(allow file-write* (subpath ${quote(folder)}) (subpath ${quote(temporary)}) (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (subpath "/dev/fd"))`,
  ].join("\n");
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

  function stop(key) {
    const server = servers.get(key);
    if (!server) return;
    servers.delete(key);
    clearTimeout(server.idleTimer);
    if (server.child.exitCode === null && server.child.signalCode === null) {
      // The command runs in its own process group; stop every process it started.
      try { process.kill(-server.child.pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-server.child.pid, "SIGKILL"); } catch {} }, 3000).unref?.();
    }
  }

  async function launch({ key, folder, permissionProfileId, command, readyUrl, idleMinutes, onLog }) {
    const env = Object.fromEntries(Object.entries(environment).filter(([name]) => !SECRET_ENV.test(name) && !name.startsWith("RELAYER_")));
    let file = "/bin/sh";
    let args = ["-c", command];
    if (permissionProfileId !== "full") {
      if (platform !== "darwin") {
        return { state: "failed", log: "This thread's permission profile confines commands, and Relayer can confine a server only on macOS. Use the Full access profile to run it here." };
      }
      const profile = serverSandboxProfile({ folder: await realpath(folder), temporary: await realpath(tmpdir()) });
      file = "/usr/bin/sandbox-exec";
      args = ["-p", profile, "/bin/sh", "-c", command];
    }
    const child = spawn(file, args, { cwd: folder, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const server = { child, log: "", readyUrl, idleMinutes, viewers: 0, idleTimer: null };
    servers.set(key, server);
    const append = (chunk) => {
      const text = String(chunk);
      server.log = (server.log + text).slice(-LOG_LIMIT);
      onLog?.(text);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const exited = new Promise((done) => {
      child.once("exit", (code, signal) => done({ code, signal }));
      child.once("error", (error) => { append(`${error.message}\n`); done({ code: -1, signal: null }); });
    });
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      const ended = await Promise.race([exited, new Promise((done) => setTimeout(() => done(null), READY_POLL_MS))]);
      if (ended) {
        servers.delete(key);
        return { state: "failed", log: `${server.log}\nThe command exited${ended.code === null ? ` (${ended.signal})` : ` with code ${ended.code}`} before ${readyUrl} answered.`.trim() };
      }
      if (await answers(readyUrl)) return { state: "ready", started: true };
    }
    stop(key);
    return { state: "failed", log: `${server.log}\nNo answer from ${readyUrl} after ${Math.round(startupTimeoutMs / 1000)} s.`.trim() };
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
      const running = servers.get(key);
      if (running) {
        clearTimeout(running.idleTimer);
        running.viewers += 1;
        if (await answers(readyUrl)) return { state: "ready", started: false, key };
      }
      // A server the user or another tool started is used as it is, and never stopped.
      if (!running && await answers(readyUrl)) return { state: "ready", started: false, key: null };
      if (approving) await approve(threadId, command);
      if (!(await approved(threadId, command))) return { state: "approval-required", command, folder, permissionProfileId };
      if (running) stop(key);
      const result = await launch({ key, folder, permissionProfileId, command, readyUrl, idleMinutes: server.idleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES, onLog });
      if (result.state === "ready") servers.get(key).viewers += 1;
      return { ...result, key: result.state === "ready" ? key : null };
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

    /** Stop every server Relayer started, when the app quits. */
    stopAll() {
      for (const key of [...servers.keys()]) stop(key);
    },

    running: () => [...servers.keys()],
  };
}
