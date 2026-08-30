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

export const graphMemoryFixtureConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "fixture-graph-memory",
  implementation: "fixture.graph-memory",
  implementationVersion: 1,
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
    const anchor = readAnchor(prompt);
    context.trace.emit({ type: "prompt", data: { text: prompt, kind: "fixture-input" } });
    context.trace.emit({ type: "tool.call.started", data: { tool: "fixture.graph-memory" } });
    if (this.turn === 1) {
      await authorFirstTurn(graph, context, anchor);
    } else if (this.turn === 2) {
      await searchAndReferenceFirstTurn(graph, context, anchor);
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
  anchor: string,
): Promise<void> {
  const beforeAcknowledgement = await graph.search({
    queryContractVersion: 1,
    query: "MATCH (l:Layer)-[:CONTAINS]->(n:Content) WHERE n.title = $anchor RETURN l AS layer ORDER BY layer ASC",
    parameters: { anchor: { type: "string", value: anchor } },
    budget: {},
  });
  if (beforeAcknowledgement.rows.length !== 0) {
    throw new Error("Graph-memory anchor unexpectedly existed before first-turn acknowledgement");
  }
  const anchorNode = new NodeObject(
    "search",
    anchor,
    "This accepted node is the unique prior-completion anchor that the next turn must discover through graph search.",
    "concept",
    "memory-anchor",
  );
  const explanation = new NodeObject(
    "git-branch",
    "Searchable accepted context",
    "Submission acknowledgement makes the complete accepted layer searchable before the next interaction starts.",
    "concept",
    "memory-explanation",
  );
  await graph.submitNode(anchorNode);
  await graph.submitNode(explanation);
  const edge = new EdgeObject([anchorNode, explanation], "memory-anchor-edge");
  await graph.createEdge(edge);
  const layer = new LayerObject(
    [anchorNode, explanation],
    [edge],
    new LayerLayoutObject([
      new NodePlacementObject(anchorNode, 0.25, 0.5),
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
  const afterAcknowledgement = await graph.search({
    queryContractVersion: 1,
    query: "MATCH (l:Layer)-[:CONTAINS]->(n:Content) WHERE n.title = $anchor RETURN l AS layer ORDER BY layer ASC",
    parameters: { anchor: { type: "string", value: anchor } },
    budget: {},
  });
  if (afterAcknowledgement.rows.length !== 1 || afterAcknowledgement.rows[0]?.[0]?.type !== "layer") {
    throw new Error("Graph-memory anchor was not searchable after first-turn acknowledgement");
  }
}

async function searchAndReferenceFirstTurn(
  graph: RelayerGraphClient,
  context: HarnessRunContext,
  anchor: string,
): Promise<void> {
  const draftDecoy = new NodeObject(
    "search",
    anchor,
    "This same-anchor draft must remain invisible to graph search.",
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
    query: "MATCH (l:Layer)-[:CONTAINS]->(n:Content) WHERE n.title = $anchor RETURN l AS layer ORDER BY layer ASC",
    parameters: { anchor: { type: "string", value: anchor } },
    budget: {},
  });
  if (result.rows.length !== 1 || result.rows[0]?.length !== 1) {
    throw new Error(`Expected one prior accepted layer for graph-memory anchor, received ${result.rows.length}`);
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

function readAnchor(prompt: string): string {
  const match = prompt.match(/GRAPH_MEMORY_ANCHOR:[a-z0-9_-](?:[a-z0-9._-]*[a-z0-9_-])?/i);
  if (match === null) throw new Error("Graph-memory prompt is missing its unique anchor");
  return match[0];
}

function numericLayerId(layer: GraphQueryLayerValue): number {
  const match = /^layer:([1-9]\d*)$/.exec(layer.id);
  const value = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(value)) throw new Error(`Graph-memory search returned invalid layer identity ${layer.id}`);
  return value;
}
