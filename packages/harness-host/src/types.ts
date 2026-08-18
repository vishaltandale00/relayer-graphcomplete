import type { CompletionOutput, GraphCapability, GraphNode } from "@relayer/graph-client";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface HarnessSessionState {
  readonly schemaVersion: number;
  readonly values: Readonly<Record<string, JsonValue>>;
}

export interface Harness {
  complete(interactionNode: GraphNode, signal?: AbortSignal): Promise<CompletionOutput>;
  setGraphCapability(graph: GraphCapability): void | Promise<void>;
  state(): HarnessSessionState;
  dispose?(): void | Promise<void>;
}

export interface HarnessFactoryContext {
  readonly threadId: number;
  readonly workingDirectory: string;
  readonly graph: GraphCapability;
  readonly savedState?: HarnessSessionState;
}

export type HarnessFactory = (context: HarnessFactoryContext) => Harness | Promise<Harness>;
export type HarnessMap = Readonly<Record<string, HarnessFactory>>;

export interface HarnessSessionDescriptor {
  readonly threadId: number;
  readonly harnessKey: string;
  readonly workingDirectory: string;
  readonly graph: GraphCapability;
  readonly state?: HarnessSessionState;
}

export type HarnessSessionRegistration = Omit<HarnessSessionDescriptor, "state">;

export interface HarnessCompleteResult {
  readonly threadId: number;
  readonly harnessKey: string;
  readonly output: CompletionOutput;
}
