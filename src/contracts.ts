export type NodeStatus = "draft" | "accepted" | "stopped";

export interface GraphNode {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly content: string;
  readonly status: NodeStatus;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface InputGraph {
  readonly version: 1;
  readonly rootNodeId: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelChoice {
  readonly model: string;
  readonly thinking?: ThinkingLevel;
}

export interface ModelPolicy {
  readonly orchestrator: ModelChoice;
  readonly contentOwner: ModelChoice;
  readonly reviewer: ModelChoice;
  readonly reviser: ModelChoice;
}

export interface CompletionBudget {
  readonly maxTokens?: number;
  readonly maxDurationMs?: number;
  readonly maxNodes?: number;
}

export interface CompletionPolicy {
  readonly models: ModelPolicy;
  readonly budget?: CompletionBudget;
  readonly minChildren: number;
  readonly maxChildren: number;
  readonly maxDepth?: number;
}

export type CompletionStopReason = "accepted" | "budget" | "cancelled" | "blocked" | "failed";

export interface CompletionResult {
  readonly graph: InputGraph;
  readonly reason: CompletionStopReason;
  readonly accepted: boolean;
  readonly diagnostics: readonly string[];
}

export interface CompletionRequest {
  readonly inputGraph: InputGraph;
  readonly policy: CompletionPolicy;
  readonly signal?: AbortSignal;
}

export interface GraphCompleteRuntime {
  run(request: CompletionRequest): Promise<CompletionResult>;
}

export interface CompleteOptions {
  readonly runtime: GraphCompleteRuntime;
  readonly policy: CompletionPolicy;
  readonly signal?: AbortSignal;
}

