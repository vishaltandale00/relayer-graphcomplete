import { Codex, type ApprovalMode, type CodexOptions, type ModelReasoningEffort, type SandboxMode, type ThreadOptions, type WebSearchMode } from "@openai/codex-sdk";
import { RELAYER_ICON_NAMES, type GraphCapability, type GraphNode } from "@relayer/graph-client";
import type { Harness, HarnessFactory, HarnessFactoryContext, HarnessRunContext, HarnessSessionState, JsonObject } from "../types.js";

export const CODEX_BASIC_KEY = "codex.basic";

type CodexThread = ReturnType<Codex["startThread"]>;

export interface CodexBasicDependencies {
  readonly createCodex?: (environment: Record<string, string>, codexPathOverride: string | undefined, config: CodexConfiguration) => Codex;
  readonly clientModuleUrl?: string;
  readonly codexPathOverride?: string;
}

interface CodexBasicConfiguration {
  readonly model?: string;
  readonly modelReasoningEffort?: ModelReasoningEffort;
  readonly sandboxMode?: SandboxMode;
  readonly approvalPolicy?: ApprovalMode;
  readonly networkAccessEnabled?: boolean;
  readonly webSearchMode?: WebSearchMode;
  readonly skipGitRepoCheck?: boolean;
  readonly additionalDirectories?: readonly string[];
}

type CodexConfiguration = NonNullable<CodexOptions["config"]>;

interface ResolvedCodexConfiguration {
  readonly threadOptions: CodexBasicConfiguration;
  readonly codexConfig: CodexConfiguration;
}

export class CodexBasicHarness implements Harness {
  private readonly clientModuleUrl: string;
  private readonly threadOptions: CodexBasicConfiguration;
  private readonly codexConfig: CodexConfiguration;
  private codexThreadId: string | undefined;

  constructor(private readonly context: HarnessFactoryContext, private readonly dependencies: CodexBasicDependencies = {}) {
    const resolved = parseCodexBasicConfiguration(context);
    this.threadOptions = resolved.threadOptions;
    this.codexConfig = resolved.codexConfig;
    this.clientModuleUrl = dependencies.clientModuleUrl ?? import.meta.resolve("@relayer/graph-client");
    const codexThreadId = context.savedState?.codexThreadId;
    this.codexThreadId = typeof codexThreadId === "string" ? codexThreadId : undefined;
  }

  async complete(context: HarnessRunContext, signal?: AbortSignal): Promise<void> {
    const model = this.selectedModel(context);
    const capability = context.graph.acquireCapability();
    const thread = this.openThread(this.createCodex(capability), model);
    try {
      await thread.run(this.prompt(context.inputGraph), signal === undefined ? {} : { signal });
    } finally {
      this.codexThreadId = thread.id ?? this.codexThreadId;
    }
  }

  state(): HarnessSessionState {
    return this.codexThreadId === undefined ? {} : { codexThreadId: this.codexThreadId };
  }

  private createCodex(graph: GraphCapability): Codex {
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    environment.RELAYER_GRAPH_URL = graph.url;
    environment.RELAYER_GRAPH_TOKEN = graph.token;
    environment.RELAYER_NODE_ID = String(graph.nodeId);
    return this.dependencies.createCodex?.(environment, this.dependencies.codexPathOverride, this.codexConfig) ?? new Codex({
      env: environment,
      config: this.codexConfig,
      ...(this.dependencies.codexPathOverride === undefined ? {} : {
        codexPathOverride: this.dependencies.codexPathOverride,
      }),
    });
  }

  private selectedModel(context: HarnessRunContext): string | undefined {
    if (context.model === undefined) return this.threadOptions.model;
    if (context.model.providerId !== "codex") {
      throw new Error(`codex.basic cannot run provider ${context.model.providerId}`);
    }
    return context.model.modelId;
  }

