import {
  EdgeObject,
  LayerLayoutObject,
  LayerObject,
  NodeObject,
  NodePlacementObject,
  RelayerGraphClient,
  type GraphQueryLayerValue,
} from "@relayer/graph-client";
import {
  renderInteractionInput,
  type Harness,
  type HarnessConfiguration,
  type HarnessFactory,
  type HarnessRunContext,
  type HarnessSessionState,
  type HarnessTraceSupport,
} from "@relayer/harness-host";

export const graphMemorySearchTitle = "Freshness acknowledged";
export const graphMemorySearchQuery = "MATCH (l:Layer)-[:CONTAINS]->(n:Content) WHERE n.title = $topic RETURN l AS layer ORDER BY layer ASC";
export const graphMemorySearchBudget = Object.freeze({ resultRows: 1 });

export const graphMemorySearchParameters = Object.freeze({
  topic: Object.freeze({ type: "string" as const, value: graphMemorySearchTitle }),
});

export const graphMemoryFixtureConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "fixture-graph-memory",
  implementation: "fixture.graph-memory",
  implementationVersion: 1,
  graphCapabilityProfile: { search: "query-v1" },
  permissionBindings: { ask: {}, auto: {}, full: {} },
  settings: {},
};

const FIXTURE_SESSION_ID = "graph-memory-fixture-session-v1";

class GraphMemoryFixtureHarness implements Harness {
  private turn = 0;

  traceSupport(): HarnessTraceSupport {
    return {
      prompt: "full",
      messages: "full",
      reasoningSummaries: "none",
      modelCalls: "none",
      toolCalls: "summary",
      usage: "none",
      childStreams: "none",
      nativeArtifacts: "none",
    };
  }

  state(): HarnessSessionState {
    return { graphMemorySessionId: FIXTURE_SESSION_ID };
  }

  async complete(context: HarnessRunContext): Promise<void> {
    this.turn += 1;
    const graph = new RelayerGraphClient(context.graph.acquireCapability());
    const prompt = renderInteractionInput(context.interactionInput);
    context.trace.emit({ type: "prompt", data: { text: prompt, kind: "fixture-input" } });
    context.trace.emit({ type: "tool.call.started", data: { tool: "fixture.graph-memory" } });
    if (this.turn === 1) {
      await authorFirstTurn(graph, context);
    } else if (this.turn === 2) {
      await searchAndReferenceFirstTurn(graph, context);
    } else {
      throw new Error(`Graph-memory fixture supports exactly two turns, received ${this.turn}`);
    }
    context.trace.emit({ type: "tool.call.completed", data: { tool: "fixture.graph-memory", status: "completed" } });
    context.trace.emit({ type: "message", data: { role: "assistant", text: `Completed graph-memory fixture turn ${this.turn}.` } });
  }
}

export const graphMemoryFixtureFactory: HarnessFactory = () => new GraphMemoryFixtureHarness();

async function authorFirstTurn(
  graph: RelayerGraphClient,
  context: HarnessRunContext,
): Promise<void> {
  const beforeAcknowledgement = await graph.search({
    queryContractVersion: 1,
    query: graphMemorySearchQuery,
    parameters: graphMemorySearchParameters,
    budget: graphMemorySearchBudget,
  });
  if (beforeAcknowledgement.rows.length !== 0) {
    throw new Error("Graph-memory search topic unexpectedly existed before first-turn acknowledgement");
  }
  const searchTargetNode = new NodeObject(
    "search",
    graphMemorySearchTitle,
    "This accepted node explains the prior acknowledgement that the next turn must discover through graph search.",
    "concept",
    "memory-search-target",
  );
  const explanation = new NodeObject(
    "git-branch",
    "Searchable accepted context",
    "Submission acknowledgement makes the complete accepted layer searchable before the next interaction starts.",
    "concept",
    "memory-explanation",
  );
  await graph.submitNode(searchTargetNode);
  await graph.submitNode(explanation);
  const edge = new EdgeObject([searchTargetNode, explanation], "memory-search-target-edge");
  await graph.createEdge(edge);
  const layer = new LayerObject(
    [searchTargetNode, explanation],
    [edge],
    new LayerLayoutObject([
      new NodePlacementObject(searchTargetNode, 0.25, 0.5),
      new NodePlacementObject(explanation, 0.75, 0.5),
    ]),
    "memory-first-root",
  );
  await graph.submitLayer(layer);
  await graph.addAction(context.inputGraph.id, {
    kind: "navigate",
    relation: "expand",
    label: "Response",
    target: layer,
    clientKey: "memory-first-response",
  });
  await graph.submit(context.inputGraph.id);
}

async function searchAndReferenceFirstTurn(
  graph: RelayerGraphClient,
  context: HarnessRunContext,
): Promise<void> {
  const draftDecoy = new NodeObject(
    "search",
    graphMemorySearchTitle,
    "This same-topic draft must remain invisible to graph search.",
    "concept",
    "memory-draft-decoy",
  );
  await graph.submitNode(draftDecoy);
  const draftDecoyLayer = new LayerObject(
    [draftDecoy],
    [],
    new LayerLayoutObject([new NodePlacementObject(draftDecoy, 0.5, 0.5)]),
    "memory-draft-decoy-layer",
  );
  await graph.submitLayer(draftDecoyLayer);
  const result = await graph.search({
    queryContractVersion: 1,
    query: graphMemorySearchQuery,
    parameters: graphMemorySearchParameters,
    budget: graphMemorySearchBudget,
  });
  if (result.truncated || result.rows.length !== 1 || result.rows[0]?.length !== 1) {
    throw new Error(`Expected one prior accepted layer for graph-memory search topic, received ${result.rows.length}`);
  }
  const searchedLayer = result.rows[0][0];
  if (searchedLayer?.type !== "layer") {
    throw new Error("Graph-memory search did not return a typed layer value");
  }
  const priorLayerId = numericLayerId(searchedLayer);
  await graph.discardLayer(draftDecoyLayer);
  const recalled = new NodeObject(
    "link",
    "Prior accepted answer recalled",
    "The current turn searched accepted graph state and links back to the exact returned layer as supporting context.",
    "concept",
    "memory-recalled",
  );
  await graph.submitNode(recalled);
  const layer = new LayerObject(
    [recalled],
    [],
    new LayerLayoutObject([new NodePlacementObject(recalled, 0.5, 0.5)]),
    "memory-second-root",
  );
  await graph.submitLayer(layer);
  await graph.addAction(recalled, {
    kind: "navigate",
    relation: "reference",
    sourceLayer: layer,
    label: "Open searched prior answer",
    target: priorLayerId,
    clientKey: "memory-prior-reference",
  });
  await graph.addAction(context.inputGraph.id, {
    kind: "navigate",
    relation: "expand",
    label: "Response",
    target: layer,
    clientKey: "memory-second-response",
  });
  await graph.submit(context.inputGraph.id);
}

function numericLayerId(layer: GraphQueryLayerValue): number {
  const match = /^layer:([1-9]\d*)$/.exec(layer.id);
  const value = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(value)) throw new Error(`Graph-memory search returned invalid layer identity ${layer.id}`);
  return value;
}
