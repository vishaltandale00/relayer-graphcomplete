import { describe, expect, it, vi } from "vitest";
import {
  ClaudeBasicHarness,
  claudePermissionMode,
  createClaudeBasicFactory,
  type ClaudeSdkQuery,
  type ClaudeSdkModule,
} from "../src/implementations/claude-basic.js";
import { HarnessActionLedgerRecorder } from "../src/action-ledger.js";
import { CLAUDE_BROWSER_TOOL } from "../src/implementations/claude-basic-browser.js";
import { createNoopHarnessTraceSink } from "../src/trace.js";
import type { HarnessExecutionAccess, HarnessFactoryContext, HarnessRunContext, HarnessTraceEventInput } from "../src/types.js";
import { expectGraphPresentationGuidance } from "./graph-presentation-guidance-assertions.js";

function factoryContext(
  approvalMode: string,
  savedState = {},
  search: "disabled" | "query-v1" = "disabled",
): HarnessFactoryContext {
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
      graphCapabilityProfile: { search },
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

function browserSdk(): Pick<ClaudeSdkModule, "tool" | "createSdkMcpServer"> {
  return {
    tool: ((name: string, description: string, inputSchema: unknown, handler: unknown) => ({
      name, description, inputSchema, handler,
    })) as ClaudeSdkModule["tool"],
    createSdkMcpServer: ((options: unknown) => ({ type: "sdk", options })) as ClaudeSdkModule["createSdkMcpServer"],
  };
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
    version: "0.3.250",
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
      version: "0.3.250",
      executable: "/managed/claude",
      moduleUrl: "file:///managed/claude-agent-sdk/sdk.mjs",
      environment: { CLAUDE_CONFIG_DIR: "/isolated/anthropic-work" },
    },
    ...overrides,
  } as HarnessExecutionAccess;
}

/** A trace sink that records the visible native-session reset notices a turn emits. */
function resetRecorder(): { readonly trace: HarnessRunContext["trace"]; resets(): string[] } {
  const events: HarnessTraceEventInput[] = [];
  return {
    trace: { ...createNoopHarnessTraceSink(), emit: (event) => { events.push(event); } },
    resets: () => events
      .filter((event) => event.type === "warning" && typeof event.data.nativeSessionReset === "string")
      .map((event) => event.data.nativeSessionReset as string),
  };
}

function runContext(access: HarnessRunContext["access"]): HarnessRunContext {
  if (!access) throw new Error("test access is required");
  const inputGraph = { id: 4, kind: "user-interaction", icon: "user", title: "Question", detail: "Explain", state: "accepted" as const };
  return {
    origin: { kind: "root" },
    inputGraph,
    interactionInput: { interaction: inputGraph, contexts: [] },
    graph: { interactionNodeId: 4, acquireCapability: () => ({ url: "http://127.0.0.1:9", token: "token", nodeId: 4 }) },
    approvals: { request: async () => { throw new Error("unused approval channel"); } },
    model: { providerId: access.providerId, adapterId: access.adapterId, modelId: "claude-sonnet-4" },
    access,
    trace: createNoopHarnessTraceSink(),
  };
}