  private openThread(codex: Codex, model: string | undefined): CodexThread {
    const { additionalDirectories, ...configuredOptions } = this.threadOptions;
    const options: ThreadOptions = {
      workingDirectory: this.context.workingDirectory,
      ...configuredOptions,
      ...(model === undefined ? {} : { model }),
      ...(additionalDirectories === undefined ? {} : { additionalDirectories: [...additionalDirectories] }),
    };
    return this.codexThreadId === undefined ? codex.startThread(options) : codex.resumeThread(this.codexThreadId, options);
  }

  private prompt(interactionNode: GraphNode): string {
    return `You are the basic Relayer graph harness. Answer the current user interaction by authoring and accepting a useful graph layer.

Current interaction node: ${interactionNode.id}
User text: ${interactionNode.detail}

Use executable JavaScript and the Relayer graph client. Do not return a JSON graph in chat. Write a small .mjs file in the system temporary directory, not in the project checkout, and run it with Node.js. Import from:
${this.clientModuleUrl}

The module exports RelayerGraphClient, NodeObject, EdgeObject, and LayerObject. Use RelayerGraphClient.fromEnv(). The required order is:
1. create NodeObject values with icon, title, and useful markdown detail;
2. await graph.submitNode(node) for each node;
3. await graph.createEdge(leftNode, rightNode) for each visible undirected connection;
4. create and await graph.submitLayer(new LayerObject(nodes, edges));
5. await graph.addAction(${interactionNode.id}, { kind: "navigate", label: "Response", target: layer, response: true });
6. await graph.submit(${interactionNode.id}).

The visible layer must contain 1 to 8 nodes and must be connected. Layer edges are exactly what the user sees.

Every node icon, and every optional action icon, must use exactly one supported Relayer icon name. Unsupported names are rejected so that you can repair the object. Choose the closest semantic name from:
${RELAYER_ICON_NAMES.join(", ")}

Relayer graph affordances:
- A node can be a complete explanation in the current layer.
- A node can open a more detailed child layer. Submit the child LayerObject, then attach it with await graph.addAction(node, { kind: "navigate", label: "Useful label", target: childLayer, variant: "pill" }).
- A node can offer a useful follow-up interaction with await graph.addAction(node, { kind: "invoke", label: "Useful label", interactionText: "A useful follow-up", variant: "chip" }).

Every action uses Relayer's renderer-independent presentation grammar. You author its order, kind and payload, label, optional supported icon, and one of these variants:
- "chip": the most compact inline action;
- "pill": the standard rounded action and the default when variant is omitted;
- "wide": a full-width action for a prominent next step;
- "card": a full-width action with both label and a required supporting description, for example { variant: "card", label: "Compare approaches", description: "Lay out the tradeoffs before choosing.", icon: "git-compare" }.

Choose variants with the available inspector space in mind: chips and pills suit several concise choices, while wide actions and cards consume more vertical space. This footprint guidance is advisory, not a limit. You may freely mix variants, author multiple cards, and let a useful action list scroll. Do not author HTML, CSS, colors, dimensions, or style fields. Description is supported only by card actions.

Navigate and invoke actions are first-class options, not requirements for every node. Use them where they materially improve the answer, and submit every referenced node, edge, and layer before adding its action.

If a graph call rejects an object, read its error message, repair only that object, and retry. The graph is complete only after graph.submit succeeds.`;
  }
}

