import type { CompletionOutput } from "@relayer/graph-client";
import type { HarnessConfiguration } from "@relayer/harness-host";
import {
  graphMemorySearchBudget,
  graphMemorySearchQuery,
  graphMemorySearchTitle,
} from "../fixtures/graph-memory.js";

export const basicEvalCaseId = "empty-project.task-system.two-turn";
export const basicEvalPrompt = "A task system has an incoming queue, two workers, and a results store. Explain how a task moves through the system and what happens when both workers are busy.";
export const basicEvalFollowUpPrompt = "Follow up in the same thread: explain the task flow again, emphasizing what happens while both workers are busy and immediately after one worker finishes.";
export const graphMemoryEvalCaseId = "graph-memory.prior-accepted-reference";
export const AUTHORED_VISUAL_NODE_DETAILS_PREFERENCE = "Author a compiled visual Node Detail for every node you create; do not leave any authored node on plain Markdown alone. Import the exported html, css, and detailCapability helpers. At minimum, call node.detailAuthoring.setComponent(\"main\", html`<section><h2>Summary</h2><p>Details</p></section>`, css`section { display: grid; gap: 0.75rem; }`), await graph.checkpointNodeDetail(node), and then await graph.submitNode(node). When a node has actions, create each stable action object with its sourceLayer before checkpointing, bind that same object in the page with the matching detailCapability helper, and pass it to graph.addAction after submitting the layer. Keep every authored page self-contained, keyboard operable, and accessible. Mount every action belonging to the node inside its detail page.";
const graphMemoryPromptPair: readonly [string, string] = Object.freeze([
  `Explain when newly saved graph content becomes available to future requests. Include exactly one section titled ${graphMemorySearchTitle}.`,
  `Find your earlier ${graphMemorySearchTitle} explanation and link the original as supporting context in a concise follow-up. Do not recreate or paraphrase it.`,
]);

export function graphMemoryEvalPrompts(_testRunId?: string): readonly [string, string] {
  return graphMemoryPromptPair;
}

export function graphMemorySearchRequestMode(implementation: string): "exact" | "natural" {
  return implementation === "fixture.graph-memory" ? "exact" : "natural";
}
export function selectEvalPermissionProfile(configuration: HarnessConfiguration): string {
  const profiles = Object.keys(configuration.permissionBindings);
  if (profiles.includes("auto")) return "auto";
  if (profiles.length === 1) return profiles[0]!;
  throw new Error(`Eval cases need Auto or one unambiguous permission profile in ${configuration.name}.`);
}

export interface EvalCheck { readonly name: string; readonly passed: boolean; readonly detail: string }
export interface GraphMemoryAuditEvent {
  readonly sequence: number;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly recordKind?: "node" | "edge" | "layer" | "action";
  readonly recordId?: number;
  readonly recordState?: string;
  readonly errorCodes?: readonly string[];
  readonly completionNodeId?: number;
  readonly completionRootLayerId?: number;
  readonly searchLayerIds?: readonly number[];
  readonly resultTruncated?: boolean;
  readonly queryContractVersion?: number;
  readonly target?: Readonly<Record<string, unknown>>;
  readonly query?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly budget?: Readonly<Record<string, unknown>>;
  readonly actionKind?: string;
  readonly actionRelation?: string | null;
  readonly actionSourceNodeId?: number;
  readonly actionSourceLayerId?: number | null;
  readonly actionTargetLayerId?: number | null;
}

export interface GraphMemoryEvidence {
  readonly secondTurnStartSequence: number;
  readonly searchedLayerIds: readonly number[];
  readonly searchSequence?: number;
  readonly searchRequest?: {
    readonly queryContractVersion: number | undefined;
    readonly target?: Readonly<Record<string, unknown>>;
    readonly query: string | undefined;
    readonly parameters: Readonly<Record<string, unknown>> | undefined;
    readonly budget: Readonly<Record<string, unknown>> | undefined;
  };
  readonly draftDecoyLayerId?: number;
  readonly referenceActionId?: number;
  readonly referenceActionSequence?: number;
  readonly auditEvents: readonly GraphMemoryAuditEvent[];
}

