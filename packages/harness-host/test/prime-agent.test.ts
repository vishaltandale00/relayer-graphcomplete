import { detailAuthoringReference } from "@relayer/graph-client";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAX_HARNESS_APPROVAL_TEXT_LENGTH, parseHarnessApprovalRequestInput } from "../src/approval.js";
import { PrimeAgentHarness, PYTHON_GRAPH_API_REFERENCE } from "../src/implementations/prime-agent.js";
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

  it.each(["basic", "layered-navigation-v1"])("delivers the Python communication baseline in actual %s Prime turns", async (profile) => {
    const session = primeSession("/tmp/communication-session.jsonl");
    const harness = await createHarness(session, { ...configuration, settings: {
      ...configuration.settings, ...(profile === "basic" ? {} : { promptProfile: profile }),
    } });
    try {
      for (const brokerAvailable of [false, true]) {
        await harness.complete({ ...runContext(brokerAvailable ? 12 : 11, "token"), ...(brokerAvailable ? { completionBroker: {
          url: "http://127.0.0.1:43125/api/completions", token: "fixture-broker-token-1234567890123456",
        } } : {}) });
        const prompt = session.promptAndWait.mock.calls.at(-1)![0];
        expect(prompt).toContain("Your current layer is how you explain the work to the user while doing it.");
        expect(prompt).toContain("read each changed current.current_layer_id with graph.get_layer");
        expect(prompt).toContain("skip Exception values before reading current.current_layer_id");
        expect(prompt).toContain("an ordinary Input on your current root layer exposes an explicit Answer control");
        expect(prompt).toContain("graph.get_live_answers(cursor)");
        expect(prompt).toContain("graph.wait_for_live_answers(cursor)");
        expect(prompt).toContain("The sealed initial contract remains unchanged");
        expect(prompt).toContain("Semantic children and Invoke-bound inputs use the next ordinary interaction");
        expect(prompt).toContain('graph.authoring("first-finding-');
        expect(prompt).toContain('target=GraphLayer.from_dict(prior["layer"])');
        expect(prompt).toContain('operation_key="first-finding-publication"');
        expect(prompt).toContain('kind="input", label="Answer", control="text"');
        expect(prompt).not.toContain("Advancing is optional");
        expect(prompt).not.toContain("graph.advanceCurrent");
        expect(prompt).not.toContain("watchCompletions");
        expect(prompt).not.toContain("fixture-broker-token");
        expect(prompt.includes("For explicit semantic child work")).toBe(brokerAvailable);
      }
    } finally { await harness.dispose(); }
  });

  it.each(["basic", "layered-navigation-v1"])("selects an eligible thread icon in the ordinary %s Prime turn", async (profile) => {
    const session = primeSession("/tmp/thread-icon-session.jsonl");
    const harness = await createHarness(session, { ...configuration, settings: {
      ...configuration.settings, ...(profile === "basic" ? {} : { promptProfile: profile }),
    } });
    try {
      await harness.complete({ ...runContext(11, "token"), threadIconSelection: { eligible: true } });
      await harness.complete(runContext(12, "token"));
      const prompts = session.promptAndWait.mock.calls.map((call) => call[0]);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain('await graph.propose_thread_icon("semantic-icon-name")');
      expect(prompts[0]).toContain("same supported Relayer icon library and guidance used for nodes");
      expect(prompts[0]).toContain("only when this completion is accepted");
      expect(prompts[0]).toContain("Missing or invalid selection keeps the default visible");
      expect(prompts[1]).not.toContain("propose_thread_icon");
    } finally { await harness.dispose(); }
  });

  it.each(["missing", "changed-presentation"])("refuses legacy continuation without executing or replacing Prime history when %s", async (reason) => {
    const session = primeSession("/tmp/legacy-prime-session.jsonl");
    const create = vi.fn(() => "fresh-session");
    const open = vi.fn(() => "saved-session");
    const createSession = vi.fn(async () => ({ session }));
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
      ...(reason === "changed-presentation" ? { savedState: {
        primeAgentSessionFile: session.sessionFile,
        primeAgentSessionPersonalPresentationVersionId: 17,
      } } : {}),
    }, { loadModule: async () => ({
      ...runScopeApi(), SessionManager: { create, open },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => ({ modelRegistry: { find: vi.fn() } })),
      createAgentSessionFromServices: createSession,
    }) as never });
    const saved = harness.state();
    create.mockClear(); open.mockClear(); createSession.mockClear();
    try {
      await expect(harness.complete({ ...runContext(31, "fixture"), requireNativeContinuity: true }))
        .rejects.toThrow("native history is unavailable or incompatible");
      expect(session.promptAndWait).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(harness.state()).toEqual(saved);
    } finally {
      await harness.dispose();
    }
  });

  it("uses only explicit managed Prime profile and session paths in the production factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-prime-managed-factory-"));
    const runtime = managedRuntimePaths(root);
    const session = primeSession(join(runtime.privateStateRoot, "sessions", "root.jsonl"));
    const createAgentSessionServices = vi.fn(async () => nativeServices());
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

      await expect(PrimeAgentHarness.create({
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
          createAgentSessionServices: vi.fn(async () => nativeServices()),
          createAgentSessionFromServices: vi.fn(async () => ({ session: primeSession(join(sessions, "fresh.jsonl")) })),
        }) as never,
        resolvePrimeRuntime: async () => runtime,
      })).rejects.toThrow("saved state was preserved");

      expect(open).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();

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
          createAgentSessionServices: vi.fn(async () => nativeServices()),
          createAgentSessionFromServices: vi.fn(async () => ({ session: primeSession(join(sessions, "fresh.jsonl")) })),
        }) as never,
        resolvePrimeRuntime: async () => runtime,
      })).rejects.toThrow(/session state is not an owned directory/i);
      expect(open).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
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
          createAgentSessionServices: vi.fn(async () => nativeServices()),
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
    const createAgentSessionServices = vi.fn(async () => nativeServices());
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
    const createAgentSessionServices = vi.fn(async () => nativeServices());
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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

  it("forgets the root session a force shutdown kills during a root turn, and keeps an idle one", async () => {
    // PRD: a root turn force-stopped while its native conversation ran is not resumed.
    const idle = await createHarness(primeSession("/tmp/idle.jsonl"));
    await idle.complete(runContext(11, "token"));
    idle.forceShutdown();
    expect(idle.state()).toEqual({ primeAgentSessionFile: "/tmp/idle.jsonl", primeAgentSessionPersonalPresentationVersionId: null });

    const session = primeSession("/tmp/killed.jsonl", {
      promptAndWait: vi.fn().mockResolvedValueOnce(undefined).mockReturnValueOnce(new Promise<void>(() => {})),
    });
    const harness = await createHarness(session);
    await harness.complete(runContext(11, "token"));
    expect(harness.state()).toEqual({ primeAgentSessionFile: "/tmp/killed.jsonl", primeAgentSessionPersonalPresentationVersionId: null });
    void harness.complete(runContext(12, "token")).catch(() => undefined);
    await vi.waitFor(() => expect(session.promptAndWait).toHaveBeenCalledTimes(2));

    harness.forceShutdown();

    expect(session.abort).toHaveBeenCalledOnce();
    expect(harness.state()).toEqual({ primeRootResetReason: "force_stopped" });
  });

  it("keeps the next root turn's session at force shutdown after an earlier root turn was force-stopped", async () => {
    const stuck = primeSession("/tmp/stuck.jsonl", { promptAndWait: vi.fn(() => new Promise<void>(() => {})) });
    const next = primeSession("/tmp/next.jsonl");
    const sessions = [stuck, next];
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => nativeServices()),
      createAgentSessionFromServices: vi.fn(async () => ({ session: sessions.shift() })),
    }) as never });
    const force = new AbortController();
    // The stuck root turn's native prompt never settles, even after its force-stop.
    const stuckTurn = harness.complete({ ...runContext(11, "stuck"), forceSignal: force.signal });
    await vi.waitFor(() => expect(stuck.promptAndWait).toHaveBeenCalledOnce());
    force.abort(new Error("force-stopped after two minutes"));
    await expect(stuckTurn).rejects.toThrow("force-stopped after two minutes");
    await harness.complete({ ...runContext(12, "next"), forceSignal: new AbortController().signal });

    harness.forceShutdown();

    expect(harness.state()).toEqual({ primeAgentSessionFile: "/tmp/next.jsonl", primeAgentSessionPersonalPresentationVersionId: null });
  });

  it("keeps the root session when force shutdown ends a root turn still acquiring it", async () => {
    // The reload for a new pin never settles: no conversation ran on the restored session.
    const session = primeSession("/tmp/restored.jsonl", { reload: vi.fn(() => new Promise<void>(() => {})) });
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
      savedState: { primeAgentSessionFile: "/tmp/restored.jsonl", primeAgentSessionPersonalPresentationVersionId: 90 },
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create: vi.fn(), open: vi.fn(() => "restored-manager") },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => nativeServices()),
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never });
    void harness.complete(presentationRunContext(11, "root", 90)).catch(() => undefined);
    await vi.waitFor(() => expect(session.reload).toHaveBeenCalledOnce());

    harness.forceShutdown();

    expect(session.promptAndWait).not.toHaveBeenCalled();
    expect(harness.state()).toEqual({ primeAgentSessionFile: "/tmp/restored.jsonl", primeAgentSessionPersonalPresentationVersionId: 90 });
  });

  it("records a visible notice whenever a root turn cannot continue the previous native session", async () => {
    const pinned = primeSession("/tmp/pinned.jsonl", { reload: vi.fn(async () => undefined) });
    const neutral = primeSession("/tmp/neutral.jsonl", { promptAndWait: vi.fn(() => new Promise<void>(() => {})) });
    const fresh = primeSession("/tmp/fresh.jsonl");
    const sessions = [pinned, neutral, fresh];
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
      savedState: { primeAgentSessionFile: "/tmp/pinned.jsonl", primeAgentSessionPersonalPresentationVersionId: 90 },
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn(() => "saved-session") },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => nativeServices()),
      createAgentSessionFromServices: vi.fn(async () => ({ session: sessions.shift() })),
    }) as never });
    const resets = (trace: { events: HarnessTraceEventInput[] }) => trace.events
      .filter((event) => event.type === "warning" && typeof event.data.nativeSessionReset === "string")
      .map((event) => event.data.nativeSessionReset);

    // The restored conversation continues under its own pin.
    const resumed = recordingTrace();
    await harness.complete({ ...presentationRunContext(11, "resumed", 90), trace: resumed.sink });
    expect(resets(resumed)).toEqual([]);

    // A new pin rotates away from a session that held a conversation.
    const rotated = recordingTrace();
    const force = new AbortController();
    const stuck = harness.complete({ ...runContext(12, "rotated", rotated.sink), forceSignal: force.signal });
    await vi.waitFor(() => expect(neutral.promptAndWait).toHaveBeenCalledOnce());
    expect(resets(rotated)).toEqual(["presentation_changed"]);

    // A force-stopped conversation is not resumed, and the reason survives a restart.
    force.abort(new Error("force-stopped after two minutes"));
    await expect(stuck).rejects.toThrow("force-stopped after two minutes");
    expect(harness.state()).toEqual({ primeRootResetReason: "force_stopped" });
    const next = recordingTrace();
    await harness.complete({ ...runContext(13, "next", next.sink), forceSignal: new AbortController().signal });
    expect(resets(next)).toEqual(["force_stopped"]);
    expect(harness.state()).toEqual({ primeAgentSessionFile: "/tmp/fresh.jsonl", primeAgentSessionPersonalPresentationVersionId: null });
  });

  it("fails closed when the installed package cannot scope presentation instructions to a session", async () => {
    const session = primeSession("/tmp/unscoped.jsonl", { reload: vi.fn(async () => undefined) });
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      // No resource loader: a neutral session still works, pinned instructions cannot be delivered.
      createAgentSessionServices: vi.fn(async () => ({})),
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never });

    await expect(harness.complete(presentationRunContext(11, "root", 90)))
      .rejects.toThrow("cannot refresh interaction-scoped presentation instructions");
    await expect(harness.complete(invokedRunContext(presentationRunContext(12, "child", 90), 7)))
      .rejects.toThrow("cannot scope presentation instructions to a session");
    expect(session.reload).not.toHaveBeenCalled();
    expect(session.promptAndWait).not.toHaveBeenCalled();
  });

  it("guards native disposal before an asynchronous abort continuation can dispose again", async () => {
    let releaseAbort!: () => void;
    let markAbortFinished!: () => void;
    const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const abortFinished = new Promise<void>((resolve) => { markAbortFinished = resolve; });
    const nativeSyncDispose = vi.fn();
    const session = {
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
    // The graph is the user's interface, so mechanics never appear in its content.
    expect(prompts[0]!.text).toContain("Never expose execution mechanics in graph content");
    expect(prompts[0]!.text).toContain("when the user would gain a materially more useful view");
    expect(prompts[0]!.text).toContain("await graph.get_current()");
    expect(prompts[0]!.text).toContain("await graph.advance_current(");
    expect(prompts[0]!.text).toContain("Advancing current does not complete the interaction");
    // Only the run the product granted a broker is taught explicit semantic child work.
    expect(prompts[0]!.text).toContain("For explicit semantic child work");
    expect(prompts[0]!.text).toContain('input_graph = await graph.prepare_complete(invoke_action, "stable-call-key")');
    expect(prompts[0]!.text).toContain("reusable defaults to False");
    expect(prompts[0]!.text).toContain("Set reusable=True only for an explicit repeat-use case");
    expect(prompts[0]!.text).toContain("Before launching or waiting for this child");
    expect(prompts[0]!.text).toContain("Advance your enclosing source Layer");
    expect(prompts[0]!.text).toContain("from relayer_graph import complete");
    expect(prompts[0]!.text).toContain("do not create semantic children by themselves");
    // Returning the parent's full response leaves independent child execution intact.
    expect(prompts[0]!.text).toContain("Returning the parent does not stop the children");
    // Each child event is one the root may act on; it moves its own current only when that helps the user.
    expect(prompts[0]!.text).toContain("from relayer_graph import complete, CompletionWatch");
    expect(prompts[0]!.text).toContain("changes = await watch.changes()");
    // The watch takes the list the recipe fills, so the recipe must declare it.
    expect(prompts[0]!.text).toContain("Start with children = [] and launch each child from its own input graph with children.append(complete(input_graph))");
    // Reusable actions distinguish calls through durable Invocation keys.
    expect(prompts[0]!.text).toContain("another key creates an independent Invocation");
    expect(prompts[0]!.text).toContain("One input graph starts exactly one child");
    expect(prompts[0]!.text).toContain("Only then submit a later improved layer that presents the work itself and advance your current to it; otherwise keep waiting.");
    expect(prompts[0]!.text).toContain("Returning the parent does not stop the children");
    // A stopped or failed child raises from child.result, so the root must catch it to integrate the rest.
    expect(prompts[0]!.text).toContain("A stopped or failed child raises CompletionTerminalError there instead");
    expect(prompts[0]!.text).toContain("catch it and integrate the work its error.current still retains");
    // A child the watch can no longer observe arrives as an error change, not a raise, so the loop keeps its siblings.
    expect(prompts[0]!.text).toContain("Each change is a (child, current) pair, or (child, error) with the exception in place of the current once the watch can no longer observe that child");
    // Both shapes are tuples, so the root needs the test that tells them apart.
    expect(prompts[0]!.text).toContain("check isinstance(current, Exception) before reading it");
    // Such a child's result may raise a plain exception; the root must neither invent its findings nor leak the error.
    expect(prompts[0]!.text).toContain("If child.result raises any other exception, as it may for a child reported with an error, you cannot read that child's work; present that part as not done, without quoting the error or inventing findings.");
    expect(prompts[1]!.text).not.toContain("prepare_complete");
    expect(prompts[1]!.text).not.toContain("from relayer_graph import complete");
    expect(prompts[0]!.text).toContain("exactly one NodePlacementObject(node, x, y) per member node");
    expect(prompts[0]!.text).toContain("Place a one-node layer at (0.5, 0.5)");
    expectGraphPresentationGuidance(prompts[0]!.text);
    expectGraphAuthoringRules(prompts[0]!.text);
    // The submit call directly follows the sentence that introduces it.
    expect(prompts[0]!.text).toContain("Finish the root execution only by calling:\n\nawait graph.submit(11)");
    expect(prompts[0]!.text).toContain("exactly one new root navigate action");
    expect(prompts[0]!.text).toContain("add_navigate_action(node, \"View evidence\"");
    expect(prompts[0]!.text).toContain("Keep snapshot and local keys stable");
    expect(prompts[0]!.text).toContain("rerun the same authoring code with the same client_key values");
    expect(prompts[0]!.text).toContain("Do not add fake navigation");
    expect(prompts[0]!.text).toContain("await graph.discard_layer(layer)");
    await expect(hostHandlers[0]?.({}, invocation(first))).resolves.toEqual({
      url: "http://127.0.0.1:43123",
      token: "first-token",
      nodeId: 11,
    });
    await expect(hostHandlers[2]?.({}, invocation(first))).resolves.toEqual(first.completionBroker);
    const visual = {
      version: 1, objectId: "python-object", operation: "checkpoint", token: "first-token", nodeId: 11,
      node: { clientKey: "answer", icon: "box", title: "Answer", detail: "Fallback", kind: "concept" },
      detail: { clear: false, components: [{ id: "main", markup: { strings: ["<p>Answer</p>"], values: [] }, styles: "" }] },
    };
    await expect(hostHandlers[1]?.(visual, invocation(first))).resolves.toMatchObject({ ok: true, value: { version: 1 } });
    await expect(hostHandlers[1]?.(visual, invocation(second))).rejects.toThrow("another run");
    await expect(hostHandlers[1]?.(visual, { ...invocation(first), isCurrent: () => false })).rejects.toThrow("no longer active");
    await expect(hostHandlers[1]?.(visual, { ...invocation(first), signal: AbortSignal.abort() })).rejects.toThrow("no longer active");
    expect(createAgentSessionFromServices).toHaveBeenCalledWith(expect.objectContaining({ hostRequestHandlers: {
      "relayer.graph.current": hostHandlers[0],
      "relayer.graph.visual-authoring": hostHandlers[1],
      "relayer.complete.current": hostHandlers[2],
      "relayer.graph.submit-layer": hostHandlers[3],
    } }));
    const layer = { version: 1, token: "first-token", nodeId: 11, layer: { clientKey: "root", nodes: [2], edges: [], layout: { version: 1, placements: [{ nodeId: 2, x: 0.5, y: 0.5 }], edgeShape: "default" } } };
    // Prime adds its native envelope fields to every IPython host request.
    const layerFetch = vi.fn(async (_url: unknown, init: RequestInit) => Response.json({ layer: { id: 30, state: "draft", ...JSON.parse(init.body as string) } }));
    vi.stubGlobal("fetch", layerFetch);
    try {
      await expect(hostHandlers[3]?.({ ...layer, type: "relayer.graph.submit-layer", cellSourceCode: "await graph.submit_layer(layer)" }, invocation(first)))
        .resolves.toMatchObject({ ok: true, value: { id: 30, clientKey: "root" } });
      expect(layerFetch).toHaveBeenCalledWith("http://127.0.0.1:43123/api/graph/layers", expect.objectContaining({ method: "POST" }));
    } finally { vi.unstubAllGlobals(); }
    await expect(hostHandlers[3]?.(layer, invocation(second))).rejects.toThrow("another run");
    await expect(hostHandlers[3]?.(layer, { ...invocation(first), isCurrent: () => false })).rejects.toThrow("no longer active");
    await expect(hostHandlers[3]?.(layer, { ...invocation(first), signal: AbortSignal.abort() })).rejects.toThrow("no longer active");

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
    const createAgentSessionServices = vi.fn(async () => nativeServices());
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      createAgentSessionServices: vi.fn(async () => nativeServices()),
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      createAgentSessionServices: vi.fn(async () => nativeServices()),
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

  it("force-stops only a stuck invoked child's own session, never the root turn or a sibling child", async () => {
    let releaseRoot!: () => void;
    const rootGate = new Promise<void>((resolve) => { releaseRoot = resolve; });
    let releaseSibling!: () => void;
    const siblingGate = new Promise<void>((resolve) => { releaseSibling = resolve; });
    const root = primeSession("/tmp/root.jsonl", { promptAndWait: vi.fn(async () => rootGate) });
    // A wedged child: neither its prompt nor its abort ever settles.
    const stuckChild = primeSession("/tmp/stuck-child.jsonl", {
      promptAndWait: vi.fn(() => new Promise<void>(() => undefined)),
      abort: vi.fn(() => new Promise<void>(() => undefined)),
    });
    const sibling = primeSession("/tmp/sibling.jsonl", { promptAndWait: vi.fn(async () => siblingGate) });
    const rootNativeDispose = root.dispose;
    const stuckChildNativeDispose = stuckChild.dispose;
    const siblingNativeDispose = sibling.dispose;
    const sessions = [root, stuckChild, sibling];
    const harness = await PrimeAgentHarness.create({
      threadId: 7,
      workingDirectory: "/tmp/project",
      ...fullPermission,
      configuration,
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create: vi.fn(() => "fresh"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => nativeServices()),
      createAgentSessionFromServices: vi.fn(async () => {
        const session = sessions.shift();
        if (session === undefined) throw new Error("unexpected Prime session creation");
        return { session };
      }),
    }) as never });
    const cancel = new AbortController();
    const stuckForce = new AbortController();

    const rootTurn = harness.complete({ ...runContext(50, "root"), forceSignal: new AbortController().signal });
    await vi.waitFor(() => expect(root.promptAndWait).toHaveBeenCalledOnce());
    const stuck = harness.complete(
      { ...invokedRunContext(runContext(51, "stuck"), 151), forceSignal: stuckForce.signal },
      cancel.signal,
    );
    await vi.waitFor(() => expect(stuckChild.promptAndWait).toHaveBeenCalledOnce());
    const siblingTurn = harness.complete({
      ...invokedRunContext(runContext(52, "sibling"), 152),
      forceSignal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(sibling.promptAndWait).toHaveBeenCalledOnce());

    cancel.abort(new Error("cancelled"));
    stuckForce.abort(new Error("force-stopped after two minutes"));

    await expect(stuck).rejects.toThrow("force-stopped after two minutes");
    expect(stuckChild.abort).toHaveBeenCalled();
    expect(stuckChildNativeDispose).toHaveBeenCalledOnce();
    expect(root.abort).not.toHaveBeenCalled();
    expect(rootNativeDispose).not.toHaveBeenCalled();
    expect(sibling.abort).not.toHaveBeenCalled();
    expect(siblingNativeDispose).not.toHaveBeenCalled();

    releaseSibling();
    await siblingTurn;
    releaseRoot();
    await rootTurn;
    expect(harness.state()).toEqual({
      primeAgentSessionFile: "/tmp/root.jsonl",
      primeAgentSessionPersonalPresentationVersionId: null,
    });
    expect(harness.supportsForceStop).toBe(true);
  });

  it("replaces the root session after force-stopping a stuck root turn, leaving a running child alone", async () => {
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
    // A wedged root turn on the restored session: neither its prompt nor its abort settles.
    const stuckRoot = primeSession("/tmp/saved.jsonl", {
      promptAndWait: vi.fn(() => new Promise<void>(() => undefined)),
      abort: vi.fn(() => new Promise<void>(() => undefined)),
    });
    const child = primeSession("/tmp/child.jsonl", { promptAndWait: vi.fn(async () => childGate) });
    const replacement = primeSession("/tmp/replacement.jsonl");
    const stuckRootNativeDispose = stuckRoot.dispose;
    const childNativeDispose = child.dispose;
    const sessions = [stuckRoot, child, replacement];
    const create = vi.fn(() => "fresh-manager");
    const open = vi.fn(() => "saved-manager");
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
        primeAgentSessionFile: "/tmp/saved.jsonl",
        primeAgentSessionPersonalPresentationVersionId: null,
      },
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create, open },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => nativeServices()),
      createAgentSessionFromServices,
    }) as never });
    const cancel = new AbortController();
    const rootForce = new AbortController();

    const stuckTurn = harness.complete({ ...runContext(61, "root"), forceSignal: rootForce.signal }, cancel.signal);
    await vi.waitFor(() => expect(stuckRoot.promptAndWait).toHaveBeenCalledOnce());
    const childTurn = harness.complete({
      ...invokedRunContext(runContext(62, "child"), 162),
      forceSignal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(child.promptAndWait).toHaveBeenCalledOnce());

    cancel.abort(new Error("cancelled"));
    rootForce.abort(new Error("force-stopped after two minutes"));

    await expect(stuckTurn).rejects.toThrow("force-stopped after two minutes");
    expect(stuckRoot.abort).toHaveBeenCalled();
    expect(stuckRootNativeDispose).toHaveBeenCalledOnce();
    expect(child.abort).not.toHaveBeenCalled();
    expect(childNativeDispose).not.toHaveBeenCalled();
    // The stopped session may still write its file, so it is neither saved nor resumed.
    expect(harness.state()).toEqual({ primeRootResetReason: "force_stopped" });

    await harness.complete({ ...runContext(63, "root"), forceSignal: new AbortController().signal });
    expect(open).toHaveBeenCalledOnce();
    expect(createAgentSessionFromServices).toHaveBeenLastCalledWith(expect.objectContaining({ sessionManager: "fresh-manager" }));
    expect(replacement.promptAndWait).toHaveBeenCalledOnce();
    expect(harness.state()).toEqual({
      primeAgentSessionFile: "/tmp/replacement.jsonl",
      primeAgentSessionPersonalPresentationVersionId: null,
    });

    releaseChild();
    await childTurn;
  });

  it("force-disposes an invoked child session created after its turn was force-stopped", async () => {
    let releaseCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve; });
    const root = primeSession("/tmp/root.jsonl");
    // Graceful disposal of the late child would stall forever.
    const lateChild = primeSession("/tmp/late-child.jsonl", { disposeAsync: vi.fn(() => new Promise<void>(() => undefined)) });
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
      createAgentSessionServices: vi.fn(async () => nativeServices()),
      createAgentSessionFromServices: vi.fn(async () => {
        creations += 1;
        if (creations === 1) return { session: root };
        await creationGate;
        return { session: lateChild };
      }),
    }) as never });
    const force = new AbortController();

    const child = harness.complete({ ...invokedRunContext(runContext(81, "late"), 181), forceSignal: force.signal });
    await vi.waitFor(() => expect(creations).toBe(2));
    force.abort(new Error("force-stopped after two minutes"));
    await expect(child).rejects.toThrow("force-stopped after two minutes");

    releaseCreation();
    await vi.waitFor(() => expect(lateChildNativeDispose).toHaveBeenCalledOnce());
    expect(lateChild.abort).toHaveBeenCalledOnce();
    expect(lateChild.promptAndWait).not.toHaveBeenCalled();
    expect(lateChild.disposeAsync).not.toHaveBeenCalled();
    expect(root.abort).not.toHaveBeenCalled();
    // Nothing is retained: disposing the harness does not wait on the stalled child.
    await harness.dispose();
    expect(root.disposeAsync).toHaveBeenCalledOnce();
  });

  it("lets the next root turn start a fresh session while a force-stopped root turn's reload never settles", async () => {
    // The stuck root turn's reload of its presentation instructions never settles.
    const stuckRoot = primeSession("/tmp/stuck-root.jsonl", { reload: vi.fn(() => new Promise<void>(() => undefined)) });
    const fresh = primeSession("/tmp/fresh-root.jsonl");
    const stuckRootNativeDispose = stuckRoot.dispose;
    const sessions = [stuckRoot, fresh];
    const create = vi.fn(() => "fresh-manager");
    const createAgentSessionFromServices = vi.fn(async () => {
      const session = sessions.shift();
      if (session === undefined) throw new Error("unexpected Prime session creation");
      return { session };
    });
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create, open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => nativeServices()),
      createAgentSessionFromServices,
    }) as never });
    const rootForce = new AbortController();

    const stuck = harness.complete({ ...presentationRunContext(70, "stuck", 90), forceSignal: rootForce.signal });
    await vi.waitFor(() => expect(stuckRoot.reload).toHaveBeenCalledOnce());
    rootForce.abort(new Error("force-stopped after two minutes"));
    await expect(stuck).rejects.toThrow("force-stopped after two minutes");

    // The half-reloaded session is force-disposed, and the next root turn neither waits for
    // the reload nor reuses that session.
    await harness.complete({ ...runContext(71, "next"), forceSignal: new AbortController().signal });
    expect(stuckRootNativeDispose).toHaveBeenCalledOnce();
    expect(stuckRoot.promptAndWait).not.toHaveBeenCalled();
    expect(fresh.promptAndWait).toHaveBeenCalledOnce();
    expect(createAgentSessionFromServices).toHaveBeenLastCalledWith(expect.objectContaining({ sessionManager: "fresh-manager" }));
    expect(harness.state()).toEqual({
      primeAgentSessionFile: "/tmp/fresh-root.jsonl",
      primeAgentSessionPersonalPresentationVersionId: null,
    });
  });

  it("discards a root session a force-stopped turn created too late, after the next turn started fresh", async () => {
    let releaseStaleCreation!: () => void;
    const staleCreationGate = new Promise<void>((resolve) => { releaseStaleCreation = resolve; });
    const pinned = primeSession("/tmp/pinned.jsonl", { reload: vi.fn(async () => undefined) });
    const stale = primeSession("/tmp/stale.jsonl");
    const successor = primeSession("/tmp/successor.jsonl");
    const staleNativeDispose = stale.dispose;
    let creations = 0;
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create: vi.fn(() => "fresh-manager"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => nativeServices()),
      createAgentSessionFromServices: vi.fn(async () => {
        creations += 1;
        if (creations === 1) return { session: pinned };
        if (creations === 2) {
          await staleCreationGate;
          return { session: stale };
        }
        return { session: successor };
      }),
    }) as never });
    await harness.complete({ ...presentationRunContext(80, "pinned", 90), forceSignal: new AbortController().signal });
    const rootForce = new AbortController();

    // A different presentation pin rotates the session; its creation stalls.
    const stuck = harness.complete({ ...runContext(81, "stuck"), forceSignal: rootForce.signal });
    await vi.waitFor(() => expect(creations).toBe(2));
    rootForce.abort(new Error("force-stopped after two minutes"));
    await expect(stuck).rejects.toThrow("force-stopped after two minutes");

    await harness.complete({ ...runContext(82, "next"), forceSignal: new AbortController().signal });
    expect(successor.promptAndWait).toHaveBeenCalledOnce();

    releaseStaleCreation();
    await vi.waitFor(() => expect(staleNativeDispose).toHaveBeenCalledOnce());
    expect(stale.promptAndWait).not.toHaveBeenCalled();
    expect(harness.state()).toEqual({
      primeAgentSessionFile: "/tmp/successor.jsonl",
      primeAgentSessionPersonalPresentationVersionId: null,
    });
  });

  it("does not resume a saved conversation a force-stopped root turn was reopening", async () => {
    const restored = primeSession("/tmp/saved.jsonl");
    const fresh = primeSession("/tmp/fresh.jsonl");
    const create = vi.fn(() => "fresh-manager");
    const open = vi.fn(() => "saved-manager");
    let creations = 0;
    const createAgentSessionFromServices = vi.fn(async () => {
      creations += 1;
      if (creations === 1) return { session: restored };
      if (creations === 2) throw new Error("native session creation failed");
      // Reopening the saved conversation never finishes.
      if (creations === 3) return new Promise<never>(() => undefined);
      return { session: fresh };
    });
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
      savedState: {
        primeAgentSessionFile: "/tmp/saved.jsonl",
        primeAgentSessionPersonalPresentationVersionId: 90,
      },
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create, open },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => nativeServices()),
      createAgentSessionFromServices,
    }) as never });
    expect(open).toHaveBeenCalledOnce();

    // An unpinned turn rotates away from the restored session, but its new session fails,
    // so no root session is left installed while the saved file stays resumable.
    await expect(harness.complete({ ...runContext(100, "unpinned"), forceSignal: new AbortController().signal }))
      .rejects.toThrow("native session creation failed");
    expect(restored.disposeAsync).toHaveBeenCalledOnce();

    // A turn pinned to 90 again reopens the saved conversation, which hangs.
    const cancel = new AbortController();
    const rootForce = new AbortController();
    const stuck = harness.complete({ ...presentationRunContext(101, "stuck", 90), forceSignal: rootForce.signal }, cancel.signal);
    await vi.waitFor(() => expect(creations).toBe(3));
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith("/tmp/saved.jsonl");
    cancel.abort(new Error("cancelled"));
    rootForce.abort(new Error("force-stopped after two minutes"));
    await expect(stuck).rejects.toThrow("force-stopped after two minutes");
    expect(harness.state()).toEqual({ primeRootResetReason: "force_stopped" });

    // The next pinned root turn starts a fresh conversation instead of resuming that file.
    await harness.complete({ ...presentationRunContext(102, "next", 90), forceSignal: new AbortController().signal });
    expect(open).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(createAgentSessionFromServices).toHaveBeenLastCalledWith(expect.objectContaining({ sessionManager: "fresh-manager" }));
    expect(fresh.promptAndWait).toHaveBeenCalledOnce();
    expect(harness.state()).toEqual({
      primeAgentSessionFile: "/tmp/fresh.jsonl",
      primeAgentSessionPersonalPresentationVersionId: 90,
    });
  });

  it("keeps the successor's presentation instructions when an abandoned reload later fails", async () => {
    const loaders = sessionLoaders();
    const staleReload = deferred<void>();
    const stuckRoot = primeSession("/tmp/stuck-root.jsonl", { reload: vi.fn(() => staleReload.promise) });
    const successor = primeSession("/tmp/successor.jsonl", { reload: vi.fn(async () => undefined) });
    const sessions = [stuckRoot, successor];
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create: vi.fn(() => "fresh-manager"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => nativeServices()),
      createAgentSessionFromServices: loaders.record(vi.fn(async () => {
        const session = sessions.shift();
        if (session === undefined) throw new Error("unexpected Prime session creation");
        return { session };
      })),
    }) as never });
    const rootForce = new AbortController();

    // The stuck turn's reload is abandoned while it still holds the previous (empty) instructions.
    const stuck = harness.complete({ ...presentationRunContext(110, "stuck", 90), forceSignal: rootForce.signal });
    await vi.waitFor(() => expect(stuckRoot.reload).toHaveBeenCalledOnce());
    rootForce.abort(new Error("force-stopped after two minutes"));
    await expect(stuck).rejects.toThrow("force-stopped after two minutes");
    await harness.complete({ ...presentationRunContext(111, "successor", 90), forceSignal: new AbortController().signal });
    expect(successor.promptAndWait).toHaveBeenCalledOnce();

    staleReload.reject(new Error("stale reload failed"));
    await settleMicrotasks();

    expect(loaders.appendedFor(successor)).toEqual(["base", expect.stringContaining("If you are the root agent")]);
    await harness.complete({ ...presentationRunContext(112, "next", 90), forceSignal: new AbortController().signal });
    expect(successor.reload).not.toHaveBeenCalled();
    expect(successor.promptAndWait).toHaveBeenCalledTimes(2);
  });

  it("does not create a session when an abandoned rotation's disposal settles after the successor started", async () => {
    const loaders = sessionLoaders();
    const staleDisposal = deferred<void>();
    const pinned = primeSession("/tmp/pinned.jsonl", {
      reload: vi.fn(async () => undefined),
      disposeAsync: vi.fn(() => staleDisposal.promise),
    });
    const successor = primeSession("/tmp/successor.jsonl", { reload: vi.fn(async () => undefined) });
    const extra = primeSession("/tmp/extra.jsonl");
    const sessions = [pinned, successor, extra];
    const createAgentSessionFromServices = vi.fn(async () => {
      const session = sessions.shift();
      if (session === undefined) throw new Error("unexpected Prime session creation");
      return { session };
    });
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create: vi.fn(() => "fresh-manager"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => nativeServices()),
      createAgentSessionFromServices: loaders.record(createAgentSessionFromServices),
    }) as never });
    await harness.complete({ ...presentationRunContext(120, "pinned", 90), forceSignal: new AbortController().signal });
    const rootForce = new AbortController();

    // An unpinned turn rotates; graceful disposal of the pinned session stalls.
    const stuck = harness.complete({ ...runContext(121, "stuck"), forceSignal: rootForce.signal });
    await vi.waitFor(() => expect(pinned.disposeAsync).toHaveBeenCalledOnce());
    rootForce.abort(new Error("force-stopped after two minutes"));
    await expect(stuck).rejects.toThrow("force-stopped after two minutes");
    await harness.complete({ ...presentationRunContext(122, "successor", 90), forceSignal: new AbortController().signal });
    expect(successor.promptAndWait).toHaveBeenCalledOnce();

    staleDisposal.resolve();
    await settleMicrotasks();

    expect(createAgentSessionFromServices).toHaveBeenCalledTimes(2);
    expect(loaders.appendedFor(successor)).toEqual(["base", expect.stringContaining("If you are the root agent")]);
    expect(harness.state()).toEqual({
      primeAgentSessionFile: "/tmp/successor.jsonl",
      primeAgentSessionPersonalPresentationVersionId: 90,
    });
  });

  it("keeps the successor's presentation pin when an abandoned reload later succeeds", async () => {
    const staleReload = deferred<void>();
    const stuckRoot = primeSession("/tmp/stuck-root.jsonl", { reload: vi.fn(() => staleReload.promise) });
    const successor = primeSession("/tmp/successor.jsonl");
    const sessions = [stuckRoot, successor];
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
    }, { loadModule: async () => ({
      ...runScopeApi(),
      SessionManager: { create: vi.fn(() => "fresh-manager"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => nativeServices()),
      createAgentSessionFromServices: vi.fn(async () => {
        const session = sessions.shift();
        if (session === undefined) throw new Error("unexpected Prime session creation");
        return { session };
      }),
    }) as never });
    const rootForce = new AbortController();

    const stuck = harness.complete({ ...presentationRunContext(130, "stuck", 90), forceSignal: rootForce.signal });
    await vi.waitFor(() => expect(stuckRoot.reload).toHaveBeenCalledOnce());
    rootForce.abort(new Error("force-stopped after two minutes"));
    await expect(stuck).rejects.toThrow("force-stopped after two minutes");
    await harness.complete({ ...presentationRunContext(131, "successor", 95), forceSignal: new AbortController().signal });
    expect(harness.state()).toEqual({
      primeAgentSessionFile: "/tmp/successor.jsonl",
      primeAgentSessionPersonalPresentationVersionId: 95,
    });

    staleReload.resolve();
    await settleMicrotasks();

    expect(stuckRoot.promptAndWait).not.toHaveBeenCalled();
    expect(harness.state()).toEqual({
      primeAgentSessionFile: "/tmp/successor.jsonl",
      primeAgentSessionPersonalPresentationVersionId: 95,
    });
  });

  it("maps an admitted family to isolated native providers and reuses the session across root changes", async () => {
    const scopes: ControlledRunScope[] = [];
    const providerRequests: Array<{ provider: string; modelId: string; apiKey: string | undefined }> = [];
    const modelRegistryAuth = vi.fn(() => { throw new Error("ambient Prime registry auth must not run"); });
    let listener: ((event: unknown) => void) | undefined;
    const session = {
      sessionFile: "/tmp/family-session.jsonl",
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      createAgentSessionServices: vi.fn(async () => nativeServices()),
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never });

    for (const [index, adapterId] of ["openai-api", "anthropic-api", "openrouter", "vercel-ai-router"].entries()) {
      await harness.complete(singleAdapterRunContext(
        40 + index,
        adapterId,
        adapterId === "openrouter"
          ? { contextWindow: 196_608, maxOutputTokens: 131_072, reasoning: true, imageInput: true }
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

    expect(session.agent.state.thinkingLevel).toBe("medium");
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
      { api: "openai-completions", baseUrl: "https://provider-42.test/v1", compat: { thinkingFormat: "openrouter", openRouterRouting: {} }, reasoning: true, input: ["text", "image"], contextWindow: 196_608, maxTokens: 131_072, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { api: "openai-completions", baseUrl: "https://provider-43.test/v1", compat: { vercelGatewayRouting: {} }, reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 384_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { api: "openai-completions", baseUrl: "https://provider-44.test/v1", compat: { thinkingFormat: "openrouter", openRouterRouting: {} }, reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 2_048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { api: "anthropic-messages", baseUrl: "https://provider-45.test/proxy/anthropic", compat: undefined, reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]);
  });

  it.each([
    { imageInput: true, reasoning: true, reasoningEffort: true, expected: { effort: "medium" } },
    { imageInput: false, reasoning: true, reasoningEffort: false, expected: { enabled: true } },
    { imageInput: undefined, reasoning: false, reasoningEffort: false, expected: undefined },
  ])("preserves configured thinking through the actual native request ($reasoning/$reasoningEffort)", async ({ imageInput, reasoning, reasoningEffort, expected }) => {
    const native = await import("@earendil-works/pi-coding-agent");
    const workspace = await mkdtemp(join(tmpdir(), "prime-reasoning-"));
    const authStorage = native.AuthStorage.inMemory();
    const modelRegistry = native.ModelRegistry.inMemory(authStorage);
    // In-memory auth still reads ambient provider credentials. This fixture starts
    // unconfigured; only the real run-scoped model below may supply a request model.
    vi.spyOn(modelRegistry, "refreshAvailableModels").mockResolvedValue([]);
    const payloads: Record<string, unknown>[] = [];
    let session: Awaited<ReturnType<typeof native.createAgentSessionFromServices>>["session"] | undefined;
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: workspace, ...fullPermission,
      configuration: { ...configuration, settings: { thinkingLevel: "medium", prewarmIpythonKernel: false } },
    }, { loadModule: async () => ({
      ...native,
      createAgentSessionServices: async (options: Parameters<typeof native.createAgentSessionServices>[0]) => native.createAgentSessionServices({
        ...options, agentDir: join(workspace, "agent"), authStorage, modelRegistry,
        settingsManager: native.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        resourceLoaderOptions: { ...options.resourceLoaderOptions, noExtensions: true, noSkills: true, noPromptTemplates: true },
      }),
      createAgentSessionFromServices: async (options: Parameters<typeof native.createAgentSessionFromServices>[0]) => {
        const result = await native.createAgentSessionFromServices({ ...options, tools: [], prewarmIpythonKernel: false });
        session = result.session;
        expect(session.model?.provider).toBe("unknown");
        expect(session.thinkingLevel).toBe("off");
        session.agent.onPayload = (payload) => {
          payloads.push(payload as Record<string, unknown>);
          throw new Error("deterministic payload capture: no network request");
        };
        return result;
      },
    }) as never });
    try {
      expect(session!.thinkingLevel).toBe("medium");
      expect(session!.sessionManager.buildSessionContext().thinkingLevel).toBe("medium");
      for (const nodeId of [51, 52]) {
        session!.agent.state.messages = [...session!.agent.state.messages, { role: "user", content: [{ type: "image", data: "aW1hZ2UtcHJvYmU=", mimeType: "image/png" }], timestamp: Date.now() }];
        await harness.complete(singleAdapterRunContext(nodeId, "openrouter", {
          contextWindow: 196_608, maxOutputTokens: 131_072, reasoning, reasoningEffort, ...(imageInput === undefined ? {} : { imageInput }),
        })).catch(() => undefined);
      }
      // attach_image returns a draft preview as an image block in the ipython tool result.
      session!.agent.state.messages = [...session!.agent.state.messages,
        { role: "assistant", content: [{ type: "toolCall", id: "attach-1", name: "ipython", arguments: { code: "print(await attach_image(layer.preview.path))" } }], api: "openai-completions", provider: "openrouter", model: "probe", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() },
        { role: "toolResult", toolCallId: "attach-1", toolName: "ipython", content: [{ type: "text", text: "Loaded 1 image(s) into context" }, { type: "image", data: "cHJldmlldy1wcm9iZQ==", mimeType: "image/png" }], isError: false, timestamp: Date.now() },
      ] as never;
      await harness.complete(singleAdapterRunContext(53, "openrouter", {
        contextWindow: 196_608, maxOutputTokens: 131_072, reasoning, reasoningEffort, ...(imageInput === undefined ? {} : { imageInput }),
      })).catch(() => undefined);
      expect(payloads).toHaveLength(3);
      expect(payloads.map((payload) => JSON.stringify(payload).includes("data:image/png;base64,aW1hZ2UtcHJvYmU="))).toEqual([imageInput === true, imageInput === true, imageInput === true]);
      expect(JSON.stringify(payloads[2]).includes("data:image/png;base64,cHJldmlldy1wcm9iZQ==")).toBe(imageInput === true);
      payloads.pop();
      expect(payloads.map((payload) => payload.reasoning)).toEqual([expected, expected]);
      expect(session!.model?.provider).toBe("unknown");
    } finally {
      await harness.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a discovered context that cannot satisfy Prime's compaction reserve", async () => {
    const session = {
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
    const loaders = sessionLoaders();
    const session = {
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      createAgentSessionServices: vi.fn(async () => nativeServices({ modelRegistry: { find: vi.fn() } })),
      createAgentSessionFromServices: loaders.record(vi.fn(async () => ({ session }))),
    }) as never });

    const context = runContext(11, "token");
    const trace = recordingTrace();
    await harness.complete({
      ...context,
      completionBroker: {
        url: "http://127.0.0.1:43125/api/completions",
        token: "12345678901234567890123456789012",
      },
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
    expectGraphAuthoringRules(prompt);
    expect(prompt).toContain("A flat answer is valid");
    expect(prompt).toContain("writer persists drafts");
    expect(prompt).toContain("final acceptance requires await graph.submit(11)");
    expect(prompt).toContain("await graph.get_node(11)");
    expect(prompt).toContain("await graph.get_neighbors(11)");
    expect(prompt).toContain("ordinary graph.submit(11) automatically fulfills any lease");
    expect(prompt).toContain("There is no separate resolve_action call");
    expect(prompt).toContain('input_graph = await graph.prepare_complete(invoke_action, "stable-call-key")');
    expect(prompt).toContain("Never mention or expose the size justification");
    expect(prompt).toContain("Every new root, expansion, and reference layer requires a version-1 LayerLayoutObject");
    expect(prompt).toContain("align comparisons deliberately");
    expect(prompt).toContain('layer.node("finding", icon="info", title="Initial finding", detail="Replace with supported evidence, remaining uncertainty, and the next useful step.")');
    expect(prompt).toContain(JSON.stringify(detailAuthoringReference()));
    expect(prompt).toContain("Give graph-authoring RLM children this recipe");
    expect(prompt).not.toContain('NodeObject("lightbulb"');
    expect(prompt).toContain('client_key="root-response"');
    expect(prompt).toContain('"Key findings", root_layer, relation="expand", client_key="root-response", icon="search"');
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
    const nativeInstructions = loaders.appendedFor(session);
    expect(nativeInstructions).toHaveLength(2);
    expect(nativeInstructions?.[1]).toContain("If you are the root agent");
    expect(nativeInstructions?.[1]).toContain("relevant language-specific public API recipes");
    expect(nativeInstructions?.[1]).toContain("only when assigning a native child to author graph content");
    expect(nativeInstructions?.[1]).toContain("Never include that block in an unrelated delegate's task");
    expect(nativeInstructions?.[1]).toContain("only when that exact rendered block is present in your assigned task");
    expect(nativeInstructions?.[1]).toContain("every native child that can author graph content");
    expect(nativeInstructions?.[1]).not.toContain("Personal graph presentation preferences:");
    expect(nativeInstructions?.[1]).not.toContain("Decision-useful center");
  });

  it.each([undefined, "layered-navigation-v1"])("composes Python-only V3 guidance and redacts historical V3 echoes (%s)", async (promptProfile) => {
    const source = await readFile(new URL("../../../crates/relayer-app-server/src/runtime.rs", import.meta.url), "utf8");
    const rawDetail = JSON.parse(source.match(/title: "Authored visual Node Details",\s*detail: ("(?:[^"\\]|\\.)*")/)![1]!);
    const title = "Authored visual Node Details";
    const legacyBlock = `Personal graph presentation preferences:\n\n${title}: ${rawDetail}`;
    let prompt = "";
    let listener: ((event: unknown) => void) | undefined;
    const session = primeSession("/tmp/prime-v3-prompt.jsonl", {
      subscribe: vi.fn((next) => { listener = next; return vi.fn(); }),
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
      promptAndWait: vi.fn(async (text: string) => {
        prompt = text;
        listener?.({ type: "tool_execution_start", toolCallId: "old-child", toolName: "ipython", args: { task: legacyBlock } });
        listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: rawDetail }] } });
      }),
    });
    Object.assign(session, { reload: vi.fn(async () => undefined) });
    const harness = await createHarness(session, { ...configuration, settings: { ...configuration.settings, ...(promptProfile ? { promptProfile } : {}) } });
    const context = presentationRunContext(11, "token", 90);
    const node = context.personalPresentation!.graph.layers[0]!.nodes[0]!;
    Object.assign(node, { title, detail: rawDetail });
    const trace = recordingTrace();
    try {
      await harness.complete({ ...context, trace: trace.sink });
      expect(prompt).toContain("every node you create");
      expect(prompt).toContain("not a recommended response design");
      expect(prompt).not.toContain("Start from this runnable");
      expect(prompt).toContain("await graph.checkpoint_node_detail(node)");
      expect(prompt).toContain("graph.bind_node");
      expect(prompt).toContain("do not copy a whole explanation across siblings");
      expect(prompt).toContain("background-color: transparent");
      expect(prompt).toContain("await graph.submit(11)");
      expect(prompt).not.toMatch(/detailAuthoring|checkpointNodeDetail|detailCapability|html`/);
      const tool = trace.events.find((event) => event.type === "tool.call.started");
      expect(tool).toBeDefined();
      expect(JSON.stringify(tool)).toContain("[redacted-personal-presentation]");
      expect(JSON.stringify(trace.events)).not.toContain(rawDetail);
      expect(node.detail).toBe(rawDetail);
    } finally { await harness.dispose(); }
  });

  it.each([undefined, "layered-navigation-v1"])("teaches attach_image draft previews only when the host granted a folder (%s)", async (promptProfile) => {
    const prompts: string[] = [];
    const harness = await createHarness(primeSession("/tmp/prime-preview.jsonl", {
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
      promptAndWait: vi.fn(async (text: string) => { prompts.push(text); }),
    }), { ...configuration, settings: { ...configuration.settings, ...(promptProfile ? { promptProfile } : {}) } });
    const plain = runContext(11, "token");
    await harness.complete({
      ...plain,
      graph: { ...plain.graph, acquireCapability: () => ({ ...plain.graph.acquireCapability(), previewDirectory: "/tmp/previews-1" }) },
    });
    await harness.complete(runContext(12, "token"));

    expect(prompts[0]).toContain("Draft previews are on for this run.");
    expect(prompts[0]).toContain("print(await attach_image(submitted.preview.path))");
    expect(prompts[0]).toContain("If attach_image reports that the model cannot see images, stop using previews");
    expect(prompts[0]).toContain("Look before your final graph.submit");
    expect(prompts[1]).not.toContain("Draft previews are on");
    expect(prompts[1]).not.toContain("attach_image");
  });

  it("traces attach_image results with each image's MIME type and size, never the image", async () => {
    const image = Buffer.from("draft preview png bytes").toString("base64");
    let listener: ((event: unknown) => void) | undefined;
    const harness = await createHarness(primeSession("/tmp/prime-attach.jsonl", {
      subscribe: vi.fn((next) => { listener = next; return vi.fn(); }),
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
      promptAndWait: vi.fn(async () => {
        listener?.({ type: "tool_execution_end", toolCallId: "attach-1", toolName: "ipython", isError: false, result: {
          content: [{ type: "text", text: "Loaded 1 image(s) into context" }, { type: "image", data: image, mimeType: "image/png" }],
          details: { status: "ok", attachments: [{ mimeType: "image/png", data: image, path: "/tmp/previews-1/layer-30-abababababababab.png" }] },
        } });
      }),
    }));
    const trace = recordingTrace();
    try {
      await harness.complete({ ...runContext(11, "token"), trace: trace.sink });
      expect(JSON.stringify(trace.events)).not.toContain(image);
      const completed = trace.events.find((event) => event.type === "tool.call.completed");
      expect(completed?.data.result).toEqual({
        content: [{ type: "text", text: "Loaded 1 image(s) into context" }, { type: "image", mimeType: "image/png", byteLength: 23 }],
        details: { status: "ok", attachments: [{ mimeType: "image/png", byteLength: 23, path: "/tmp/previews-1/layer-30-abababababababab.png" }] },
      });
    } finally { await harness.dispose(); }
  });

  it("includes Python graph-search guidance only for a query-v1 capability profile", async () => {
    let disabledPrompt = "";
    const disabled = await createHarness(primeSession("/tmp/search-disabled.jsonl", {
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
      promptAndWait: vi.fn(async (text: string) => { disabledPrompt = text; }),
    }), {
      ...configuration,
      graphCapabilityProfile: { search: "disabled" },
    });
    await disabled.complete(runContext(11, "disabled-token"));

    let omittedPrompt = "";
    const omitted = await createHarness(primeSession("/tmp/search-omitted.jsonl", {
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
      promptAndWait: vi.fn(async (text: string) => { omittedPrompt = text; }),
    }), configuration);
    await omitted.complete(runContext(13, "omitted-token"));

    let enabledPrompt = "";
    const enabled = await createHarness(primeSession("/tmp/search-enabled.jsonl", {
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
      promptAndWait: vi.fn(async (text: string) => { enabledPrompt = text; }),
    }), {
      ...configuration,
      graphCapabilityProfile: { search: "query-v1" },
    });
    await enabled.complete(runContext(12, "enabled-token"));

    expect(disabledPrompt).not.toContain("Graph search is available");
    expect(disabledPrompt).not.toContain("GraphSearchRequest");
    expect(omittedPrompt).not.toContain("Graph search is available");
    expect(omittedPrompt).not.toContain("GraphSearchRequest");
    expect(enabledPrompt).toContain("Graph search is available");
    expect(enabledPrompt).toContain("await graph.search(GraphSearchRequest(...))");
    expect(enabledPrompt).toContain("query_contract_version=1");
    expect(enabledPrompt).toContain('target={"scope": "project", "id": known_project_id}');
    expect(enabledPrompt).toContain("Never invent, guess, or discover a target ID");
    expect(enabledPrompt).toContain('result["type"] == "layer"');
    expect(enabledPrompt).toContain('relation="reference"');

    const example = enabledPrompt.split("Example:\n")[1]?.split("\n\nGraph query contract failures")[0];
    expect(example).toBeDefined();
    expect(example).toContain('result = first_row[0]');
    expect(example).toContain('layer_id = int(match.group(1))');
    expect(example!.indexOf('result = first_row[0]')).toBeLessThan(example!.indexOf('layer_id = int(match.group(1))'));

    const cases = [
      { name: "valid first cell", result: { truncated: false, rows: [[{ type: "layer", id: "layer:42" }], [{ type: "layer", id: "layer:43" }]] }, target: 42 },
      { name: "truncated", result: { truncated: true, rows: [[{ type: "layer", id: "layer:42" }]] } },
      { name: "missing rows", result: { truncated: false } },
      { name: "empty rows", result: { truncated: false, rows: [] } },
      { name: "empty first row", result: { truncated: false, rows: [[]] } },
      { name: "non-layer", result: { truncated: false, rows: [[{ type: "content", id: "content:42" }]] } },
      { name: "zero identity", result: { truncated: false, rows: [[{ type: "layer", id: "layer:0" }]] } },
      { name: "malformed identity", result: { truncated: false, rows: [[{ type: "layer", id: "layer:42x" }]] } },
    ];
    const python = [
      "import asyncio, json, re, sys, textwrap, types",
      "cases = json.load(sys.stdin)",
      "class GraphSearchRequest:",
      "    def __init__(self, **kwargs): pass",
      "class FakeGraph:",
      "    def __init__(self, response): self.response = response",
      "    async def search(self, request): return self.response",
      "client = types.ModuleType('relayer_graph')",
      "client.GraphSearchRequest = GraphSearchRequest",
      "sys.modules['relayer_graph'] = client",
      "async def exercise(case):",
      "    namespace = {'graph': FakeGraph(case['result']), 'GraphSearchRequest': GraphSearchRequest, 're': re}",
      "    source = 'async def sample():\\n' + textwrap.indent(case['example'], '    ') + '\\n    return layer_id'",
      "    exec(compile(source, '<emitted-prime-search-example>', 'exec'), namespace)",
      "    try:",
      "        return {'name': case['name'], 'target': await namespace['sample']()} ",
      "    except (ValueError, TypeError, AttributeError, IndexError) as error:",
      "        return {'name': case['name'], 'error': str(error)}",
      "async def main():",
      "    print(json.dumps([await exercise(case) for case in cases]))",
      "asyncio.run(main())",
    ].join("\n");
    const executed = JSON.parse(execFileSync("python3", ["-c", python], {
      input: JSON.stringify(cases.map((entry) => ({ ...entry, example }))),
      encoding: "utf8",
    })) as Array<{ name: string; target?: number; error?: string }>;
    expect(executed[0]).toEqual({ name: "valid first cell", target: 42 });
    expect(executed.slice(1).map(({ name, error }) => ({ name, rejected: typeof error === "string" })))
      .toEqual(cases.slice(1).map(({ name }) => ({ name, rejected: true })));
    expect(executed.slice(1).map(({ error }) => error)).toEqual([
      "Graph search results are truncated; narrow the query before selecting a layer.",
      "Graph search returned no rows; no layer is available to reference.",
      "Graph search returned no rows; no layer is available to reference.",
      "The first graph search row has no result cell to reference.",
      "The first graph search result is not a tagged layer.",
      "The tagged layer has an invalid public identity.",
      "The tagged layer has an invalid public identity.",
    ]);
  });

  it("retries a presentation instruction reload after a transient failure", async () => {
    const loaders = sessionLoaders();
    const reload = vi.fn().mockRejectedValueOnce(new Error("reload failed")).mockResolvedValueOnce(undefined);
    const session = {
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
      promptAndWait: vi.fn(async () => undefined), waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined), dispose: vi.fn(), reload,
    };
    const harness = await PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
    }, { loadModule: async () => ({
      ...runScopeApi(), SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => nativeServices({ modelRegistry: { find: vi.fn() } })),
      createAgentSessionFromServices: loaders.record(vi.fn(async () => ({ session }))),
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
    expect(loaders.appendedFor(session)).toEqual(["base"]);
    await expect(harness.complete(attached)).resolves.toBeUndefined();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(loaders.appendedFor(session)?.[1]).toContain("If you are the root agent");
    expect(loaders.appendedFor(session)?.[1]).toContain("Never include that block in an unrelated delegate's task");
    expect(loaders.appendedFor(session)?.[1]).not.toContain("Personal graph presentation preferences:");
    expect(loaders.appendedFor(session)?.[1]).not.toContain("Decision-useful center");
  });

  it("rotates the native Prime session when the durable presentation pin changes", async () => {
    const firstDispose = vi.fn();
    const firstSession = {
      sessionFile: "/tmp/prime-v1.jsonl",
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
      promptAndWait: vi.fn(async () => undefined), waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined), dispose: firstDispose, reload: vi.fn(async () => undefined),
    };
    const secondSession = {
      sessionFile: "/tmp/prime-neutral.jsonl",
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      createAgentSessionServices: vi.fn(async () => nativeServices({ modelRegistry: { find: vi.fn() } })),
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
    const loaders = sessionLoaders();
    const session = {
      sessionFile: "/tmp/saved-v1.jsonl",
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      createAgentSessionServices: vi.fn(async () => nativeServices({ modelRegistry: { find: vi.fn() } })),
      createAgentSessionFromServices: loaders.record(createAgentSessionFromServices),
    }) as never });
    const attached = presentationRunContext(11, "token", 90);

    await harness.complete(attached);
    await harness.complete(attached);

    expect(open).toHaveBeenCalledWith("/tmp/saved-v1.jsonl");
    expect(createAgentSessionFromServices).toHaveBeenCalledOnce();
    expect(session.reload).toHaveBeenCalledOnce();
    expect(session.promptAndWait).toHaveBeenCalledTimes(2);
    const nativeInstructions = loaders.appendedFor(session);
    expect(nativeInstructions?.[1]).toContain("If you are the root agent");
    expect(nativeInstructions?.[1]).toContain("relevant language-specific public API recipes");
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      createAgentSessionServices: vi.fn(async () => nativeServices({ modelRegistry: { find: vi.fn() } })),
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
      promptAndWait: vi.fn(async () => undefined), waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined), dispose: vi.fn(), reload: vi.fn(async () => undefined),
    };
    const replacementDispose = vi.fn();
    const replacementSession = {
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      createAgentSessionServices: vi.fn(async () => nativeServices({ modelRegistry: { find: vi.fn() } })),
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
      promptAndWait: vi.fn(async () => undefined), waitForRlmQuiescence: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined), dispose: vi.fn(), reload: vi.fn(async () => undefined),
    };
    const create = vi.fn(() => "fresh-session");
    const open = vi.fn(() => "legacy-session");
    await expect(PrimeAgentHarness.create({
      threadId: 7, workingDirectory: "/tmp/project", ...fullPermission, configuration,
      savedState: { primeAgentSessionFile: "/tmp/legacy.jsonl" },
    }, { loadModule: async () => ({
      ...runScopeApi(), SessionManager: { create, open },
      createHostRequestHandler: (handler: unknown) => handler,
      createAgentSessionServices: vi.fn(async () => nativeServices({ modelRegistry: { find: vi.fn() } })),
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never })).rejects.toThrow("saved state was preserved");


    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(session.promptAndWait).not.toHaveBeenCalled();
  });

  it("delivers the same ordered normalized context to Prime and its native children", async () => {
    let prompt = "";
    const session = {
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      createAgentSessionServices: vi.fn(async () => nativeServices({ modelRegistry: { find: vi.fn() } })),
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
          createAgentSessionServices: vi.fn(async () => nativeServices()),
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
        agent: { state: { thinkingLevel: "off" } },
        sessionManager: { appendThinkingLevelChange: vi.fn() },
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
        agent: { state: { thinkingLevel: "off" } },
        sessionManager: { appendThinkingLevelChange: vi.fn() },
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

      const fullSession = { agent: { state: { thinkingLevel: "off" } },
        sessionManager: { appendThinkingLevelChange: vi.fn() },
        promptAndWait: vi.fn(async (_text: string, options: any) => {
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
        agent: { state: { thinkingLevel: "off" } },
        sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
      promptAndWait: vi.fn(async () => {
        listener?.({ type: "turn_start" });
        listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "private-reasoning-sentinel" }, { type: "text", text: "Visible" }], usage: { input: 2, output: 3 } } });
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
    expect(JSON.stringify(trace.events)).not.toContain("private-reasoning-sentinel");
    expect(trace.events.map((event) => event.type)).toEqual(expect.arrayContaining(["provider.event", "message", "usage", "model.call.started", "model.call.completed"]));
    expect(harness.traceSupport()).toMatchObject({ childStreams: "summary", reasoningSummaries: "none" });
  });

  it("scrubs exact provider access recursively from usage traces and exports", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-prime-usage-trace-"));
    let listener: ((event: unknown) => void) | undefined;
    const session = {
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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
      agent: { state: { thinkingLevel: "off" } },
      sessionManager: { appendThinkingLevelChange: vi.fn() },
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

/** Records the resource loader each native session was created with. */
function sessionLoaders() {
  const loaders = new Map<unknown, { getAppendSystemPrompt(): string[] }>();
  return {
    appendedFor: (session: unknown): string[] | undefined => loaders.get(session)?.getAppendSystemPrompt(),
    record: <Result extends { readonly session: unknown }>(create: (...args: never[]) => Promise<Result>) => (
      async (options: { readonly services: { readonly resourceLoader: { getAppendSystemPrompt(): string[] } } }) => {
        const result = await (create as (value: unknown) => Promise<Result>)(options);
        loaders.set(result.session, options.services.resourceLoader);
        return result;
      }
    ),
  };
}

/** Shared native services with a resource loader each session's instructions are scoped to. */
function nativeServices(services: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...services, resourceLoader: { getAppendSystemPrompt: () => ["base"] } };
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
    agent: { state: { thinkingLevel: "off" } },
    sessionManager: { appendThinkingLevelChange: vi.fn() },
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
    createAgentSessionServices: vi.fn(async () => nativeServices({ modelRegistry: { find: vi.fn() } })),
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
      createAgentSessionServices: vi.fn(async () => nativeServices()),
      createAgentSessionFromServices: vi.fn(async () => ({ session })),
    }) as never,
    createKernelBoundary: () => async () => ({ launch: vi.fn(), dispose: vi.fn(async () => undefined) }),
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Lets every continuation queued behind an already-settled native promise run. */
async function settleMicrotasks(): Promise<void> {
  for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

interface PrimeAgentSessionFixture {
  readonly agent: { readonly state: { thinkingLevel: string } };
  readonly sessionManager: { appendThinkingLevelChange(level: string): void };
  readonly promptAndWait: ReturnType<typeof vi.fn>;
  readonly waitForRlmQuiescence: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly disposeAsync?: ReturnType<typeof vi.fn>;
  readonly subscribe?: ReturnType<typeof vi.fn>;
  readonly reload?: ReturnType<typeof vi.fn>;
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
  modelCapabilities?: { readonly contextWindow: number; readonly maxOutputTokens: number; readonly reasoning?: boolean; readonly reasoningEffort?: boolean; readonly imageInput?: boolean },
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

/**
 * The graph rules Prime tripped on in live recursive runs: indented first cells, guessed
 * API names, unsupported icons, descriptions off cards, and pointer moves the graph refused
 * for losing the path back to the previous current layer.
 */
function expectGraphAuthoringRules(prompt: string): void {
  expect(prompt).toContain("Top-level cell code starts at column 0; never indent it.");
  expect(prompt).toContain("```python\nfrom relayer_graph import GraphSession\ngraph = await GraphSession.current()\n```");
  expect(prompt).toContain(PYTHON_GRAPH_API_REFERENCE);
  expect(prompt).toContain("await graph.icons.discover(query");
  expect(prompt).toContain("Only a card accepts description, and a card requires one.");
  // Graph core exempts the interaction root before enforcing draft ownership, so the rule states that exception.
  expect(prompt).toContain("Reuse alone grants no action authority");
  expect(prompt).toContain("Only an exact frozen attached-node navigation grant permits the exception");
  expect(prompt).not.toContain("Reused accepted nodes cannot take new actions.");
  expect(prompt).not.toContain("Published records are immutable.");
  expect(prompt).not.toContain("graph.replaceNodePresentation");
  expect(prompt).toContain("graph.get_node_presentation");
  expect(prompt).toContain("graph.replace_node_presentation");
  expect(prompt).toContain("interaction_permissions");
  expect(prompt).toContain("The first current layer may contain visible accepted nodes");
  expect(prompt).toContain("when no prior current exists, it needs no new draft carrier");
  expect(prompt).toContain("Reuse an existing valid path when one already exists");
  expect(prompt).toContain("every later current layer and the root of your final graph.submit must retain a navigation path back");
  expect(prompt).toContain('current["currentLayerId"], relation="reference", source_layer=new_layer');
  expect(prompt).toContain("Give each distinct logical advance_current transition its own stable operation key");
  expect(prompt).toContain("After submitting the complete closure and registering all its actions, publish it with await graph.advance_current(");
  expect(prompt).toContain("An exact retry reuses all three unchanged");
  expect(prompt).toContain("After a successful nonterminal advance_current, refresh with current = await graph.get_current()");
  expect(prompt).toContain("Use a different stable key for that next transition");
  expect(prompt).toContain("A successful terminal graph.submit ends graph access: do not call get_current");
  expect(prompt).not.toContain("every layer you make current needs at least one new draft node");
  expect(prompt).not.toContain("a-stable-operation-key");
}

const pythonExecutable = process.platform === "win32" ? "python" : "python3";

describe("Prime graph client reference", () => {
  it("names only graph methods and keywords the Python client declares", () => {
    const declared = JSON.parse(execFileSync(pythonExecutable, ["-c", `
import inspect, json
from relayer_graph import GraphSession
print(json.dumps({
    name: {
        "async": inspect.iscoroutinefunction(member),
        "parameters": [p for p in inspect.signature(member).parameters if p != "self"],
    }
    for name, member in inspect.getmembers(GraphSession, inspect.isfunction)
    if not name.startswith("_")
}))
`], {
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: join(process.cwd(), "python", "relayer-graph", "src") },
    })) as Record<string, { async: boolean; parameters: string[] }>;
    const calls = [...PYTHON_GRAPH_API_REFERENCE.matchAll(/await graph\.(\w+)\(([^)]*)\)/g)];
    expect(calls.length).toBeGreaterThan(8);
    for (const [, method, argumentList] of calls) {
      const signature = declared[method!];
      expect(signature, `graph.${method}`).toBeDefined();
      expect(signature!.async, `graph.${method} is async`).toBe(true);
      const keywords = argumentList!.split(", ")
        .map((argument) => /^(\w+)=/.exec(argument)?.[1])
        .filter((keyword): keyword is string => keyword !== undefined);
      for (const keyword of keywords) {
        expect(signature!.parameters, `graph.${method}(${keyword}=...)`).toContain(keyword);
      }
    }
  });
});
