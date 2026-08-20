import type { CompletionOutput, GraphCapability, GraphId, GraphNode } from "@relayer/graph-client";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;

export interface HarnessModelCompatibility {
  readonly providerId: string;
  /** Omitted means every model reported by this provider. */
  readonly modelIds?: readonly string[];
  readonly preferredModelId?: string;
}

export interface HarnessConfiguration {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly implementation: string;
  readonly implementationVersion: number;
  readonly permissionBindings: Readonly<Record<string, JsonObject>>;
  readonly modelCompatibility?: readonly HarnessModelCompatibility[];
  readonly settings: JsonObject;
}

export type HarnessSessionState = JsonObject;

export interface HarnessGraphScope {
  readonly interactionNodeId: GraphId;
  acquireCapability(): GraphCapability;
}

export interface HarnessRunContext {
  readonly inputGraph: GraphNode;
  readonly graph: HarnessGraphScope;
  readonly model?: InteractionModelSelection;
}

export interface InteractionModelSelection {
  readonly providerId: string;
  readonly modelId: string;
}

export interface Harness {
  complete(context: HarnessRunContext, signal?: AbortSignal): Promise<void>;
  state(): HarnessSessionState;
  dispose?(): void | Promise<void>;
}

export interface HarnessFactoryContext {
  readonly threadId: number;
  readonly workingDirectory: string;
  readonly configuration: HarnessConfiguration;
  readonly permissionProfileId: string;
  readonly permissionBinding: JsonObject;
  readonly savedState?: HarnessSessionState;
}

export type HarnessFactory = (context: HarnessFactoryContext) => Harness | Promise<Harness>;
export type HarnessImplementationMap = Readonly<Record<string, HarnessFactory>>;

export interface HarnessSessionDescriptor {
  readonly threadId: number;
  readonly configuration: HarnessConfiguration;
  readonly permissionProfileId: string;
  readonly workingDirectory: string;
  readonly state?: HarnessSessionState;
}

export type HarnessSessionRegistration = Omit<HarnessSessionDescriptor, "state">;

export interface HarnessCompleteResult {
  readonly threadId: number;
  readonly configurationName: string;
  readonly output: CompletionOutput;
}
