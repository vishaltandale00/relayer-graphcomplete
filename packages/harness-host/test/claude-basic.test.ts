import { describe, expect, it, vi } from "vitest";
import {
  ClaudeBasicHarness,
  claudePermissionMode,
  createClaudeBasicFactory,
  type ClaudeSdkQuery,
  type ClaudeSdkModule,
} from "../src/implementations/claude-basic.js";
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
  it("loads the managed Claude SDK and wires explicit runtime, permission, and environment access", async () => {
    const approvalModes = [
      ["ask", "default"],
      ["auto", "acceptEdits"],
      ["full", "bypassPermissions"],
    ] as const;
    expect(approvalModes, "approval mode inventory").toHaveLength(3);
    for (const [approvalMode, permissionMode] of approvalModes) {
      expect(claudePermissionMode(approvalMode), `approval mode ${approvalMode}`).toBe(permissionMode);
    }
    expect(() => claudePermissionMode("untrusted"), "unknown approval mode").toThrow(/ask, auto, or full/);

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
      await expect(execution.attached, "invoked attachment identity").resolves.toEqual({
        schemaVersion: 1,
        provider: "claude",
        sessionId: "session-1",
      });

      expect(loadSdk, "managed SDK module URL").toHaveBeenCalledWith("file:///managed/claude-agent-sdk/sdk.mjs");
      expect(calls, "single query boundary call").toHaveLength(1);
      const { prompt, options } = calls[0]!;
      expect(prompt, "graph authoring guidance").toContain("sourceLayer");
      expect(prompt).toContain("clientKey");
      expect(prompt).toContain("Use the harness's ordinary workspace tools and reasoning as needed");
      expect(prompt, "no Codex mechanics").not.toContain("Codex");
      expect(prompt).not.toContain("native delegation");
      expect(prompt, "search guidance disabled by default").not.toContain("Graph search is available");
      expectGraphPresentationGuidance(prompt);
      expect(prompt, "shared graph context").toContain("graph with other live agents");
      expect(prompt).toContain("live, user-facing workspace");
      expect(prompt).toContain("await graph.getCurrent()");
      expect(prompt).toContain("await graph.advanceCurrent(");
      expect(prompt).toContain("Advancing current does not complete the interaction");
      expect(prompt, "no Complete mechanics without broker authority").not.toContain("graph.prepareComplete(");
      expect(prompt).not.toContain("Import complete from");
      expect(options, "query boundary options").toMatchObject({
        cwd: "/tmp",
        model: "claude-sonnet-4",
        allowedTools: ["Bash", CLAUDE_BROWSER_TOOL],
        permissionMode: "acceptEdits",
        pathToClaudeCodeExecutable: "/managed/claude",
      });
      expect(options.allowDangerouslySkipPermissions, "no permission bypass outside full access").toBeUndefined();
      expect(options.mcpServers, "browser MCP server registered").toHaveProperty("relayer_browser");
      expect(options.env.ANTHROPIC_API_KEY, "explicit secret access").toBe("secret");
      expect(options.env.ANTHROPIC_BASE_URL, "gateway endpoint without trailing version").toBe("https://gateway.test/anthropic");
      expect(options.env.CLAUDE_CONFIG_DIR, "isolated config directory").toBe("/isolated/anthropic-work");
      expect(options.env.DISABLE_AUTOUPDATER, "autoupdater disabled").toBe("1");
      expect(options.env, "ambient OpenAI secret excluded").not.toHaveProperty("OPENAI_API_KEY");
      expect(options.env.RELAYER_GRAPH_TOKEN, "graph capability token").toBe("token");
      expect(harness.state(), "durable session state").toEqual({
        claudeSessionId: "session-1",
        claudeSessionProviderDefinitionId: "anthropic-work",
        claudeSessionPersonalPresentationVersionId: null,
      });
    } finally {
      vi.unstubAllEnvs();
    }

    let descriptorCall: Parameters<ClaudeSdkQuery>[0] | undefined;
    const resolveClaudeRuntime = vi.fn(async () => ({
      executable: "/managed/factory-claude",
      moduleUrl: "file:///managed/factory-claude/sdk.mjs",
      environment: { PATH: "/safe/bin" },
    }));
    const descriptorHarness = new ClaudeBasicHarness(factoryContext("acceptEdits"), {
      resolveClaudeRuntime,
      loadSdk: async () => ({
        ...browserSdk(),
        query: sdkQuery([
          { type: "result", subtype: "success", result: "done", session_id: "session-1" },
        ], (input) => { descriptorCall = input; }),
      }),
      clientModuleUrl: "@relayer/graph-client",
    });
    const descriptorAccess = secretAccess();
    delete (descriptorAccess as HarnessExecutionAccess & { runtime?: unknown }).runtime;

    await descriptorHarness.complete(runContext(descriptorAccess));

    expect(resolveClaudeRuntime, "factory-owned runtime descriptor").toHaveBeenCalledOnce();
    expect(descriptorCall?.options.pathToClaudeCodeExecutable, "descriptor executable").toBe("/managed/factory-claude");
    expect(descriptorCall?.options.env, "descriptor environment").toMatchObject({ PATH: "/safe/bin", ANTHROPIC_API_KEY: "secret" });

    let injectedCall: Parameters<ClaudeSdkQuery>[0] | undefined;
    const injectedQuery = sdkQuery(
      [{ type: "result", subtype: "success", result: "done", session_id: "session-1" }],
      (input) => { injectedCall = input; },
    );
    const factory = createClaudeBasicFactory({ query: injectedQuery, browserSdk: browserSdk() });
    const injectedHarness = await factory(factoryContext("ask"));
    await expect(injectedHarness.complete(runContext(managedAccess())), "injected query seam").resolves.toBeUndefined();
    expect(injectedHarness.state(), "injected query session state").toMatchObject({ claudeSessionId: "session-1" });
    expect(injectedCall?.options, "injected query options").toMatchObject({
      permissionMode: "default",
      allowedTools: ["Bash"],
      mcpServers: { relayer_browser: expect.anything() },
    });

    let windowsCall: Parameters<ClaudeSdkQuery>[0] | undefined;
    const windowsHarness = new ClaudeBasicHarness(factoryContext("ask"), {
      platform: "win32",
      query: sdkQuery([
        { type: "result", subtype: "success", result: "done", session_id: "session-1" },
      ], (input) => { windowsCall = input; }),
      browserSdk: browserSdk(),
    });

    await windowsHarness.complete(runContext(managedAccess({ environment: {
      PATH: "C:\\ambiguous\\bin",
      Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
      CLAUDE_CONFIG_DIR: "C:\\Relayer\\claude-home",
    } })));

    expect(windowsCall?.options.env.Path, "conventional Windows Path preserved").toBe("C:\\Windows\\System32;C:\\Program Files\\nodejs");
    expect(windowsCall?.options.env, "ambiguous PATH dropped").not.toHaveProperty("PATH");
    expect(Object.keys(windowsCall?.options.env ?? {}).filter((key) => key.toLowerCase() === "path"), "exactly one Path casing").toEqual(["Path"]);
  });

  it("adds broker-gated Complete mechanics and profile-gated graph search to the prompt", async () => {
    const brokerCalls: Parameters<ClaudeSdkQuery>[0][] = [];
    const brokerHarness = new ClaudeBasicHarness(factoryContext("acceptEdits"), {
      loadSdk: async () => ({
        ...browserSdk(),
        query: sdkQuery([
          { type: "system", subtype: "init", session_id: "session-1" },
          { type: "result", subtype: "success", result: "done", session_id: "session-1" },
        ], (input) => brokerCalls.push(input)),
      }),
      clientModuleUrl: "@relayer/graph-client",
    });

    await brokerHarness.complete({
      ...runContext(managedAccess()),
      completionBroker: {
        url: "http://127.0.0.1:43125/api/completions",
        token: "12345678901234567890123456789012",
      },
    });

    expect(brokerCalls[0]?.prompt, "Complete mechanics with broker authority").toContain("graph.prepareComplete(invokeAction)");
    expect(brokerCalls[0]?.prompt, "Complete import with broker authority").toContain("Import complete from");

    const searchProfiles = [
      ["disabled", false],
      ["query-v1", true],
    ] as const;
    expect(searchProfiles, "search profile inventory").toHaveLength(2);
    for (const [search, available] of searchProfiles) {
      let searchPrompt = "";
      const searchHarness = new ClaudeBasicHarness(factoryContext("ask", {}, search), {
        query: sdkQuery(
          [{ type: "result", subtype: "success", result: "done", session_id: "session-1" }],
          (input) => { searchPrompt = input.prompt; },
        ),
        browserSdk: browserSdk(),
      });
      await searchHarness.complete(runContext(managedAccess()));
      if (!available) {
        expect(searchPrompt, `${search} profile omits graph search`).not.toContain("Graph search is available");
        expect(searchPrompt, `${search} profile omits the search call`).not.toContain("await graph.search(request, options)");
        continue;
      }
      expect(searchPrompt, `${search} profile announces graph search`).toContain("Graph search is available");
      expect(searchPrompt, `${search} profile search call`).toContain("await graph.search(request, options)");
      expect(searchPrompt, `${search} profile target shape`).toContain('target: { scope: "project", id: knownProjectId }');
      expect(searchPrompt, `${search} profile target discovery ban`).toContain("Never invent, guess, or discover a target ID");
    }
  });

  it("delivers pinned presentation versions and redacts preference fragments from traces", async () => {
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

    expect(calls[0]?.prompt, "preference section delivered").toContain("Personal graph presentation preferences:");
    expect(calls[0]?.prompt, "preference content delivered").toContain("Decision-useful center: Foreground the conclusion and material tradeoffs.");
    expect(calls[0]?.prompt.indexOf("Graph presentation guidance:"), "guidance precedes preferences").toBeLessThan(
      calls[0]!.prompt.indexOf("Personal graph presentation preferences:"),
    );
    expect(calls[0]?.prompt.indexOf("Personal graph presentation preferences:"), "preferences precede interaction input").toBeLessThan(
      calls[0]!.prompt.indexOf("Normalized interaction input:"),
    );
    const tracedPrompt = events.find((event) => event.type === "prompt")?.data.text;
    expect(tracedPrompt, "traced prompt redacts preferences").not.toContain("Personal graph presentation preferences:");
    expect(tracedPrompt, "traced prompt redacts preference content").not.toContain("Decision-useful center");
    expect(calls[0]?.options.allowedTools, "preference turn tools").toEqual(["Bash"]);
    expect(calls[1]?.prompt, "second pinned version has no first preferences").not.toContain("Personal graph presentation preferences:");
    expect(calls[1]?.options.resume, "presentation change breaks resume").toBeUndefined();
    expect(harness.state(), "state tracks the second presentation pin").toMatchObject({
      claudeSessionId: "session-1",
      claudeSessionPersonalPresentationVersionId: 100,
    });

    const echoedEvents: HarnessTraceEventInput[] = [];
    const echoedHarness = new ClaudeBasicHarness(factoryContext("ask"), {
      query: sdkQuery([{
        type: "result",
        subtype: "success",
        result: "Decision-useful center means Foreground the conclusion and material tradeoffs.",
        session_id: "session-1",
      }]),
      browserSdk: browserSdk(),
    });

    await echoedHarness.complete({
      ...personalPresentationRunContext(managedAccess(), true),
      trace: { ...trace, emit: (event) => { echoedEvents.push(event); } },
    });

    expect(echoedEvents.find((event) => event.type === "message")?.data.text, "echoed preference fragments redacted").toBe(
      "[redacted-personal-presentation] means [redacted-personal-presentation]",
    );

    const preservedEvents: HarnessTraceEventInput[] = [];
    const text = "Decision-useful center is ordinary task content here.";
    const preservedHarness = new ClaudeBasicHarness(factoryContext("ask"), {
      query: sdkQuery([{
        type: "result", subtype: "success", result: text, session_id: "session-1",
      }]),
      browserSdk: browserSdk(),
    });

    await preservedHarness.complete({
      ...runContext(managedAccess()),
      trace: { ...trace, emit: (event) => { preservedEvents.push(event); } },
    });

    expect(preservedEvents.find((event) => event.type === "message")?.data.text, "message preserved without presentation attachment").toBe(text);
  });

  it("resumes sessions only within a proven provider definition", async () => {
    let bypassCall: Parameters<ClaudeSdkQuery>[0] | undefined;
    const bypassHarness = new ClaudeBasicHarness(factoryContext("bypassPermissions", {
      claudeSessionId: "prior",
      claudeSessionProviderDefinitionId: "claude-work",
      claudeSessionPersonalPresentationVersionId: null,
    }), {
      query: sdkQuery([{ type: "result", subtype: "success", result: "done", session_id: "prior" }], (input) => { bypassCall = input; }),
      browserSdk: browserSdk(),
    });
    await bypassHarness.complete(runContext(managedAccess({ environment: {
      CLAUDE_CONFIG_DIR: "/isolated",
      ANTHROPIC_API_KEY: "injected-unrelated-secret",
      RELAYER_GRAPH_TOKEN: "injected-graph-token",
    } })));

    expect(bypassCall?.options, "full access uses explicit bypass").toMatchObject({
      resume: "prior",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      pathToClaudeCodeExecutable: "/managed/claude",
    });
    expect(bypassCall?.options.allowedTools, "full access tools").toEqual(["Bash"]);
    expect(bypassCall?.options.mcpServers, "full access browser server").toHaveProperty("relayer_browser");
    expect(bypassCall?.options.env.CLAUDE_CONFIG_DIR, "definition-scoped config directory").toBe("/isolated");
    expect(bypassCall?.options.env, "injected secret dropped").not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(bypassCall?.options.env.RELAYER_GRAPH_TOKEN, "graph token not spoofable").toBe("token");

    const resumeCalls: Parameters<ClaudeSdkQuery>[0][] = [];
    const resumeHarness = new ClaudeBasicHarness(factoryContext("ask"), {
      query: sequentialSdkQuery([
        [{ type: "result", subtype: "success", result: "first", session_id: "session-1" }],
        [{ type: "result", subtype: "success", result: "second", session_id: "session-1" }],
      ], (input) => resumeCalls.push(input)),
      browserSdk: browserSdk(),
    });
    const resumeAccess = secretAccess();

    await resumeHarness.complete(runContext(resumeAccess));
    await resumeHarness.complete(runContext(resumeAccess));

    expect(resumeCalls[0]?.options.resume, "first turn starts fresh").toBeUndefined();
    expect(resumeCalls[1]?.options.resume, "repeated turn through the same provider resumes").toBe("session-1");

    const invokedCalls: Parameters<ClaudeSdkQuery>[0][] = [];
    const invokedHarness = new ClaudeBasicHarness(factoryContext("acceptEdits", {
      claudeSessionId: "root-session",
      claudeSessionProviderDefinitionId: "claude-work",
      claudeSessionPersonalPresentationVersionId: null,
    }), {
      query: sequentialSdkQuery([
        [{ type: "result", subtype: "success", result: "child a", session_id: "child-a" }],
        [{ type: "result", subtype: "success", result: "child b", session_id: "child-b" }],
        [{ type: "result", subtype: "success", result: "root", session_id: "root-session" }],
      ], (input) => invokedCalls.push(input)),
      browserSdk: browserSdk(),
    });
    const invokedAccess = managedAccess();
    const child = (actionId: number, childAccess: HarnessExecutionAccess = invokedAccess): HarnessRunContext => ({
      ...runContext(childAccess),
      origin: { kind: "invoke", sourceCompletionId: 1, actionId },
    });

    await Promise.all([
      invokedHarness.complete(child(101)),
      invokedHarness.complete(child(102, secretAccess())),
    ]);
    expect(invokedCalls.slice(0, 2).map(({ options }) => options.resume), "invoked completions never resume").toEqual([undefined, undefined]);
    expect(invokedHarness.state(), "root continuity survives invoked completions").toEqual({
      claudeSessionId: "root-session",
      claudeSessionProviderDefinitionId: "claude-work",
      claudeSessionPersonalPresentationVersionId: null,
    });

    await invokedHarness.complete(runContext(invokedAccess));
    expect(invokedCalls[2]?.options.resume, "root turn resumes after invoked completions").toBe("root-session");

    const identityHarness = new ClaudeBasicHarness(factoryContext("acceptEdits"), {
      query: sdkQuery([
        { type: "result", subtype: "success", result: "child without a session" },
      ]),
      browserSdk: browserSdk(),
    });
    const identityContext: HarnessRunContext = {
      ...runContext(managedAccess()),
      origin: { kind: "invoke", sourceCompletionId: 1, actionId: 101 },
    };

    const identityExecution = identityHarness.complete(identityContext);

    await expect(identityExecution, "invoked completion without durable session identity").rejects.toThrow("Claude invoked completion did not expose a durable native session identity");
    await expect(identityExecution.attached, "attachment mirrors the identity failure").rejects.toThrow("Claude invoked completion did not expose a durable native session identity");

    const switchRows: readonly {
      label: string;
      savedState: Record<string, unknown>;
      next: () => HarnessExecutionAccess;
      messages: readonly object[];
      expectedState: Record<string, unknown>;
    }[] = [
      {
        label: "subscription to API",
        savedState: { claudeSessionId: "prior", claudeSessionProviderDefinitionId: "claude-work" },
        next: () => secretAccess({ providerId: "anthropic-personal" }),
        messages: [
          { type: "system", subtype: "init", session_id: "replacement" },
          { type: "result", subtype: "success", result: "done", session_id: "replacement" },
        ],
        expectedState: { claudeSessionId: "replacement", claudeSessionProviderDefinitionId: "anthropic-personal", claudeSessionPersonalPresentationVersionId: null },
      },
      {
        label: "API to subscription",
        savedState: { claudeSessionId: "prior", claudeSessionProviderDefinitionId: "anthropic-work" },
        next: () => managedAccess({ providerId: "claude-work" }),
        messages: [
          { type: "system", subtype: "init", session_id: "replacement" },
          { type: "result", subtype: "success", result: "done", session_id: "replacement" },
        ],
        expectedState: { claudeSessionId: "replacement", claudeSessionProviderDefinitionId: "claude-work", claudeSessionPersonalPresentationVersionId: null },
      },
      {
        label: "one subscription definition to another",
        savedState: { claudeSessionId: "prior", claudeSessionProviderDefinitionId: "claude-work" },
        next: () => managedAccess({ providerId: "claude-personal" }),
        messages: [
          { type: "system", subtype: "init", session_id: "replacement" },
          { type: "result", subtype: "success", result: "done", session_id: "replacement" },
        ],
        expectedState: { claudeSessionId: "replacement", claudeSessionProviderDefinitionId: "claude-personal", claudeSessionPersonalPresentationVersionId: null },
      },
      {
        label: "provider-scoped legacy state whose presentation version is unknown",
        savedState: { claudeSessionId: "legacy-session", claudeSessionProviderDefinitionId: "claude-work" },
        next: () => managedAccess(),
        messages: [{ type: "result", subtype: "success", result: "done", session_id: "legacy-session" }],
        expectedState: { claudeSessionId: "legacy-session", claudeSessionProviderDefinitionId: "claude-work", claudeSessionPersonalPresentationVersionId: null },
      },
      {
        label: "legacy unscoped saved state",
        savedState: { claudeSessionId: "legacy" },
        next: () => secretAccess(),
        messages: [{ type: "result", subtype: "success", result: "done" }],
        expectedState: {},
      },
    ];
    expect(switchRows, "resume suppression inventory").toHaveLength(5);
    for (const { label, savedState, next, messages, expectedState } of switchRows) {
      let switchCall: Parameters<ClaudeSdkQuery>[0] | undefined;
      const switchHarness = new ClaudeBasicHarness(factoryContext("ask", savedState), {
        query: sdkQuery([...messages], (input) => { switchCall = input; }),
        browserSdk: browserSdk(),
      });

      await switchHarness.complete(runContext(next()));

      expect(switchCall?.options.resume, `${label} must not resume`).toBeUndefined();
      expect(switchHarness.state(), `${label} state`).toEqual(expectedState);
    }
  });

  it("fails and cancels without surfacing provider details", async () => {
    const runtimeRequirementRows = [
      ["managed access without executable", () => managedAccess({ executable: undefined })],
      ["managed access without SDK module", () => managedAccess({ moduleUrl: undefined })],
      ["secret access without runtime descriptor", () => secretAccess({ runtime: undefined })],
    ] as const;
    expect(runtimeRequirementRows, "runtime requirement inventory").toHaveLength(3);
    for (const [label, access] of runtimeRequirementRows) {
      const harness = new ClaudeBasicHarness(factoryContext("ask"), {
        query: sdkQuery([{ type: "result", subtype: "success", result: "done" }]),
        browserSdk: browserSdk(),
      });
      await expect(harness.complete(runContext(access())), label).rejects.toThrow(/explicit managed Claude runtime/);
    }

    let sdkSignal: AbortSignal | undefined;
    const cancellingQuery: ClaudeSdkQuery = ((input) => (async function* () {
      sdkSignal = input.options.abortController.signal;
      await new Promise<void>((_resolve, reject) => {
        sdkSignal!.addEventListener("abort", () => reject(sdkSignal!.reason), { once: true });
      });
      yield { type: "result", subtype: "success", result: "unreachable" };
    })()) as ClaudeSdkQuery;
    const cancellingHarness = new ClaudeBasicHarness(factoryContext("ask"), { query: cancellingQuery, browserSdk: browserSdk() });
    const controller = new AbortController();
    const completion = cancellingHarness.complete(runContext(managedAccess()), controller.signal);
    await vi.waitFor(() => expect(sdkSignal).toBeDefined());
    controller.abort(new Error("user cancelled Claude"));
    await expect(completion, "cancellation reason preserved").rejects.toThrow("user cancelled Claude");
    expect(sdkSignal?.aborted, "abort forwarded to the SDK").toBe(true);

    const errorRows = [
      [
        "thrown SDK error",
        (() => (async function* () {
          throw new Error("upstream rejected sk-secret customer@example.test");
        })()) as ClaudeSdkQuery,
      ],
      [
        "unsuccessful structured result",
        sdkQuery([{
          type: "result", subtype: "error_during_execution", errors: ["customer@example.test sk-secret"],
        }]),
      ],
    ] as const;
    expect(errorRows, "failure shape inventory").toHaveLength(2);
    for (const [label, query] of errorRows) {
      const harness = new ClaudeBasicHarness(factoryContext("ask"), { query, browserSdk: browserSdk() });
      const failing = harness.complete(runContext(secretAccess({ fields: { "api-key": "sk-secret" } })));
      await expect(failing, `${label} reports the generic failure`).rejects.toThrow("Claude Agent SDK completion failed.");
      await expect(failing, `${label} hides provider details`).rejects.not.toThrow(/sk-secret|customer@example\.test|upstream rejected/);
    }
  });
});
