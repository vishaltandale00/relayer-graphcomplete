import {
  LayerLayoutObject,
  LayerObject,
  NodeObject,
  NodePlacementObject,
  RelayerGraphClient,
} from "@relayer/graph-client";
import { nativeExecutionHandle } from "@relayer/harness-host";

import { complete } from "../../src/index.js";

const SEARCH_QUERY = "MATCH (layer:Layer)-[:CONTAINS]->(content:Content) WHERE content.title = $topic RETURN layer LIMIT 1";
const STOP_CONDITION = "Launch stops if any stale grant survives a verified rotation and rollback cycle.";

function centered(node) {
  return new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)]);
}

function numericLayerId(value) {
  const match = /^layer:([1-9]\d*)$/.exec(value?.id || "");
  const id = match === null ? Number.NaN : Number(match[1]);
  if (value?.type !== "layer" || !Number.isSafeInteger(id)) {
    throw new Error("Lantern fixture search did not return one typed layer identity");
  }
  return id;
}

async function findPriorLayer(graph, topic) {
  const result = await graph.search({
    queryContractVersion: 1,
    query: SEARCH_QUERY,
    parameters: { topic: { type: "string", value: topic } },
  });
  if (result.truncated || result.rows.length !== 1 || result.rows[0]?.length !== 1) {
    throw new Error(`Lantern fixture expected one accepted prior root for ${topic}`);
  }
  return numericLayerId(result.rows[0][0]);
}

async function authorChild(context, observed) {
  const capability = context.graph.acquireCapability();
  const graph = new RelayerGraphClient(capability);
  const [input, interaction] = await Promise.all([
    graph.getInteractionInput(),
    graph.getNode(context.inputGraph.id),
  ]);
  if (input.interaction.id !== context.inputGraph.id
    || !Number.isSafeInteger(interaction.leasedActionId)
    || interaction.leasedActionId < 1) {
    throw new Error("Invoked Lantern child did not receive its exact leased interaction input");
  }
  observed.revokedChildCapabilityProbes.push(() => (
    new RelayerGraphClient(capability).getNode(context.inputGraph.id)
  ));
  const current = await graph.getCurrent();
  const node = new NodeObject("box", "Red-team stop condition", STOP_CONDITION, "concept", "red-team-condition");
  await graph.submitNode(node);
  const layer = new LayerObject([node], [], centered(node), "red-team-layer");
  await graph.submitLayer(layer);
  await graph.addAction(context.inputGraph.id, {
    kind: "navigate", relation: "expand", label: "Response", target: layer, clientKey: "red-team-response",
  });
  const advanced = await graph.advanceCurrent(layer, current.headRevision, "red-team-advance");
  await graph.returnCurrent(layer, advanced.revision, "red-team-return");
}

async function authorRoot(context, turn, searchEnabled, recursionEnabled, observed) {
  const graph = new RelayerGraphClient(context.graph.acquireCapability());
  const titles = ["Offline recovery covenant", "Constrained recovery revision", "Red-team stop condition"];
  const details = [
    "Interrupted updates roll back to the last-known-good build and stale permissions are revoked before relaunch.",
    "One retained build and a 72-hour offline window require staged recovery with staffed escalation.",
    STOP_CONDITION,
  ];
  const priorTopics = turn === 2
    ? [titles[0]]
    : turn === 3 ? [titles[0], titles[1]] : [];
  const priorLayers = searchEnabled
    ? await Promise.all(priorTopics.map((topic) => findPriorLayer(graph, topic)))
    : [];
  const node = new NodeObject("box", titles[turn - 1], details[turn - 1], "concept", `lantern-turn-${turn}`);
  await graph.submitNode(node);
  const layer = new LayerObject([node], [], centered(node), `lantern-layer-${turn}`);
  await graph.submitLayer(layer);
  for (const [index, priorLayer] of priorLayers.entries()) {
    await graph.addAction(node, {
      kind: "navigate",
      relation: "reference",
      sourceLayer: layer,
      label: `Supporting brief ${index + 1}`,
      target: priorLayer,
      clientKey: `lantern-reference-${turn}-${index + 1}`,
    });
  }
  await graph.addAction(context.inputGraph.id, {
    kind: "navigate", relation: "expand", label: "Response", target: layer, clientKey: `lantern-response-${turn}`,
  });
  if (turn !== 3 || !recursionEnabled) {
    await graph.submit(context.inputGraph.id);
    return;
  }
  const delegate = await graph.addAction(node, {
    kind: "invoke",
    sourceLayer: layer,
    label: "Red-team stale-grant challenge",
    interactionText: "Challenge whether a 48-hour containment plan can make stale grants impossible and return one falsifiable stop condition.",
    clientKey: "lantern-red-team-invoke",
  });
  const current = await graph.getCurrent();
  const advanced = await graph.advanceCurrent(layer, current.headRevision, "lantern-publish-specialist");
  const input = await graph.prepareComplete(delegate);
  process.env.RELAYER_COMPLETE_URL = context.completionBroker.url;
  process.env.RELAYER_COMPLETE_TOKEN = context.completionBroker.token;
  const child = complete(input);
  observed.childCompletionIds.push(child.completionId);
  await child.result;
  await graph.returnCurrent(layer, advanced.revision, "lantern-return-final");
}

export function lantern2x2FixtureFactory(observed) {
  return (factoryContext) => {
    let turn = 0;
    const searchEnabled = factoryContext.configuration.graphCapabilityProfile?.search === "query-v1";
    const recursionEnabled = factoryContext.configuration.complete?.agentAuthored === true;
    return {
      supportsInvokedComplete: true,
      traceSupport: () => ({
        prompt: "none", messages: "none", reasoningSummaries: "none", modelCalls: "none",
        toolCalls: "none", usage: "none", childStreams: "none", nativeArtifacts: "none",
      }),
      state: () => ({}),
      complete(context) {
        const invoked = context.origin?.kind === "invoke";
        if (!invoked) turn += 1;
        const execution = invoked
          ? authorChild(context, observed)
          : authorRoot(context, turn, searchEnabled, recursionEnabled, observed);
        return nativeExecutionHandle(execution, undefined, Promise.resolve({
          schemaVersion: 1,
          provider: "codex",
          sessionId: `fixture-${factoryContext.configuration.name}-${invoked ? "child" : `root-${turn}`}`,
        }));
      },
    };
  };
}
