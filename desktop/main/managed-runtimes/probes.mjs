import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function waitForExit(child, signal) {
  if (signal?.aborted) {
    child.kill("SIGTERM");
    return Promise.reject(abortReason(signal));
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      child.kill("SIGTERM");
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", reject);
    child.once("exit", (code, exitSignal) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(abortReason(signal));
      else resolve({ code, signal: exitSignal });
    });
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

async function executableVersion(executable, { signal, spawnProcess = spawn } = {}) {
  const child = spawnProcess(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const result = await waitForExit(child, signal);
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

export function createDefaultRuntimeProbes({ spawnProcess = spawn } = {}) {
  return Object.freeze({
    claude: async ({ executable, signal }) => ({
      version: await executableVersion(executable, { signal, spawnProcess }),
    }),
    codex: async ({ executable, signal }) => {
      const version = await executableVersion(executable, { signal, spawnProcess });
      await codexInitialize(executable, { signal, spawnProcess });
      return { version };
    },
  });
}
