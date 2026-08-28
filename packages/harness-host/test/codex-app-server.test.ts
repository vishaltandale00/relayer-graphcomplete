import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  codexForceTerminationSignal,
  forceTerminateCodexProcessTree,
  runCodexAppServerTurn,
  type CodexAppServerSpawn,
  type CodexAppServerTurnOptions,
} from "../src/implementations/codex-app-server.js";
import type { HarnessApprovalChannel } from "../src/approval-coordinator.js";

describe("Codex app-server transport", () => {
  it("rejects a missing explicit Codex executable before spawning", async () => {
    const fake = new FakeCodexProcess(() => undefined);
    const { codexPathOverride: _codexPathOverride, ...withoutExecutable } = options(fake);

    await expect(runCodexAppServerTurn(withoutExecutable as CodexAppServerTurnOptions))
      .rejects.toThrow("Codex app-server requires an explicit executable path");

    expect(fake.spawn).toBeUndefined();
  });

  it("uses only platform-supported generic force signals", () => {
    expect(codexForceTerminationSignal("darwin")).toBe("SIGUSR2");
    expect(codexForceTerminationSignal("win32")).toBe("SIGKILL");
    expect(codexForceTerminationSignal("linux")).toBe("SIGKILL");
  });

  it("uses taskkill to terminate the complete Codex process tree on Windows", () => {
    const child = { pid: 4321, kill: vi.fn() };
    const killer = new EventEmitter();
    const spawnTreeKiller = vi.fn(() => killer);

    forceTerminateCodexProcessTree(child as never, "win32", spawnTreeKiller as never, "C:\\Windows");

    expect(spawnTreeKiller).toHaveBeenCalledWith("C:\\Windows\\System32\\taskkill.exe", ["/pid", "4321", "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("signals the complete Codex process group on POSIX", () => {
    const child = { pid: 4321, kill: vi.fn() };
    const killProcessGroup = vi.fn();

    forceTerminateCodexProcessTree(child as never, "linux", spawn, undefined, killProcessGroup);

    expect(killProcessGroup).toHaveBeenCalledWith(-4321, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to direct POSIX termination when the process group is unavailable", () => {
    const child = { pid: 4321, kill: vi.fn() };
    const killProcessGroup = vi.fn(() => { throw new Error("missing process group"); });

    forceTerminateCodexProcessTree(child as never, "darwin", spawn, undefined, killProcessGroup);

    expect(killProcessGroup).toHaveBeenCalledWith(-4321, "SIGUSR2");
    expect(child.kill).toHaveBeenCalledWith("SIGUSR2");
  });

  it("falls back to direct termination if Windows taskkill cannot start", () => {
    const child = { pid: 4321, kill: vi.fn() };
    const killer = new EventEmitter();

    forceTerminateCodexProcessTree(child as never, "win32", vi.fn(() => killer) as never);
    killer.emit("error", new Error("missing taskkill"));

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("falls back to direct termination if Windows taskkill exits unsuccessfully", () => {
    const child = { pid: 4321, kill: vi.fn() };
    const killer = new EventEmitter();

    forceTerminateCodexProcessTree(child as never, "win32", vi.fn(() => killer) as never);
    killer.emit("exit", 1);

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it.each([
    [undefined, "thread/start"],
    ["thread-existing", "thread/resume"],
  ] as const)("initializes, %s a thread, completes a turn, and shuts down", async (savedThreadId, threadMethod) => {
    const fake = new FakeCodexProcess((message) => {
      if (message.method === "initialize") fake.respond(message.id, { userAgent: "codex" });
      if (message.method === threadMethod) fake.respond(message.id, { thread: { id: savedThreadId ?? "thread-new" } });
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => fake.notify("turn/completed", {
          threadId: savedThreadId ?? "thread-new",
          turn: { id: "turn-1", status: "completed", error: null },
        }));
      }
    });
    const onThreadId = vi.fn();

    const result = await runCodexAppServerTurn(options(fake, {
      ...(savedThreadId === undefined ? {} : { savedThreadId }),
      onThreadId,
    }));

    expect(result).toEqual({ threadId: savedThreadId ?? "thread-new", turnId: "turn-1", status: "completed" });
    expect(onThreadId).toHaveBeenCalledWith(savedThreadId ?? "thread-new");
    expect(fake.messages.map(({ method }) => method).filter(Boolean)).toEqual([
      "initialize",
      "initialized",
      threadMethod,
      "turn/start",
    ]);
    expect(fake.messages[0]).toMatchObject({ params: { capabilities: { experimentalApi: true } } });
    expect(fake.messages.find(({ method }) => method === threadMethod)?.params).toMatchObject(
      savedThreadId === undefined ? { cwd: "/workspace" } : { threadId: savedThreadId, cwd: "/workspace" },
    );
    expect(fake.messages.find(({ method }) => method === "turn/start")?.params).toMatchObject({
      threadId: savedThreadId ?? "thread-new",
      input: [{ type: "text", text: "Build the graph" }],
    });
    expect(fake.spawn).toEqual({ command: process.execPath, args: ["app-server", "--listen", "stdio://"] });
    expect(fake.spawnOptions?.detached).toBe(process.platform !== "win32");
    expect(fake.killed).toBe(true);
  });

  it("bridges a server command approval and never sends acceptForSession", async () => {
    const onServerRequest = vi.fn();
    const request = vi.fn(async () => ({
      requestId: "request-1",
      decision: "approve_always" as const,
      actor: "user" as const,
      decidedAt: "2026-08-20T15:00:00.000Z",
    }));
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => {
          fake.notify("item/started", {
            threadId: "thread-new",
            turnId: "turn-1",
            item: { type: "commandExecution", id: "item-1", command: "npm test", cwd: "/workspace", source: "agent" },
          });
          fake.serverRequest("provider-1", "item/commandExecution/requestApproval", {
            threadId: "thread-new",
            turnId: "turn-1",
            itemId: "item-1",
            environmentId: "local",
            command: "npm test",
            cwd: "/workspace",
          });
        });
      }
      if (message.id === "provider-1" && message.result !== undefined) {
        queueMicrotask(() => fake.notify("turn/completed", {
          threadId: "thread-new",
          turn: { id: "turn-1", status: "completed", error: null },
        }));
      }
    });

    await runCodexAppServerTurn(options(fake, { approvals: { request }, onServerRequest }));

    expect(request).toHaveBeenCalledOnce();
    expect(onServerRequest).toHaveBeenCalledWith("item/commandExecution/requestApproval", expect.objectContaining({
      itemId: "item-1",
      command: "npm test",
      cwd: "/workspace",
    }));
    const providerResponse = fake.messages.find(({ id }) => id === "provider-1" && "result" in (fake.messages.find(({ id }) => id === "provider-1") ?? {}));
    expect(providerResponse).toEqual({ id: "provider-1", result: { decision: "accept" } });
    expect(JSON.stringify(fake.messages)).not.toContain("acceptForSession");
  });

  it("returns pinned Codex MCP denial as Cancel for the exact enclosing tool call", async () => {
    const request = vi.fn(async () => ({
      requestId: "request-1",
      decision: "deny" as const,
      actor: "user" as const,
      decidedAt: "2026-08-20T15:00:00.000Z",
      rationale: "No.",
    }));
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => {
          fake.notify("item/started", {
            threadId: "thread-new",
            turnId: "turn-1",
            item: {
              type: "mcpToolCall",
              id: "tool-1",
              server: "chrome-devtools",
              tool: "evaluate_script",
              arguments: { pageId: 1, function: "() => document.title" },
              readOnlyHint: false,
            },
          });
          fake.serverRequest("mcp-provider-1", "item/tool/requestUserInput", {
            threadId: "thread-new",
            turnId: "turn-1",
            itemId: "tool-1",
            isBlocking: true,
            questions: [{
              id: "mcp_tool_call_approval_call-1",
              header: "Approve app tool call?",
              question: "Allow chrome-devtools.evaluate_script?",
              isOther: false,
              isSecret: false,
              options: [
                { label: "Allow", description: "Run the tool and continue." },
                { label: "Cancel", description: "Cancel this tool call." },
              ],
            }],
          });
        });
      }
      if (message.id === "mcp-provider-1" && message.result !== undefined) {
        queueMicrotask(() => completeTurn(fake));
      }
    });

    await runCodexAppServerTurn(options(fake, { approvals: { request } }));

    expect(request).toHaveBeenCalledOnce();
    expect(fake.messages).toContainEqual({
      id: "mcp-provider-1",
      result: {
        answers: {
          "mcp_tool_call_approval_call-1": { answers: ["Cancel"] },
        },
      },
    });
  });

  it.each([
    ["Auto", { approvalPolicy: "on-request", approvalsReviewer: "auto_review" }],
    ["Full", { approvalPolicy: "never" }],
  ] as const)("does not invent a Relayer MCP prompt from an event-only %s lifecycle", async (_profile, nativeApproval) => {
    const request = vi.fn(async () => { throw new Error("unexpected Relayer approval"); });
    const onServerRequest = vi.fn();
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => {
          fake.notify("item/started", {
            threadId: "thread-new",
            turnId: "turn-1",
            item: {
              type: "mcpToolCall",
              id: "tool-1",
              server: "chrome-devtools",
              tool: "evaluate_script",
              arguments: { function: "() => document.title" },
              readOnlyHint: false,
            },
          });
          fake.notify("item/completed", {
            threadId: "thread-new",
            turnId: "turn-1",
            item: {
              type: "mcpToolCall",
              id: "tool-1",
              server: "chrome-devtools",
              tool: "evaluate_script",
              arguments: { function: "() => document.title" },
              status: "completed",
            },
          });
          completeTurn(fake);
        });
      }
    });

    await runCodexAppServerTurn(options(fake, {
      approvals: { request },
      onServerRequest,
      threadParams: {
        cwd: "/workspace",
        ...nativeApproval,
        config: {
          mcp_servers: {
            "chrome-devtools": { default_tools_approval_mode: "prompt" },
          },
        },
      },
    }));

    expect(request).not.toHaveBeenCalled();
    expect(onServerRequest).not.toHaveBeenCalled();
    expect(fake.messages.find(({ method }) => method === "thread/start")?.params).toMatchObject({
      ...nativeApproval,
      config: {
        mcp_servers: {
          "chrome-devtools": { default_tools_approval_mode: "prompt" },
        },
      },
    });
  });

  it("bridges a permission approval without item/started and completes the same turn", async () => {
    const request = vi.fn(async () => ({
      requestId: "request-1",
      decision: "approve_once" as const,
      actor: "user" as const,
      decidedAt: "2026-08-20T15:00:00.000Z",
    }));
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => fake.serverRequest("permission-provider-1", "item/permissions/requestApproval", {
          threadId: "thread-new",
          turnId: "turn-1",
          itemId: "permission-item-1",
          environmentId: "local",
          startedAtMs: 1,
          cwd: "/workspace",
          reason: "Read a shared dependency",
          permissions: {
            network: null,
            fileSystem: { read: ["/workspace/shared"], write: null },
          },
        }));
      }
      if (message.id === "permission-provider-1" && message.result !== undefined) {
        queueMicrotask(() => completeTurn(fake));
      }
    });

    const result = await runCodexAppServerTurn(options(fake, { approvals: { request } }));

    expect(result.status).toBe("completed");
    expect(request).toHaveBeenCalledOnce();
    expect(fake.messages).toContainEqual({
      id: "permission-provider-1",
      result: {
        permissions: { fileSystem: { read: ["/workspace/shared"], write: null } },
        scope: "turn",
      },
    });
  });

  it("returns denial to the same turn and handles the safer follow-up request", async () => {
    const decisions = ["deny", "approve_once"] as const;
    const request = vi.fn(async () => ({
      requestId: `request-${request.mock.calls.length}`,
      decision: decisions[request.mock.calls.length - 1]!,
      actor: "user" as const,
      decidedAt: "2026-08-20T15:00:00.000Z",
    }));
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => sendCommandApproval(fake, "provider-1", "item-1", "npm test"));
      }
      if (message.id === "provider-1" && message.result?.decision === "decline") {
        queueMicrotask(() => sendCommandApproval(fake, "provider-2", "item-2", "npm test -- --runInBand"));
      }
      if (message.id === "provider-2" && message.result?.decision === "accept") {
        queueMicrotask(() => completeTurn(fake));
      }
    });

    const result = await runCodexAppServerTurn(options(fake, { approvals: { request } }));

    expect(result.status).toBe("completed");
    expect(request).toHaveBeenCalledTimes(2);
    expect(fake.messages).toContainEqual({ id: "provider-1", result: { decision: "decline" } });
    expect(fake.messages).toContainEqual({ id: "provider-2", result: { decision: "accept" } });
  });

  it("keeps distinct concurrent provider requests independently addressable", async () => {
    const pending = new Map<string, (decision: "approve_once" | "deny") => void>();
    const request: HarnessApprovalChannel["request"] = (input) => new Promise((resolve) => {
      const command = input.action.kind === "command" ? input.action.command : "";
      pending.set(command, (decision) => resolve({
        requestId: `request-${pending.size}`,
        decision,
        actor: "user",
        decidedAt: "2026-08-20T15:00:00.000Z",
      }));
    });
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => {
          sendCommandApproval(fake, "provider-1", "item-1", "npm test");
          sendCommandApproval(fake, "provider-2", "item-2", "npm lint");
        });
      }
      const providerResponses = fake.messages.filter(({ id, result }) => (
        (id === "provider-1" || id === "provider-2") && result !== undefined
      ));
      if (providerResponses.length === 2) queueMicrotask(() => completeTurn(fake));
    });

    const turn = runCodexAppServerTurn(options(fake, { approvals: { request } }));
    await vi.waitFor(() => expect([...pending.keys()]).toEqual(["npm test", "npm lint"]));
    pending.get("npm lint")!("deny");
    await vi.waitFor(() => expect(fake.messages).toContainEqual({ id: "provider-2", result: { decision: "decline" } }));
    pending.get("npm test")!("approve_once");

    await expect(turn).resolves.toMatchObject({ status: "completed" });
    expect(fake.messages).toContainEqual({ id: "provider-1", result: { decision: "accept" } });
  });

  it("aborts a pending provider approval when the child exits", async () => {
    let approvalSignal: AbortSignal | undefined;
    const request: HarnessApprovalChannel["request"] = (_input, requestOptions) => new Promise((_resolve, reject) => {
      approvalSignal = requestOptions?.signal;
      approvalSignal?.addEventListener("abort", () => reject(approvalSignal?.reason), { once: true });
    });
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => {
          sendCommandApproval(fake, "provider-1", "item-1", "npm test");
          queueMicrotask(() => fake.exit(17, null));
        });
      }
    });

    await expect(runCodexAppServerTurn(options(fake, { approvals: { request } }))).rejects.toThrow("stopped (17)");
    expect(approvalSignal?.aborted).toBe(true);
    expect(String(approvalSignal?.reason)).toContain("stopped (17)");
  });

  it("interrupts the active turn on cancellation", async () => {
    const controller = new AbortController();
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => controller.abort(new Error("cancelled")));
      }
      if (message.method === "turn/interrupt") {
        fake.respond(message.id, {});
        queueMicrotask(() => fake.notify("turn/completed", {
          threadId: "thread-new",
          turn: { id: "turn-1", status: "interrupted", error: null },
        }));
      }
    });

    const result = await runCodexAppServerTurn(options(fake, { signal: controller.signal }));

    expect(result.status).toBe("interrupted");
    expect(fake.messages.find(({ method }) => method === "turn/interrupt")).toMatchObject({
      params: { threadId: "thread-new", turnId: "turn-1" },
    });
  });

  it("force-terminates a stuck app-server process without waiting for turn interruption", async () => {
    const force = new AbortController();
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => force.abort(new Error("force shutdown")));
      }
    });

    await expect(runCodexAppServerTurn(options(fake, { forceSignal: force.signal }))).rejects.toThrow("force-closed");
    expect(fake.signalCode).toBe(codexForceTerminationSignal());
    expect(fake.messages.some(({ method }) => method === "turn/interrupt")).toBe(false);
  });

  it("contains hard-kill errors raised from an AbortSignal listener", async () => {
    const force = new AbortController();
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => force.abort(new Error("force shutdown")));
      }
    });
    fake.kill = vi.fn(function kill(this: FakeCodexProcess, signal: NodeJS.Signals = "SIGTERM") {
      if (signal === codexForceTerminationSignal()) throw new Error("hard kill unavailable");
      this.exit(null, signal);
      return true;
    });

    await expect(runCodexAppServerTurn(options(fake, { forceSignal: force.signal }))).rejects.toThrow("force-closed");
    expect(fake.signalCode).toBe("SIGTERM");
  });

  it("retains force ownership after the turn settles and graceful transport close starts", async () => {
    const force = new AbortController();
    const signals: NodeJS.Signals[] = [];
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => completeTurn(fake));
      }
    });
    fake.kill = vi.fn(function kill(this: FakeCodexProcess, signal: NodeJS.Signals = "SIGTERM") {
      signals.push(signal);
      if (signal === "SIGTERM") queueMicrotask(() => force.abort(new Error("force during close")));
      if (signal === codexForceTerminationSignal()) this.exit(null, signal);
      return true;
    });

    await expect(runCodexAppServerTurn(options(fake, {
      forceSignal: force.signal,
      shutdownGraceMs: 20,
    }))).resolves.toMatchObject({ status: "completed" });

    expect(signals).toEqual(["SIGTERM", codexForceTerminationSignal()]);
    expect(fake.signalCode).toBe(codexForceTerminationSignal());
  });

  it("escalates a fatal transport exactly once when the child ignores SIGTERM", async () => {
    const signals: NodeJS.Signals[] = [];
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => fake.stdout.write("not-json\n"));
      }
    });
    fake.kill = vi.fn(function kill(this: FakeCodexProcess, signal: NodeJS.Signals = "SIGTERM") {
      signals.push(signal);
      if (signal === codexForceTerminationSignal()) this.exit(null, signal);
      return true;
    });

    await expect(runCodexAppServerTurn(options(fake, { shutdownGraceMs: 10 }))).rejects.toThrow("malformed JSON");

    expect(signals).toEqual(["SIGTERM", codexForceTerminationSignal()]);
    expect(fake.signalCode).toBe(codexForceTerminationSignal());
  });

  it("does not treat a child error as process exit and exhausts bounded escalation", async () => {
    const signals: NodeJS.Signals[] = [];
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => fake.emit("error", new Error("transport failed while process stayed alive")));
      }
    });
    fake.kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      signals.push(signal);
      return true;
    });

    await expect(runCodexAppServerTurn(options(fake, { shutdownGraceMs: 5 })))
      .rejects.toThrow("process did not exit after forced termination");

    expect(signals).toEqual(["SIGTERM", codexForceTerminationSignal(), "SIGKILL"]);
    expect(fake.exitCode).toBeNull();
    expect(fake.signalCode).toBeNull();
  });

  it("settles the exit fence only when the errored child actually exits", async () => {
    const signals: NodeJS.Signals[] = [];
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => fake.emit("error", new Error("transport failed before exit")));
      }
    });
    fake.kill = vi.fn(function kill(this: FakeCodexProcess, signal: NodeJS.Signals = "SIGTERM") {
      signals.push(signal);
      if (signal === codexForceTerminationSignal()) this.exit(null, signal);
      return true;
    });

    await expect(runCodexAppServerTurn(options(fake, { shutdownGraceMs: 5 })))
      .rejects.toThrow("Codex app-server failed: transport failed before exit");

    expect(signals).toEqual(["SIGTERM", codexForceTerminationSignal()]);
    expect(fake.signalCode).toBe(codexForceTerminationSignal());
  });

  it("settles the termination fence on close after an unsuccessful spawn without force escalation", async () => {
    const signals: NodeJS.Signals[] = [];
    const fake = new FakeCodexProcess(() => undefined);
    fake.kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      signals.push(signal);
      return false;
    });
    const running = runCodexAppServerTurn(options(fake, { shutdownGraceMs: 5 }));

    fake.emit("error", Object.assign(new Error("spawn missing"), { code: "ENOENT" }));
    queueMicrotask(() => fake.emit("close", -2, null));

    await expect(running).rejects.toMatchObject({
      message: expect.stringContaining("spawn missing"),
      cause: expect.objectContaining({ code: "ENOENT" }),
    });
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("preserves a real unsuccessful-spawn ENOENT instead of replacing it with a close timeout", async () => {
    const missingExecutable = join(tmpdir(), `relayer-missing-codex-${process.pid}-${Date.now()}`);
    const spawnMissing: CodexAppServerSpawn = () => spawn(missingExecutable, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const fake = new FakeCodexProcess(() => undefined);

    await expect(runCodexAppServerTurn(options(fake, {
      spawnProcess: spawnMissing,
      shutdownGraceMs: 20,
    }))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails on malformed JSON and terminates the child", async () => {
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => fake.stdout.write("not-json\n"));
      }
    });

    await expect(runCodexAppServerTurn(options(fake))).rejects.toThrow("malformed JSON");
    expect(fake.killed).toBe(true);
  });

  it("fails on duplicate in-flight server request IDs", async () => {
    let keepWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { keepWaiting = resolve; });
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => {
          fake.notify("item/started", {
            threadId: "thread-new",
            turnId: "turn-1",
            item: { type: "commandExecution", id: "item-1", command: "npm test", cwd: "/workspace", source: "agent" },
          });
          const params = { threadId: "thread-new", turnId: "turn-1", itemId: "item-1", command: "npm test", cwd: "/workspace" };
          fake.serverRequest("duplicate", "item/commandExecution/requestApproval", params);
          fake.serverRequest("duplicate", "item/commandExecution/requestApproval", params);
        });
      }
    });
    const approvals: HarnessApprovalChannel = {
      request: async () => { await waiting; throw new Error("unreachable"); },
    };

    await expect(runCodexAppServerTurn(options(fake, { approvals }))).rejects.toThrow("repeated server request ID");
    keepWaiting();
  });

  it("fails when the child exits before the turn completes", async () => {
    const fake = new FakeCodexProcess((message) => {
      handshake(fake, message);
      if (message.method === "turn/start") {
        fake.respond(message.id, { turn: { id: "turn-1", status: "inProgress" } });
        queueMicrotask(() => fake.exit(17, null));
      }
    });

    await expect(runCodexAppServerTurn(options(fake))).rejects.toThrow("stopped (17)");
  });
});

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  messages: Record<string, any>[] = [];
  spawn: { command: string; args: readonly string[] } | undefined;
  spawnOptions: Parameters<CodexAppServerSpawn>[2] | undefined;
  private buffer = "";

  constructor(private readonly onMessage: (message: Record<string, any>) => void) {
    super();
    this.stdin.on("data", (chunk) => {
      this.buffer += chunk.toString();
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const message = JSON.parse(line) as Record<string, any>;
        this.messages.push(message);
        this.onMessage(message);
      }
    });
  }

  readonly spawnProcess: CodexAppServerSpawn = (command, args, spawnOptions) => {
    this.spawn = { command, args };
    this.spawnOptions = spawnOptions;
    return this as unknown as ChildProcessWithoutNullStreams;
  };

  respond(id: unknown, result: unknown): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id, result })}\n`));
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  serverRequest(id: string | number, method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function options(fake: FakeCodexProcess, overrides: Partial<CodexAppServerTurnOptions> = {}): CodexAppServerTurnOptions {
  return {
    codexPathOverride: process.execPath,
    environment: { PATH: process.env.PATH ?? "" },
    threadParams: { cwd: "/workspace" },
    turnParams: { cwd: "/workspace" },
    prompt: "Build the graph",
    approvals: { request: async () => { throw new Error("unexpected approval"); } },
    workingDirectory: "/workspace",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/workspace"], networkAccess: true },
    onThreadId: () => undefined,
    spawnProcess: fake.spawnProcess,
    killProcessGroup: (_pid, signal): true => {
      fake.kill(signal as NodeJS.Signals | undefined);
      return true;
    },
    ...overrides,
  };
}

function handshake(fake: FakeCodexProcess, message: Record<string, any>): void {
  if (message.method === "initialize") fake.respond(message.id, {});
  if (message.method === "thread/start") fake.respond(message.id, { thread: { id: "thread-new" } });
}

function sendCommandApproval(fake: FakeCodexProcess, providerRequestId: string, itemId: string, command: string): void {
  fake.notify("item/started", {
    threadId: "thread-new",
    turnId: "turn-1",
    item: { type: "commandExecution", id: itemId, command, cwd: "/workspace", source: "agent" },
  });
  fake.serverRequest(providerRequestId, "item/commandExecution/requestApproval", {
    threadId: "thread-new",
    turnId: "turn-1",
    itemId,
    environmentId: "local",
    command,
    cwd: "/workspace",
  });
}

function completeTurn(fake: FakeCodexProcess): void {
  fake.notify("turn/completed", {
    threadId: "thread-new",
    turn: { id: "turn-1", status: "completed", error: null },
  });
}
