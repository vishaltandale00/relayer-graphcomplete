import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ClaudeBasicHarness, claudePermissionMode } from "../src/implementations/claude-basic.js";
import { createNoopHarnessTraceSink } from "../src/trace.js";
import type { HarnessFactoryContext, HarnessRunContext } from "../src/types.js";

function factoryContext(approvalMode: string, savedState = {}): HarnessFactoryContext {
  return {
    threadId: 1,
    workingDirectory: "/tmp",
    permissionProfileId: "auto",
    permissionBinding: { approvalMode },
    savedState,
    configuration: {
      schemaVersion: 1,
      name: "claude-basic",
      implementation: "claude.basic",
      implementationVersion: 1,
      permissionBindings: { auto: { approvalMode } },
      settings: {},
    },
  };
}

function fakeSpawn(output: object, capture: (args: readonly unknown[]) => void): typeof spawn {
  return ((...args: unknown[]) => {
    capture(args);
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    queueMicrotask(() => {
      (child.stdout as PassThrough).end(JSON.stringify(output));
      child.emit("exit", 0, null);
    });
    return child;
  }) as typeof spawn;
}

function failingSpawn(stderr: string): typeof spawn {
  return (() => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    queueMicrotask(() => {
      (child.stderr as PassThrough).end(stderr);
      child.emit("exit", 1, null);
    });
    return child;
  }) as typeof spawn;
}

function runContext(access: HarnessRunContext["access"]): HarnessRunContext {
  if (!access) throw new Error("test access is required");
  const inputGraph = { id: 4, kind: "user-interaction", icon: "user", title: "Question", detail: "Explain", state: "accepted" as const };
  return {
    inputGraph,
    interactionInput: { interaction: inputGraph, contexts: [] },
    graph: { interactionNodeId: 4, acquireCapability: () => ({ url: "http://127.0.0.1:9", token: "token", nodeId: 4 }) },
    approvals: { request: async () => { throw new Error("unused approval channel"); } },
    model: { providerId: "anthropic-work", adapterId: access.adapterId, modelId: "claude-sonnet-4" },
    access,
    trace: createNoopHarnessTraceSink(),
  };
}

describe("ClaudeBasicHarness", () => {
  it("maps product approval modes onto supported Claude CLI permission modes", () => {
    expect(claudePermissionMode("ask")).toBe("default");
    expect(claudePermissionMode("auto")).toBe("acceptEdits");
    expect(claudePermissionMode("full")).toBe("bypassPermissions");
    expect(() => claudePermissionMode("untrusted")).toThrow(/ask, auto, or full/);
  });
  it("uses execution-scoped Anthropic access, canonical graph guidance, and the configured permission mode", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-openai-secret");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/ambient/claude-home");
    let call: readonly unknown[] = [];
    try {
      const harness = new ClaudeBasicHarness(factoryContext("acceptEdits"), {
        spawnProcess: fakeSpawn({ result: "done", session_id: "session-1" }, (args) => { call = args; }),
        clientModuleUrl: "@relayer/graph-client",
      });
      await harness.complete(runContext({
        kind: "secret", contract: "secret@1", providerId: "anthropic-work", adapterId: "anthropic-api",
        adapterImplementationVersion: "1", endpoint: "https://gateway.test/anthropic/v1", fields: { "api-key": "secret" },
      }));

      const args = call[1] as string[];
      const options = call[2] as { env: Record<string, string> };
      expect(args).toContain("--permission-mode");
      expect(args).toContain("acceptEdits");
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(args.join(" ")).toContain("sourceLayer");
      expect(args.join(" ")).toContain("clientKey");
      expect(options.env.ANTHROPIC_API_KEY).toBe("secret");
      expect(options.env.ANTHROPIC_BASE_URL).toBe("https://gateway.test/anthropic");
      expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(options.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
      expect(harness.state()).toEqual({ claudeSessionId: "session-1" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses definition-scoped managed runtime state and explicit bypass only for full access", async () => {
    let call: readonly unknown[] = [];
    const harness = new ClaudeBasicHarness(factoryContext("bypassPermissions", { claudeSessionId: "prior" }), {
      spawnProcess: fakeSpawn({ result: "done" }, (args) => { call = args; }),
    });
    await harness.complete(runContext({
      kind: "managed-runtime", contract: "managed-runtime@1", providerId: "claude-work", adapterId: "claude-subscription",
      adapterImplementationVersion: "1", executable: "/managed/claude", environment: {
        CLAUDE_CONFIG_DIR: "/isolated",
        ANTHROPIC_API_KEY: "injected-unrelated-secret",
        RELAYER_GRAPH_TOKEN: "injected-graph-token",
      },
    }));
    expect(call[0]).toBe("/managed/claude");
    expect(call[1]).toEqual(expect.arrayContaining(["--resume", "prior", "--dangerously-skip-permissions"]));
    const environment = (call[2] as { env: Record<string, string> }).env;
    expect(environment.CLAUDE_CONFIG_DIR).toBe("/isolated");
    expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(environment.RELAYER_GRAPH_TOKEN).toBe("token");
  });

  it("never surfaces provider stderr from a failed Claude process", async () => {
    const harness = new ClaudeBasicHarness(factoryContext("ask"), {
      spawnProcess: failingSpawn("upstream rejected sk-secret customer@example.test"),
    });
    await expect(harness.complete(runContext({
      kind: "secret", contract: "secret@1", providerId: "anthropic-work", adapterId: "anthropic-api",
      adapterImplementationVersion: "1", endpoint: "https://api.anthropic.com/v1", fields: { "api-key": "sk-secret" },
    }))).rejects.toThrow("Claude CLI completion failed.");
    await expect(harness.complete(runContext({
      kind: "secret", contract: "secret@1", providerId: "anthropic-work", adapterId: "anthropic-api",
      adapterImplementationVersion: "1", endpoint: "https://api.anthropic.com/v1", fields: { "api-key": "sk-secret" },
    }))).rejects.not.toThrow(/sk-secret|customer@example\.test|upstream rejected/);
  });
});