export function checkBasicOutput(
  output: CompletionOutput,
  expectedInteractionNodeId = output.nodeId,
  options: { allowLegacyLayout?: boolean } = {},
): EvalCheck[] {
  const layer = output.rootLayer;
  const declaredNodeIds = layer.layer.nodes;
  const resolvedNodeIds = layer.nodes.map((node) => node.id);
  const declaredEdgeIds = layer.layer.edges;
  const resolvedEdgeIds = layer.edges.map((edge) => edge.id);
  const nodeIds = new Set(layer.nodes.map((node) => node.id));
  const layout = layer.layer.layout;
  const placements = layout?.placements ?? [];
  const placementIds = new Set(placements.map((placement) => placement.nodeId));
  const layoutComplete = layout?.version === 1
    && placements.length === nodeIds.size
    && placementIds.size === nodeIds.size
    && [...nodeIds].every((id) => placementIds.has(id))
    && placements.every(({ x, y }) => (
      Number.isFinite(x) && x >= 0 && x <= 1
      && Number.isFinite(y) && y >= 0 && y <= 1
    ));
  const adjacency = new Map(layer.nodes.map((node) => [node.id, new Set<number>()]));
  for (const edge of layer.edges) { adjacency.get(edge.endpoints[0])?.add(edge.endpoints[1]); adjacency.get(edge.endpoints[1])?.add(edge.endpoints[0]); }
  const visited = new Set<number>(); const pending = layer.nodes[0] === undefined ? [] : [layer.nodes[0].id];
  while (pending.length) { const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id); pending.push(...(adjacency.get(id) ?? [])); }
  return [
    { name: "interaction-output", passed: output.nodeId === expectedInteractionNodeId && output.rootAction.sourceNodeId === expectedInteractionNodeId, detail: "Completion output and response action belong to the requested interaction." },
    { name: "accepted-closure", passed: output.rootAction.state === "accepted" && layer.layer.state === "accepted" && layer.nodes.every((node) => node.state === "accepted") && layer.edges.every((edge) => edge.state === "accepted") && layer.actions.every((action) => action.state === "accepted"), detail: "The response action and complete visible closure are accepted." },
    { name: "resolved-membership", passed: arraysEqual(declaredNodeIds, resolvedNodeIds) && arraysEqual(declaredEdgeIds, resolvedEdgeIds), detail: "Resolved records exactly match the accepted layer references." },
    {
      name: "authored-layout",
      passed: layoutComplete || (options.allowLegacyLayout === true && layout == null),
      detail: layout == null && options.allowLegacyLayout === true
        ? "The accepted legacy layer has no authored layout and remains compatible."
        : "The accepted layer has one finite normalized v1 placement per visible node.",
    },
    { name: "response-action", passed: output.rootAction.kind === "navigate" && output.rootAction.relation === "expand" && output.rootAction.sourceLayerId == null && output.rootAction.targetLayerId === layer.layer.id, detail: "Interaction has one accepted root expansion action." },
    { name: "visible-layer", passed: layer.nodes.length >= 1 && layer.nodes.length <= 8 && layer.nodes.every((node) => node.icon.trim() && node.title.trim() && node.detail.trim()), detail: `${layer.nodes.length} complete visible nodes.` },
    { name: "exact-edges", passed: layer.edges.every((edge) => edge.endpoints[0] !== edge.endpoints[1] && nodeIds.has(edge.endpoints[0]) && nodeIds.has(edge.endpoints[1])), detail: `${layer.edges.length} visible undirected edges stay inside the layer.` },
    { name: "connected", passed: visited.size === layer.nodes.length, detail: `${visited.size}/${layer.nodes.length} nodes connected.` },
  ];
}

export function checkGraphMemoryFirstTurn(
  output: CompletionOutput,
  expectedInteractionNodeId = output.nodeId,
): EvalCheck[] {
  const matching = output.rootLayer.nodes.filter((node) => node.title === graphMemorySearchTitle);
  const graphHasNoMachineMarker = output.rootLayer.nodes.every((node) => (
    !node.title.includes("GRAPH_MEMORY_ANCHOR:")
    && !node.detail.includes("GRAPH_MEMORY_ANCHOR:")
  ));
  return [
    ...checkBasicOutput(output, expectedInteractionNodeId),
    {
      name: "natural-memory-search-target",
      passed: matching.length === 1 && graphHasNoMachineMarker,
      detail: `The first accepted root contains one human-readable ${graphMemorySearchTitle} search target and no machine marker in visible content.`,
    },
  ];
}

