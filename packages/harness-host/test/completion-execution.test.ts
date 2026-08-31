import { describe, expect, test, vi } from "vitest";
import type { ResolvedLayer } from "@relayer/graph-client";
import {
  CompletionExecutionModule,
  type CompletionBinding,
  type CompletionCurrentSnapshot,
  type CompletionLifecycleObservation,
  type CompletionPreparation,
  type NativeCompletionExecution,
  type CompletionExecutionAdapter,
  type NativeExecutionHandle,
} from "../src/completion-execution.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nativeHandle(settled: Promise<NativeCompletionExecution>): NativeExecutionHandle {
  const execution = settled.then(() => {});
  return {
    settled,
    then: execution.then.bind(execution),
    catch: execution.catch.bind(execution),
    finally: execution.finally.bind(execution),
  };
}

function inputGraph(completionId: number) {
  return { interactionNode: completionId };
}

function layer(id: number): ResolvedLayer {
  return {
    layer: { id, nodes: [], edges: [], state: "accepted", layout: null },
    nodes: [],
    edges: [],
    actions: [],
  };
}

function binding(completionId: number, token = `token-${completionId}`): CompletionBinding {
  return {
    completionId,
    inputGraph: inputGraph(completionId),
    capability: { url: "http://127.0.0.1:43123", token, nodeId: completionId },
    origin: { kind: "invoke", sourceCompletionId: 1, actionId: completionId + 100 },
  };
}

