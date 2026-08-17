import type { CompletionOutput, GraphCapability, GraphNode } from "@relayer/graph-client";

export interface HarnessSessionState {
  readonly codexThreadId?: string;
}

export interface Harness {
  complete(interactionNode: GraphNode, signal?: AbortSignal): Promise<CompletionOutput>;
  setGraphCapability(graph: GraphCapability): void | Promise<void>;
  state(): HarnessSessionState;
}

export interface HarnessFactoryContext {
  readonly threadId: number;
  readonly workingDirectory: string;
  readonly graph: GraphCapability;
  readonly savedState?: HarnessSessionState;
}

export type HarnessFactory = (context: HarnessFactoryContext) => Harness;
export type HarnessMap = Readonly<Record<string, HarnessFactory>>;

export interface HarnessSessionDescriptor {
  readonly threadId: number;
  readonly harnessKey: string;
  readonly workingDirectory: string;
  readonly graph: GraphCapability;
  readonly state?: HarnessSessionState;
}

export interface HarnessCompleteResult {
  readonly threadId: number;
  readonly harnessKey: string;
  readonly output: CompletionOutput;
}
