import {
  ManagedRuntimeCredentialAdapter,
  ManagedRuntimeModelCatalogAdapter,
  PrimeProfileCredentialAdapter,
} from "./managed-subscription-adapter.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { managedRuntimeExecutionDetails, requireManagedRuntime } from "./managed-runtime-contract.mjs";

// Claude Code does not currently expose a subscription-authenticated model
// catalog command. Keep only the literal CLI-documented execution aliases in
// this versioned manifest; do not guess full model ids from display names.
export const CLAUDE_SUBSCRIPTION_MODELS = Object.freeze([
  Object.freeze({ id: "sonnet", label: "Sonnet", providerDefault: true, catalogSource: "code-manifest-cli-alias" }),
  Object.freeze({ id: "opus", label: "Opus", providerDefault: false, catalogSource: "code-manifest-cli-alias" }),
  Object.freeze({ id: "fable", label: "Fable", providerDefault: false, catalogSource: "code-manifest-cli-alias" }),
]);

function runClaude(executable, args, environment, {
  signal,
  spawnProcess = spawn,
  acceptedExitCodes = [0],
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", () => {});
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      else if (acceptedExitCodes.includes(code)) resolve(stdout);
      else reject(new Error(`Claude CLI command failed (${code ?? "unknown"}).`));
    });
  });
}

export class ClaudeCliManagedRuntime {
  constructor({ environment = process.env, executable, spawnProcess = spawn } = {}) {
    if (typeof executable !== "string" || executable.trim() === "") {
      throw new Error("Claude managed runtime executable is required.");
    }
    this.environment = environment;
    this.executable = executable;
    this.spawnProcess = spawnProcess;
    this.loginProcess = null;
  }

  async account({ signal } = {}) {
    try {
      const output = await runClaude(this.executable, ["auth", "status", "--json"], this.environment, {
        signal,
        spawnProcess: this.spawnProcess,
        // Claude emits valid loggedIn:false JSON with exit code 1. That is an
        // ordinary disconnected state while browser login is still pending.
        acceptedExitCodes: [0, 1],
      });
      const status = JSON.parse(output);
      return { status: status?.loggedIn === true ? "connected" : "disconnected", account: status };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { status: "unavailable", account: null, error: "Claude subscription is unavailable." };
    }
  }

  async login() {
    if (this.loginProcess && this.loginProcess.exitCode === null) return { loginId: this.loginProcess.loginId };
    const child = this.spawnProcess(this.executable, ["auth", "login"], {
      env: this.environment,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.loginId = randomUUID();
    child.once("exit", () => { if (this.loginProcess === child) this.loginProcess = null; });
    this.loginProcess = child;
    try {
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch {
      if (this.loginProcess === child) this.loginProcess = null;
      throw new Error("Claude subscription login is unavailable.");
    }
    return { loginId: child.loginId };
  }

  async logout({ signal } = {}) {
    await runClaude(this.executable, ["auth", "logout"], this.environment, {
      signal, spawnProcess: this.spawnProcess,
    });
    return this.account({ signal });
  }

  async close() {
    if (this.loginProcess?.exitCode === null) this.loginProcess.kill("SIGTERM");
    this.loginProcess = null;
  }
}

export const claudeSubscriptionDescriptor = Object.freeze({
  adapterId: "claude-subscription",
  implementationVersion: "1",
  label: "Claude subscription",
  accessContract: "managed-runtime@1",
  defaultEndpoint: null,
  endpointEditableDuringCreation: false,
  connection: { mode: "managed-login", fields: [] },
  catalog: { source: "code-manifest" },
  create: ({ definition, runtimeFactory, discoverModels, environment, managedRuntime: runtimeDescriptor, spawnProcess, primeSubscriptionProfile }) => {
    const managedRuntime = requireManagedRuntime(runtimeDescriptor, "claude");
    const effectiveRuntimeFactory = runtimeFactory ?? (() => new ClaudeCliManagedRuntime({
      environment, executable: managedRuntime.executable, spawnProcess,
    }));
    const credentials = primeSubscriptionProfile
      ? new PrimeProfileCredentialAdapter({
        definition,
        profile: primeSubscriptionProfile,
        environment,
        fallbackRuntimeFactory: effectiveRuntimeFactory,
      })
      : new ManagedRuntimeCredentialAdapter({ definition, runtimeFactory: effectiveRuntimeFactory });
    const catalog = new ManagedRuntimeModelCatalogAdapter({
      definition,
      credentials,
      discoverModels: discoverModels ?? (async () => CLAUDE_SUBSCRIPTION_MODELS),
    });
    return Object.freeze({
      descriptor: claudeSubscriptionDescriptor,
      definition,
      credentials,
      catalog,
      executionAccess: async ({ signal } = {}) => {
        const account = await credentials.account({ signal });
        if (account?.status !== "connected") throw new Error("Claude subscription is not connected.");
        if (!credentials.runtime) throw new Error("Claude managed runtime is unavailable.");
        let nativeRequestAccess;
        if (typeof credentials.nativeRequestAccess === "function") {
          try {
            nativeRequestAccess = await credentials.nativeRequestAccess({ signal });
          } catch (error) {
            if (signal?.aborted) throw error;
          }
        }
        return Object.freeze({
          kind: "managed-runtime",
          ...managedRuntimeExecutionDetails(managedRuntime, credentials.runtime.environment),
          ...(nativeRequestAccess ? { nativeRequestAccess } : {}),
        });
      },
      close: () => credentials.close(),
    });
  },
});
