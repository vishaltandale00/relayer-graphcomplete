import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

// Observe close as soon as the child is created: exitCode only proves exit,
// while close also proves its stdio has closed. Keep this observation across
// handshake completion, cancellation and termination so no event can be missed.
function observeClose(child) {
  let closed = false;
  let error;
  const promise = new Promise((resolve) => {
    const onError = (value) => { error = value; };
    child.on("error", onError);
    child.once("close", (code, signal) => {
      closed = true;
      child.off("error", onError);
      resolve({ code, signal, error });
    });
  });
  return { promise, isClosed: () => closed };
}

function waitForClose(completion, { signal, timeoutMs, message }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    const timer = setTimeout(() => finish(reject, new Error(message)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    completion.promise.then((result) => finish(resolve, result));
  });
}

async function closeProbeChild(child, completion, { graceful = false, shutdownTimeoutMs }) {
  if (completion.isClosed()) return;
  const wait = () => waitForClose(completion, {
    timeoutMs: shutdownTimeoutMs, message: "Managed runtime probe did not close in time.",
  });
  if (graceful) {
    // Codex app-server has no shutdown request. EOF is its protocol close.
    child.stdin.end();
    try { await wait(); return; } catch { /* Terminate the owned probe below. */ }
  }
  child.kill("SIGTERM");
  try { await wait(); return; } catch { /* Escalate once, still within a bound. */ }
  child.kill("SIGKILL");
  // A probe that cannot be confirmed closed must never permit promotion.
  await wait();
}

async function executableVersion(executable, {
  signal, spawnProcess = spawn, timeoutMs = 10_000, shutdownTimeoutMs = 1_000,
} = {}) {
  signal?.throwIfAborted();
  const child = spawnProcess(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  const completion = observeClose(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  try {
    const result = await waitForClose(completion, {
      signal, timeoutMs, message: "Managed runtime version probe timed out.",
    });
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error("Managed runtime version probe failed.");
    const match = `${stdout}\n${stderr}`.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
    if (!match) throw new Error("Managed runtime reported an invalid version.");
    return match[1];
  } finally {
    await closeProbeChild(child, completion, { shutdownTimeoutMs });
  }
}

async function codexInitialize(executable, {
  signal, spawnProcess = spawn, timeoutMs = 10_000, shutdownTimeoutMs = 1_000,
} = {}) {
  signal?.throwIfAborted();
  const child = spawnProcess(executable, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const completion = observeClose(child);
  child.stdin?.on("error", () => {});
  child.stderr?.on("data", () => {});
  const lines = createInterface({ input: child.stdout });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(reject, new Error("Codex app-server probe timed out.")), timeoutMs);
      const onAbort = () => finish(reject, abortReason(signal));
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
    try {
      await closeProbeChild(child, completion, { graceful: !signal?.aborted, shutdownTimeoutMs });
    } finally {
      lines.close();
    }
  }
  signal?.throwIfAborted();
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
    if (!loaded || typeof loaded !== "object"
      || typeof loaded.query !== "function"
      || typeof loaded.tool !== "function"
      || typeof loaded.createSdkMcpServer !== "function") {
      throw new Error("Managed Claude Agent SDK module does not export query(), tool(), and createSdkMcpServer().");
    }
  } finally {
    clearTimeout(timer);
  }
}

export function createDefaultRuntimeProbes({
  spawnProcess = spawn,
  importModule = (moduleUrl) => import(moduleUrl),
  timeoutMs = 10_000,
  shutdownTimeoutMs = 1_000,
} = {}) {
  return Object.freeze({
    claude: async ({ executable, modulePath, signal }) => {
      const version = await executableVersion(executable, { signal, spawnProcess, timeoutMs, shutdownTimeoutMs });
      if (typeof modulePath !== "string" || modulePath.trim() === "") {
        throw new Error("Managed Claude Agent SDK module is missing.");
      }
      await probeClaudeSdk(modulePath, { importModule, timeoutMs });
      return { version };
    },
    codex: async ({ executable, signal }) => {
      const version = await executableVersion(executable, { signal, spawnProcess, timeoutMs, shutdownTimeoutMs });
      await codexInitialize(executable, { signal, spawnProcess, timeoutMs, shutdownTimeoutMs });
      return { version };
    },
    prime: async (runtime) => {
      const { checkPrimeManagedRuntime } = await import("../services/prime-managed-runtime.mjs");
      const result = await checkPrimeManagedRuntime({ runtime });
      if (result.available !== true) throw new Error("Managed Prime kernel probe failed.");
      return { version: runtime.version };
    },
  });
}