describe("CompletionExecutionModule", () => {
  test("returns one live handle whose result follows GraphComplete rather than provider settlement", async () => {
    const semantic = deferred<CompletionLifecycleObservation>();
    const native = deferred<NativeCompletionExecution>();
    let lifecycle: "active" | "succeeded" = "active";
    const preparation: CompletionPreparation = {
      prepare: vi.fn(() => binding(2)),
      current: vi.fn(async (): Promise<CompletionCurrentSnapshot> => ({
        completionId: 2,
        lifecycle,
        revision: lifecycle === "active" ? 0 : 1,
        currentLayerId: lifecycle === "active" ? null : 20,
        finalLayerId: lifecycle === "active" ? null : 20,
      })),
      observe: vi.fn(() => semantic.promise),
      fail: vi.fn(async () => {}),
    };
    const adapter: CompletionExecutionAdapter = {
      complete: vi.fn(() => nativeHandle(native.promise)),
    };
    const module = new CompletionExecutionModule(preparation, adapter);

    const handle = module.complete(inputGraph(2));

    expect(handle.completionId).toBe(2);
    await expect(handle.current.snapshot()).resolves.toMatchObject({
      completionId: 2,
      lifecycle: "active",
      revision: 0,
    });

    lifecycle = "succeeded";
    semantic.resolve({
      completionId: 2,
      lifecycle: "succeeded",
      revision: 1,
      currentLayerId: 20,
      finalLayer: layer(20),
    });

    await expect(handle.result).resolves.toMatchObject({ layer: { id: 20 } });
    expect(await Promise.race([native.promise.then(() => "settled"), Promise.resolve("still-running")]))
      .toBe("still-running");

    native.resolve({ status: "exited", effectBoundary: "none" });
    await expect(native.promise).resolves.toMatchObject({ status: "exited" });
    expect(preparation.fail).not.toHaveBeenCalled();
  });

  test("keeps concurrent semantic calls independent and fails only an active completion on provider exit", async () => {
    const observations = new Map<number, ReturnType<typeof deferred<CompletionLifecycleObservation>>>();
    const nativeSettlements = new Map<number, ReturnType<typeof deferred<NativeCompletionExecution>>>();
    const states = new Map<number, "active" | "failed">();
    const preparation: CompletionPreparation = {
      prepare: vi.fn((input) => {
        observations.set(input.interactionNode, deferred());
        states.set(input.interactionNode, "active");
        return binding(input.interactionNode);
      }),
      current: vi.fn(async (prepared) => ({
        completionId: prepared.completionId,
        lifecycle: states.get(prepared.completionId) ?? "active",
        revision: states.get(prepared.completionId) === "failed" ? 1 : 0,
        currentLayerId: null,
        finalLayerId: null,
      })),
      observe: vi.fn((prepared) => observations.get(prepared.completionId)!.promise),
      fail: vi.fn(async (prepared) => {
        states.set(prepared.completionId, "failed");
        observations.get(prepared.completionId)!.resolve({
          completionId: prepared.completionId,
          lifecycle: "failed",
          revision: 1,
          currentLayerId: null,
          reason: "provider_exited_without_return",
        });
      }),
    };
    const adapter: CompletionExecutionAdapter = {
      complete: vi.fn((prepared) => {
        const settled = deferred<NativeCompletionExecution>();
        nativeSettlements.set(prepared.completionId, settled);
        return nativeHandle(settled.promise);
      }),
    };
    const module = new CompletionExecutionModule(preparation, adapter);

    const first = module.complete(inputGraph(2));
    const second = module.complete(inputGraph(3));

    nativeSettlements.get(first.completionId)!.resolve({ status: "failed", effectBoundary: "unknown" });

    await expect(first.result).rejects.toMatchObject({ lifecycle: "failed", completionId: first.completionId });
    await expect(second.current.snapshot()).resolves.toMatchObject({ lifecycle: "active", revision: 0 });
    expect(preparation.fail).toHaveBeenCalledTimes(1);
    expect(preparation.fail).toHaveBeenCalledWith(
      expect.objectContaining({ completionId: first.completionId }),
      "provider_exited_without_return",
    );
  });

  test("recovers an exact prepared identity as the same handle without starting provider execution twice", () => {
    const terminal = deferred<CompletionLifecycleObservation>();
    const preparation: CompletionPreparation = {
      prepare: vi.fn(() => binding(2)),
      current: vi.fn(async (): Promise<CompletionCurrentSnapshot> => ({
        completionId: 2,
        lifecycle: "active",
        revision: 0,
        currentLayerId: null,
        finalLayerId: null,
      })),
      observe: vi.fn(() => terminal.promise),
      fail: vi.fn(async () => {}),
    };
    const adapter: CompletionExecutionAdapter = {
      complete: vi.fn(() => nativeHandle(new Promise<NativeCompletionExecution>(() => {}))),
    };
    const module = new CompletionExecutionModule(preparation, adapter);

    const first = module.complete(inputGraph(2));
    const recovered = module.complete(inputGraph(2));

    expect(recovered).toBe(first);
    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(preparation.observe).toHaveBeenCalledTimes(1);
  });

  test("recovers one durable completion identity after its ephemeral capability rotates", () => {
    const terminal = deferred<CompletionLifecycleObservation>();
    let preparations = 0;
    const preparation: CompletionPreparation = {
      prepare: vi.fn(() => binding(2, preparations++ === 0 ? "first-token" : "foreign-token")),
      current: vi.fn(async (): Promise<CompletionCurrentSnapshot> => ({
        completionId: 2,
        lifecycle: "active",
        revision: 0,
        currentLayerId: null,
        finalLayerId: null,
      })),
      observe: vi.fn(() => terminal.promise),
      fail: vi.fn(async () => {}),
    };
    const adapter: CompletionExecutionAdapter = {
      complete: vi.fn(() => nativeHandle(new Promise<NativeCompletionExecution>(() => {}))),
    };
    const module = new CompletionExecutionModule(preparation, adapter);

    const first = module.complete(inputGraph(2));

    expect(module.complete(inputGraph(2))).toBe(first);
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });

  test("rejects recovery through different durable invocation provenance", () => {
    const terminal = deferred<CompletionLifecycleObservation>();
    let preparations = 0;
    const preparation: CompletionPreparation = {
      prepare: vi.fn(() => ({
        ...binding(2),
        origin: preparations++ === 0
          ? { kind: "invoke" as const, sourceCompletionId: 1, actionId: 102 }
          : { kind: "invoke" as const, sourceCompletionId: 1, actionId: 103 },
      })),
      current: vi.fn(async (): Promise<CompletionCurrentSnapshot> => ({
        completionId: 2,
        lifecycle: "active",
        revision: 0,
        currentLayerId: null,
        finalLayerId: null,
      })),
      observe: vi.fn(() => terminal.promise),
      fail: vi.fn(async () => {}),
    };
    const adapter: CompletionExecutionAdapter = {
      complete: vi.fn(() => nativeHandle(new Promise<NativeCompletionExecution>(() => {}))),
    };
    const module = new CompletionExecutionModule(preparation, adapter);

    module.complete(inputGraph(2));

    expect(() => module.complete(inputGraph(2))).toThrow("different completion binding");
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });

  test("recovers equivalent capabilities independently of object property insertion order", () => {
    const terminal = deferred<CompletionLifecycleObservation>();
    let preparations = 0;
    const preparation: CompletionPreparation = {
      prepare: vi.fn(() => {
        const prepared = binding(2);
        if (preparations++ === 0) return prepared;
        return {
          ...prepared,
          capability: {
            nodeId: prepared.capability.nodeId,
            token: prepared.capability.token,
            url: prepared.capability.url,
          },
        };
      }),
      current: vi.fn(async (): Promise<CompletionCurrentSnapshot> => ({
        completionId: 2,
        lifecycle: "active",
        revision: 0,
        currentLayerId: null,
        finalLayerId: null,
      })),
      observe: vi.fn(() => terminal.promise),
      fail: vi.fn(async () => {}),
    };
    const adapter: CompletionExecutionAdapter = {
      complete: vi.fn(() => nativeHandle(new Promise<NativeCompletionExecution>(() => {}))),
    };
    const module = new CompletionExecutionModule(preparation, adapter);

    const first = module.complete(inputGraph(2));
    expect(module.complete(inputGraph(2))).toBe(first);
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });

  test("returns a handle and fails only that completion when native launch throws", async () => {
    const terminal = deferred<CompletionLifecycleObservation>();
    let state: "active" | "failed" = "active";
    const preparation: CompletionPreparation = {
      prepare: vi.fn(() => binding(2)),
      current: vi.fn(async (): Promise<CompletionCurrentSnapshot> => ({
        completionId: 2,
        lifecycle: state,
        revision: state === "active" ? 0 : 1,
        currentLayerId: null,
        finalLayerId: null,
        ...(state === "failed" ? { safeReason: "provider_exited_without_return" } : {}),
      })),
      observe: vi.fn(() => terminal.promise),
      fail: vi.fn(async (prepared) => {
        state = "failed";
        terminal.resolve({
          completionId: prepared.completionId,
          lifecycle: "failed",
          revision: 1,
          currentLayerId: null,
          reason: "provider_exited_without_return",
        });
      }),
    };
    const module = new CompletionExecutionModule(preparation, {
      complete: () => { throw new Error("launch failed"); },
    });

    const handle = module.complete(inputGraph(2));

    expect(handle.completionId).toBe(2);
    await expect(handle.result).rejects.toMatchObject({
      name: "CompletionTerminalError",
      completionId: 2,
      lifecycle: "failed",
      current: { lifecycle: "failed", revision: 1 },
    });
  });

  test("rejects the result when native-settlement reconciliation cannot read durable state", async () => {
    const terminal = deferred<CompletionLifecycleObservation>();
    const native = deferred<NativeCompletionExecution>();
    const reconciliationError = new Error("durable current unavailable");
    const preparation: CompletionPreparation = {
      prepare: vi.fn(() => binding(2)),
      current: vi.fn(async () => { throw reconciliationError; }),
      observe: vi.fn(() => terminal.promise),
      fail: vi.fn(async () => {}),
    };
    const module = new CompletionExecutionModule(preparation, {
      complete: () => nativeHandle(native.promise),
    });

    const handle = module.complete(inputGraph(2));
    native.resolve({ status: "failed", effectBoundary: "unknown" });

    await expect(handle.result).rejects.toBe(reconciliationError);
    expect(preparation.fail).not.toHaveBeenCalled();
  });
});
