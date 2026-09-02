import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAX_HARNESS_APPROVAL_TEXT_LENGTH, parseHarnessApprovalRequestInput } from "../src/approval.js";
import { PrimeAgentHarness } from "../src/implementations/prime-agent.js";
import type { PrimeAgentDependencies } from "../src/implementations/prime-agent.js";
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
type LoadModuleFn = NonNullable<PrimeAgentDependencies["loadModule"]>;


describe("PrimeAgentHarness", () => {
  it("uses only owned managed state paths and rejects every symlink escape before Prime services write", async () => {
    {
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

      expect(loadModule, "module loaded exactly once").toHaveBeenCalledOnce();
      expect(createAgentSessionServices, "managed agent dir and kernel wiring").toHaveBeenCalledWith(expect.objectContaining({
        agentDir: join(runtime.privateStateRoot, "agent"),
        managedKernel: { version: 1, pythonExecutable: runtime.executable },
      }));
      expect(createSessionManager, "managed session directory wiring").toHaveBeenCalledWith("/tmp/project", join(runtime.privateStateRoot, "sessions"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    }

    {
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

      expect(open, "regular saved session opens from its realpath").toHaveBeenCalledWith(await realpath(savedSession));
      expect(create, "no fresh session alongside a restored one").not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    }

    type EscapeContext = {
      root: string;
      outside: string;
      runtime: ReturnType<typeof managedRuntimePaths>;
      loadModule: LoadModuleFn;
      createAgentSessionServices: ReturnType<typeof vi.fn>;
      open: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    type EscapeRow = { label: string; run: (ctx: EscapeContext) => Promise<void> };
    const escapeRows: readonly EscapeRow[] = [
      {
        label: "symlinked private state root",
        run: async ({ root, outside, runtime, loadModule, createAgentSessionServices }) => {
          await mkdir(join(root, "prime", "macos-arm64", "private-state"), { recursive: true });
          await symlink(outside, runtime.privateStateRoot, "dir");
          await expect(PrimeAgentHarness.create({
            threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
          }, { loadModule, resolvePrimeRuntime: async () => runtime }), "symlinked private state root rejects")
            .rejects.toThrow(/private state is not an owned directory/i);
          expect(loadModule, "symlinked private state root never loads Prime").not.toHaveBeenCalled();
          expect(createAgentSessionServices, "symlinked private state root never builds services").not.toHaveBeenCalled();
        },
      },
      ...(["agent", "sessions"] as const).map((child): EscapeRow => ({
        label: `symlinked ${child} state child`,
        run: async ({ outside, runtime, loadModule, createAgentSessionServices }) => {
          await mkdir(runtime.privateStateRoot, { recursive: true });
          await symlink(outside, join(runtime.privateStateRoot, child), "dir");
          await expect(PrimeAgentHarness.create({
            threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
          }, { loadModule, resolvePrimeRuntime: async () => runtime }), `symlinked ${child} state child rejects`)
            .rejects.toThrow(new RegExp(`${child === "sessions" ? "session" : child} state is not an owned directory`, "i"));
          expect(loadModule, `symlinked ${child} state child never loads Prime`).not.toHaveBeenCalled();
          expect(createAgentSessionServices, `symlinked ${child} state child never builds services`).not.toHaveBeenCalled();
        },
      })),
      {
        label: "saved session file symlinked outside private state",
        run: async ({ outside, runtime, open, create }) => {
          const sessions = join(runtime.privateStateRoot, "sessions");
          const savedSession = join(sessions, "saved.jsonl");
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

          expect(open, "escaped saved session file is never opened").not.toHaveBeenCalled();
          expect(create, "escaped saved session file falls back to a fresh session").toHaveBeenCalledWith("/tmp/project", sessions);
        },
      },
      {
        label: "sessions directory swapped for an outside directory",
        run: async ({ outside, runtime, open, create }) => {
          const sessions = join(runtime.privateStateRoot, "sessions");
          const savedSession = join(sessions, "saved.jsonl");
          await mkdir(runtime.privateStateRoot, { recursive: true });
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
          }), "escaped sessions directory rejects").rejects.toThrow(/session state is not an owned directory/i);
          expect(open, "escaped sessions directory never opens saved state").not.toHaveBeenCalled();
          expect(create, "escaped sessions directory never creates a session").not.toHaveBeenCalled();
        },
      },
    ];
    expect(escapeRows, "managed state escape inventory").toHaveLength(5);
    for (const escapeRow of escapeRows) {
      const root = await mkdtemp(join(tmpdir(), "relayer-prime-managed-escape-"));
      const outside = await mkdtemp(join(tmpdir(), "relayer-prime-escape-outside-"));
      const runtime = managedRuntimePaths(root);
      const createAgentSessionServices = vi.fn(async () => ({}));
      const open = vi.fn(() => "fresh-managed-session");
      const create = vi.fn(() => "fresh-managed-session");
      const loadModule = vi.fn(async () => ({
        ...runScopeApi(),
        SessionManager: { create, open },
        createHostRequestHandler: (handler: unknown) => handler,
        createAgentSessionServices,
        createAgentSessionFromServices: vi.fn(async () => ({ session: primeSession(join(runtime.privateStateRoot, "sessions", "fresh.jsonl")) })),
      }) as never);
      try {
        await escapeRow.run({ root, outside, runtime, loadModule, createAgentSessionServices, open, create });
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    }
  });


  it("walks the forced and graceful disposal state machine without double disposal or leaked failures", async () => {
    {
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

    expect(session.abort, "forced shutdown aborts once").toHaveBeenCalledOnce();
    expect(nativeSyncDispose, "forced shutdown uses native synchronous disposal").toHaveBeenCalledOnce();
    expect(session.disposeAsync, "forced shutdown never takes the graceful path").not.toHaveBeenCalled();
    }

    {
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

    expect(session.abort, "reentrant continuation never aborts again").toHaveBeenCalledOnce();
    expect(nativeSyncDispose, "reentrant abort continuation never disposes again").toHaveBeenCalledOnce();
    }

    const abortFailureRows = [
      ["asynchronous native abort rejection", vi.fn(async () => { throw new Error("abort failed"); })],
      ["synchronous native abort failure", vi.fn(() => { throw new Error("abort failed synchronously"); })],
    ] as const;
    expect(abortFailureRows, "abort failure inventory").toHaveLength(2);
    for (const [label, abort] of abortFailureRows) {
      const nativeSyncDispose = vi.fn();
      const session = {
        promptAndWait: vi.fn(async () => undefined),
        waitForRlmQuiescence: vi.fn(async () => undefined),
        abort,
        dispose: nativeSyncDispose,
      };
      const harness = await createHarness(session);

      expect(() => harness.forceShutdown(), `${label} stays contained`).not.toThrow();
      await Promise.resolve();

      expect(abort, `${label} aborts once`).toHaveBeenCalledOnce();
      expect(nativeSyncDispose, `${label} still force-disposes`).toHaveBeenCalledOnce();
    }

    {
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

    expect(() => harness.forceShutdown(), "forced native disposal failure propagates").toThrow("forced native disposal failed");
    await expect(harness.dispose()).resolves.toBeUndefined();
    harness.forceShutdown();
    await harness.dispose();

    expect(session.abort, "retry never aborts again").toHaveBeenCalledOnce();
    expect(session.disposeAsync, "graceful cleanup retries through the async path").toHaveBeenCalledOnce();
    expect(nativeSyncDispose, "native disposal retried after the forced failure").toHaveBeenCalledTimes(2);
    }

    {
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

    expect(session.disposeAsync, "graceful shutdown uses native asynchronous disposal").toHaveBeenCalledOnce();
    expect(nativeSyncDispose, "graceful shutdown disposes exactly once").toHaveBeenCalledOnce();
    expect(session.abort, "graceful shutdown never aborts").not.toHaveBeenCalled();
    }

    {
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

    expect(nativeSyncDispose, "fallback disposal never force-disposes again").toHaveBeenCalledOnce();
    expect(session.abort, "fallback disposal never aborts").not.toHaveBeenCalled();
    }

    {
    const nativeSyncDispose = vi.fn();
    const session = {
      promptAndWait: vi.fn(async () => undefined),
      waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: nativeSyncDispose,
      disposeAsync: vi.fn(async () => { throw new Error("graceful disposal failed"); }),
    };
    const harness = await createHarness(session);

    await expect(harness.dispose(), "graceful failure preserved on first attempt").rejects.toThrow("graceful disposal failed");
    await expect(harness.dispose(), "graceful failure preserved on retry").rejects.toThrow("graceful disposal failed");

    expect(session.disposeAsync, "failed graceful disposal never retries underneath").toHaveBeenCalledOnce();
    expect(nativeSyncDispose, "failed graceful disposal never falls back to force").not.toHaveBeenCalled();
    }

    {
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
    expect(harness.dispose(), "one published graceful disposal promise").toBe(graceful);
    harness.forceShutdown();
    await graceful;
    await harness.dispose();

    expect(session.abort, "force wins before graceful disposal starts").toHaveBeenCalledOnce();
    expect(nativeSyncDispose, "native disposal owned by force").toHaveBeenCalledOnce();
    expect(session.disposeAsync, "graceful path never runs after force wins").not.toHaveBeenCalled();
    }

    {
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

    expect(session.abort, "stale rejection race aborts once").toHaveBeenCalledOnce();
    expect(nativeSyncDispose, "stale rejection race disposes once").toHaveBeenCalledOnce();
    expect(session.disposeAsync, "stale graceful cleanup runs to completion").toHaveBeenCalledOnce();
    }

    {
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

    expect(session.abort, "successful drain race aborts once").toHaveBeenCalledOnce();
    expect(session.disposeAsync, "successful drain runs to completion").toHaveBeenCalledOnce();
    expect(nativeSyncDispose, "native dispose boundary guarded after force wins the drain").toHaveBeenCalledOnce();
    }
  });


  it("keeps root session continuity while invoked Prime sessions start, cancel, and shut down", async () => {
    {
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

    expect(createAgentSessionFromServices, "one Prime session across runs").toHaveBeenCalledTimes(1);
    expect(createAgentSessionFromServices).toHaveBeenCalledWith(expect.objectContaining({ prewarmIpythonKernel: true }));
    expect(services.modelRegistry.find, "no ambient registry lookups").not.toHaveBeenCalled();
    expect(createAgentSessionFromServices).toHaveBeenCalledWith(expect.not.objectContaining({ model: expect.anything() }));
    expect(prompts.map(({ runContext }) => runContext), "distinct run context delivered per prompt").toEqual([
      { graph: first.graph, completionBroker: first.completionBroker },
      { graph: second.graph },
    ]);
    expect(createAgentRunModelScope, "one model scope per run").toHaveBeenCalledTimes(2);
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
    await expect(hostHandlers[0]?.({}, invocation(first)), "graph capability host handler").resolves.toEqual({
      url: "http://127.0.0.1:43123",
      token: "first-token",
      nodeId: 11,
    });
    await expect(hostHandlers[1]?.({}, invocation(first)), "completion broker host handler").resolves.toEqual(first.completionBroker);
    expect(harness.state(), "durable session state").toEqual({
      primeAgentSessionFile: "/tmp/prime-session.jsonl",
      primeAgentSessionPersonalPresentationVersionId: null,
    });
    }

    {
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
    expect(attachments, "invoked session attachments").toEqual([
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

    expect(open, "root session restored from saved state").toHaveBeenCalledWith("/tmp/root-prime-session.jsonl");
    expect(create.mock.calls, "fresh sessions for each invoked completion").toEqual([["/tmp/project"], ["/tmp/project"]]);
    expect(createAgentSessionServices).toHaveBeenCalledOnce();
    expect(createAgentSessionFromServices).toHaveBeenCalledTimes(3);
    expect(root.promptAndWait, "root untouched during invoked runs").not.toHaveBeenCalled();
    expect(firstChild.promptAndWait).toHaveBeenCalledOnce();
    expect(secondChild.promptAndWait).toHaveBeenCalledOnce();
    expect(scopes.map(({ input }) => input.root.id), "per-invocation orchestrators").toEqual(["gpt-shared", "claude-root"]);
    expect(scopes[0]!.input.root.provider, "isolated providers per invocation").not.toBe(scopes[1]!.input.root.provider);
    expect(firstChild.waitForRlmQuiescence).toHaveBeenCalledOnce();
    expect(secondChild.waitForRlmQuiescence).toHaveBeenCalledOnce();
    expect(firstChild.disposeAsync).toHaveBeenCalledOnce();
    expect(secondChild.disposeAsync).toHaveBeenCalledOnce();
    expect(harness.state()).toEqual({
      primeAgentSessionFile: "/tmp/root-prime-session.jsonl",
      primeAgentSessionPersonalPresentationVersionId: null,
    });

    await harness.complete(runContext(43, "root-token"));
    expect(root.promptAndWait, "root resumes after invoked completions").toHaveBeenCalledOnce();
    expect(root.disposeAsync, "root session survives the invoked lifecycle").not.toHaveBeenCalled();
    }

    {
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

    expect(cancelledChild.abort, "abort targets only the cancelled session").toHaveBeenCalledOnce();
    expect(root.abort, "root never aborted by a child cancellation").not.toHaveBeenCalled();
    expect(sibling.abort, "sibling never aborted by a sibling cancellation").not.toHaveBeenCalled();
    expect(cancelledSettled, "cancelled completion waits for abort and quiescence").toBe(false);
    expect(cancelledChild.disposeAsync, "no disposal before quiescence settles").not.toHaveBeenCalled();

    releaseQuiescence();
    await cancelled;
    expect(cancelledSettled, "cancelled completion settles after quiescence").toBe(true);
    expect(cancelledChild.disposeAsync, "cancelled session disposed after quiescence").toHaveBeenCalledOnce();
    expect(sibling.disposeAsync, "sibling session disposed after completion").toHaveBeenCalledOnce();
    expect(root.disposeAsync, "root survives targeted cancellation").not.toHaveBeenCalled();
    }

    {
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
    await expect(late, "late completion rejected during shutdown").rejects.toThrow("shutting down");
    expect(activeChild.abort, "active invoked child aborted").toHaveBeenCalledOnce();
    expect(activeChildNativeDispose, "active invoked child natively disposed").toHaveBeenCalledOnce();
    expect(lateChild.promptAndWait, "late invoked child never prompted").not.toHaveBeenCalled();
    expect(lateChild.abort, "late invoked child aborted").toHaveBeenCalledOnce();
    expect(lateChildNativeDispose, "late invoked child natively disposed").toHaveBeenCalledOnce();
    expect(root.abort, "root aborted with its invoked sessions").toHaveBeenCalledOnce();
    expect(rootNativeDispose, "root natively disposed with its invoked sessions").toHaveBeenCalledOnce();
    }
  });


  it("maps admitted families to isolated providers and validates adapter access before prompting", async () => {
    {
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
          expect(() => scope.resolve({ ...scope.input.models[0]!, id: "ambient-outsider" }), "unadmitted model has no upfront access").toThrow("has no upfront access");
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
    expect(() => scopes[0]!.resolve(scopes[0]!.input.root), "first scope revoked after its run").toThrow("revoked");
    await harness.complete(second);
    expect(() => scopes[1]!.resolve(scopes[1]!.input.root), "second scope revoked after its run").toThrow("revoked");

    expect(createAgentSessionFromServices, "session reused across root changes").toHaveBeenCalledOnce();
    expect(session.promptAndWait, "both runs prompt the same session").toHaveBeenCalledTimes(2);
    expect(modelRegistryAuth, "ambient Prime registry auth never runs").not.toHaveBeenCalled();
    expect(scopes[0]!.input.models.map(({ id }) => id), "admitted family model ordering").toEqual([
      "gpt-shared", "gpt-shared", "claude-root", "qwen-root", "gemini-root",
    ]);
    expect(scopes[0]!.input.models[0]!.provider, "duplicate model ids stay provider-isolated").not.toBe(scopes[0]!.input.models[1]!.provider);
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
    expect(scopes[0]!.input.root.id, "first run orchestrator root").toBe("claude-root");
    expect(scopes[1]!.input.root.id, "second run orchestrator root").toBe("gpt-shared");
    expect(scopes[0]!.input.requestAccess, "upfront access for every admitted model").toHaveLength(scopes[0]!.input.models.length);
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
    expect(scopes[0]!.input, "no lazy auth resolver leaks into the scope").not.toHaveProperty("resolveRequestAuth");
    expect(providerRequests.map(({ apiKey }) => apiKey), "resolved provider keys per admitted model").toEqual([
      "secret-openai-personal", "secret-openai-work", "secret-anthropic-work",
      "secret-openrouter-work", "secret-vercel-work",
      "secret-openai-personal", "secret-openai-work", "secret-anthropic-work",
      "secret-openrouter-work", "secret-vercel-work",
    ]);
    expect(harness.state(), "durable session state").toEqual({
      primeAgentSessionFile: "/tmp/family-session.jsonl",
      primeAgentSessionPersonalPresentationVersionId: null,
    });

    const trace = JSON.stringify(firstTrace.events);
    expect(trace, "trace keeps provider attribution").toContain('"providerDefinitionId":"anthropic-work"');
    expect(trace).toContain('"providerDefinitionId":"openai-work"');
    expect(trace).toContain('"adapterId":"anthropic-api"');
    expect(trace).toContain('"adapterId":"openai-api"');
    expect(trace).toContain('"modelId":"claude-root"');
    expect(trace).toContain('"modelId":"gpt-shared"');
    expect(trace).not.toContain("relayer-openai-api-");
    expect(trace, "trace hides endpoints").not.toContain("https://");
    expect(trace, "trace hides unrouted event material").not.toContain("must-not-trace");
    expect(trace, "trace hides provider secrets").not.toContain("secret-openai");
    expect(JSON.stringify(harness.state()), "state hides secrets").not.toContain("secret-");
    }

    {
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

    await expect(harness.complete(invalid), "mismatched adapter access rejects before starting Prime").rejects.toThrow("does not support provider adapter codex-subscription");
    expect(session.promptAndWait, "no prompt after adapter rejection").not.toHaveBeenCalled();
    }

    {
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
    }), "discovered per-model capabilities with conservative fallback")).toEqual([
      { api: "openai-responses", baseUrl: "https://provider-40.test/v1", compat: undefined, reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { api: "anthropic-messages", baseUrl: "https://provider-41.test", compat: undefined, reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { api: "openai-completions", baseUrl: "https://provider-42.test/v1", compat: { thinkingFormat: "openrouter", openRouterRouting: {} }, reasoning: false, input: ["text"], contextWindow: 196_608, maxTokens: 131_072, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { api: "openai-completions", baseUrl: "https://provider-43.test/v1", compat: { vercelGatewayRouting: {} }, reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 384_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { api: "openai-completions", baseUrl: "https://provider-44.test/v1", compat: { thinkingFormat: "openrouter", openRouterRouting: {} }, reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 2_048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { api: "anthropic-messages", baseUrl: "https://provider-45.test/proxy/anthropic", compat: undefined, reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]);
    }

    {
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
    )), "impossible compaction reserve rejects before prompting").rejects.toThrow("context window cannot satisfy Prime's 16384-token compaction reserve");
    expect(session.promptAndWait, "no prompt after reserve rejection").not.toHaveBeenCalled();
    }
  });


  it("opens saved Prime state and settles cancellation only after abort and quiescence", async () => {
    {
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

    expect(open, "saved Prime state opened").toHaveBeenCalledWith("/tmp/saved.jsonl");
    expect(createAgentSessionFromServices, "opened session manager wired with services").toHaveBeenCalledWith(expect.objectContaining({ sessionManager: "opened-session", services }));
    expect(session.abort, "cancellation forwarded to the saved session").toHaveBeenCalledTimes(1);
    }

    {
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

    await expect(harness.complete(runContext(11, "token"), controller.signal), "pre-cancelled run rejects with the caller reason").rejects.toThrow("cancelled before admission");
    expect(session.promptAndWait, "pre-cancelled run never prompts").not.toHaveBeenCalled();
    expect(session.abort, "pre-cancelled run never aborts").not.toHaveBeenCalled();
    }

    {
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

    await expect(harness.complete(runContext(11, "token"), signal), "registration race rejects with the caller reason").rejects.toThrow("cancelled during registration");
    expect(session.abort, "registration race aborts the session").toHaveBeenCalledOnce();
    expect(session.promptAndWait, "registration race never prompts").not.toHaveBeenCalled();
    expect(session.waitForRlmQuiescence, "registration race never waits for quiescence").not.toHaveBeenCalled();
    }

    {
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

    expect(settled, "cancelled completion unsettled while abort is in flight").toBe(false);
    releaseAbort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled, "cancelled completion unsettled until quiescence").toBe(false);
    releaseQuiescence();
    await completing;
    expect(settled, "cancelled completion settles after abort and quiescence").toBe(true);
    }

    {
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
    expect(session.promptAndWait, "completion prompts once").toHaveBeenCalledOnce();
    expect(session.waitForRlmQuiescence, "completion waits for recursive quiescence").toHaveBeenCalledOnce();
    expect(settled, "completion unsettled while recursive work runs").toBe(false);
    releaseQuiescence();
    await completing;
    expect(settled, "completion settles after quiescence").toBe(true);
    }

    {
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
    expect(error, "root and quiescence failures aggregate").toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map(String), "both failure causes preserved").toEqual(["Error: root failed", "Error: barrier failed"]);
    }

    {
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

    await expect(completing, "Prime Agent abort failure reported").rejects.toThrow("abort failed");
    }
  });


  it("composes prompt profiles and rotates Prime sessions around the durable presentation pin", async () => {
    {
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
    expect(prompt.indexOf("Graph presentation guidance:"), "guidance precedes personal preferences").toBeLessThan(
      prompt.indexOf("Personal graph presentation preferences:"),
    );
    expect(prompt.indexOf("Personal graph presentation preferences:"), "preferences precede interaction input").toBeLessThan(
      prompt.indexOf("Normalized interaction input:"),
    );
    const tracedPrompt = trace.events.find((event) => event.type === "prompt")?.data.text;
    expect(tracedPrompt, "traced prompt redacts preference content").not.toContain("Decision-useful center");
    expect(tracedPrompt, "traced prompt redacts the preference section").not.toContain("Personal graph presentation preferences");
    const providerEchoes = trace.events.filter((event) => !JSON.stringify(event.data).includes("unrelated-tool"));
    expect(JSON.stringify(providerEchoes)).not.toContain("Foreground the conclusion and material tradeoffs.");
    expect(JSON.stringify(providerEchoes)).not.toContain("Decision-useful center");
    expect(JSON.stringify(providerEchoes), "provider echoes marked as redacted presentation").toContain("[redacted-personal-presentation]");
    const unrelatedTool = trace.events.find((event) => event.type === "tool.call.started");
    expect(JSON.stringify(unrelatedTool?.data), "unrelated tool output keeps ordinary content").toContain("Decision-useful center");
    expect(session.reload, "presentation instructions propagated through one reload").toHaveBeenCalledOnce();
    const nativeInstructions = resourceLoaderOptions?.appendSystemPromptOverride(["base prompt"]);
    expect(nativeInstructions, "native instructions appended once").toHaveLength(2);
    expect(nativeInstructions?.[1]).toContain("If you are the root agent");
    expect(nativeInstructions?.[1]).toContain("only when assigning a native child to author graph content");
    expect(nativeInstructions?.[1]).toContain("Never include that block in an unrelated delegate's task");
    expect(nativeInstructions?.[1]).toContain("only when that exact rendered block is present in your assigned task");
    expect(nativeInstructions?.[1]).toContain("every native child that can author graph content");
    expect(nativeInstructions?.[1]).not.toContain("Personal graph presentation preferences:");
    expect(nativeInstructions?.[1]).not.toContain("Decision-useful center");
    }

    {
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

    expect(disabledPrompt, "disabled profile omits graph search").not.toContain("Graph search is available");
    expect(disabledPrompt).not.toContain("GraphSearchRequest");
    expect(enabledPrompt, "query-v1 profile announces graph search").toContain("Graph search is available");
    expect(enabledPrompt).toContain("await graph.search(GraphSearchRequest(...))");
    expect(enabledPrompt).toContain("query_contract_version=1");
    expect(enabledPrompt).toContain('target={"scope": "project", "id": known_project_id}');
    expect(enabledPrompt).toContain("Never invent, guess, or discover a target ID");
    expect(enabledPrompt).toContain('result["type"] == "layer"');
    expect(enabledPrompt).toContain('relation="reference"');
    }

    {
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
    expect(prompt.indexOf('"title": "First target"'), "context target order preserved").toBeLessThan(prompt.indexOf('"title": "Second target"'));
    expect(prompt.indexOf('"first annotation"'), "annotation order preserved").toBeLessThan(prompt.indexOf('"second annotation"'));
    expect(prompt).toContain("product assigns no semantic precedence");
    expect(prompt).toContain("including in native child agents");
    expect(prompt).toContain("await graph.get_interaction_input()");
    expect(prompt, "normalized input hides graph internals").not.toContain("sourceNodeId");
    expect(prompt).not.toContain("sourceLayerId");
    }

    {
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

    await expect(harness.complete(attached), "transient reload failure rejects the run").rejects.toThrow("reload failed");
    expect(resourceLoaderOptions?.appendSystemPromptOverride(["base"]), "failed reload leaves no native instructions").toEqual(["base"]);
    await expect(harness.complete(attached), "retry after transient reload failure succeeds").resolves.toBeUndefined();
    expect(reload, "reload retried exactly once").toHaveBeenCalledTimes(2);
    expect(resourceLoaderOptions?.appendSystemPromptOverride(["base"])[1]).toContain("If you are the root agent");
    expect(resourceLoaderOptions?.appendSystemPromptOverride(["base"])[1]).toContain("Never include that block in an unrelated delegate's task");
    expect(resourceLoaderOptions?.appendSystemPromptOverride(["base"])[1]).not.toContain("Personal graph presentation preferences:");
    expect(resourceLoaderOptions?.appendSystemPromptOverride(["base"])[1]).not.toContain("Decision-useful center");
    }

    {
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

    expect(firstSession.promptAndWait, "pinned session reused for repeat pin").toHaveBeenCalledTimes(2);
    expect(firstDispose, "pin change rotates the old session away").toHaveBeenCalledOnce();
    expect(secondSession.promptAndWait, "rotated session serves the neutral run").toHaveBeenCalledOnce();
    expect(createAgentSessionFromServices, "exactly one rotation").toHaveBeenCalledTimes(2);
    expect(harness.state(), "state follows the rotated session").toEqual({
      primeAgentSessionFile: "/tmp/prime-neutral.jsonl",
      primeAgentSessionPersonalPresentationVersionId: null,
    });
    }

    {
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

    expect(open, "matching pin restores the saved session").toHaveBeenCalledWith("/tmp/saved-v1.jsonl");
    expect(createAgentSessionFromServices).toHaveBeenCalledOnce();
    expect(session.reload, "restored pin reloads propagation instructions once").toHaveBeenCalledOnce();
    expect(session.promptAndWait, "restored session serves both runs").toHaveBeenCalledTimes(2);
    const nativeInstructions = resourceLoaderOptions?.appendSystemPromptOverride(["base"]);
    expect(nativeInstructions?.[1]).toContain("If you are the root agent");
    expect(nativeInstructions?.[1]).not.toContain("Decision-useful center");
    expect(harness.state(), "state keeps the restored pin").toEqual({
      primeAgentSessionFile: "/tmp/saved-v1.jsonl",
      primeAgentSessionPersonalPresentationVersionId: 90,
    });
    }

    {
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

    await expect(completing, "force shutdown wins the instruction reload").rejects.toThrow("Prime Agent harness is shutting down");
    expect(session.promptAndWait, "restored session never prompted after shutdown wins").not.toHaveBeenCalled();
    expect(nativeDispose, "restored session disposed by force shutdown").toHaveBeenCalledOnce();
    }

    {
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

    await expect(rotating, "force shutdown wins the rotation").rejects.toThrow("Prime Agent harness is shutting down");
    expect(replacementSession.promptAndWait, "replacement session never prompted").not.toHaveBeenCalled();
    expect(replacementDispose, "replacement session disposed after shutdown wins").toHaveBeenCalledOnce();
    }

    {
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

    expect(open, "unknown presentation pin never resumes legacy state").not.toHaveBeenCalled();
    expect(create, "unknown presentation pin starts a fresh session").toHaveBeenCalledWith("/tmp/project");
    expect(session.promptAndWait, "fresh session serves the run").toHaveBeenCalledOnce();
    }
  });


  it("validates bounded configuration before loading Prime and enforces exact tool authority after attestation", async () => {
    const loadTimeRejections: readonly { label: string; expected: string; attempt: (loadModule: LoadModuleFn) => Promise<unknown> }[] = [
      {
        label: "unsupported implementation settings",
        expected: "Unknown prime.agent configuration field: model",
        attempt: (loadModule) => PrimeAgentHarness.create({
          threadId: 7,
          workingDirectory: "/tmp/project",
          ...fullPermission,
          configuration: { ...configuration, settings: { model: "invalid" } },
        }, { loadModule }),
      },
      {
        label: "malformed bounded permission bindings",
        expected: "requires workspace-write@1",
        attempt: (loadModule) => PrimeAgentHarness.create({
          threadId: 7,
          workingDirectory: "/tmp/project",
          permissionProfileId: "auto",
          permissionBinding: {},
          configuration,
        }, { loadModule }),
      },
    ];
    expect(loadTimeRejections, "load-time rejection inventory").toHaveLength(2);
    for (const { label, expected, attempt } of loadTimeRejections) {
      const loadModule = vi.fn();
      await expect(attempt(loadModule), `${label} rejects before loading Prime`).rejects.toThrow(expected);
      expect(loadModule, `${label} never loads Prime`).not.toHaveBeenCalled();
    }

    {
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
      expect(createAgentSessionFromServices, "bounded sessions disable base kernel prewarming").toHaveBeenCalledWith(expect.objectContaining({ prewarmIpythonKernel: false }));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
    }

    {
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
      }) as never }), "valid bounded profile rejects when Prime lacks exact v1 APIs").rejects.toThrow("does not support version-1 bounded tool and kernel authority");
      expect(createAgentSessionServices, "missing v1 APIs fail before session setup").not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
    }

    {
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

      expect(observedAuthorizations, "Ask authorization decisions").toEqual([
        { decision: "allow" },
        { decision: "deny", reason: "Prime IPython code exceeds the approval display limit" },
      ]);
      expect(approvals, "one approval request for the validated cell").toHaveBeenCalledOnce();
      expect(approvals, "approval request attests the exact boundary").toHaveBeenCalledWith(expect.objectContaining({
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
      expect(receiptTrace, "receipt trace records boundary version").toContain('"boundaryVersion":1');
      expect(receiptTrace).toContain('"reviewerMode":"ask"');
      expect(receiptTrace).toContain('"cleanupOutcome":"completed"');
      expect(receiptTrace, "receipt trace hides the workspace path").not.toContain(canonicalWorkspace);
      expect(receiptTrace, "receipt trace hides cell content").not.toContain("print('ok')");
      expect(receiptTrace, "receipt trace hides provider secrets").not.toContain("bounded-secret");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
    }

    {
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
      expect(decisions, "Auto allows only the validated IPython shape").toEqual([
        { decision: "allow" },
        { decision: "deny", reason: "Relayer does not recognize this Prime tool request" },
        { decision: "deny", reason: "Relayer does not recognize this Prime tool request" },
      ]);

      const fullSession = { promptAndWait: vi.fn(async (_text: string, options: any) => {
        expect(options, "Full access omits bounded tool authority").not.toHaveProperty("toolAuthorityScope");
        expect(options, "Full access omits bounded kernel boundaries").not.toHaveProperty("kernelBoundaryScope");
      }), waitForRlmQuiescence: vi.fn(async () => undefined), abort: vi.fn(async () => undefined), dispose: vi.fn() };
      const full = await createHarness(fullSession);
      await full.complete(runContext(73, "full-secret"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
    }

    {
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
          expect(decision, "Ask denial returned to Prime").toEqual({ decision: "deny", reason: "not now" });
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
      expect(executed, "denied cell never executes").toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
    }
  });


  it("subscribes for one run and scrubs provider access and provenance from traces", async () => {
    {
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

    expect(session.subscribe, "subscribes for the duration of a run").toHaveBeenCalledOnce();
    expect(unsubscribe, "unsubscribes when the run ends").toHaveBeenCalledOnce();
    expect(JSON.stringify(trace.events), "thinking content stays out of traces").not.toContain("hidden");
    expect(trace.events.map((event) => event.type), "honest event coverage").toEqual(expect.arrayContaining(["provider.event", "message", "usage", "model.call.started", "model.call.completed"]));
    expect(harness.traceSupport(), "recursive coverage reported honestly").toMatchObject({ childStreams: "summary", reasoningSummaries: "none" });
    }

    {
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
      expect(events, "exported usage marked as redacted provider access").toContain("[redacted-provider-access]");
      expect(events, "exported usage hides nested secrets").not.toContain("test-secret");
      expect(events, "exported usage hides provider endpoints").not.toContain("https://api.openai.test/v1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    }

    {
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
      expect(serialized, "validated provenance recorded").toContain("runtime.provenance");
      expect(serialized, "source commit recorded").toContain("f6130839ad3043f1cd3d5294fe03023035bfcd5c");
      expect(serialized, "validated package recorded").toContain("@earendil-works/pi-coding-agent");
      expect(serialized, "provenance secret omitted").not.toContain("must-not-trace");
    } finally {
      if (previous === undefined) delete process.env.RELAYER_PRIME_RUNTIME_PROVENANCE;
      else process.env.RELAYER_PRIME_RUNTIME_PROVENANCE = previous;
    }
    }

    {
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
      expect(JSON.stringify(trace.events), "duplicated package set omits provenance entirely").not.toContain("runtime.provenance");
    } finally {
      if (previous === undefined) delete process.env.RELAYER_PRIME_RUNTIME_PROVENANCE;
      else process.env.RELAYER_PRIME_RUNTIME_PROVENANCE = previous;
    }
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
