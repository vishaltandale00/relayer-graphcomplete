import { describe, expect, it, vi } from "vitest";
import {
  ClaudeBasicHarness,
  claudePermissionMode,
  createClaudeBasicFactory,
  type ClaudeSdkQuery,
} from "../src/implementations/claude-basic.js";
import { createNoopHarnessTraceSink } from "../src/trace.js";
import type { HarnessExecutionAccess, HarnessFactoryContext, HarnessRunContext } from "../src/types.js";
import { expectGraphPresentationGuidance } from "./graph-presentation-guidance-assertions.js";

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

function sdkQuery(
  messages: readonly object[],
  capture: (input: Parameters<ClaudeSdkQuery>[0]) => void = () => {},
): ClaudeSdkQuery {
  return ((input) => {
    capture(input);
    return (async function* () {
      for (const message of messages) yield message;
    })();
  }) as ClaudeSdkQuery;
}

function sequentialSdkQuery(
  outputs: readonly (readonly object[])[],
  capture: (input: Parameters<ClaudeSdkQuery>[0]) => void,
): ClaudeSdkQuery {
  let index = 0;
  return ((input) => {
    capture(input);
    const messages = outputs[index++] ?? outputs.at(-1) ?? [];
    return (async function* () {
      for (const message of messages) yield message;
    })();
  }) as ClaudeSdkQuery;
}

function managedAccess(overrides = {}): HarnessExecutionAccess {
  return {
    kind: "managed-runtime",
    contract: "managed-runtime@1",
    providerId: "claude-work",
    adapterId: "claude-subscription",
    adapterImplementationVersion: "1",
    runtimeId: "claude-code",
    version: "0.3.247",
    executable: "/managed/claude",
    moduleUrl: "file:///managed/claude-agent-sdk/sdk.mjs",
    environment: { CLAUDE_CONFIG_DIR: "/isolated" },
    ...overrides,
  } as HarnessExecutionAccess;
}

function secretAccess(overrides = {}): HarnessExecutionAccess {
  return {
    kind: "secret",
    contract: "secret@1",
    providerId: "anthropic-work",
    adapterId: "anthropic-api",
    adapterImplementationVersion: "1",
    endpoint: "https://api.anthropic.com/v1",
    fields: { "api-key": "secret" },
    runtime: {
      runtimeId: "claude-code",
      version: "0.3.247",
      executable: "/managed/claude",
      moduleUrl: "file:///managed/claude-agent-sdk/sdk.mjs",
      environment: { CLAUDE_CONFIG_DIR: "/isolated/anthropic-work" },
    },
    ...overrides,
  } as HarnessExecutionAccess;
}

function runContext(access: HarnessRunContext["access"]): HarnessRunContext {
  if (!access) throw new Error("test access is required");
  const inputGraph = { id: 4, kind: "user-interaction", icon: "user", title: "Question", detail: "Explain", state: "accepted" as const };
  return {
    inputGraph,
    interactionInput: { interaction: inputGraph, contexts: [] },
    graph: { interactionNodeId: 4, acquireCapability: () => ({ url: "http://127.0.0.1:9", token: "token", nodeId: 4 }) },
    approvals: { request: async () => { throw new Error("unused approval channel"); } },
    model: { providerId: access.providerId, adapterId: access.adapterId, modelId: "claude-sonnet-4" },
    access,
    trace: createNoopHarnessTraceSink(),
  };
}

