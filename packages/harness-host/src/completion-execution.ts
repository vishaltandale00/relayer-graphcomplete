import { createHash } from "node:crypto";
import type { GraphCapability, GraphId, ResolvedLayer } from "@relayer/graph-client";
import type { CompletionOrigin, JsonObject } from "./types.js";

export type { CompletionOrigin } from "./types.js";

export interface CompletionBinding {
  readonly completionId: GraphId;
  readonly inputGraph: CompletionInputGraph;
  readonly capability: GraphCapability;
  readonly origin: CompletionOrigin;
}

export interface CompletionInputGraph {
  readonly interactionNode: GraphId;
}

export interface CompletionCurrentSnapshot {
  readonly completionId: GraphId;
  readonly lifecycle: "active" | "succeeded" | "stopped" | "failed";
  readonly revision: number;
  readonly currentLayerId: GraphId | null;
  readonly finalLayerId: GraphId | null;
  readonly safeReason?: string;
}

export type CompletionLifecycleObservation =
  | {
      readonly completionId: GraphId;
      readonly lifecycle: "succeeded";
      readonly revision: number;
      readonly currentLayerId: GraphId;
      readonly finalLayer: ResolvedLayer;
    }
  | {
      readonly completionId: GraphId;
      readonly lifecycle: "stopped" | "failed";
      readonly revision: number;
      readonly currentLayerId: GraphId | null;
      readonly reason: string;
    };

export interface CompletionPreparation {
  /** Resolve one previously prepared canonical interaction pointer. */
  prepare(inputGraph: CompletionInputGraph): CompletionBinding;
  /** Read the durable current pointer for this exact completion. */
  current(binding: CompletionBinding): Promise<CompletionCurrentSnapshot>;
  /** Observe GraphComplete terminal state independently from provider settlement. */
  observe(binding: CompletionBinding): Promise<CompletionLifecycleObservation>;
  /** Trusted, binding-scoped failure. It may fail only this exact completion. */
  fail(binding: CompletionBinding, reason: "provider_exited_without_return"): void | Promise<void>;
}

export interface NativeCompletionExecution {
  readonly status: "exited" | "cancelled" | "failed";
  readonly effectBoundary: "none" | "partial_output" | "graph_write" | "tool_effect" | "unknown";
  readonly safeReason?: string;
}

export interface NativeExecutionHandle extends PromiseLike<void> {
  /** Resolves after the adapter has durably attached its exact native identity. */
  readonly attached?: Promise<JsonObject>;
  readonly settled: Promise<NativeCompletionExecution>;
  stopSelf?(reason: string): void | Promise<void>;
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<void | TResult>;
  finally(onfinally?: (() => void) | null): Promise<void>;
}

export function nativeExecutionHandle(
  execution: Promise<void>,
  stopSelf?: (reason: string) => void | Promise<void>,
  attached?: Promise<JsonObject>,
): NativeExecutionHandle {
  // Attachment has independent settlement from provider execution. Install a
  // rejection observer so callers that only await the execution do not create
  // an unhandled rejection; callers still receive the original rejecting
  // promise when they inspect native identity explicitly.
  void attached?.catch(() => undefined);
  const settled: Promise<NativeCompletionExecution> = execution.then(
    (): NativeCompletionExecution => ({ status: "exited", effectBoundary: "none" }),
    (): NativeCompletionExecution => ({ status: "failed", effectBoundary: "unknown" }),
  );
  return Object.freeze({
    ...(attached === undefined ? {} : { attached }),
    settled,
    ...(stopSelf === undefined ? {} : { stopSelf }),
    then: execution.then.bind(execution),
    catch: execution.catch.bind(execution),
    finally: execution.finally.bind(execution),
  });
}

export interface CompletionExecutionAdapter {
  complete(binding: CompletionBinding): NativeExecutionHandle;
}

export interface CompletionCurrent {
  snapshot(): Promise<CompletionCurrentSnapshot>;
}

export interface CompletionHandle {
  readonly completionId: GraphId;
  readonly current: CompletionCurrent;
  /** Resolves only for GraphComplete success; stop/failure rejects with retained current. */
  readonly result: Promise<ResolvedLayer>;
}

export class CompletionTerminalError extends Error {
  constructor(
    readonly completionId: GraphId,
    readonly lifecycle: "stopped" | "failed",
    readonly current: CompletionCurrentSnapshot,
    readonly reason: string,
  ) {
    super(`Completion ${completionId} ${lifecycle}: ${reason}`);
    this.name = "CompletionTerminalError";
  }
}

/**
 * Separates durable GraphComplete result settlement from provider settlement.
 * The module deliberately owns no recursive queue, retry timer, parent callback,
 * or incorporation policy; provider adapters retain their native execution rules.
 */
export class CompletionExecutionModule {
  private readonly handles = new Map<GraphId, {
    readonly bindingDigest: string;
    readonly handle: CompletionHandle;
  }>();

  constructor(
    private readonly preparation: CompletionPreparation,
    private readonly adapter: CompletionExecutionAdapter,
  ) {}

  complete(inputGraph: CompletionInputGraph): CompletionHandle {
    const binding = this.preparation.prepare(inputGraph);
    const bindingDigest = completionBindingDigest(binding);
    const existing = this.handles.get(binding.completionId);
    if (existing !== undefined) {
      if (existing.bindingDigest !== bindingDigest) {
        throw new Error("Completion is already active under a different completion binding");
      }
      return existing.handle;
    }

    const current: CompletionCurrent = Object.freeze({
      snapshot: () => this.preparation.current(binding),
    });
    let native: NativeExecutionHandle;
    try {
      native = this.adapter.complete(binding);
    } catch (error) {
      native = nativeExecutionHandle(Promise.reject(error));
    }
    const result = this.preparation.observe(binding).then(async (terminal) => {
      if (terminal.lifecycle === "succeeded") return terminal.finalLayer;
      const retained = await this.preparation.current(binding);
      throw new CompletionTerminalError(
        terminal.completionId,
        terminal.lifecycle,
        retained,
        terminal.reason,
      );
    });

    void native.settled.then(async () => {
      const durable = await this.preparation.current(binding);
      if (durable.lifecycle === "active") {
        await this.preparation.fail(binding, "provider_exited_without_return");
      }
    }).catch(() => {});

    const handle = Object.freeze({ completionId: binding.completionId, current, result });
    this.handles.set(binding.completionId, { bindingDigest, handle });
    return handle;
  }
}

function completionBindingDigest(binding: CompletionBinding): string {
  return createHash("sha256").update(JSON.stringify({
    completionId: binding.completionId,
    inputGraph: binding.inputGraph,
    origin: binding.origin,
  })).digest("hex");
}