export function readGraphMemoryEvidence(
  firstOutput: CompletionOutput,
  secondOutput: CompletionOutput,
  auditEvents: readonly GraphMemoryAuditEvent[],
  secondTurnStartSequence: number,
): GraphMemoryEvidence {
  const firstSubmit = auditEvents.find((event) => (
    event.method === "POST"
    && event.path === "/api/graph/submit"
    && event.status >= 200
    && event.status < 300
    && event.completionNodeId === firstOutput.nodeId
  ));
  const search = auditEvents.find((event) => (
    event.method === "POST" && event.path === "/api/graph/search" && event.status >= 200 && event.status < 300
    && event.sequence > secondTurnStartSequence
  ));
  const searchedLayerIds = search?.searchLayerIds ?? [];
  const reference = auditEvents.find((event) => (
    event.method === "POST"
    && event.path === "/api/graph/actions"
    && event.status >= 200
    && event.status < 300
    && event.actionKind === "navigate"
    && event.actionRelation === "reference"
    && event.actionTargetLayerId === firstOutput.rootLayer.layer.id
    && event.actionSourceLayerId === secondOutput.rootLayer.layer.id
  ));
  const draftDecoy = search === undefined ? undefined : auditEvents.filter((event) => (
    event.method === "POST"
    && event.path === "/api/graph/layers"
    && event.status >= 200
    && event.status < 300
    && event.recordKind === "layer"
    && event.recordState === "draft"
    && event.recordId !== firstOutput.rootLayer.layer.id
    && (firstSubmit === undefined || event.sequence > firstSubmit.sequence)
    && event.sequence < search.sequence
  )).at(-1);
  return {
    secondTurnStartSequence,
    searchedLayerIds,
    ...(search === undefined ? {} : { searchSequence: search.sequence }),
    ...(search === undefined ? {} : {
      searchRequest: {
        queryContractVersion: search.queryContractVersion,
        ...(search.target === undefined ? {} : { target: structuredClone(search.target) }),
        query: search.query,
        parameters: structuredClone(search.parameters),
        budget: structuredClone(search.budget),
      },
    }),
    ...(draftDecoy?.recordId === undefined ? {} : { draftDecoyLayerId: draftDecoy.recordId }),
    ...(reference?.recordId === undefined ? {} : { referenceActionId: reference.recordId }),
    ...(reference === undefined ? {} : { referenceActionSequence: reference.sequence }),
    auditEvents: structuredClone(auditEvents),
  };
}

