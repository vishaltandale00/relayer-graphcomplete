import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function waitForExit(child, signal, timeoutMs) {
  if (signal?.aborted) {
    child.kill("SIGTERM");
    return Promise.reject(abortReason(signal));
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.off("error", onError);
      child.off("exit", onExit);
      callback(value);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(reject, abortReason(signal));
    };
    const onError = (error) => finish(reject, error);
    const onExit = (code, exitSignal) => finish(resolve, { code, signal: exitSignal });
    const timer = timeoutMs === undefined ? null : setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject, new Error("Managed runtime version probe timed out."));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExitWithin(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error("Managed runtime did not close in time.")), timeoutMs);
    const finish = (callback, value) => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      callback(value);
    };
    const onError = (error) => finish(reject, error);
    const onExit = (code, exitSignal) => finish(resolve, { code, signal: exitSignal });
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function closeCodexAppServer(child, signal) {
  if (signal?.aborted) {
    child.kill("SIGTERM");
    await waitForExitWithin(child, 1_000).catch(() => undefined);
    return;
  }

  // Codex app-server has no shutdown request. EOF on stdin is its graceful
  // protocol close: after the initialize/initialized handshake it exits 0.
  child.stdin.end();
  try {
    await waitForExitWithin(child, 1_000);
  } catch {
    child.kill("SIGTERM");
    await waitForExitWithin(child, 1_000).catch(() => undefined);
  }
}

async function executableVersion(executable, { signal, spawnProcess = spawn, timeoutMs = 10_000 } = {}) {
  const child = spawnProcess(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const result = await waitForExit(child, signal, timeoutMs);
  if (result.code !== 0) throw new Error("Managed runtime version probe failed.");
  const match = `${stdout}\n${stderr}`.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  if (!match) throw new Error("Managed runtime reported an invalid version.");
  return match[1];
}

async function codexInitialize(executable, { signal, spawnProcess = spawn, timeoutMs = 10_000 } = {}) {
  signal?.throwIfAborted();
  const child = spawnProcess(executable, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.on("error", () => {});
  child.stderr?.on("data", () => {});
  const lines = createInterface({ input: child.stdout });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex app-server probe timed out.")), timeoutMs);
      const onAbort = () => reject(abortReason(signal));
      const finish = (callback, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        lines.off("line", onLine);
        child.off("error", onError);
        child.off("exit", onExit);
        callback(value);
      };
      const onLine = (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message?.id === 1 && ("result" in message || "error" in message)) {
          if (message.error) finish(reject, new Error("Codex app-server initialization failed."));
          else finish(resolve);
        }
      };
      const onError = () => finish(reject, new Error("Codex app-server probe failed."));
      const onExit = () => finish(reject, new Error("Codex app-server stopped during its probe."));
      signal?.addEventListener("abort", onAbort, { once: true });
      lines.on("line", onLine);
      child.once("error", onError);
      child.once("exit", onExit);
      child.stdin.write(`${JSON.stringify({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "relayer-runtime-probe", version: "1" }, capabilities: { experimentalApi: false } },
      })}\n`);
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  } finally {
    await closeCodexAppServer(child, signal);
    lines.close();
  }
}

async function probeClaudeSdk(modulePath, { importModule, timeoutMs }) {
  const moduleUrl = pathToFileURL(modulePath).href;
  let timer;
  try {
    const loaded = await Promise.race([
      importModule(moduleUrl),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Claude Agent SDK module probe timed out.")), timeoutMs);
      }),
    ]);
    if (!loaded || typeof loaded !== "object" || typeof loaded.query !== "function") {
      throw new Error("Managed Claude Agent SDK module does not export query().");
    }
  } finally {
    clearTimeout(timer);
  }
}

export function createDefaultRuntimeProbes({
  spawnProcess = spawn,
  importModule = (moduleUrl) => import(moduleUrl),
  timeoutMs = 10_000,
} = {}) {
  return Object.freeze({
    claude: async ({ executable, modulePath, signal }) => {
      const version = await executableVersion(executable, { signal, spawnProcess, timeoutMs });
      if (typeof modulePath !== "string" || modulePath.trim() === "") {
        throw new Error("Managed Claude Agent SDK module is missing.");
      }
      await probeClaudeSdk(modulePath, { importModule, timeoutMs });
      return { version };
    },
    codex: async ({ executable, signal }) => {
      const version = await executableVersion(executable, { signal, spawnProcess, timeoutMs });
      await codexInitialize(executable, { signal, spawnProcess, timeoutMs });
      return { version };
    },
  });
}