function parseCodexBasicConfiguration(context: HarnessFactoryContext): ResolvedCodexConfiguration {
  const selected = context.configuration;
  if (selected.implementation !== CODEX_BASIC_KEY) {
    throw new Error(`codex.basic cannot run implementation ${selected.implementation}`);
  }
  if (selected.implementationVersion !== 1) {
    throw new Error(`Unsupported codex.basic implementation version: ${selected.implementationVersion}`);
  }
  const configuration = selected.settings;
  const allowed = new Set(["model", "modelReasoningEffort", "webSearchMode", "skipGitRepoCheck", "additionalDirectories"]);
  const unknown = Object.keys(configuration).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown codex.basic configuration field: ${unknown.join(", ")}`);

  const model = optionalString(configuration.model, "model");
  const modelReasoningEffort = optionalEnum(configuration.modelReasoningEffort, ["minimal", "low", "medium", "high", "xhigh"] as const, "modelReasoningEffort");
  const webSearchMode = optionalEnum(configuration.webSearchMode, ["disabled", "cached", "live"] as const, "webSearchMode");
  const skipGitRepoCheck = optionalBoolean(configuration.skipGitRepoCheck, "skipGitRepoCheck");
  const additionalDirectories = optionalStringArray(configuration.additionalDirectories, "additionalDirectories");
  const permission = parseCodexPermissionBinding(context.permissionProfileId, context.permissionBinding);

  return {
    threadOptions: {
      ...(model === undefined ? {} : { model }),
      ...(modelReasoningEffort === undefined ? {} : { modelReasoningEffort }),
      sandboxMode: permission.sandboxMode,
      approvalPolicy: permission.approvalPolicy,
      ...(permission.networkAccessEnabled === undefined ? {} : { networkAccessEnabled: permission.networkAccessEnabled }),
      ...(webSearchMode === undefined ? {} : { webSearchMode }),
      ...(skipGitRepoCheck === undefined ? {} : { skipGitRepoCheck }),
      ...(additionalDirectories === undefined ? {} : { additionalDirectories }),
    },
    codexConfig: permission.approvalsReviewer === undefined ? {} : { approvals_reviewer: permission.approvalsReviewer },
  };
}

function parseCodexPermissionBinding(profileId: string, binding: JsonObject): {
  readonly sandboxMode: SandboxMode;
  readonly approvalPolicy: ApprovalMode;
  readonly approvalsReviewer?: "user" | "auto_review";
  readonly networkAccessEnabled?: boolean;
} {
  const allowed = new Set(["sandboxMode", "approvalPolicy", "approvalsReviewer", "networkAccessEnabled"]);
  const unknown = Object.keys(binding).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown codex.basic permission binding field: ${unknown.join(", ")}`);
  const sandboxMode = optionalEnum(binding.sandboxMode, ["read-only", "workspace-write", "danger-full-access"] as const, "permission sandboxMode");
  const approvalPolicy = optionalEnum(binding.approvalPolicy, ["never", "on-request", "on-failure", "untrusted"] as const, "permission approvalPolicy");
  const approvalsReviewer = optionalEnum(binding.approvalsReviewer, ["user", "auto_review"] as const, "permission approvalsReviewer");
  const networkAccessEnabled = optionalBoolean(binding.networkAccessEnabled, "permission networkAccessEnabled");
  const expected = profileId === "ask"
    ? { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user" } as const
    : profileId === "auto"
      ? { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review" } as const
      : profileId === "full"
        ? { sandboxMode: "danger-full-access", approvalPolicy: "never" } as const
        : undefined;
  if (expected === undefined) throw new Error(`codex.basic does not support permission profile ${profileId}`);
  if (sandboxMode !== expected.sandboxMode || approvalPolicy !== expected.approvalPolicy) {
    throw new Error(`codex.basic permission binding ${profileId} does not match the product profile contract`);
  }
  if (profileId === "full") {
    if (approvalsReviewer !== undefined) throw new Error("codex.basic full permission binding must not configure an approvals reviewer");
    if (networkAccessEnabled !== undefined) throw new Error("codex.basic full permission binding must not claim sandbox network control");
    return { sandboxMode, approvalPolicy };
  }
  const expectedReviewer = profileId === "ask" ? "user" : "auto_review";
  if (approvalsReviewer !== expectedReviewer || networkAccessEnabled === undefined) {
    throw new Error(`codex.basic permission binding ${profileId} does not match the product profile contract`);
  }
  return { sandboxMode, approvalPolicy, approvalsReviewer, networkAccessEnabled };
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`codex.basic ${field} must be a non-empty string`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`codex.basic ${field} must be a boolean`);
  return value;
}

function optionalEnum<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`codex.basic ${field} must be one of: ${allowed.join(", ")}`);
  return value as T[number];
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`codex.basic ${field} must be an array of non-empty strings`);
  }
  return value;
}

export function createCodexBasicFactory(dependencies: CodexBasicDependencies = {}): HarnessFactory {
  return (context) => new CodexBasicHarness(context, dependencies);
}