export function checkGraphMemorySecondTurn(
  output: CompletionOutput,
  firstOutput: CompletionOutput,
  evidence: GraphMemoryEvidence | undefined,
  expectedInteractionNodeId = output.nodeId,
  options: {
    readonly requireDraftDecoy?: boolean;
    readonly searchRequestMode?: "exact" | "natural";
  } = {},
): EvalCheck[] {
  const requireDraftDecoy = options.requireDraftDecoy === true;
  const searchRequestMode = options.searchRequestMode ?? "exact";
  const base = checkBasicOutput(output, expectedInteractionNodeId);
  if (evidence === undefined) {
    return [
      ...base,
      { name: "search-returned-prior-root", passed: false, detail: "No authoritative graph-search audit evidence was captured." },
      ...(requireDraftDecoy
        ? [{ name: "draft-decoy-hidden", passed: false, detail: "No same-topic draft-isolation evidence was captured." }]
        : []),
      { name: "typed-reference-target", passed: false, detail: "No searched prior-layer identity was available for the accepted reference." },
      { name: "ack-search-submit-order", passed: false, detail: "No audited acknowledgement/search/submission ordering was available." },
    ];
  }
  const priorLayerId = firstOutput.rootLayer.layer.id;
  const acceptedReference = output.rootLayer.actions.find((action) => (
    action.id === evidence.referenceActionId
    && action.state === "accepted"
    && action.kind === "navigate"
    && action.relation === "reference"
    && action.sourceLayerId === output.rootLayer.layer.id
    && action.targetLayerId === priorLayerId
    && output.rootLayer.nodes.some((node) => node.id === action.sourceNodeId)
  ));
  const firstSubmit = evidence.auditEvents.find((event) => (
    event.method === "POST"
    && event.path === "/api/graph/submit"
    && event.status >= 200
    && event.status < 300
    && event.completionNodeId === firstOutput.nodeId
    && event.completionRootLayerId === priorLayerId
  ));
  const successfulSearches = evidence.auditEvents.filter((event) => (
    event.method === "POST"
    && event.path === "/api/graph/search"
    && event.status >= 200
    && event.status < 300
    && event.sequence > evidence.secondTurnStartSequence
  ));
  const secondSubmit = evidence.auditEvents.find((event) => (
    event.method === "POST"
    && event.path === "/api/graph/submit"
    && event.status >= 200
    && event.status < 300
    && event.completionNodeId === output.nodeId
    && event.completionRootLayerId === output.rootLayer.layer.id
  ));
  const search = successfulSearches[0];
  const draftDecoyDiscard = evidence.draftDecoyLayerId === undefined ? undefined : evidence.auditEvents.find((event) => (
    event.method === "POST"
    && event.path === `/api/graph/layers/${evidence.draftDecoyLayerId}/discard`
    && event.status >= 200
    && event.status < 300
    && event.recordKind === "layer"
    && event.recordId === evidence.draftDecoyLayerId
    && event.recordState === "stopped"
  ));
  const ordered = firstSubmit !== undefined
    && search !== undefined
    && evidence.searchSequence === search.sequence
    && evidence.referenceActionSequence !== undefined
    && secondSubmit !== undefined
    && firstSubmit.sequence < search.sequence
    && search.sequence < evidence.referenceActionSequence
    && evidence.referenceActionSequence < secondSubmit.sequence;
  return [
    ...base,
    {
      name: "search-returned-prior-root",
      passed: successfulSearches.length === 1
        && evidence.searchedLayerIds.length === 1
        && evidence.searchedLayerIds[0] === priorLayerId
        && successfulSearches[0]?.resultTruncated === false,
      detail: "The one audited graph.search call returned exactly the first accepted root Layer identity.",
    },
    {
      name: "search-request-contract",
      passed: successfulSearches.length === 1
        && (searchRequestMode === "exact"
          ? matchesRequiredGraphMemorySearch(evidence.searchRequest)
          : matchesNaturalGraphMemorySearch(evidence.searchRequest)),
      detail: searchRequestMode === "exact"
        ? "The deterministic fixture used the exact admitted conformance query, natural topic parameter, and bounded budget."
        : "The provider formulated one bounded parameterized query for the natural topic without a machine marker.",
    },
    ...(requireDraftDecoy ? [{
      name: "draft-decoy-hidden",
      passed: evidence.draftDecoyLayerId !== undefined
        && draftDecoyDiscard !== undefined
        && search !== undefined
        && search.resultTruncated === false
        && search.sequence < draftDecoyDiscard.sequence,
      detail: "A same-topic draft layer existed during search, was absent from its exact result, and was stopped only afterward.",
    }] : []),
    {
      name: "typed-reference-target",
      passed: acceptedReference !== undefined,
      detail: "The second accepted root contains the audited typed reference action targeting that exact searched Layer.",
    },
    {
      name: "ack-search-submit-order",
      passed: ordered,
      detail: "Server response order proves first submit acknowledgement before second-turn search, the matching reference action, and second submit acknowledgement.",
    },
  ];
}

function matchesRequiredGraphMemorySearch(
  request: GraphMemoryEvidence["searchRequest"],
): boolean {
  if (request?.queryContractVersion !== 1 || request.query !== graphMemorySearchQuery
    || request.target !== undefined
    || !isRecord(request.parameters) || !isRecord(request.budget)) return false;
  const parameterKeys = Object.keys(request.parameters);
  const topicParameter = request.parameters.topic;
  return parameterKeys.length === 1
    && parameterKeys[0] === "topic"
    && isRecord(topicParameter)
    && Object.keys(topicParameter).length === 2
    && topicParameter.type === "string"
    && topicParameter.value === graphMemorySearchTitle
    && Object.keys(request.budget).length === 1
    && request.budget.resultRows === graphMemorySearchBudget.resultRows;
}