function personalPresentationRunContext(
  access: HarnessRunContext["access"],
  preference: boolean,
): HarnessRunContext {
  const context = runContext(access);
  const versionInteractionNodeId = preference ? 90 : 100;
  const rootLayerId = versionInteractionNodeId + 1;
  return {
    ...context,
    personalPresentation: {
      attachment: { interactionNodeId: 4, versionInteractionNodeId, rootLayerId },
      graph: {
        nodeId: versionInteractionNodeId,
        rootLayerId,
        rootAction: { id: rootLayerId + 1, sourceNodeId: versionInteractionNodeId, kind: "navigate", relation: "expand", label: "Personal presentation", variant: "pill", targetLayerId: rootLayerId, state: "accepted" },
        layers: [{
          layer: { id: rootLayerId, nodes: [rootLayerId + 2], edges: [], state: "accepted" },
          nodes: [{
            id: rootLayerId + 2,
            kind: preference ? "presentation-preference" : "personal-presentation-manifest",
            icon: preference ? "compass" : "settings",
            title: preference ? "Decision-useful center" : "Neutral personal presentation",
            detail: preference ? "Foreground the conclusion and material tradeoffs." : "No additional guidance.",
            state: "accepted",
          }],
          edges: [],
          actions: [],
        }],
      },
    },
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
      ...browserSdk(),
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
      const execution = harness.complete(runContext(secretAccess({ endpoint: "https://gateway.test/anthropic/v1" })));
      await execution;
      await expect(execution.attached).resolves.toEqual({
        schemaVersion: 1,
        provider: "claude",
        sessionId: "session-1",
      });

      expect(loadSdk).toHaveBeenCalledWith("file:///managed/claude-agent-sdk/sdk.mjs");
      expect(calls).toHaveLength(1);
      const { prompt, options } = calls[0]!;
      expect(prompt).toContain("sourceLayer");
      expect(prompt).toContain("clientKey");
      expect(prompt).toContain("Use the harness's ordinary workspace tools and reasoning as needed");
      expect(prompt).not.toContain("Codex");
      expect(prompt).not.toContain("native delegation");
      expect(prompt).not.toContain("Graph search is available");
      expectGraphPresentationGuidance(prompt);
      expect(prompt).toContain("graph with other live agents");
      expect(prompt).toContain("live, user-facing workspace");
      // The graph is the user's interface, so mechanics never appear in its content.
      expect(prompt).toContain("Never expose execution mechanics in graph content");
      expect(prompt).toContain("rather than on every change");
      expect(prompt).toContain("await graph.getCurrent()");
      expect(prompt).toContain("await graph.advanceCurrent(");
      expect(prompt).toContain("every distinct attached native node must receive a NEW navigate action");
      expect(prompt).toContain("Version-1 descriptions grant ability only");
      expect(prompt).toContain("Only an exact frozen attached-node navigation grant permits the exception");
      expect(prompt).not.toContain("Reused accepted nodes cannot take new actions.");
      expect(prompt).not.toContain("Do not add actions or edit published nodes afterward;");
      expect(prompt).toContain("Advancing current does not complete the interaction");
      expect(prompt).not.toContain("graph.prepareComplete(");
      expect(prompt).not.toContain("Import complete and watchCompletions from");
      expect(options).toMatchObject({
        cwd: "/tmp",
        model: "claude-sonnet-4",
        allowedTools: ["Bash", CLAUDE_BROWSER_TOOL],
        permissionMode: "acceptEdits",
        pathToClaudeCodeExecutable: "/managed/claude",
      });
      expect(options.allowDangerouslySkipPermissions).toBeUndefined();
      expect(options.mcpServers).toHaveProperty("relayer_browser");
      expect(options.env.ANTHROPIC_API_KEY).toBe("secret");
      expect(options.env.ANTHROPIC_BASE_URL).toBe("https://gateway.test/anthropic");
      expect(options.env.CLAUDE_CONFIG_DIR).toBe("/isolated/anthropic-work");
      expect(options.env.DISABLE_AUTOUPDATER).toBe("1");
      expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(options.env.RELAYER_GRAPH_TOKEN).toBe("token");
      expect(harness.state()).toEqual({
        claudeSessionLocationIdentity: expect.any(String),
        claudeSessionId: "session-1",
        claudeSessionProviderDefinitionId: "anthropic-work",
        claudeSessionPersonalPresentationVersionId: null,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("executes secret access through the factory-owned managed runtime descriptor", async () => {
    let call: Parameters<ClaudeSdkQuery>[0] | undefined;
    const resolveClaudeRuntime = vi.fn(async () => ({
      executable: "/managed/factory-claude",
      moduleUrl: "file:///managed/factory-claude/sdk.mjs",
      environment: { PATH: "/safe/bin" },
    }));
    const harness = new ClaudeBasicHarness(factoryContext("acceptEdits"), {
      resolveClaudeRuntime,
      loadSdk: async () => ({
        ...browserSdk(),
        query: sdkQuery([
          { type: "result", subtype: "success", result: "done", session_id: "session-1" },
        ], (input) => { call = input; }),
      }),
      clientModuleUrl: "@relayer/graph-client",
    });
    const access = secretAccess();
    delete (access as HarnessExecutionAccess & { runtime?: unknown }).runtime;

    await harness.complete(runContext(access));

    expect(resolveClaudeRuntime).toHaveBeenCalledOnce();
    expect(call?.options.pathToClaudeCodeExecutable).toBe("/managed/factory-claude");
    expect(call?.options.env).toMatchObject({ PATH: "/safe/bin", ANTHROPIC_API_KEY: "secret" });
  });

  it("adds semantic Complete mechanics only when the completion broker grants authority", async () => {
    const calls: Parameters<ClaudeSdkQuery>[0][] = [];
    const harness = new ClaudeBasicHarness(factoryContext("acceptEdits"), {
      loadSdk: async () => ({
        ...browserSdk(),
        query: sdkQuery([
          { type: "system", subtype: "init", session_id: "session-1" },
          { type: "result", subtype: "success", result: "done", session_id: "session-1" },
        ], (input) => calls.push(input)),
      }),
      clientModuleUrl: "@relayer/graph-client",
    });
    const context = runContext(managedAccess());

    await harness.complete({
      ...context,
      completionBroker: {
        url: "http://127.0.0.1:43125/api/completions",
        token: "12345678901234567890123456789012",
      },
    });

    expect(calls[0]?.prompt).toContain("graph.prepareComplete(invokeAction)");
    expect(calls[0]?.prompt).toContain("Import complete and watchCompletions from");
  });

  it("includes graph-search guidance only for a query-v1 capability profile", async () => {
    let prompt = "";
    const harness = new ClaudeBasicHarness(factoryContext("ask", {}, "query-v1"), {
      query: sdkQuery(
        [{ type: "result", subtype: "success", result: "done", session_id: "session-1" }],
        (input) => { prompt = input.prompt; },
      ),
      browserSdk: browserSdk(),
    });

    await harness.complete(runContext(managedAccess()));

    expect(prompt).toContain("Graph search is available");
    expect(prompt).toContain("await graph.search(request, options)");
    expect(prompt).toContain('target: { scope: "project", id: knownProjectId }');
    expect(prompt).toContain("Never invent, guess, or discover a target ID");
  });

  it("allows injecting query directly through the public factory seam", async () => {
    let call: Parameters<ClaudeSdkQuery>[0] | undefined;
    const query = sdkQuery(
      [{ type: "result", subtype: "success", result: "done", session_id: "session-1" }],
      (input) => { call = input; },
    );
    const factory = createClaudeBasicFactory({ query, browserSdk: browserSdk() });
    const harness = await factory(factoryContext("ask"));
    await expect(harness.complete(runContext(managedAccess()))).resolves.toBeUndefined();
    expect(harness.state()).toMatchObject({ claudeSessionId: "session-1" });
    expect(call?.options).toMatchObject({
      permissionMode: "default",
      allowedTools: ["Bash"],
      mcpServers: { relayer_browser: expect.anything() },
    });
  });

  it("delivers each pinned presentation version while redacting the traced Claude prompt", async () => {
    const calls: Parameters<ClaudeSdkQuery>[0][] = [];
    const events: HarnessTraceEventInput[] = [];
    const trace = createNoopHarnessTraceSink();
    const harness = new ClaudeBasicHarness(factoryContext("ask"), {
      query: sequentialSdkQuery([
        [{ type: "result", subtype: "success", result: "first", session_id: "session-1" }],
        [{ type: "result", subtype: "success", result: "second", session_id: "session-1" }],
      ], (input) => calls.push(input)),
      browserSdk: browserSdk(),
    });
    const access = managedAccess();

    await harness.complete({
      ...personalPresentationRunContext(access, true),
      trace: { ...trace, emit: (event) => { events.push(event); } },
    });
    await harness.complete(personalPresentationRunContext(access, false));

    expect(calls[0]?.prompt).toContain("Personal graph presentation preferences:");
    expect(calls[0]?.prompt).toContain("Decision-useful center: Foreground the conclusion and material tradeoffs.");
    expect(calls[0]?.prompt.indexOf("Graph presentation guidance:")).toBeLessThan(
      calls[0]!.prompt.indexOf("Personal graph presentation preferences:"),
    );
    expect(calls[0]?.prompt.indexOf("Personal graph presentation preferences:")).toBeLessThan(
      calls[0]!.prompt.indexOf("Normalized interaction input:"),
    );
    const tracedPrompt = events.find((event) => event.type === "prompt")?.data.text;
    expect(tracedPrompt).not.toContain("Personal graph presentation preferences:");
    expect(tracedPrompt).not.toContain("Decision-useful center");
    expect(calls[0]?.options.allowedTools).toEqual(["Bash"]);
    expect(calls[1]?.prompt).not.toContain("Personal graph presentation preferences:");
    expect(calls[1]?.options.resume).toBeUndefined();
    expect(harness.state()).toMatchObject({
      claudeSessionId: "session-1",
      claudeSessionPersonalPresentationVersionId: 100,
    });
  });

  it("redacts preference fragments echoed by Claude from message traces", async () => {
    const events: HarnessTraceEventInput[] = [];
    const trace = createNoopHarnessTraceSink();
    const harness = new ClaudeBasicHarness(factoryContext("ask"), {
      query: sdkQuery([{
        type: "result",
        subtype: "success",
        result: "Decision-useful center means Foreground the conclusion and material tradeoffs.",
        session_id: "session-1",
      }]),
      browserSdk: browserSdk(),
    });

    await harness.complete({
      ...personalPresentationRunContext(managedAccess(), true),
      trace: { ...trace, emit: (event) => { events.push(event); } },
    });

    const tracedMessage = events.find((event) => event.type === "message")?.data.text;
    expect(tracedMessage).toBe(
      "[redacted-personal-presentation] means [redacted-personal-presentation]",
    );
  });

  it("preserves Claude message traces without a presentation attachment", async () => {
    const events: HarnessTraceEventInput[] = [];
    const trace = createNoopHarnessTraceSink();
    const text = "Decision-useful center is ordinary task content here.";
    const harness = new ClaudeBasicHarness(factoryContext("ask"), {
      query: sdkQuery([{
        type: "result", subtype: "success", result: text, session_id: "session-1",
      }]),
      browserSdk: browserSdk(),
    });

    await harness.complete({
      ...runContext(managedAccess()),
      trace: { ...trace, emit: (event) => { events.push(event); } },
    });

    expect(events.find((event) => event.type === "message")?.data.text).toBe(text);
  });

  it("uses definition-scoped runtime state and explicit bypass only for full access", async () => {
    let call: Parameters<ClaudeSdkQuery>[0] | undefined;
    const harness = new ClaudeBasicHarness(factoryContext("bypassPermissions", {
      claudeSessionId: "prior",
      claudeSessionProviderDefinitionId: "claude-work",
      claudeSessionPersonalPresentationVersionId: null,
    }), {
      query: sdkQuery([{ type: "result", subtype: "success", result: "done", session_id: "prior" }], (input) => { call = input; }),
      browserSdk: browserSdk(),
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
    expect(call?.options.allowedTools).toEqual(["Bash"]);
    expect(call?.options.mcpServers).toHaveProperty("relayer_browser");
    expect(call?.options.env.CLAUDE_CONFIG_DIR).toBe("/isolated");
    expect(call?.options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(call?.options.env.RELAYER_GRAPH_TOKEN).toBe("token");
  });

  it.each(["missing", "changed-presentation"])("refuses legacy continuation before SDK query when history is %s", async (reason) => {
    const saved = reason === "missing" ? {} : {
      claudeSessionId: "prior", claudeSessionProviderDefinitionId: "claude-work",
      claudeSessionPersonalPresentationVersionId: 17,
    };
    const capture = vi.fn();
    const harness = new ClaudeBasicHarness(factoryContext("ask", saved), {
      query: sdkQuery([], capture), browserSdk: browserSdk(),
    });
    const before = harness.state();
    await expect(harness.complete({ ...runContext(managedAccess()), requireNativeContinuity: true }))
      .rejects.toThrow("native history cannot be verified");
    expect(capture).not.toHaveBeenCalled();
    expect(harness.state()).toEqual(before);
  });

  it("preserves legacy Claude identity after changed storage refusal and mismatched native resume", async () => {
    const calls: Parameters<ClaudeSdkQuery>[0][] = [];
    const harness = new ClaudeBasicHarness(factoryContext("ask", {
      claudeSessionId: "prior", claudeSessionProviderDefinitionId: "claude-work",
      claudeSessionPersonalPresentationVersionId: null,
    }), {
      query: sequentialSdkQuery([
        [{ type: "result", subtype: "success", result: "original", session_id: "prior" }],
        [{ type: "result", subtype: "success", result: "foreign", session_id: "foreign" }],
      ], input => calls.push(input)), browserSdk: browserSdk(),
    });
    const context = { ...runContext(managedAccess()), requireNativeContinuity: true };
    await harness.complete(context);
    const saved = harness.state();
    expect(calls[0]?.options.resume).toBe("prior");
    await expect(harness.complete({ ...runContext(managedAccess({ environment: { CLAUDE_CONFIG_DIR: "/foreign" } })), requireNativeContinuity: true }))
      .rejects.toThrow("native session location changed");
    expect(calls).toHaveLength(1);
    expect(harness.state()).toEqual(saved);
    await expect(harness.complete(context)).rejects.toThrow("Claude Agent SDK completion failed");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.options.resume).toBe("prior");
    expect(harness.state()).toEqual(saved);
  });

  it("rotates provider-scoped legacy state whose presentation version is unknown", async () => {
    let call: Parameters<ClaudeSdkQuery>[0] | undefined;
    const harness = new ClaudeBasicHarness(factoryContext("ask", {
      claudeSessionId: "legacy-session",
      claudeSessionProviderDefinitionId: "claude-work",
    }), {
      query: sdkQuery([{ type: "result", subtype: "success", result: "done", session_id: "legacy-session" }], (input) => { call = input; }),
      browserSdk: browserSdk(),
    });

    await harness.complete(runContext(managedAccess()));

    expect(call?.options.resume).toBeUndefined();
    expect(harness.state()).toEqual({
      claudeSessionLocationIdentity: expect.any(String),
      claudeSessionId: "legacy-session",
      claudeSessionProviderDefinitionId: "claude-work",
      claudeSessionPersonalPresentationVersionId: null,
    });
  });

  it("preserves one conventional Windows Path for Claude SDK Bash execution", async () => {
    let call: Parameters<ClaudeSdkQuery>[0] | undefined;
    const harness = new ClaudeBasicHarness(factoryContext("ask"), {
      platform: "win32",
      query: sdkQuery([
        { type: "result", subtype: "success", result: "done", session_id: "session-1" },
      ], (input) => { call = input; }),
      browserSdk: browserSdk(),
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
      browserSdk: browserSdk(),
    });
    const access = secretAccess();

    await harness.complete(runContext(access));
    await harness.complete(runContext(access));

    expect(calls[0]?.options.resume).toBeUndefined();
    expect(calls[1]?.options.resume).toBe("session-1");
  });

  it("starts invoked completions in fresh sessions without replacing root continuity", async () => {
    const calls: Parameters<ClaudeSdkQuery>[0][] = [];
    const harness = new ClaudeBasicHarness(factoryContext("acceptEdits", {
      claudeSessionId: "root-session",
      claudeSessionProviderDefinitionId: "claude-work",
      claudeSessionPersonalPresentationVersionId: null,
    }), {
      query: sequentialSdkQuery([
        [{ type: "result", subtype: "success", result: "child a", session_id: "child-a" }],
        [{ type: "result", subtype: "success", result: "child b", session_id: "child-b" }],
        [{ type: "result", subtype: "success", result: "root", session_id: "root-session" }],
      ], (input) => calls.push(input)),
      browserSdk: browserSdk(),
    });
    const access = managedAccess();
    const child = (actionId: number, childAccess: HarnessExecutionAccess = access): HarnessRunContext => ({
      ...runContext(childAccess),
      origin: { kind: "invoke", sourceCompletionId: 1, actionId },
    });

    await Promise.all([
      harness.complete(child(101)),
      harness.complete(child(102, secretAccess())),
    ]);
    expect(calls.slice(0, 2).map(({ options }) => options.resume)).toEqual([undefined, undefined]);
    expect(harness.state()).toEqual({
      claudeSessionId: "root-session",
      claudeSessionProviderDefinitionId: "claude-work",
      claudeSessionPersonalPresentationVersionId: null,
    });

    await harness.complete(runContext(access));
    expect(calls[2]?.options.resume).toBe("root-session");
  });

  it("rejects an invoked completion that succeeds without a durable session identity", async () => {
    const harness = new ClaudeBasicHarness(factoryContext("acceptEdits"), {
      query: sdkQuery([
        { type: "result", subtype: "success", result: "child without a session" },
      ]),
      browserSdk: browserSdk(),
    });
    const context: HarnessRunContext = {
      ...runContext(managedAccess()),
      origin: { kind: "invoke", sourceCompletionId: 1, actionId: 101 },
    };

    const execution = harness.complete(context);

    await expect(execution).rejects.toThrow("Claude invoked completion did not expose a durable native session identity");
    await expect(execution.attached).rejects.toThrow("Claude invoked completion did not expose a durable native session identity");
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
      browserSdk: browserSdk(),
    });

    const recorder = resetRecorder();
    await harness.complete({ ...runContext(next), trace: recorder.trace });

    expect(call?.options.resume).toBeUndefined();
    // The previous native conversation cannot be continued here, and the turn says so.
    expect(recorder.resets()).toEqual(["provider_changed"]);
    expect(harness.state()).toEqual({
      claudeSessionLocationIdentity: expect.any(String),
      claudeSessionId: "replacement",
      claudeSessionProviderDefinitionId: next.providerId,
      claudeSessionPersonalPresentationVersionId: null,
    });
  });

  it("preserves unverified legacy state by refusing registration before execution", () => {
    expect(() => new ClaudeBasicHarness(factoryContext("ask", { claudeSessionId: "legacy" }), {
      query: sdkQuery([]), browserSdk: browserSdk(),
    })).toThrow("unverified ownership");
  });

  it("requires an explicit managed executable and SDK module for every provider access kind", async () => {
    const harness = new ClaudeBasicHarness(factoryContext("ask"), {
      query: sdkQuery([{ type: "result", subtype: "success", result: "done" }]),
      browserSdk: browserSdk(),
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
    const harness = new ClaudeBasicHarness(factoryContext("ask"), { query, browserSdk: browserSdk() });
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
      browserSdk: browserSdk(),
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
      browserSdk: browserSdk(),
    });
    await expect(harness.complete(runContext(secretAccess()))).rejects.toThrow("Claude Agent SDK completion failed.");
    await expect(harness.complete(runContext(secretAccess()))).rejects.not.toThrow(/customer@example\.test|sk-secret/);
  });
});

describe("ClaudeBasicHarness action ledger (#584, CONT-013)", () => {
  const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
    type: "assistant", session_id: "session-1", message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const toolResult = (id: string, isError: boolean) => ({
    type: "user", session_id: "session-1",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: `secret-tool-output-${id}` }] },
  });

  it("records tool calls from the Agent SDK's own messages, since Claude emits no tool events", async () => {
    const recorder = new HarnessActionLedgerRecorder();
    const harness = new ClaudeBasicHarness(factoryContext("full"), {
      query: sdkQuery([
        { type: "system", subtype: "init", session_id: "session-1" },
        toolUse("bash-1", "Bash", { command: "npm test\necho secret-second-line", description: "Run tests" }),
        toolResult("bash-1", true),
        toolUse("edit-1", "Edit", { file_path: "src/queue.ts", old_string: "secret-old", new_string: "secret-new" }),
        toolResult("edit-1", false),
        toolUse("fetch-1", "WebFetch", { url: "https://docs.bullmq.io/retries", prompt: "secret-fetch-prompt" }),
        toolResult("fetch-1", false),
        toolUse("browser-1", CLAUDE_BROWSER_TOOL, { action: "read", token: "secret-browser-input" }),
        toolResult("browser-1", false),
        toolUse("task-1", "Task", { subagent_type: "general-purpose", description: "Compare queues", prompt: "secret-task-prompt" }),
        toolResult("task-1", false),
        toolUse("read-1", "Read", { file_path: "package.json" }),
        toolResult("read-1", false),
        { type: "assistant", session_id: "session-1", message: { content: [{ type: "text", text: "secret-assistant-text" }] } },
        toolUse("bash-2", "Bash", { command: "npm run migrate" }),
        { type: "result", subtype: "success", result: "done", session_id: "session-1" },
      ]),
      browserSdk: browserSdk(),
    });

    await harness.complete({ ...runContext(managedAccess()), actions: recorder });
    const ledger = recorder.seal();

    expect(ledger).toEqual({
      entries: [
        { kind: "command", summary: "npm test …", status: "failed" },
        { kind: "file_change", summary: "Edit src/queue.ts", status: "completed" },
        { kind: "web", summary: "fetch https://docs.bullmq.io/retries", status: "completed" },
        { kind: "mcp_tool", summary: CLAUDE_BROWSER_TOOL.replace(/^mcp__(.+?)__/, "$1."), status: "completed" },
        { kind: "native_subagent", summary: "general-purpose: Compare queues", status: "completed" },
        { kind: "other", summary: "Read package.json", status: "completed" },
        { kind: "command", summary: "npm run migrate", status: "interrupted" },
      ],
      omitted: 0,
    });
    expect(JSON.stringify(ledger)).not.toContain("secret-");
  });

  it("keeps a stopped Claude turn's actions, with the unfinished one interrupted", async () => {
    const recorder = new HarnessActionLedgerRecorder();
    let sdkSignal: AbortSignal | undefined;
    const query: ClaudeSdkQuery = ((input) => (async function* () {
      sdkSignal = input.options.abortController.signal;
      yield toolUse("bash-1", "Bash", { command: "npm run migrate" });
      await new Promise<void>((_resolve, reject) => {
        sdkSignal!.addEventListener("abort", () => reject(sdkSignal!.reason), { once: true });
      });
    })()) as ClaudeSdkQuery;
    const harness = new ClaudeBasicHarness(factoryContext("full"), { query, browserSdk: browserSdk() });
    const controller = new AbortController();
    const completion = harness.complete({ ...runContext(managedAccess()), actions: recorder }, controller.signal);
    await vi.waitFor(() => expect(sdkSignal).toBeDefined());
    controller.abort(new Error("Stopped by user"));
    await expect(completion).rejects.toThrow("Stopped by user");

    expect(recorder.seal()).toEqual({
      entries: [{ kind: "command", summary: "npm run migrate", status: "interrupted" }],
      omitted: 0,
    });
  });

  it("keeps the actions a failed Claude turn took before it failed", async () => {
    const recorder = new HarnessActionLedgerRecorder();
    const harness = new ClaudeBasicHarness(factoryContext("full"), {
      query: sdkQuery([
        toolUse("bash-1", "Bash", { command: "npm run migrate" }),
        toolResult("bash-1", false),
        toolUse("bash-2", "Bash", { command: "npm run seed" }),
        { type: "result", subtype: "error_during_execution", errors: ["secret-provider-error"] },
      ]),
      browserSdk: browserSdk(),
    });

    await expect(harness.complete({ ...runContext(managedAccess()), actions: recorder })).rejects.toThrow("Claude Agent SDK completion failed.");

    expect(recorder.seal()).toEqual({
      entries: [
        { kind: "command", summary: "npm run migrate", status: "completed" },
        { kind: "command", summary: "npm run seed", status: "interrupted" },
      ],
      omitted: 0,
    });
  });
});
