import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAX_HARNESS_APPROVAL_TEXT_LENGTH, parseHarnessApprovalRequestInput } from "../src/approval.js";
import { PrimeAgentHarness } from "../src/implementations/prime-agent.js";
import { createNoopHarnessTraceSink, HarnessTraceStore } from "../src/trace.js";
import type { HarnessConfiguration, HarnessRunContext, HarnessTraceEventInput, HarnessTraceSink } from "../src/types.js";
import { expectGraphPresentationGuidance } from "./graph-presentation-guidance-assertions.js";

const configuration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "prime-agent-basic",
  implementation: "prime.agent",
  implementationVersion: 1,
  permissionBindings: { full: {} },
  settings: { thinkingLevel: "medium", rlmMaxDepth: 1, prewarmIpythonKernel: true },
};
const fullPermission = { permissionProfileId: "full", permissionBinding: {} } as const;

describe("PrimeAgentHarness", () => {
  it("uses only explicit managed Prime profile and session paths in the production factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-prime-managed-factory-"));
    const runtime = managedRuntimePaths(root);
    const session = primeSession(join(runtime.privateStateRoot, "sessions", "root.jsonl"));
    const createAgentSessionServices = vi.fn(async () => ({}));
    const createSessionManager = vi.fn(() => "managed-session");
    const loadModule = vi.fn(async () => ({
      ...runScopeApi(),
      SessionManager: { create: createSessionManager, open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices,
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never);

    try {
      await mkdir(runtime.privateStateRoot, { recursive: true });
      await PrimeAgentHarness.create({
        threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
      }, { loadModule, resolvePrimeRuntime: async () => runtime });

      expect(loadModule).toHaveBeenCalledOnce();
      expect(createAgentSessionServices).toHaveBeenCalledWith(expect.objectContaining({
        agentDir: join(runtime.privateStateRoot, "agent"),
        managedKernel: { version: 1, pythonExecutable: runtime.executable },
      }));
      expect(createSessionManager).toHaveBeenCalledWith("/tmp/project", join(runtime.privateStateRoot, "sessions"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not open symlinked managed session state that resolves outside private state", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-prime-managed-session-"));
    const outside = await mkdtemp(join(tmpdir(), "relayer-prime-session-outside-"));
    const runtime = managedRuntimePaths(root);
    const { privateStateRoot } = runtime;
    const sessions = join(privateStateRoot, "sessions");
    const savedSession = join(sessions, "saved.jsonl");
    const open = vi.fn(() => "outside-session");
    const create = vi.fn(() => "fresh-managed-session");
    try {
      await mkdir(sessions, { recursive: true });
      await writeFile(join(outside, "outside.jsonl"), "outside session", { mode: 0o600 });
      await symlink(join(outside, "outside.jsonl"), savedSession);

      await PrimeAgentHarness.create({
        threadId: 7,
        workingDirectory: "/tmp/project",
        ...fullPermission,
        configuration,
        savedState: {
          primeAgentSessionFile: savedSession,
          primeAgentSessionPersonalPresentationVersionId: null,
        },
      }, {
        loadModule: async () => ({
          ...runScopeApi(),
          SessionManager: { create, open },
          createHostRequestHandler: (handler: unknown) => handler,
          createAgentSessionServices: vi.fn(async () => ({})),
          createAgentSessionFromServices: vi.fn(async () => ({ session: primeSession(join(sessions, "fresh.jsonl")) })),
        }) as never,
        resolvePrimeRuntime: async () => runtime,
      });

      expect(open).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledWith("/tmp/project", sessions);

      await rm(sessions, { recursive: true, force: true });
      const outsideSessions = join(outside, "sessions");
      await mkdir(outsideSessions);
      await writeFile(join(outsideSessions, "saved.jsonl"), "outside directory session", { mode: 0o600 });
      await symlink(outsideSessions, sessions, "dir");
      await expect(PrimeAgentHarness.create({
        threadId: 8,
        workingDirectory: "/tmp/project",
        ...fullPermission,
        configuration,
        savedState: {
          primeAgentSessionFile: savedSession,
          primeAgentSessionPersonalPresentationVersionId: null,
        },
      }, {
        loadModule: async () => ({
          ...runScopeApi(),
          SessionManager: { create, open },
          createHostRequestHandler: (handler: unknown) => handler,
          createAgentSessionServices: vi.fn(async () => ({})),
          createAgentSessionFromServices: vi.fn(async () => ({ session: primeSession(join(sessions, "fresh.jsonl")) })),
        }) as never,
        resolvePrimeRuntime: async () => runtime,
      })).rejects.toThrow(/session state is not an owned directory/i);
      expect(open).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("restores a regular saved session from the managed sessions directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-prime-managed-session-"));
    const runtime = managedRuntimePaths(root);
    const { privateStateRoot } = runtime;
    const sessions = join(privateStateRoot, "sessions");
    const savedSession = join(sessions, "saved.jsonl");
    const open = vi.fn(() => "managed-session");
    const create = vi.fn();
    try {
      await mkdir(sessions, { recursive: true });
      await writeFile(savedSession, "managed session", { mode: 0o600 });
      await PrimeAgentHarness.create({
        threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
        savedState: {
          primeAgentSessionFile: savedSession,
          primeAgentSessionPersonalPresentationVersionId: null,
        },
      }, {
        loadModule: async () => ({
          ...runScopeApi(), SessionManager: { create, open },
          createHostRequestHandler: (handler: unknown) => handler,
          createAgentSessionServices: vi.fn(async () => ({})),
          createAgentSessionFromServices: vi.fn(async () => ({ session: primeSession(savedSession) })),
        }) as never,
        resolvePrimeRuntime: async () => runtime,
      });

      expect(open).toHaveBeenCalledWith(await realpath(savedSession));
      expect(create).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked private state root before managed Prime services can write", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-prime-managed-root-"));
    const outside = await mkdtemp(join(tmpdir(), "relayer-prime-state-outside-"));
    const runtime = managedRuntimePaths(root);
    const createAgentSessionServices = vi.fn(async () => ({}));
    const loadModule = vi.fn(async () => ({
      ...runScopeApi(), SessionManager: { create: vi.fn(), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices,
      createAgentSessionFromServices: vi.fn(),
    }) as never);
    try {
      await mkdir(join(root, "prime", "macos-arm64", "private-state"), { recursive: true });
      await symlink(outside, runtime.privateStateRoot, "dir");

      await expect(PrimeAgentHarness.create({
        threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
      }, { loadModule, resolvePrimeRuntime: async () => runtime }))
        .rejects.toThrow(/private state is not an owned directory/i);
      expect(loadModule).not.toHaveBeenCalled();
      expect(createAgentSessionServices).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.each(["agent", "sessions"])("rejects symlinked %s state before managed Prime services can write", async (child) => {
    const root = await mkdtemp(join(tmpdir(), "relayer-prime-managed-child-"));
    const outside = await mkdtemp(join(tmpdir(), "relayer-prime-child-outside-"));
    const runtime = managedRuntimePaths(root);
    const createAgentSessionServices = vi.fn(async () => ({}));
    const loadModule = vi.fn(async () => ({
      ...runScopeApi(), SessionManager: { create: vi.fn(), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices,
      createAgentSessionFromServices: vi.fn(),
    }) as never);
    try {
      await mkdir(runtime.privateStateRoot, { recursive: true });
      await symlink(outside, join(runtime.privateStateRoot, child), "dir");

      await expect(PrimeAgentHarness.create({
        threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
      }, { loadModule, resolvePrimeRuntime: async () => runtime }))
        .rejects.toThrow(new RegExp(`${child === "sessions" ? "session" : child} state is not an owned directory`, "i"));
      expect(loadModule).not.toHaveBeenCalled();
      expect(createAgentSessionServices).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("aborts once and uses native synchronous Prime Agent disposal for forced shutdown", async () => {
    const nativeSyncDispose = vi.fn();
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: nativeSyncDispose,
      disposeAsync: vi.fn(async () => undefined),
    };
    const harness = await createHarness(session);

    harness.forceShutdown();
    harness.forceShutdown();

    expect(session.abort).toHaveBeenCalledOnce();
    expect(nativeSyncDispose).toHaveBeenCalledOnce();
    expect(session.disposeAsync).not.toHaveBeenCalled();
  });

  it("guards native disposal before an asynchronous abort continuation can dispose again", async () => {
    let releaseAbort!: () => void;
    let markAbortFinished!: () => void;
    const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const abortFinished = new Promise<void>((resolve) => { markAbortFinished = resolve; });
    const nativeSyncDispose = vi.fn();
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => {
        await abortGate;
        session.dispose();
        markAbortFinished();
      }),
      dispose: nativeSyncDispose,
    };
    const harness = await createHarness(session);

    harness.forceShutdown();
    releaseAbort();
    await abortFinished;

    expect(session.abort).toHaveBeenCalledOnce();
    expect(nativeSyncDispose).toHaveBeenCalledOnce();
  });

  it("contains a native abort rejection and still force-disposes the Prime Agent session", async () => {
    const nativeSyncDispose = vi.fn();
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => { throw new Error("abort failed"); }),
      dispose: nativeSyncDispose,
    };
    const harness = await createHarness(session);

    expect(() => harness.forceShutdown()).not.toThrow();
    await Promise.resolve();

    expect(session.abort).toHaveBeenCalledOnce();
    expect(nativeSyncDispose).toHaveBeenCalledOnce();
  });

  it("contains a synchronous native abort failure and still force-disposes the Prime Agent session", async () => {
    const nativeSyncDispose = vi.fn();
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(() => { throw new Error("abort failed synchronously"); }),
      dispose: nativeSyncDispose,
    };
    const harness = await createHarness(session);

    expect(() => harness.forceShutdown()).not.toThrow();

    expect(session.abort).toHaveBeenCalledOnce();
    expect(nativeSyncDispose).toHaveBeenCalledOnce();
  });

  it("lets graceful cleanup retry after forced native disposal throws", async () => {
    let nativeAttempts = 0;
    const nativeSyncDispose = vi.fn(() => {
      nativeAttempts += 1;
      if (nativeAttempts === 1) throw new Error("forced native disposal failed");
    });
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: nativeSyncDispose,
      disposeAsync: vi.fn(async () => { session.dispose(); }),
    };
    const harness = await createHarness(session);

    expect(() => harness.forceShutdown()).toThrow("forced native disposal failed");
    await expect(harness.dispose()).resolves.toBeUndefined();
    harness.forceShutdown();
    await harness.dispose();

    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.disposeAsync).toHaveBeenCalledOnce();
    expect(nativeSyncDispose).toHaveBeenCalledTimes(2);
  });

  it("uses native asynchronous Prime Agent disposal for graceful shutdown", async () => {
    const nativeSyncDispose = vi.fn();
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: nativeSyncDispose,
      disposeAsync: vi.fn(async () => { nativeSyncDispose(); }),
    };
    const harness = await createHarness(session);

    await harness.dispose();
    harness.forceShutdown();

    expect(session.disposeAsync).toHaveBeenCalledOnce();
    expect(nativeSyncDispose).toHaveBeenCalledOnce();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("does not force-dispose again after successful graceful fallback disposal", async () => {
    const nativeSyncDispose = vi.fn();
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: nativeSyncDispose,
    };
    const harness = await createHarness(session);

    await harness.dispose();
    harness.forceShutdown();

    expect(nativeSyncDispose).toHaveBeenCalledOnce();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("preserves native graceful disposal failures when force did not take ownership", async () => {
    const nativeSyncDispose = vi.fn();
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: nativeSyncDispose,
      disposeAsync: vi.fn(async () => { throw new Error("graceful disposal failed"); }),
    };
    const harness = await createHarness(session);

    await expect(harness.dispose()).rejects.toThrow("graceful disposal failed");
    await expect(harness.dispose()).rejects.toThrow("graceful disposal failed");

    expect(session.disposeAsync).toHaveBeenCalledOnce();
    expect(nativeSyncDispose).not.toHaveBeenCalled();
  });

  it("publishes one graceful disposal promise and lets force win before it starts", async () => {
    const nativeSyncDispose = vi.fn();
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: nativeSyncDispose,
      disposeAsync: vi.fn(async () => undefined),
    };
    const harness = await createHarness(session);

    const graceful = harness.dispose();
    expect(harness.dispose()).toBe(graceful);
    harness.forceShutdown();
    await graceful;
    await harness.dispose();

    expect(session.abort).toHaveBeenCalledOnce();
    expect(nativeSyncDispose).toHaveBeenCalledOnce();
    expect(session.disposeAsync).not.toHaveBeenCalled();
  });

  it("contains a stale graceful rejection after force wins an in-flight disposal", async () => {
    let markGracefulStarted!: () => void;
    let releaseGraceful!: () => void;
    const gracefulStarted = new Promise<void>((resolve) => { markGracefulStarted = resolve; });
    const gracefulGate = new Promise<void>((resolve) => { releaseGraceful = resolve; });
    const nativeSyncDispose = vi.fn();
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: nativeSyncDispose,
      disposeAsync: vi.fn(async () => {
        markGracefulStarted();
        await gracefulGate;
        throw new Error("stale graceful cleanup failure");
      }),
    };
    const harness = await createHarness(session);

    const graceful = harness.dispose();
    await gracefulStarted;
    harness.forceShutdown();
    releaseGraceful();
    await expect(graceful).resolves.toBeUndefined();
    await expect(harness.dispose()).resolves.toBeUndefined();

    expect(session.abort).toHaveBeenCalledOnce();
    expect(nativeSyncDispose).toHaveBeenCalledOnce();
    expect(session.disposeAsync).toHaveBeenCalledOnce();
  });

  it("guards the native dispose boundary when force wins a successful in-flight drain", async () => {
    let markGracefulStarted!: () => void;
    let releaseGraceful!: () => void;
    const gracefulStarted = new Promise<void>((resolve) => { markGracefulStarted = resolve; });
    const gracefulGate = new Promise<void>((resolve) => { releaseGraceful = resolve; });
    const nativeSyncDispose = vi.fn();
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: nativeSyncDispose,
      disposeAsync: vi.fn(async () => {
        markGracefulStarted();
        await gracefulGate;
        session.dispose();
      }),
    };
    const harness = await createHarness(session);

    const graceful = harness.dispose();
    await gracefulStarted;
    harness.forceShutdown();
    releaseGraceful();
    await expect(graceful).resolves.toBeUndefined();

    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.disposeAsync).toHaveBeenCalledOnce();
    expect(nativeSyncDispose).toHaveBeenCalledOnce();
  });

  it("keeps one Prime Agent session while passing a distinct context to each run", async () => {
    const prompts: { text: string; runContext: unknown; modelScope: unknown }[] = [];
    const session = {
      sessionFile: "/tmp/prime-session.jsonl",
      promptAndWait: vi.fn(async (text: string, options: { runContext: unknown; modelScope: unknown }) => { prompts.push({ text, ...options }); }),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const hostHandlers: ((payload: Record<string, unknown>, context: any) => Promise<Record<string, unknown>>)[] = [];
    const services = { modelRegistry: { find: vi.fn() } };
    const createAgentRunModelScope = vi.fn((input: unknown) => input);
    const createAgentSessionFromServices = vi.fn(async () => ({ session }));
    const harness = await PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      ...fullPermission,
      configuration,
    }, { loadModule: async () => ({
      AGENT_RUN_MODEL_SCOPE_VERSION: 1,
      createAgentRunModelScope,
      SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
      createHostRequestHandler: (handler: (payload: Record<string, unknown>, context: any) => Promise<Record<string, unknown>>) => {
        hostHandlers.push(handler);
        return handler;
      },
      createAgentSessionServices: vi.fn(async () => services),
      createAgentSessionFromServices,
    }) as never });

    const first = {
      ...runContext(11, "first-token"),
      completionBroker: {
        url: "http://127.0.0.1:43125/api/completions",
        token: "12345678901234567890123456789012",
      },
    };
    const second = runContext(12, "second-token");
    await harness.complete(first);
    await harness.complete(second);

    expect(createAgentSessionFromServices).toHaveBeenCalledTimes(1);
    expect(createAgentSessionFromServices).toHaveBeenCalledWith(expect.objectContaining({ prewarmIpythonKernel: true }));
    expect(services.modelRegistry.find).not.toHaveBeenCalled();
    expect(createAgentSessionFromServices).toHaveBeenCalledWith(expect.not.objectContaining({ model: expect.anything() }));
    expect(prompts.map(({ runContext }) => runContext)).toEqual([
      { graph: first.graph, completionBroker: first.completionBroker },
      { graph: second.graph },
    ]);
    expect(createAgentRunModelScope).toHaveBeenCalledTimes(2);
    expect(prompts[0]!.text).toContain("graph = await GraphSession.current()");
    expect(prompts[0]!.text).toContain("await graph.submit(11)");
    expect(prompts[0]!.text).toContain("graph with other live agents");
    expect(prompts[0]!.text).toContain("live, user-facing workspace");
    expect(prompts[0]!.text).toContain("await graph.get_current()");
    expect(prompts[0]!.text).toContain("await graph.advance_current(");
    expect(prompts[0]!.text).toContain("Advancing current does not complete the interaction");
    expect(prompts[0]!.text).not.toContain("prepare_complete");
    expect(prompts[0]!.text).not.toContain("from relayer_graph import complete");
    expect(prompts[1]!.text).not.toContain("prepare_complete");
    expect(prompts[1]!.text).not.toContain("from relayer_graph import complete");
    expect(prompts[0]!.text).toContain("exactly one NodePlacementObject(node, x, y) per member node");
    expect(prompts[0]!.text).toContain("Place a one-node layer at (0.5, 0.5)");
    expectGraphPresentationGuidance(prompts[0]!.text);
    expect(prompts[0]!.text).toContain("add_navigate_action(node, \"View evidence\"");
    expect(prompts[0]!.text).toContain("explicit descriptive client_key");
    expect(prompts[0]!.text).toContain("rerun the same authoring code with the same client_key values");
    expect(prompts[0]!.text).toContain("Do not add fake navigation");
    expect(prompts[0]!.text).toContain("await graph.discard_layer(layer)");
    await expect(hostHandlers[0]?.({}, invocation(first))).resolves.toEqual({
      url: "http://127.0.0.1:43123",
      token: "first-token",
      nodeId: 11,
    });
    await expect(hostHandlers[1]?.({}, invocation(first))).resolves.toEqual(first.completionBroker);
    expect(harness.state()).toEqual({
      primeAgentSessionFile: "/tmp/prime-session.jsonl",
      primeAgentSessionPersonalPresentationVersionId: null,
    });
  });

  it("runs concurrent invoked completions in fresh sessions without changing root continuity", async () => {
    const scopes: ControlledRunScope[] = [];
    const root = primeSession("/tmp/root-prime-session.jsonl");
    const firstChild = primeSession("/tmp/invoked-a.jsonl");
    const secondChild = primeSession("/tmp/invoked-b.jsonl");
    const sessions = [root, firstChild, secondChild];
    const create = vi.fn()
      .mockReturnValueOnce("fresh-a")
      .mockReturnValueOnce("fresh-b");
    const open = vi.fn(() => "saved-root");
    const createAgentSessionServices = vi.fn(async () => ({}));
    const createAgentSessionFromServices = vi.fn(async () => {
      const session = sessions.shift();
      if (session === undefined) throw new Error("unexpected Prime session creation");
      return { session };
    });
    const harness = await PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      ...fullPermission,
      configuration,
      savedState: {
        primeAgentSessionFile: "/tmp/root-prime-session.jsonl",
        primeAgentSessionPersonalPresentationVersionId: null,
      },
    }, { loadModule: async () => ({
      ...controlledRunScopeApi(scopes),
      SessionManager: { create, open },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices,
      createAgentSessionFromServices,
    }) as never });

    const firstExecution = harness.complete(invokedRunContext(familyRunContext(41, "child-a", 0), 101));
    const secondExecution = harness.complete(invokedRunContext(familyRunContext(42, "child-b", 2), 102));
    await Promise.all([firstExecution, secondExecution]);
    const attachments = await Promise.all([firstExecution.attached, secondExecution.attached]);
    expect(attachments).toEqual([
      {
        schemaVersion: 1,
        provider: "prime-agent",
        sessionDigest: `sha256:${createHash("sha256").update("/tmp/invoked-a.jsonl").digest("hex")}`,
      },
      {
        schemaVersion: 1,
        provider: "prime-agent",
        sessionDigest: `sha256:${createHash("sha256").update("/tmp/invoked-b.jsonl").digest("hex")}`,
      },
    ]);

    expect(open).toHaveBeenCalledWith("/tmp/root-prime-session.jsonl");
    expect(create.mock.calls).toEqual([["/tmp/project"], ["/tmp/project"]]);
    expect(createAgentSessionServices).toHaveBeenCalledOnce();
    expect(createAgentSessionFromServices).toHaveBeenCalledTimes(3);
    expect(root.promptAndWait).not.toHaveBeenCalled();
    expect(firstChild.promptAndWait).toHaveBeenCalledOnce();
    expect(secondChild.promptAndWait).toHaveBeenCalledOnce();
    expect(scopes.map(({ input }) => input.root.id)).toEqual(["gpt-shared", "claude-root"]);
    expect(scopes[0]!.input.root.provider).not.toBe(scopes[1]!.input.root.provider);
    expect(firstChild.waitForRlmQuiescence).toHaveBeenCalledOnce();
    expect(secondChild.waitForRlmQuiescence).toHaveBeenCalledOnce();
    expect(firstChild.disposeAsync).toHaveBeenCalledOnce();
    expect(secondChild.disposeAsync).toHaveBeenCalledOnce();
    expect(harness.state()).toEqual({
      primeAgentSessionFile: "/tmp/root-prime-session.jsonl",
      primeAgentSessionPersonalPresentationVersionId: null,
    });

    await harness.complete(runContext(43, "root-token"));
    expect(root.promptAndWait).toHaveBeenCalledOnce();
    expect(root.disposeAsync).not.toHaveBeenCalled();
  });

  it("cancels and quiesces only the exact invoked Prime session before disposing it", async () => {
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    let releaseQuiescence!: () => void;
    const quiescenceGate = new Promise<void>((resolve) => { releaseQuiescence = resolve; });
    const root = primeSession("/tmp/root.jsonl");
    const cancelledChild = primeSession("/tmp/cancelled.jsonl", {
      promptAndWait: vi.fn(async () => promptGate),
      waitForRlmQuiescence: vi.fn(async () => quiescenceGate),
      abort: vi.fn(async () => { releasePrompt(); }),
    });
    const sibling = primeSession("/tmp/sibling.jsonl");
    const sessions = [root, cancelledChild, sibling];
    const harness = await PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      ...fullPermission,
      configuration,
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create: vi.fn(() => "fresh"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => ({})),
      createAgentSessionFromServices: vi.fn(async () => {
        const session = sessions.shift();
        if (session === undefined) throw new Error("unexpected Prime session creation");
        return { session };
      }),
    }) as never });
    const controller = new AbortController();
    let cancelledSettled = false;

    const cancelled = harness.complete(invokedRunContext(runContext(51, "cancelled"), 151), controller.signal);
    const completedSibling = harness.complete(invokedRunContext(runContext(52, "sibling"), 152));
    void cancelled.finally(() => { cancelledSettled = true; });
    await vi.waitFor(() => expect(cancelledChild.promptAndWait).toHaveBeenCalledOnce());
    controller.abort();
    await completedSibling;
    await new Promise((resolve) => setImmediate(resolve));

    expect(cancelledChild.abort).toHaveBeenCalledOnce();
    expect(root.abort).not.toHaveBeenCalled();
    expect(sibling.abort).not.toHaveBeenCalled();
    expect(cancelledSettled).toBe(false);
    expect(cancelledChild.disposeAsync).not.toHaveBeenCalled();

    releaseQuiescence();
    await cancelled;
    expect(cancelledSettled).toBe(true);
    expect(cancelledChild.disposeAsync).toHaveBeenCalledOnce();
    expect(sibling.disposeAsync).toHaveBeenCalledOnce();
    expect(root.disposeAsync).not.toHaveBeenCalled();
  });

  it("force-disposes active and late-created invoked sessions without leaking into root", async () => {
    let markActiveStarted!: () => void;
    const activeStarted = new Promise<void>((resolve) => { markActiveStarted = resolve; });
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => { releaseActive = resolve; });
    let releaseCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve; });
    const root = primeSession("/tmp/root.jsonl");
    const activeChild = primeSession("/tmp/active-child.jsonl", {
      promptAndWait: vi.fn(async () => {
        markActiveStarted();
        await activeGate;
      }),
      abort: vi.fn(async () => { releaseActive(); }),
    });
    const lateChild = primeSession("/tmp/late-child.jsonl");
    const rootNativeDispose = root.dispose;
    const activeChildNativeDispose = activeChild.dispose;
    const lateChildNativeDispose = lateChild.dispose;
    let creations = 0;
    const harness = await PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      ...fullPermission,
      configuration,
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create: vi.fn(() => "fresh"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => ({})),
      createAgentSessionFromServices: vi.fn(async () => {
        creations += 1;
        if (creations === 1) return { session: root };
        if (creations === 2) return { session: activeChild };
        await creationGate;
        return { session: lateChild };
      }),
    }) as never });

    const active = harness.complete(invokedRunContext(runContext(61, "active"), 161));
    await activeStarted;
    const late = harness.complete(invokedRunContext(runContext(62, "late"), 162));
    await new Promise((resolve) => setImmediate(resolve));
    harness.forceShutdown();
    releaseCreation();

    await active;
    await expect(late).rejects.toThrow("shutting down");
    expect(activeChild.abort).toHaveBeenCalledOnce();
    expect(activeChildNativeDispose).toHaveBeenCalledOnce();
    expect(lateChild.promptAndWait).not.toHaveBeenCalled();
    expect(lateChild.abort).toHaveBeenCalledOnce();
    expect(lateChildNativeDispose).toHaveBeenCalledOnce();
    expect(root.abort).toHaveBeenCalledOnce();
    expect(rootNativeDispose).toHaveBeenCalledOnce();
  });

  it("maps an admitted family to isolated native providers and reuses the session across root changes", async () => {
    const scopes: ControlledRunScope[] = [];
    const providerRequests: Array<{ provider: string; modelId: string; apiKey: string | undefined }> = [];
    const modelRegistryAuth = vi.fn(() => { throw new Error("ambient Prime registry auth must not run"); });
    let listener: ((event: unknown) => void) | undefined;
    const session = {
      sessionFile: "/tmp/family-session.jsonl",
      promptAndWait: vi.fn(async (_text: string, options: { modelScope: ControlledRunScope }) => {
        const scope = options.modelScope;
        try {
          for (const model of scope.input.models) {
            const auth = await scope.resolve(model);
            providerRequests.push({ provider: model.provider, modelId: model.id, apiKey: auth.apiKey });
          }
          expect(() => scope.resolve({ ...scope.input.models[0]!, id: "ambient-outsider" })).toThrow("has no upfront access");
          const child = scope.input.models[1]!;
          listener?.({ type: "turn_start", endpoint: "https://must-not-trace.test", apiKey: "must-not-trace" });
          listener?.({ type: "tool_execution_start", toolName: "ipython", args: { endpoint: "https://must-not-trace.test", apiKey: "must-not-trace" } });
          listener?.({
            type: "message_end",
            message: { role: "assistant", provider: scope.input.root.provider, model: scope.input.root.id, content: [{ type: "text", text: "root" }] },
          });
          listener?.({
            type: "rlm_child_update",
            child: {
              id: "child-1",
              model: `${child.provider}/${child.id}`,
              status: "completed",
              error: "https://openai-work.test/v1 rejected secret-openai-work",
            },
          });
          listener?.({ type: "turn_end" });
        } finally {
          scope.revoke();
        }
      }),
      subscribe: vi.fn((next: (event: unknown) => void) => { listener = next; return vi.fn(); }),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const createAgentSessionFromServices = vi.fn(async () => ({ session }));
    const harness = await PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      ...fullPermission,
      configuration,
    }, { loadModule: async () => ({
      ...controlledRunScopeApi(scopes),
      SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => ({ modelRegistry: { getApiKeyAndHeaders: modelRegistryAuth } })),
      createAgentSessionFromServices,
    }) as never });
    const firstTrace = recordingTrace();
    const first = familyRunContext(21, "first-token", 2, firstTrace.sink);
    const second = familyRunContext(22, "second-token", 0);

    await harness.complete(first);
    expect(() => scopes[0]!.resolve(scopes[0]!.input.root)).toThrow("revoked");
    await harness.complete(second);
    expect(() => scopes[1]!.resolve(scopes[1]!.input.root)).toThrow("revoked");

    expect(createAgentSessionFromServices).toHaveBeenCalledOnce();
    expect(session.promptAndWait).toHaveBeenCalledTimes(2);
    expect(modelRegistryAuth).not.toHaveBeenCalled();
    expect(scopes[0]!.input.models.map(({ id }) => id)).toEqual([
      "gpt-shared", "gpt-shared", "claude-root", "qwen-root", "gemini-root",
    ]);
    expect(scopes[0]!.input.models[0]!.provider).not.toBe(scopes[0]!.input.models[1]!.provider);
    expect(scopes[0]!.input.models[0]!.api).toBe("openai-responses");
    expect(scopes[0]!.input.models[1]!.api).toBe("openai-responses");
    expect(scopes[0]!.input.models[2]).toMatchObject({
      id: "claude-root",
      api: "anthropic-messages",
      baseUrl: "https://anthropic-work.test",
      reasoning: false,
      input: ["text"],
      contextWindow: 32_768,
      maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(scopes[0]!.input.models[3]).toMatchObject({
      id: "qwen-root",
      api: "openai-completions",
      baseUrl: "https://openrouter-work.test/v1",
      compat: { thinkingFormat: "openrouter", openRouterRouting: {} },
    });
    expect(scopes[0]!.input.models[4]).toMatchObject({
      id: "gemini-root",
      api: "openai-completions",
      baseUrl: "https://vercel-work.test/v1",
      compat: { vercelGatewayRouting: {} },
    });
    expect(scopes[0]!.input.root.id).toBe("claude-root");
    expect(scopes[1]!.input.root.id).toBe("gpt-shared");
    expect(scopes[0]!.input.requestAccess).toHaveLength(scopes[0]!.input.models.length);
    expect(scopes[0]!.input.requestAccess.map(({ access }) => ({
      kind: access.kind,
      contract: access.contract,
      apiKey: access.apiKey,
    }))).toEqual([
      { kind: "secret", contract: "secret@1", apiKey: "secret-openai-personal" },
      { kind: "secret", contract: "secret@1", apiKey: "secret-openai-work" },
      { kind: "secret", contract: "secret@1", apiKey: "secret-anthropic-work" },
      { kind: "secret", contract: "secret@1", apiKey: "secret-openrouter-work" },
      { kind: "secret", contract: "secret@1", apiKey: "secret-vercel-work" },
    ]);
    expect(scopes[0]!.input).not.toHaveProperty("resolveRequestAuth");
    expect(providerRequests.map(({ apiKey }) => apiKey)).toEqual([
      "secret-openai-personal", "secret-openai-work", "secret-anthropic-work",
      "secret-openrouter-work", "secret-vercel-work",
      "secret-openai-personal", "secret-openai-work", "secret-anthropic-work",
      "secret-openrouter-work", "secret-vercel-work",
    ]);
    expect(harness.state()).toEqual({
      primeAgentSessionFile: "/tmp/family-session.jsonl",
      primeAgentSessionPersonalPresentationVersionId: null,
    });

    const trace = JSON.stringify(firstTrace.events);
    expect(trace).toContain('"providerDefinitionId":"anthropic-work"');
    expect(trace).toContain('"providerDefinitionId":"openai-work"');
    expect(trace).toContain('"adapterId":"anthropic-api"');
    expect(trace).toContain('"adapterId":"openai-api"');
    expect(trace).toContain('"modelId":"claude-root"');
    expect(trace).toContain('"modelId":"gpt-shared"');
    expect(trace).not.toContain("relayer-openai-api-");
    expect(trace).not.toContain("https://");
    expect(trace).not.toContain("must-not-trace");
    expect(trace).not.toContain("secret-openai");
    expect(JSON.stringify(harness.state())).not.toContain("secret-");
  });

  it("rejects unsupported and mismatched adapter access before starting Prime", async () => {
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const harness = await createHarness(session);
    const managed = familyRunContext(31, "token", 0);
    const route = managed.modelPlan!.roster[0]!;
    const managedAccess = {
      kind: "managed-runtime",
      contract: "managed-runtime@1",
      providerId: route.providerId,
      adapterId: "codex-subscription",
      adapterImplementationVersion: "1",
      environment: {},
    } as const;
    const invalid = {
      ...managed,
      model: { providerId: route.providerId, adapterId: "codex-subscription", modelId: route.modelId },
      modelPlan: {
        ...managed.modelPlan!,
        orchestrator: { ...route, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
        roster: [{ ...route, adapterId: "codex-subscription", accessContract: "managed-runtime@1" }],
      },
      access: managedAccess,
      accessBundle: { byProviderId: { [route.providerId]: managedAccess } },
    } satisfies HarnessRunContext;

    await expect(harness.complete(invalid)).rejects.toThrow("does not support provider adapter codex-subscription");
    expect(session.promptAndWait).not.toHaveBeenCalled();
  });

  it("uses discovered per-model token capabilities with a conservative fallback", async () => {
    const scopes: ControlledRunScope[] = [];
    const session = {
      promptAndWait: vi.fn(async (_text: string, options: { modelScope: ControlledRunScope }) => { options.modelScope.revoke(); }),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const harness = await PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      ...fullPermission,
      configuration,
    }, { loadModule: async () => ({
      ...controlledRunScopeApi(scopes),
      SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => ({})),
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never });

    for (const [index, adapterId] of ["openai-api", "anthropic-api", "openrouter", "vercel-ai-router"].entries()) {
      await harness.complete(singleAdapterRunContext(
        40 + index,
        adapterId,
        adapterId === "openrouter"
          ? { contextWindow: 196_608, maxOutputTokens: 131_072 }
          : adapterId === "vercel-ai-router"
            ? { contextWindow: 1_000_000, maxOutputTokens: 384_000 }
            : undefined,
      ));
    }
    await harness.complete(singleAdapterRunContext(
      44,
      "openrouter",
      { contextWindow: 32_768, maxOutputTokens: 2_048 },
    ));
    await harness.complete(singleAdapterRunContext(
      45,
      "anthropic-api",
      undefined,
      "https://provider-45.test/proxy/anthropic/v1/",
    ));

    expect(scopes.map(({ input }) => ({
      api: input.root.api,
      baseUrl: input.root.baseUrl,
      compat: input.root.compat,
      reasoning: input.root.reasoning,
      input: input.root.input,
      contextWindow: input.root.contextWindow,
      maxTokens: input.root.maxTokens,
      cost: input.root.cost,
    }))).toEqual([
      { api: "openai-responses", baseUrl: "https://provider-40.test/v1", compat: undefined, reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { api: "anthropic-messages", baseUrl: "https://provider-41.test", compat: undefined, reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { api: "openai-completions", baseUrl: "https://provider-42.test/v1", compat: { thinkingFormat: "openrouter", openRouterRouting: {} }, reasoning: false, input: ["text"], contextWindow: 196_608, maxTokens: 131_072, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { api: "openai-completions", baseUrl: "https://provider-43.test/v1", compat: { vercelGatewayRouting: {} }, reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 384_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { api: "openai-completions", baseUrl: "https://provider-44.test/v1", compat: { thinkingFormat: "openrouter", openRouterRouting: {} }, reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 2_048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { api: "anthropic-messages", baseUrl: "https://provider-45.test/proxy/anthropic", compat: undefined, reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]);
  });

  it("rejects a discovered context that cannot satisfy Prime's compaction reserve", async () => {
    const session = {
      promptAndWait: vi.fn(async (_text: string, _options: { modelScope: ControlledRunScopeInput }) => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const harness = await createHarness(session);

    await expect(harness.complete(singleAdapterRunContext(
      45,
      "openrouter",
      { contextWindow: 4_095, maxOutputTokens: 3_685 },
    ))).rejects.toThrow("context window cannot satisfy Prime's 16384-token compaction reserve");
    expect(session.promptAndWait).not.toHaveBeenCalled();
  });

  it("opens saved Prime Agent state and forwards cancellation", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const session = {
      sessionFile: "/tmp/saved.jsonl",
      promptAndWait: vi.fn(async () => waiting),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => { release(); }),
      dispose: vi.fn(),
    };
    const open = vi.fn(() => "opened-session");
    const services = { modelRegistry: { find: vi.fn() } };
    const createAgentSessionFromServices = vi.fn(async () => ({ session }));
    const harness = await PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      ...fullPermission,
      configuration,
      savedState: {
        primeAgentSessionFile: "/tmp/saved.jsonl",
        primeAgentSessionPersonalPresentationVersionId: null,
      },
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create: vi.fn(), open },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => services),
      createAgentSessionFromServices,
    }) as never });
    const controller = new AbortController();

    const completing = harness.complete(runContext(11, "token"), controller.signal);
    controller.abort();
    await completing;

    expect(open).toHaveBeenCalledWith("/tmp/saved.jsonl");
    expect(createAgentSessionFromServices).toHaveBeenCalledWith(expect.objectContaining({ sessionManager: "opened-session", services }));
    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  it("uses the separate layered-navigation prompt profile", async () => {
    let prompt = "";
    let listener: ((event: unknown) => void) | undefined;
    let resourceLoaderOptions: { appendSystemPromptOverride(base: string[]): string[] } | undefined;
    const session = {
      promptAndWait: vi.fn(async (text: string) => {
        prompt = text;
        listener?.({
          type: "rlm_child_update",
          child: {
            id: "graph-child",
            status: "completed",
            answerPreview: "Decision-useful center",
          },
        });
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Foreground the conclusion and material tradeoffs." }],
          },
        });
        listener?.({
          type: "tool_execution_start",
          toolCallId: "unrelated-tool",
          toolName: "ipython",
          args: { label: "Decision-useful center" },
        });
      }),
      subscribe: vi.fn((next: (event: unknown) => void) => { listener = next; return vi.fn(); }),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
      reload: vi.fn(async () => undefined),
    };
    const harness = await PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      ...fullPermission,
      configuration: {
        ...configuration,
        name: "prime-agent-layered-navigation-luna",
        settings: { ...configuration.settings, promptProfile: "layered-navigation-v1" },
      },
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async (options: { resourceLoaderOptions: typeof resourceLoaderOptions }) => {
        resourceLoaderOptions = options.resourceLoaderOptions;
        return { modelRegistry: { find: vi.fn() } };
      }),
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never });

    const context = runContext(11, "token");
    const trace = recordingTrace();
    await harness.complete({
      ...context,
      trace: trace.sink,
      personalPresentation: {
        attachment: { interactionNodeId: 11, versionInteractionNodeId: 90, rootLayerId: 91 },
        graph: {
          nodeId: 90,
          rootLayerId: 91,
          rootAction: { id: 92, sourceNodeId: 90, kind: "navigate", relation: "expand", label: "Personal presentation", variant: "pill", targetLayerId: 91, state: "accepted" },
          layers: [{
            layer: { id: 91, nodes: [93], edges: [], state: "accepted" },
            nodes: [{ id: 93, kind: "presentation-preference", icon: "compass", title: "Decision-useful center", detail: "Foreground the conclusion and material tradeoffs.", state: "accepted" }],
            edges: [],
            actions: [],
          }],
        },
      },
    });

    expect(prompt).toContain('relation="expand"');
    expect(prompt).toContain('relation="reference"');
    expectGraphPresentationGuidance(prompt);
    expect(prompt).toContain("A flat answer is valid");
    expect(prompt).toContain("Author in whatever order fits the task");
    expect(prompt).toContain("final graph call must be await graph.submit(11)");
    expect(prompt).toContain("await graph.get_node(11)");
    expect(prompt).toContain("await graph.get_neighbors(11)");
    expect(prompt).toContain("ordinary graph.submit(11) automatically fulfills any lease");
    expect(prompt).toContain("There is no separate resolve_action call");
    expect(prompt).toContain("Never mention or expose the size justification");
    expect(prompt).toContain("Every new root, expansion, and reference layer requires a version-1 LayerLayoutObject");
    expect(prompt).toContain("align comparisons deliberately");
    expect(prompt).toContain('NodeObject("info", "Summary", "...", client_key="summary-node")');
    expect(prompt).not.toContain('NodeObject("lightbulb"');
    expect(prompt).toContain('client_key="root-response"');
    expect(prompt).toContain('client_key="node-detail"');
    expect(prompt).toContain('client_key="node-evidence"');
    expect(prompt).toContain('client_key="node-follow-up"');
    expect(prompt).toContain("rerun it with the same client_key values");
    expect(prompt).toContain("Do not add fake navigate or reference actions");
    expect(prompt).toContain("await graph.discard_layer(layer)");
    expect(prompt).toContain("Decision-useful center: Foreground the conclusion and material tradeoffs.");
    expect(prompt.indexOf("Graph presentation guidance:")).toBeLessThan(
      prompt.indexOf("Personal graph presentation preferences:"),
    );
    expect(prompt.indexOf("Personal graph presentation preferences:")).toBeLessThan(
      prompt.indexOf("Normalized interaction input:"),
    );
    const tracedPrompt = trace.events.find((event) => event.type === "prompt")?.data.text;
    expect(tracedPrompt).not.toContain("Decision-useful center");
    expect(tracedPrompt).not.toContain("Personal graph presentation preferences");
    const providerEchoes = trace.events.filter((event) => !JSON.stringify(event.data).includes("unrelated-tool"));
    expect(JSON.stringify(providerEchoes)).not.toContain("Foreground the conclusion and material tradeoffs.");
    expect(JSON.stringify(providerEchoes)).not.toContain("Decision-useful center");
    expect(JSON.stringify(providerEchoes)).toContain("[redacted-personal-presentation]");
    const unrelatedTool = trace.events.find((event) => event.type === "tool.call.started");
    expect(JSON.stringify(unrelatedTool?.data)).toContain("Decision-useful center");
    expect(session.reload).toHaveBeenCalledOnce();
    const nativeInstructions = resourceLoaderOptions?.appendSystemPromptOverride(["base prompt"]);
    expect(nativeInstructions).toHaveLength(2);
    expect(nativeInstructions?.[1]).toContain("If you are the root agent");
    expect(nativeInstructions?.[1]).toContain("only when assigning a native child to author graph content");
    expect(nativeInstructions?.[1]).toContain("Never include that block in an unrelated delegate's task");
    expect(nativeInstructions?.[1]).toContain("only when that exact rendered block is present in your assigned task");
    expect(nativeInstructions?.[1]).toContain("every native child that can author graph content");
    expect(nativeInstructions?.[1]).not.toContain("Personal graph presentation preferences:");
    expect(nativeInstructions?.[1]).not.toContain("Decision-useful center");
  });

  it("includes Python graph-search guidance only for a query-v1 capability profile", async () => {
    let disabledPrompt = "";
    const disabled = await createHarness(primeSession("/tmp/search-disabled.jsonl", {
      promptAndWait: vi.fn(async (text: string) => { disabledPrompt = text; }),
    }), {
      ...configuration,
      graphCapabilityProfile: { search: "disabled" },
    });
    await disabled.complete(runContext(11, "disabled-token"));

    let enabledPrompt = "";
    const enabled = await createHarness(primeSession("/tmp/search-enabled.jsonl", {
      promptAndWait: vi.fn(async (text: string) => { enabledPrompt = text; }),
    }), {
      ...configuration,
      graphCapabilityProfile: { search: "query-v1" },
    });
    await enabled.complete(runContext(12, "enabled-token"));

    expect(disabledPrompt).not.toContain("Graph search is available");
    expect(disabledPrompt).not.toContain("GraphSearchRequest");
    expect(enabledPrompt).toContain("Graph search is available");
    expect(enabledPrompt).toContain("await graph.search(GraphSearchRequest(...))");
    expect(enabledPrompt).toContain("query_contract_version=1");
    expect(enabledPrompt).toContain('target={"scope": "project", "id": known_project_id}');
    expect(enabledPrompt).toContain("Never invent, guess, or discover a target ID");
    expect(enabledPrompt).toContain('result["type"] == "layer"');
    expect(enabledPrompt).toContain('relation="reference"');
  });

  it("retries a presentation instruction reload after a transient failure", async () => {
    let resourceLoaderOptions: { appendSystemPromptOverride(base: string[]): string[] } | undefined;
    const reload = vi.fn().mockRejectedValueOnce(new Error("reload failed")).mockResolvedValueOnce(undefined);
    const session = {
      promptAndWait: vi.fn(async () => undefined), waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined), dispose: vi.fn(), reload,
    };
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
    }, { loadModule: async () => ({
      ...runScopeApi(), SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async (options: { resourceLoaderOptions: typeof resourceLoaderOptions }) => {
        resourceLoaderOptions = options.resourceLoaderOptions;
        return { modelRegistry: { find: vi.fn() } };
      }),
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never });
    const context = runContext(11, "token");
    const attached: HarnessRunContext = {
      ...context,
      personalPresentation: {
        attachment: { interactionNodeId: 11, versionInteractionNodeId: 90, rootLayerId: 91 },
        graph: {
          nodeId: 90, rootLayerId: 91,
          rootAction: { id: 92, sourceNodeId: 90, kind: "navigate", relation: "expand", label: "Personal presentation", variant: "pill", targetLayerId: 91, state: "accepted" },
          layers: [{
            layer: { id: 91, nodes: [93], edges: [], state: "accepted" },
            nodes: [{ id: 93, kind: "presentation-preference", icon: "compass", title: "Decision-useful center", detail: "Foreground the conclusion.", state: "accepted" }],
            edges: [], actions: [],
          }],
        },
      },
    };

    await expect(harness.complete(attached)).rejects.toThrow("reload failed");
    expect(resourceLoaderOptions?.appendSystemPromptOverride(["base"])).toEqual(["base"]);
    await expect(harness.complete(attached)).resolves.toBeUndefined();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(resourceLoaderOptions?.appendSystemPromptOverride(["base"])[1]).toContain("If you are the root agent");
    expect(resourceLoaderOptions?.appendSystemPromptOverride(["base"])[1]).toContain("Never include that block in an unrelated delegate's task");
    expect(resourceLoaderOptions?.appendSystemPromptOverride(["base"])[1]).not.toContain("Personal graph presentation preferences:");
    expect(resourceLoaderOptions?.appendSystemPromptOverride(["base"])[1]).not.toContain("Decision-useful center");
  });

  it("rotates the native Prime session when the durable presentation pin changes", async () => {
    const firstDispose = vi.fn();
    const firstSession = {
      sessionFile: "/tmp/prime-v1.jsonl",
      promptAndWait: vi.fn(async () => undefined), waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined), dispose: firstDispose, reload: vi.fn(async () => undefined),
    };
    const secondSession = {
      sessionFile: "/tmp/prime-neutral.jsonl",
      promptAndWait: vi.fn(async () => undefined), waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined), dispose: vi.fn(), reload: vi.fn(async () => undefined),
    };
    const createAgentSessionFromServices = vi.fn()
      .mockResolvedValueOnce({ session: firstSession })
      .mockResolvedValueOnce({ session: secondSession });
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
    }, { loadModule: async () => ({
      ...runScopeApi(), SessionManager: { create: vi.fn(() => ({})), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => ({ modelRegistry: { find: vi.fn() } })),
      createAgentSessionFromServices,
    }) as never });
    const first = presentationRunContext(11, "first-token", 90);

    await harness.complete(first);
    await harness.complete(first);
    await harness.complete(runContext(12, "second-token"));

    expect(firstSession.promptAndWait).toHaveBeenCalledTimes(2);
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondSession.promptAndWait).toHaveBeenCalledOnce();
    expect(createAgentSessionFromServices).toHaveBeenCalledTimes(2);
    expect(harness.state()).toEqual({
      primeAgentSessionFile: "/tmp/prime-neutral.jsonl",
      primeAgentSessionPersonalPresentationVersionId: null,
    });
  });

  it("reloads native propagation instructions when restoring a matching presentation pin", async () => {
    let resourceLoaderOptions: { appendSystemPromptOverride(base: string[]): string[] } | undefined;
    const session = {
      sessionFile: "/tmp/saved-v1.jsonl",
      promptAndWait: vi.fn(async () => undefined), waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined), dispose: vi.fn(), reload: vi.fn(async () => undefined),
    };
    const open = vi.fn(() => "saved-v1-session");
    const createAgentSessionFromServices = vi.fn(async () => ({ session }));
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
      savedState: {
        primeAgentSessionFile: "/tmp/saved-v1.jsonl",
        primeAgentSessionPersonalPresentationVersionId: 90,
      },
    }, { loadModule: async () => ({
      ...runScopeApi(), SessionManager: { create: vi.fn(), open },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async (options: { resourceLoaderOptions: typeof resourceLoaderOptions }) => {
        resourceLoaderOptions = options.resourceLoaderOptions;
        return { modelRegistry: { find: vi.fn() } };
      }),
      createAgentSessionFromServices,
    }) as never });
    const attached = presentationRunContext(11, "token", 90);

    await harness.complete(attached);
    await harness.complete(attached);

    expect(open).toHaveBeenCalledWith("/tmp/saved-v1.jsonl");
    expect(createAgentSessionFromServices).toHaveBeenCalledOnce();
    expect(session.reload).toHaveBeenCalledOnce();
    expect(session.promptAndWait).toHaveBeenCalledTimes(2);
    const nativeInstructions = resourceLoaderOptions?.appendSystemPromptOverride(["base"]);
    expect(nativeInstructions?.[1]).toContain("If you are the root agent");
    expect(nativeInstructions?.[1]).not.toContain("Decision-useful center");
    expect(harness.state()).toEqual({
      primeAgentSessionFile: "/tmp/saved-v1.jsonl",
      primeAgentSessionPersonalPresentationVersionId: 90,
    });
  });

  it("does not prompt a restored session when force shutdown wins its instruction reload", async () => {
    let markReloadStarted!: () => void;
    let releaseReload!: () => void;
    const reloadStarted = new Promise<void>((resolve) => { markReloadStarted = resolve; });
    const reloadGate = new Promise<void>((resolve) => { releaseReload = resolve; });
    const nativeDispose = vi.fn();
    const session = {
      promptAndWait: vi.fn(async () => undefined), waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined), dispose: nativeDispose,
      reload: vi.fn(async () => {
        markReloadStarted();
        await reloadGate;
      }),
    };
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
      savedState: {
        primeAgentSessionFile: "/tmp/saved-v1.jsonl",
        primeAgentSessionPersonalPresentationVersionId: 90,
      },
    }, { loadModule: async () => ({
      ...runScopeApi(), SessionManager: { create: vi.fn(), open: vi.fn(() => ({})) },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => ({ modelRegistry: { find: vi.fn() } })),
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never });

    const completing = harness.complete(presentationRunContext(11, "token", 90));
    await reloadStarted;
    harness.forceShutdown();
    releaseReload();

    await expect(completing).rejects.toThrow("Prime Agent harness is shutting down");
    expect(session.promptAndWait).not.toHaveBeenCalled();
    expect(nativeDispose).toHaveBeenCalledOnce();
  });

  it("disposes a replacement session created after force shutdown wins a rotation", async () => {
    let markReplacementStarted!: () => void;
    let releaseReplacement!: () => void;
    const replacementStarted = new Promise<void>((resolve) => { markReplacementStarted = resolve; });
    const replacementGate = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    const firstSession = {
      promptAndWait: vi.fn(async () => undefined), waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined), dispose: vi.fn(), reload: vi.fn(async () => undefined),
    };
    const replacementDispose = vi.fn();
    const replacementSession = {
      promptAndWait: vi.fn(async () => undefined), waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined), dispose: replacementDispose,
    };
    const createAgentSessionFromServices = vi.fn()
      .mockResolvedValueOnce({ session: firstSession })
      .mockImplementationOnce(async () => {
        markReplacementStarted();
        await replacementGate;
        return { session: replacementSession };
      });
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
    }, { loadModule: async () => ({
      ...runScopeApi(), SessionManager: { create: vi.fn(() => ({})), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => ({ modelRegistry: { find: vi.fn() } })),
      createAgentSessionFromServices,
    }) as never });
    await harness.complete(presentationRunContext(11, "first-token", 90));

    const rotating = harness.complete(runContext(12, "second-token"));
    await replacementStarted;
    harness.forceShutdown();
    releaseReplacement();

    await expect(rotating).rejects.toThrow("Prime Agent harness is shutting down");
    expect(replacementSession.promptAndWait).not.toHaveBeenCalled();
    expect(replacementDispose).toHaveBeenCalledOnce();
  });

  it("does not resume legacy Prime state whose presentation pin is unknown", async () => {
    const session = {
      sessionFile: "/tmp/fresh.jsonl",
      promptAndWait: vi.fn(async () => undefined), waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined), dispose: vi.fn(), reload: vi.fn(async () => undefined),
    };
    const create = vi.fn(() => "fresh-session");
    const open = vi.fn(() => "legacy-session");
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
      savedState: { primeAgentSessionFile: "/tmp/legacy.jsonl" },
    }, { loadModule: async () => ({
      ...runScopeApi(), SessionManager: { create, open },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => ({ modelRegistry: { find: vi.fn() } })),
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never });

    await harness.complete(runContext(11, "token"));

    expect(open).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith("/tmp/project");
    expect(session.promptAndWait).toHaveBeenCalledOnce();
  });

  it("delivers the same ordered normalized context to Prime and its native children", async () => {
    let prompt = "";
    const session = {
      promptAndWait: vi.fn(async (text: string) => { prompt = text; }),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const harness = await createHarness(session);

    await harness.complete(attachedRunContext(11, "token"));

    expect(prompt).toContain('"message": "Question"');
    expect(prompt.indexOf('"title": "First target"')).toBeLessThan(prompt.indexOf('"title": "Second target"'));
    expect(prompt.indexOf('"first annotation"')).toBeLessThan(prompt.indexOf('"second annotation"'));
    expect(prompt).toContain("product assigns no semantic precedence");
    expect(prompt).toContain("including in native child agents");
    expect(prompt).toContain("await graph.get_interaction_input()");
    expect(prompt).not.toContain("sourceNodeId");
    expect(prompt).not.toContain("sourceLayerId");
  });

  it("does not start a prompt when the run was already cancelled", async () => {
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const harness = await PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      ...fullPermission,
      configuration,
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => ({ modelRegistry: { find: vi.fn() } })),
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never });
    const controller = new AbortController();
    controller.abort(new Error("cancelled before admission"));

    await expect(harness.complete(runContext(11, "token"), controller.signal)).rejects.toThrow("cancelled before admission");
    expect(session.promptAndWait).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("aborts without prompting when cancellation races listener registration", async () => {
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const harness = await createHarness(session);
    const controller = new AbortController();
    const signal = controller.signal;
    const addEventListener = signal.addEventListener.bind(signal);
    vi.spyOn(signal, "addEventListener").mockImplementation((type, listener, options) => {
      addEventListener(type, listener, options);
      if (type === "abort") controller.abort(new Error("cancelled during registration"));
    });

    await expect(harness.complete(runContext(11, "token"), signal)).rejects.toThrow("cancelled during registration");
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.promptAndWait).not.toHaveBeenCalled();
    expect(session.waitForRlmQuiescence).not.toHaveBeenCalled();
  });

  it("does not settle a cancelled completion until Prime Agent abort settles", async () => {
    let releasePrompt!: () => void;
    const waitingForPrompt = new Promise<void>((resolve) => { releasePrompt = resolve; });
    let releaseAbort!: () => void;
    const waitingForAbort = new Promise<void>((resolve) => { releaseAbort = resolve; });
    let releaseQuiescence!: () => void;
    const waitingForQuiescence = new Promise<void>((resolve) => { releaseQuiescence = resolve; });
    const session = {
      promptAndWait: vi.fn(async () => waitingForPrompt),
      waitForRlmQuiescence: vi.fn(async () => waitingForQuiescence),
      abort: vi.fn(async () => {
        releasePrompt();
        await waitingForAbort;
      }),
      dispose: vi.fn(),
    };
    const harness = await createHarness(session);
    const controller = new AbortController();
    let settled = false;

    const completing = harness.complete(runContext(11, "token"), controller.signal);
    void completing.then(() => { settled = true; }, () => { settled = true; });
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    releaseAbort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseQuiescence();
    await completing;
    expect(settled).toBe(true);
  });

  it("keeps completion unsettled until recursive Prime work is quiescent", async () => {
    let releaseQuiescence!: () => void;
    const waitingForQuiescence = new Promise<void>((resolve) => { releaseQuiescence = resolve; });
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => waitingForQuiescence),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const harness = await createHarness(session);
    let settled = false;
    const completing = harness.complete(runContext(11, "token"));
    void completing.finally(() => { settled = true; });

    await new Promise((resolve) => setImmediate(resolve));
    expect(session.promptAndWait).toHaveBeenCalledOnce();
    expect(session.waitForRlmQuiescence).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    releaseQuiescence();
    await completing;
    expect(settled).toBe(true);
  });

  it("aggregates root and recursive-quiescence failures", async () => {
    const session = {
      promptAndWait: vi.fn(async () => { throw new Error("root failed"); }),
      waitForRlmQuiescence: vi.fn(async () => { throw new Error("barrier failed"); }),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const harness = await createHarness(session);
    const error = await harness.complete(runContext(11, "token")).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map(String)).toEqual(["Error: root failed", "Error: barrier failed"]);
  });

  it("reports a Prime Agent abort failure", async () => {
    let releasePrompt!: () => void;
    const waitingForPrompt = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const session = {
      promptAndWait: vi.fn(async () => waitingForPrompt),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => {
        releasePrompt();
        throw new Error("abort failed");
      }),
      dispose: vi.fn(),
    };
    const harness = await createHarness(session);
    const controller = new AbortController();

    const completing = harness.complete(runContext(11, "token"), controller.signal);
    controller.abort();

    await expect(completing).rejects.toThrow("abort failed");
  });

  it("rejects unsupported implementation settings before loading Prime Agent", async () => {
    const loadModule = vi.fn();
    await expect(PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      ...fullPermission,
      configuration: { ...configuration, settings: { model: "invalid" } },
    }, { loadModule })).rejects.toThrow("Unknown prime.agent configuration field: model");
    expect(loadModule).not.toHaveBeenCalled();
  });

  it("rejects malformed bounded permission bindings before loading Prime Agent", async () => {
    const loadModule = vi.fn();
    await expect(PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      permissionProfileId: "auto",
      permissionBinding: {},
      configuration,
    }, { loadModule })).rejects.toThrow("requires workspace-write@1");
    expect(loadModule).not.toHaveBeenCalled();
  });

  it("disables base kernel prewarming for bounded sessions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "relayer-prime-no-prewarm-"));
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const createAgentSessionFromServices = vi.fn(async () => ({ session }));
    try {
      await PrimeAgentHarness.create({
        threadId: 7,
        workingDirectory: workspace,
        permissionProfileId: "auto",
        permissionBinding: { boundary: "workspace-write@1", reviewer: "automatic", networkAccessEnabled: true },
        configuration: {
          ...configuration,
          permissionBindings: {
            auto: { boundary: "workspace-write@1", reviewer: "automatic", networkAccessEnabled: true },
          },
        },
      }, {
        loadModule: async () => ({
          ...runScopeApi(),
          AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION: 1,
          AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION: 1,
          createAgentRunToolAuthorityScope: vi.fn((input: unknown) => ({ input })),
          createAgentRunKernelBoundaryScope: vi.fn((input: unknown) => ({ input })),
          SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
          createHostRequestHandler: (handler: unknown) => handler,
          createAgentSessionServices: vi.fn(async () => ({})),
          createAgentSessionFromServices,
        }) as never,
        createKernelBoundary: () => async () => ({ launch: vi.fn(), dispose: vi.fn(async () => undefined) }),
      });
      expect(createAgentSessionFromServices).toHaveBeenCalledWith(expect.objectContaining({ prewarmIpythonKernel: false }));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails a valid bounded profile before session setup when Prime lacks exact v1 APIs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "relayer-prime-missing-api-"));
    const createAgentSessionServices = vi.fn();
    try {
      await expect(PrimeAgentHarness.create({
        threadId: 7,
        workingDirectory: workspace,
        permissionProfileId: "ask",
        permissionBinding: { boundary: "workspace-write@1", reviewer: "user", networkAccessEnabled: true },
        configuration,
      }, { loadModule: async () => ({
        ...runScopeApi(),
        SessionManager: { create: vi.fn(), open: vi.fn() },
        createHostRequestHandler: (handler: unknown) => handler,
        createAgentSessionServices,
        createAgentSessionFromServices: vi.fn(),
      }) as never })).rejects.toThrow("does not support version-1 bounded tool and kernel authority");
      expect(createAgentSessionServices).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("routes Ask through exact approval scope after boundary attestation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "relayer-prime-ask-"));
    try {
      const approvals = vi.fn(async (input: unknown) => {
        parseHarnessApprovalRequestInput(input);
        return {
          requestId: "approval-1",
          decision: "approve_always",
          actor: "user",
          decidedAt: "2026-08-26T00:00:00.000Z",
        } as const;
      });
      const observedAuthorizations: unknown[] = [];
      const session = {
        promptAndWait: vi.fn(async (_text: string, options: any) => {
          const boundary = options.kernelBoundaryScope.input;
          const execution = { executionId: "root-execution", sessionId: "prime-session", recursionDepth: 0, cwd: workspace, signal: new AbortController().signal };
          await boundary.prepare(execution);
          const publicExecution = { executionId: execution.executionId, sessionId: execution.sessionId, recursionDepth: execution.recursionDepth, cwd: execution.cwd };
          await boundary.observe({ phase: "initialized", context: publicExecution, policy: boundary.policy });
          observedAuthorizations.push(await options.toolAuthorityScope.input.authorize({
            toolCallId: "tool-root",
            toolName: "ipython",
            args: { code: "print('ok')\n\tprint('again')" },
            context: { executionId: execution.executionId, runContext: options.runContext, recursionDepth: 0, signal: execution.signal },
          }));
          observedAuthorizations.push(await options.toolAuthorityScope.input.authorize({
            toolCallId: "tool-oversized",
            toolName: "ipython",
            args: { code: `x${"\n".repeat(Math.floor(MAX_HARNESS_APPROVAL_TEXT_LENGTH / 2))}` },
            context: { executionId: execution.executionId, runContext: options.runContext, recursionDepth: 0, signal: execution.signal },
          }));
          await boundary.observe({ phase: "terminal", context: publicExecution, policy: boundary.policy, outcome: "completed", cleanup: "completed" });
        }),
        waitForRlmQuiescence: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
      };
      const harness = await createBoundedHarness("ask", workspace, session);
      const canonicalWorkspace = await realpath(workspace);
      const trace = recordingTrace();
      const run = {
        ...runContext(71, "bounded-secret", trace.sink),
        approvals: { request: approvals },
      };

      await harness.complete(run);

      expect(observedAuthorizations).toEqual([
        { decision: "allow" },
        { decision: "deny", reason: "Prime IPython code exceeds the approval display limit" },
      ]);
      expect(approvals).toHaveBeenCalledOnce();
      expect(approvals).toHaveBeenCalledWith(expect.objectContaining({
        providerItemId: "tool-root",
        action: {
          kind: "command",
          command: JSON.stringify("print('ok')\n\tprint('again')"),
          workingDirectory: canonicalWorkspace,
        },
        scopeKeys: expect.arrayContaining([
          "prime.tool:ipython",
          `cwd:${canonicalWorkspace}`,
          "boundary:workspace-write@1",
          "network:enabled",
        ]),
      }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
      const receiptTrace = JSON.stringify(trace.events.filter((event) => event.type === "provider.event"));
      expect(receiptTrace).toContain('"boundaryVersion":1');
      expect(receiptTrace).toContain('"reviewerMode":"ask"');
      expect(receiptTrace).toContain('"cleanupOutcome":"completed"');
      expect(receiptTrace).not.toContain(canonicalWorkspace);
      expect(receiptTrace).not.toContain("print('ok')");
      expect(receiptTrace).not.toContain("bounded-secret");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("Auto allows only validated IPython after attestation and Full omits bounded scopes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "relayer-prime-auto-"));
    try {
      const decisions: unknown[] = [];
      const boundedSession = {
        promptAndWait: vi.fn(async (_text: string, options: any) => {
          const boundary = options.kernelBoundaryScope.input;
          const signal = new AbortController().signal;
          await boundary.observe({
            phase: "initialized",
            context: { executionId: "child", sessionId: "session", recursionDepth: 1, cwd: workspace },
            policy: boundary.policy,
          });
          for (const [toolName, args] of [["ipython", { code: "1 + 1" }], ["unknown", { code: "1 + 1" }], ["ipython", { input: "1 + 1" }]] as const) {
            decisions.push(await options.toolAuthorityScope.input.authorize({
              toolCallId: `call-${decisions.length}`, toolName, args,
              context: { executionId: "child", runContext: options.runContext, recursionDepth: 1, signal },
            }));
          }
        }),
        waitForRlmQuiescence: vi.fn(async () => undefined), abort: vi.fn(async () => undefined), dispose: vi.fn(),
      };
      const bounded = await createBoundedHarness("auto", workspace, boundedSession);
      await bounded.complete(runContext(72, "auto-secret"));
      expect(decisions).toEqual([
        { decision: "allow" },
        { decision: "deny", reason: "Relayer does not recognize this Prime tool request" },
        { decision: "deny", reason: "Relayer does not recognize this Prime tool request" },
      ]);

      const fullSession = { promptAndWait: vi.fn(async (_text: string, options: any) => {
        expect(options).not.toHaveProperty("toolAuthorityScope");
        expect(options).not.toHaveProperty("kernelBoundaryScope");
      }), waitForRlmQuiescence: vi.fn(async () => undefined), abort: vi.fn(async () => undefined), dispose: vi.fn() };
      const full = await createHarness(fullSession);
      await full.complete(runContext(73, "full-secret"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns an Ask denial to Prime without executing the recognized cell", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "relayer-prime-deny-"));
    try {
      let executed = false;
      const session = {
        promptAndWait: vi.fn(async (_text: string, options: any) => {
          const boundary = options.kernelBoundaryScope.input;
          const run = { executionId: "denied-root", sessionId: "session", recursionDepth: 0, cwd: workspace };
          await boundary.observe({ phase: "initialized", context: run, policy: boundary.policy });
          const decision = await options.toolAuthorityScope.input.authorize({
            toolCallId: "denied-call", toolName: "ipython", args: { code: "executed = True" },
            context: { executionId: run.executionId, runContext: options.runContext, recursionDepth: 0, signal: new AbortController().signal },
          });
          if (decision.decision === "allow") executed = true;
          expect(decision).toEqual({ decision: "deny", reason: "not now" });
        }),
        waitForRlmQuiescence: vi.fn(async () => undefined), abort: vi.fn(async () => undefined), dispose: vi.fn(),
      };
      const harness = await createBoundedHarness("ask", workspace, session);
      const base = runContext(74, "deny-secret");
      await harness.complete({
        ...base,
        approvals: { request: vi.fn(async () => ({
          requestId: "denied", decision: "deny", actor: "user", decidedAt: "2026-08-26T00:00:00.000Z", rationale: "not now",
        } as const)) },
      });
      expect(executed).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("subscribes for the duration of a run and reports recursive coverage honestly", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const session = {
      promptAndWait: vi.fn(async () => {
        listener?.({ type: "turn_start" });
        listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Visible" }], usage: { input: 2, output: 3 } } });
        listener?.({ type: "rlm_child_update", child: { id: "child-1", label: "Research", status: "completed", answerPreview: "Evidence", toolUseCount: 1 } });
        listener?.({ type: "turn_end" });
      }),
      subscribe: vi.fn((next: (event: unknown) => void) => { listener = next; return unsubscribe; }),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const harness = await createHarness(session);
    const trace = recordingTrace();

    await harness.complete(runContext(11, "token", trace.sink));

    expect(session.subscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(JSON.stringify(trace.events)).not.toContain("hidden");
    expect(trace.events.map((event) => event.type)).toEqual(expect.arrayContaining(["provider.event", "message", "usage", "model.call.started", "model.call.completed"]));
    expect(harness.traceSupport()).toMatchObject({ childStreams: "summary", reasoningSummaries: "none" });
  });

  it("scrubs exact provider access recursively from usage traces and exports", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-prime-usage-trace-"));
    let listener: ((event: unknown) => void) | undefined;
    const session = {
      promptAndWait: vi.fn(async () => {
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "safe" }],
            usage: {
              nested: {
                note: "credential=test-secret",
                source: "https://api.openai.test/v1/models",
              },
            },
          },
        });
      }),
      subscribe: vi.fn((next: (event: unknown) => void) => { listener = next; return vi.fn(); }),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const harness = await createHarness(session);
    const store = new HarnessTraceStore({
      directory: join(directory, "traces"),
      policy: {
        mode: "required",
        requiredFeatures: {},
        includeNativeArtifacts: false,
        maxBytesPerTurn: 100_000,
        maxEventsPerTurn: 100,
      },
    });
    const active = store.start({
      threadId: 7,
      interactionNodeId: 11,
      productInteractionId: 77,
      implementation: "prime.agent",
      configurationName: "prime-agent-basic",
      support: harness.traceSupport(),
    });
    try {
      await harness.complete(runContext(11, "token", active.sink));
      await active.seal("complete");
      const exported = join(directory, "exported");
      await store.export(77, exported, {
        runId: "run",
        executionId: "execution",
        interactionId: "77",
        harnessConfigurationName: "prime-agent-basic",
      });
      const events = await readFile(join(exported, "events.jsonl"), "utf8");
      expect(events).toContain("[redacted-provider-access]");
      expect(events).not.toContain("test-secret");
      expect(events).not.toContain("https://api.openai.test/v1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records only validated package provenance in execution traces", async () => {
    const previous = process.env.RELAYER_PRIME_RUNTIME_PROVENANCE;
    process.env.RELAYER_PRIME_RUNTIME_PROVENANCE = JSON.stringify({
      sourceCommit: "f6130839ad3043f1cd3d5294fe03023035bfcd5c",
      packages: ["agent-core", "ai", "coding-agent", "tui"].map((name) => ({
        name: `@earendil-works/pi-${name}`,
        version: "0.8.1",
      })),
      secret: "must-not-trace",
    });
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    try {
      const harness = await createHarness(session);
      const trace = recordingTrace();
      await harness.complete(runContext(11, "token", trace.sink));
      const serialized = JSON.stringify(trace.events);
      expect(serialized).toContain("runtime.provenance");
      expect(serialized).toContain("f6130839ad3043f1cd3d5294fe03023035bfcd5c");
      expect(serialized).toContain("@earendil-works/pi-coding-agent");
      expect(serialized).not.toContain("must-not-trace");
    } finally {
      if (previous === undefined) delete process.env.RELAYER_PRIME_RUNTIME_PROVENANCE;
      else process.env.RELAYER_PRIME_RUNTIME_PROVENANCE = previous;
    }
  });

  it("omits runtime provenance when the package set is duplicated", async () => {
    const previous = process.env.RELAYER_PRIME_RUNTIME_PROVENANCE;
    process.env.RELAYER_PRIME_RUNTIME_PROVENANCE = JSON.stringify({
      sourceCommit: "f6130839ad3043f1cd3d5294fe03023035bfcd5c",
      packages: Array.from({ length: 4 }, () => ({
        name: "@earendil-works/pi-ai",
        version: "0.8.1",
      })),
    });
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    try {
      const harness = await createHarness(session);
      const trace = recordingTrace();
      await harness.complete(runContext(12, "token", trace.sink));
      expect(JSON.stringify(trace.events)).not.toContain("runtime.provenance");
    } finally {
      if (previous === undefined) delete process.env.RELAYER_PRIME_RUNTIME_PROVENANCE;
      else process.env.RELAYER_PRIME_RUNTIME_PROVENANCE = previous;
    }
  });
});

function managedRuntimePaths(root: string) {
  const installation = "11111111-1111-4111-8111-111111111111";
  const targetRoot = join(root, "prime", "macos-arm64");
  return {
    runtimeId: "prime" as const,
    executable: join(targetRoot, "installations", installation, "python"),
    moduleUrl: "file:///managed/prime/prime.mjs",
    installationRoot: join(targetRoot, "installations", installation),
    privateStateRoot: join(targetRoot, "private-state", installation),
  };
}

function runContext(nodeId: number, token: string, trace: HarnessTraceSink = createNoopHarnessTraceSink()): HarnessRunContext {
  const inputGraph = { id: nodeId, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" as const };
  const route = {
    providerId: "openai-work",
    adapterId: "openai-api",
    accessContract: "secret@1",
    modelId: "gpt-test",
    adapterImplementationVersion: "2",
  } as const;
  const access = {
    kind: "secret",
    contract: "secret@1",
    providerId: route.providerId,
    adapterId: route.adapterId,
    adapterImplementationVersion: route.adapterImplementationVersion,
    endpoint: "https://api.openai.test/v1",
    fields: { "api-key": "test-secret" },
  } as const;
  return {
    origin: { kind: "root" },
    inputGraph,
    interactionInput: { interaction: inputGraph, contexts: [] },
    graph: {
      interactionNodeId: nodeId,
      acquireCapability: () => ({ url: "http://127.0.0.1:43123", token, nodeId }),
    },
    approvals: { request: async () => { throw new Error("unused approval channel"); } },
    model: { providerId: route.providerId, adapterId: route.adapterId, modelId: route.modelId },
    modelPlan: {
      familyId: 1,
      familyRevision: 1,
      orchestrator: route,
      roster: [route],
      harnessPolicyDigest: "sha256:policy",
      digest: `sha256:plan-${nodeId}`,
    },
    access,
    accessBundle: { byProviderId: { [route.providerId]: access } },
    trace,
  };
}

function invokedRunContext(context: HarnessRunContext, actionId: number): HarnessRunContext {
  return {
    ...context,
    origin: { kind: "invoke", sourceCompletionId: 1, actionId },
  };
}

function primeSession(
  sessionFile: string,
  overrides: Partial<PrimeAgentSessionFixture> = {},
): PrimeAgentSessionFixture & { readonly sessionFile: string } {
  return {
    sessionFile,
    promptAndWait: vi.fn(async () => undefined),
    waitForRlmQuiescence: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
    disposeAsync: vi.fn(async () => undefined),
    ...overrides,
  };
}

function attachedRunContext(nodeId: number, token: string): HarnessRunContext {
  const context = runContext(nodeId, token);
  return {
    ...context,
    interactionInput: {
      interaction: context.inputGraph,
      contexts: [
        {
          type: "interaction.context",
          targetNode: { id: 20, kind: "concept", icon: "box", title: "First target", detail: "First detail", state: "accepted" },
          annotations: ["first annotation", "second annotation"],
        },
        {
          type: "interaction.context",
          targetNode: { id: 21, kind: "concept", icon: "box", title: "Second target", detail: "Second detail", state: "accepted" },
          annotations: ["third annotation"],
        },
      ],
    },
  };
}

function presentationRunContext(nodeId: number, token: string, versionId: number): HarnessRunContext {
  return {
    ...runContext(nodeId, token),
    personalPresentation: {
      attachment: { interactionNodeId: nodeId, versionInteractionNodeId: versionId, rootLayerId: 91 },
      graph: {
        nodeId: versionId,
        rootLayerId: 91,
        rootAction: { id: 92, sourceNodeId: versionId, kind: "navigate", relation: "expand", label: "Personal presentation", variant: "pill", targetLayerId: 91, state: "accepted" },
        layers: [{
          layer: { id: 91, nodes: [93], edges: [], state: "accepted" },
          nodes: [{ id: 93, kind: "presentation-preference", icon: "compass", title: "Decision-useful center", detail: "Foreground the conclusion.", state: "accepted" }],
          edges: [], actions: [],
        }],
      },
    },
  };
}

async function createHarness(
  session: PrimeAgentSessionFixture,
  harnessConfiguration: HarnessConfiguration = configuration,
): Promise<PrimeAgentHarness> {
  return PrimeAgentHarness.create({
    threadId: 7,
    workingDirectory: "/tmp/project",
    ...fullPermission,
    configuration: harnessConfiguration,
  }, { loadModule: async () => ({
    ...runScopeApi(),
    SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
    createHostRequestHandler: (handler: unknown) => handler,
    createAgentSessionServices: vi.fn(async () => ({ modelRegistry: { find: vi.fn() } })),
    createAgentSessionFromServices: vi.fn(async () => ({ session })),
  }) as never });
}

async function createBoundedHarness(
  profile: "ask" | "auto",
  workspace: string,
  session: PrimeAgentSessionFixture,
): Promise<PrimeAgentHarness> {
  const reviewer = profile === "ask" ? "user" : "automatic";
  return PrimeAgentHarness.create({
    threadId: 7,
    workingDirectory: workspace,
    permissionProfileId: profile,
    permissionBinding: { boundary: "workspace-write@1", reviewer, networkAccessEnabled: true },
    configuration: {
      ...configuration,
      permissionBindings: {
        [profile]: { boundary: "workspace-write@1", reviewer, networkAccessEnabled: true },
      },
    },
  }, {
    loadModule: async () => ({
      ...runScopeApi(),
      AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION: 1,
      AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION: 1,
      createAgentRunToolAuthorityScope: vi.fn((input: unknown) => ({ input })),
      createAgentRunKernelBoundaryScope: vi.fn((input: unknown) => ({ input })),
      SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => ({})),
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never,
    createKernelBoundary: () => async () => ({ launch: vi.fn(), dispose: vi.fn(async () => undefined) }),
  });
}

interface PrimeAgentSessionFixture {
  readonly promptAndWait: ReturnType<typeof vi.fn>;
  readonly waitForRlmQuiescence: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly disposeAsync?: ReturnType<typeof vi.fn>;
  readonly subscribe?: ReturnType<typeof vi.fn>;
}

function invocation(runContext: HarnessRunContext) {
  return {
    runContext,
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
}

function recordingTrace(): { sink: HarnessTraceSink; events: HarnessTraceEventInput[] } {
  const events: HarnessTraceEventInput[] = [];
  const noop = createNoopHarnessTraceSink();
  return { sink: { ...noop, emit: (event) => { events.push({ ...event, streamId: noop.rootStreamId }); } }, events };
}

function runScopeApi() {
  return {
    AGENT_RUN_MODEL_SCOPE_VERSION: 1,
    createAgentRunModelScope: vi.fn((input: unknown) => input),
  } as const;
}

interface ControlledPrimeModel {
  readonly id: string;
  readonly provider: string;
  readonly api: string;
  readonly baseUrl: string;
  readonly reasoning: boolean;
  readonly input: readonly string[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly cost: Readonly<Record<string, number>>;
  readonly compat?: Readonly<Record<string, unknown>>;
}

interface ControlledRunScopeInput {
  readonly root: ControlledPrimeModel;
  readonly models: readonly ControlledPrimeModel[];
  readonly requestAccess: readonly {
    readonly model: ControlledPrimeModel;
    readonly access: { readonly kind: "secret"; readonly contract: "secret@1"; readonly apiKey: string };
  }[];
}

interface ControlledRunScope {
  readonly input: ControlledRunScopeInput;
  resolve(model: ControlledPrimeModel): { readonly apiKey: string };
  revoke(): void;
}

function controlledRunScopeApi(scopes: ControlledRunScope[]) {
  return {
    AGENT_RUN_MODEL_SCOPE_VERSION: 1,
    createAgentRunModelScope: vi.fn((input: ControlledRunScopeInput): ControlledRunScope => {
      let active = true;
      const scope: ControlledRunScope = {
        input,
        resolve(model) {
          if (!active) throw new Error("Agent run model scope is revoked");
          const entry = input.requestAccess.find(({ model: admitted }) => (
            admitted.provider === model.provider
            && admitted.id === model.id
            && admitted.api === model.api
            && admitted.baseUrl === model.baseUrl
          ));
          if (!entry) throw new Error(`Agent run model ${model.provider}/${model.id} has no upfront access`);
          return entry.access;
        },
        revoke() { active = false; },
      };
      scopes.push(scope);
      return scope;
    }),
  } as const;
}

function familyRunContext(
  nodeId: number,
  token: string,
  orchestratorIndex: number,
  trace: HarnessTraceSink = createNoopHarnessTraceSink(),
): HarnessRunContext {
  const routes = [
    { providerId: "openai-personal", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt-shared", adapterImplementationVersion: "2" },
    { providerId: "openai-work", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt-shared", adapterImplementationVersion: "2" },
    { providerId: "anthropic-work", adapterId: "anthropic-api", accessContract: "secret@1", modelId: "claude-root", adapterImplementationVersion: "2" },
    { providerId: "openrouter-work", adapterId: "openrouter", accessContract: "secret@1", modelId: "qwen-root", adapterImplementationVersion: "2" },
    { providerId: "vercel-work", adapterId: "vercel-ai-router", accessContract: "secret@1", modelId: "gemini-root", adapterImplementationVersion: "2" },
  ] as const;
  const orchestrator = routes[orchestratorIndex];
  if (orchestrator === undefined) throw new Error("invalid test orchestrator");
  const access = {
    "openai-personal": {
      kind: "secret", contract: "secret@1", providerId: "openai-personal", adapterId: "openai-api",
      adapterImplementationVersion: "2", endpoint: "https://openai-personal.test/v1", fields: { "api-key": "secret-openai-personal" },
    },
    "openai-work": {
      kind: "secret", contract: "secret@1", providerId: "openai-work", adapterId: "openai-api",
      adapterImplementationVersion: "2", endpoint: "https://openai-work.test/v1", fields: { "api-key": "secret-openai-work" },
    },
    "anthropic-work": {
      kind: "secret", contract: "secret@1", providerId: "anthropic-work", adapterId: "anthropic-api",
      adapterImplementationVersion: "2", endpoint: "https://anthropic-work.test/v1", fields: { "api-key": "secret-anthropic-work" },
    },
    "openrouter-work": {
      kind: "secret", contract: "secret@1", providerId: "openrouter-work", adapterId: "openrouter",
      adapterImplementationVersion: "2", endpoint: "https://openrouter-work.test/v1", fields: { "api-key": "secret-openrouter-work" },
    },
    "vercel-work": {
      kind: "secret", contract: "secret@1", providerId: "vercel-work", adapterId: "vercel-ai-router",
      adapterImplementationVersion: "2", endpoint: "https://vercel-work.test/v1", fields: { "api-key": "secret-vercel-work" },
    },
  } as const;
  const base = runContext(nodeId, token, trace);
  return {
    ...base,
    model: { providerId: orchestrator.providerId, adapterId: orchestrator.adapterId, modelId: orchestrator.modelId },
    modelPlan: {
      familyId: 91,
      familyRevision: 3,
      orchestrator,
      roster: routes,
      harnessPolicyDigest: "sha256:family-policy",
      digest: `sha256:family-${nodeId}`,
    },
    access: access[orchestrator.providerId],
    accessBundle: { byProviderId: access },
  };
}

function singleAdapterRunContext(
  nodeId: number,
  adapterId: string,
  modelCapabilities?: { readonly contextWindow: number; readonly maxOutputTokens: number },
  endpoint = `https://provider-${nodeId}.test/v1`,
): HarnessRunContext {
  const base = runContext(nodeId, `token-${nodeId}`);
  const route = {
    providerId: `provider-${nodeId}`,
    adapterId,
    accessContract: "secret@1",
    modelId: `model-${nodeId}`,
    adapterImplementationVersion: "2",
  } as const;
  const access = {
    kind: "secret",
    contract: "secret@1",
    providerId: route.providerId,
    adapterId,
    adapterImplementationVersion: "2",
    endpoint,
    fields: { "api-key": `secret-${nodeId}` },
    ...(modelCapabilities === undefined ? {} : {
      modelCapabilities: { [route.modelId]: modelCapabilities },
    }),
  } as const;
  return {
    ...base,
    model: { providerId: route.providerId, adapterId, modelId: route.modelId },
    modelPlan: {
      familyId: nodeId,
      familyRevision: 1,
      orchestrator: route,
      roster: [route],
      harnessPolicyDigest: "sha256:policy",
      digest: `sha256:adapter-${nodeId}`,
    },
    access,
    accessBundle: { byProviderId: { [route.providerId]: access } },
  };
}