describe("ClaudeBasicHarness", () => {
  it("maps product approval modes onto supported Claude SDK permission modes", () => {
    expect(claudePermissionMode("ask")).toBe("default");
    expect(claudePermissionMode("auto")).toBe("acceptEdits");
    expect(claudePermissionMode("full")).toBe("bypassPermissions");
    expect(() => claudePermissionMode("untrusted")).toThrow(/ask, auto, or full/);
  });

  it("loads the managed SDK module and calls its query boundary with explicit runtime and graph access", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-openai-secret");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/ambient/claude-home");
    const calls: Parameters<ClaudeSdkQuery>[0][] = [];
    const loadSdk = vi.fn(async () => ({
      query: sdkQuery([
        { type: "system", subtype: "init", session_id: "session-1" },
        { type: "result", subtype: "success", result: "done", session_id: "session-1" },
      ], (input) => calls.push(input)),
    }));
    try {
      const harness = new ClaudeBasicHarness(factoryContext("acceptEdits"), {
        loadSdk,
        clientModuleUrl: "@relayer/graph-client",
      });
      await harness.complete(runContext(secretAccess({ endpoint: "https://gateway.test/anthropic/v1" })));

      expect(loadSdk).toHaveBeenCalledWith("file:///managed/claude-agent-sdk/sdk.mjs");
      expect(calls).toHaveLength(1);
      const { prompt, options } = calls[0]!;
      expect(prompt).toContain("sourceLayer");
      expect(prompt).toContain("clientKey");
      expect(prompt).toContain("Use the harness's ordinary workspace tools and reasoning as needed");
      expect(prompt).not.toContain("Codex");
      expect(prompt).not.toContain("native delegation");
      expectGraphPresentationGuidance(prompt);
      expect(options).toMatchObject({
        cwd: "/tmp",
        model: "claude-sonnet-4",
        allowedTools: ["Bash"],
        permissionMode: "acceptEdits",
        pathToClaudeCodeExecutable: "/managed/claude",
      });
      expect(options.allowDangerouslySkipPermissions).toBeUndefined();
      expect(options.env.ANTHROPIC_API_KEY).toBe("secret");
      expect(options.env.ANTHROPIC_BASE_URL).toBe("https://gateway.test/anthropic");
      expect(options.env.CLAUDE_CONFIG_DIR).toBe("/isolated/anthropic-work");
      expect(options.env.DISABLE_AUTOUPDATER).toBe("1");
      expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(options.env.RELAYER_GRAPH_TOKEN).toBe("token");
      expect(harness.state()).toEqual({
        claudeSessionId: "session-1",
        claudeSessionProviderDefinitionId: "anthropic-work",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("allows injecting query directly through the public factory seam", async () => {
    const query = sdkQuery([{ type: "result", subtype: "success", result: "done", session_id: "session-1" }]);
    const factory = createClaudeBasicFactory({ query });
    const harness = await factory(factoryContext("ask"));
    await expect(harness.complete(runContext(managedAccess()))).resolves.toBeUndefined();
    expect(harness.state()).toMatchObject({ claudeSessionId: "session-1" });
  });

  it("uses definition-scoped runtime state and explicit bypass only for full access", async () => {
    let call: Parameters<ClaudeSdkQuery>[0] | undefined;
    const harness = new ClaudeBasicHarness(factoryContext("bypassPermissions", {
      claudeSessionId: "prior",
      claudeSessionProviderDefinitionId: "claude-work",
    }), {
      query: sdkQuery([{ type: "result", subtype: "success", result: "done", session_id: "prior" }], (input) => { call = input; }),
    });
    await harness.complete(runContext(managedAccess({ environment: {
      CLAUDE_CONFIG_DIR: "/isolated",
      ANTHROPIC_API_KEY: "injected-unrelated-secret",
      RELAYER_GRAPH_TOKEN: "injected-graph-token",
    } })));

    expect(call?.options).toMatchObject({
      resume: "prior",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      pathToClaudeCodeExecutable: "/managed/claude",
    });
    expect(call?.options.env.CLAUDE_CONFIG_DIR).toBe("/isolated");
    expect(call?.options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(call?.options.env.RELAYER_GRAPH_TOKEN).toBe("token");
  });

  it("preserves one conventional Windows Path for Claude SDK Bash execution", async () => {
    let call: Parameters<ClaudeSdkQuery>[0] | undefined;
    const harness = new ClaudeBasicHarness(factoryContext("ask"), {
      platform: "win32",
      query: sdkQuery([
        { type: "result", subtype: "success", result: "done", session_id: "session-1" },
      ], (input) => { call = input; }),
    });

    await harness.complete(runContext(managedAccess({ environment: {
      PATH: "C:\\ambiguous\\bin",
      Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
      CLAUDE_CONFIG_DIR: "C:\\Relayer\\claude-home",
    } })));

    expect(call?.options.env.Path).toBe("C:\\Windows\\System32;C:\\Program Files\\nodejs");
    expect(call?.options.env).not.toHaveProperty("PATH");
    expect(Object.keys(call?.options.env ?? {}).filter((key) => key.toLowerCase() === "path")).toEqual(["Path"]);
  });

  it("resumes a session only for repeated turns through the same provider definition", async () => {
    const calls: Parameters<ClaudeSdkQuery>[0][] = [];
    const harness = new ClaudeBasicHarness(factoryContext("ask"), {
      query: sequentialSdkQuery([
        [{ type: "result", subtype: "success", result: "first", session_id: "session-1" }],
        [{ type: "result", subtype: "success", result: "second", session_id: "session-1" }],
      ], (input) => calls.push(input)),
    });
    const access = secretAccess();

    await harness.complete(runContext(access));
    await harness.complete(runContext(access));

    expect(calls[0]?.options.resume).toBeUndefined();
    expect(calls[1]?.options.resume).toBe("session-1");
  });

  it.each([
    { name: "subscription to API", next: secretAccess({ providerId: "anthropic-personal" }) },
    { name: "API to subscription", savedProviderDefinitionId: "anthropic-work", next: managedAccess({ providerId: "claude-work" }) },
    { name: "one subscription definition to another", next: managedAccess({ providerId: "claude-personal" }) },
  ])("does not resume when switching from a saved provider definition: $name", async ({ next, ...fixture }) => {
    let call: Parameters<ClaudeSdkQuery>[0] | undefined;
    const harness = new ClaudeBasicHarness(factoryContext("ask", {
      claudeSessionId: "prior",
      claudeSessionProviderDefinitionId: fixture.savedProviderDefinitionId ?? "claude-work",
    }), {
      query: sdkQuery([
        { type: "system", subtype: "init", session_id: "replacement" },
        { type: "result", subtype: "success", result: "done", session_id: "replacement" },
      ], (input) => { call = input; }),
    });

    await harness.complete(runContext(next));

    expect(call?.options.resume).toBeUndefined();
    expect(harness.state()).toEqual({
      claudeSessionId: "replacement",
      claudeSessionProviderDefinitionId: next.providerId,
    });
  });

  it("ignores legacy unscoped saved state because its provider identity cannot be proven", async () => {
    let call: Parameters<ClaudeSdkQuery>[0] | undefined;
    const harness = new ClaudeBasicHarness(factoryContext("ask", { claudeSessionId: "legacy" }), {
      query: sdkQuery([{ type: "result", subtype: "success", result: "done" }], (input) => { call = input; }),
    });

    await harness.complete(runContext(secretAccess()));

    expect(call?.options.resume).toBeUndefined();
    expect(harness.state()).toEqual({});
  });

  it("requires an explicit managed executable and SDK module for every provider access kind", async () => {
    const harness = new ClaudeBasicHarness(factoryContext("ask"), {
      query: sdkQuery([{ type: "result", subtype: "success", result: "done" }]),
    });
    await expect(harness.complete(runContext(managedAccess({ executable: undefined })))).rejects.toThrow(/explicit managed Claude runtime/);
    await expect(harness.complete(runContext(managedAccess({ moduleUrl: undefined })))).rejects.toThrow(/explicit managed Claude runtime/);
    await expect(harness.complete(runContext(secretAccess({ runtime: undefined })))).rejects.toThrow(/explicit managed Claude runtime/);
  });

  it("forwards abort to the SDK and preserves the caller's cancellation reason", async () => {
    let sdkSignal: AbortSignal | undefined;
    const query: ClaudeSdkQuery = ((input) => (async function* () {
      sdkSignal = input.options.abortController.signal;
      await new Promise<void>((_resolve, reject) => {
        sdkSignal!.addEventListener("abort", () => reject(sdkSignal!.reason), { once: true });
      });
      yield { type: "result", subtype: "success", result: "unreachable" };
    })()) as ClaudeSdkQuery;
    const harness = new ClaudeBasicHarness(factoryContext("ask"), { query });
    const controller = new AbortController();
    const completion = harness.complete(runContext(managedAccess()), controller.signal);
    await vi.waitFor(() => expect(sdkSignal).toBeDefined());
    controller.abort(new Error("user cancelled Claude"));
    await expect(completion).rejects.toThrow("user cancelled Claude");
    expect(sdkSignal?.aborted).toBe(true);
  });

  it("never surfaces SDK/provider error details", async () => {
    const harness = new ClaudeBasicHarness(factoryContext("ask"), {
      query: (() => (async function* () {
        throw new Error("upstream rejected sk-secret customer@example.test");
      })()) as ClaudeSdkQuery,
    });
    const completion = harness.complete(runContext(secretAccess({ fields: { "api-key": "sk-secret" } })));
    await expect(completion).rejects.toThrow("Claude Agent SDK completion failed.");
    await expect(completion).rejects.not.toThrow(/sk-secret|customer@example\.test|upstream rejected/);
  });

  it("rejects unsuccessful structured results without exposing their provider payload", async () => {
    const harness = new ClaudeBasicHarness(factoryContext("ask"), {
      query: sdkQuery([{
        type: "result", subtype: "error_during_execution", errors: ["customer@example.test sk-secret"],
      }]),
    });
    await expect(harness.complete(runContext(secretAccess()))).rejects.toThrow("Claude Agent SDK completion failed.");
    await expect(harness.complete(runContext(secretAccess()))).rejects.not.toThrow(/customer@example\.test|sk-secret/);
  });
});
