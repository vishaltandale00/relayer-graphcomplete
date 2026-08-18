import type { CompletionOutput, GraphCapability, GraphNode } from "@relayer/graph-client";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;

export interface HarnessConfiguration {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly implementation: string;
  readonly implementationVersion: number;
  readonly settings: JsonObject;
}

export type HarnessSessionState = JsonObject;

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
  readonly configuration: HarnessConfiguration;
  readonly savedState?: HarnessSessionState;
}

export type HarnessFactory = (context: HarnessFactoryContext) => Harness | Promise<Harness>;
export type HarnessImplementationMap = Readonly<Record<string, HarnessFactory>>;

export interface HarnessSessionDescriptor {
  readonly threadId: number;
  readonly configuration: HarnessConfiguration;
  readonly workingDirectory: string;
  readonly graph: GraphCapability;
  readonly state?: HarnessSessionState;
}

export type HarnessSessionRegistration = Omit<HarnessSessionDescriptor, "state">;

export interface HarnessCompleteResult {
  readonly threadId: number;
  readonly configurationName: string;
  readonly output: CompletionOutput;
}