function matchesNaturalGraphMemorySearch(
  request: GraphMemoryEvidence["searchRequest"],
): boolean {
  if (request?.queryContractVersion !== 1 || typeof request.query !== "string"
    || request.target !== undefined
    || !isRecord(request.parameters)
    || (request.budget !== undefined && !isRecord(request.budget))) return false;
  const parameterKeys = Object.keys(request.parameters);
  if (parameterKeys.length !== 1
    || (request.budget !== undefined && !matchesNaturalGraphMemoryBudget(request.budget))) return false;
  const parameterName = parameterKeys[0]!;
  const parameter = request.parameters[parameterName];
  return isRecord(parameter)
    && Object.keys(parameter).length === 2
    && parameter.type === "string"
    && parameter.value === graphMemorySearchTitle
    && isNaturalGraphMemoryQueryShape(request.query, parameterName)
    && !JSON.stringify({ query: request.query, parameters: request.parameters }).includes("GRAPH_MEMORY_ANCHOR:");
}

function matchesNaturalGraphMemoryBudget(budget: Readonly<Record<string, unknown>>): boolean {
  const resultRows = budget.resultRows;
  return resultRows === undefined
    || (Number.isSafeInteger(resultRows) && (resultRows as number) >= 1 && (resultRows as number) <= 8);
}

function isNaturalGraphMemoryQueryShape(query: string, parameterName: string): boolean {
  const identifier = "[A-Za-z_][A-Za-z0-9_]*";
  const layer = `(?<layer>${identifier})`;
  const content = `(?<content>${identifier})`;
  const relationship = `\\[\\s*(?:${identifier}\\s*)?:\\s*CONTAINS(?:\\s*\\{[^}]*\\})?\\s*\\]`;
  const contains = `\\s*-\\s*${relationship}\\s*->\\s*`;
  const containedBy = `\\s*<-\\s*${relationship}\\s*-\\s*`;
  const layerNode = `\\(\\s*${layer}\\s*:\\s*Layer\\s*\\)`;
  const contentNode = `\\(\\s*${content}\\s*:\\s*Content\\s*\\)`;
  const escapedParameter = parameterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const titleProperty = "\\k<content>\\s*\\.\\s*title";
  const parameter = `\\$${escapedParameter}`;
  const predicate = `\\s+WHERE\\s+(?:${titleProperty}\\s*=\\s*${parameter}|${parameter}\\s*=\\s*${titleProperty})`;
  const projection = `\\s+RETURN\\s+(?:DISTINCT\\s+)?\\k<layer>(?:\\s+AS\\s+${identifier})?`;
  const orderingExpression = `${identifier}(?:\\s*\\.\\s*${identifier})?`;
  const ordering = `(?:\\s+ORDER\\s+BY\\s+${orderingExpression}(?:\\s+(?:ASC|DESC))?)?`;
  const limit = "(?:\\s+LIMIT\\s+[1-8])?\\s*;?\\s*$";
  const pathBinding = `(?:${identifier}\\s*=\\s*)?`;
  const forward = new RegExp(`^\\s*MATCH\\s+${pathBinding}${layerNode}${contains}${contentNode}${predicate}${projection}${ordering}${limit}`, "i");
  const reverse = new RegExp(`^\\s*MATCH\\s+${pathBinding}${contentNode}${containedBy}${layerNode}${predicate}${projection}${ordering}${limit}`, "i");
  return forward.test(query) || reverse.test(query);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function checkNodeNavigation(output: CompletionOutput): EvalCheck[] {
  const visibleNodeIds = new Set(output.rootLayer.nodes.map((node) => node.id));
  const navigation = output.rootLayer.actions.find((action) => (
    action.kind === "navigate"
    && action.state === "accepted"
    && action.relation === "expand"
    && action.sourceLayerId === output.rootLayer.layer.id
    && Number.isInteger(action.targetLayerId)
    && visibleNodeIds.has(action.sourceNodeId)
  ));
  return [{
    name: "node-navigation",
    passed: navigation !== undefined,
    detail: navigation
      ? "A visible output node opens an accepted child layer."
      : "No visible output node opens a child layer.",
  }];
}

function arraysEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

