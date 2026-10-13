import {
  LayerLayoutObject, LayerObject, NodeObject, NodePlacementObject, RelayerGraphClient,
} from "@relayer/graph-client";
import { nativeExecutionHandle } from "@relayer/harness-host";
import { complete } from "relayer-graphcomplete";

const CHILD_TASK = "Compare the two approaches for this review";
const VACATION_TASK = "Analyze the confirmed vacation destination and update the overall comparison";
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const centered = (node) => new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)], "default");

/** Deterministic production-seam demo. It runs no model and claims no model quality. */
export function completionContractFixtureFactory(observed, { bindingTest = false, multiple = false } = {}) {
  return () => ({
    supportsInvokedComplete: true,
    traceSupport: () => ({
      prompt: "none", messages: "none", reasoningSummaries: "none", modelCalls: "none",
      toolCalls: "none", usage: "none", childStreams: "none", nativeArtifacts: "none",
    }),
    state: () => ({}),
    complete(context, signal) {
      const execution = run(context, signal, observed, bindingTest, multiple).catch((error) => {
        observed.errors.push(String(error.stack ?? error));
        throw error;
      });
      return nativeExecutionHandle(execution, undefined, Promise.resolve({
        schemaVersion: 1, provider: "fixture", executionId: `review-${context.inputGraph.id}`,
      }));
    },
  });
}

async function run(context, signal, observed, bindingTest, multiple) {
  const graph = new RelayerGraphClient(context.graph.acquireCapability());
  const contract = await graph.getContract();
  if (!contract) throw new Error("The review requires a sealed CompletionContract.");
  observed.contracts.push(contract);
  if (multiple) { await runMultipleInputs(graph, context, contract, observed); return; }
  if (bindingTest || context.inputGraph.detail === VACATION_TASK || /vacation/i.test(context.inputGraph.detail)) {
    await runVacation(graph, context, contract, observed, bindingTest);
    return;
  }
  const start = await graph.getCurrent();
  const isChild = context.inputGraph.detail === CHILD_TASK;
  const node = new NodeObject(
    isChild ? "check-circle" : "compass",
    isChild ? "Updated overall analysis" : "A useful first direction",
    isChild
      ? "Overall recommendation: use Approach A for a fast first result, then Approach B to check the decision. The comparison below supports this recommendation; the enclosing analysis now incorporates its findings."
      : "The request is captured. Compare a fast first approach with a more careful check, then combine their findings.",
    "concept", "first-node",
  );
  await graph.submitNode(node);
  const layer = new LayerObject([node], [], centered(node), "first-layer");
  await graph.submitLayer(layer);
  if (isChild) {
    const detail = new NodeObject("git-compare", "Approach comparison", "Approach A minimizes time to a first result. Approach B costs more time but checks whether that result is dependable. Neither alone satisfies both goals; combine them in that order.", "concept", "comparison-detail");
    await graph.submitNode(detail);
    const detailLayer = new LayerObject([detail], [], centered(detail), "comparison-detail-layer");
    await graph.submitLayer(detailLayer);
    await graph.addAction(node, { kind: "navigate", relation: "expand", sourceLayer: layer, label: "Inspect the supporting comparison", target: detailLayer, clientKey: "comparison-detail" });
  }
  await graph.addAction(context.inputGraph.id, {
    kind: "navigate", relation: "expand", label: "Review the approaches", icon: "compass",
    target: layer, clientKey: "response",
  });
  await stageResponseLinks(graph, contract, layer);

  let children = [];
  if (!isChild) {
    const action = await graph.addAction(node, {
      kind: "invoke", sourceLayer: layer, label: "Compare approaches", icon: "git-compare",
      interactionText: CHILD_TASK, clientKey: "compare",
    });
    // Default demonstration: one child at a time. Prepare on the owned draft,
    // publish its parent before executing the child's accepted-history integration.
    const first = await graph.prepareComplete(action, "comparison-a");
    observed.invocations.push(first);
    process.env.RELAYER_COMPLETE_URL = context.completionBroker.url;
    process.env.RELAYER_COMPLETE_TOKEN = context.completionBroker.token;
    children = [first];
  }

  const advanced = await graph.advanceCurrent(layer, start.headRevision, "first-progress");
  observed.advances.push({ interactionNode: context.inputGraph.id, revision: advanced.revision });
  if (!isChild) children = children.map((prepared) => complete(prepared));
  await wait(isChild ? 3000 : 1500);
  if (signal?.aborted) throw new Error("Review execution cancelled.");
  if (isChild) {
    await graph.returnCurrent(layer, advanced.revision, "child-return");
    return;
  }
  const results = await Promise.all(children.map((child) => child.result));
  observed.results.push(...results);
  const conclusion = new NodeObject("check-circle", "Start small, then verify", "Use the fast approach to establish a direction, then verify it before committing to the larger investment. The earlier view connects to the child's updated overall analysis and its nested supporting comparison.", "concept", "conclusion");
  await graph.submitNode(conclusion);
  const finalLayer = new LayerObject([conclusion], [], centered(conclusion), "final-layer");
  await graph.submitLayer(finalLayer);
  await graph.addAction(conclusion, {
    kind: "navigate", relation: "reference", sourceLayer: finalLayer,
    label: "Earlier view and comparisons", target: layer, clientKey: "earlier-view",
  });
  await graph.addAction(context.inputGraph.id, {
    kind: "navigate", relation: "expand", label: "Review the approaches", icon: "compass",
    target: finalLayer, clientKey: "response",
  });
  await stageResponseLinks(graph, contract, finalLayer);
  await graph.returnCurrent(finalLayer, advanced.revision, "final-response");
}

async function runVacation(graph, context, contract, observed, bindingTest) {
  const isChild = context.inputGraph.detail === VACATION_TASK;
  const destination = contract.input.answers.find((answer) => answer.question.prompt === "Destination")?.value.text;
  if (isChild && !destination) throw new Error("Vacation invocation lacks a sealed confirmed destination.");
  const reference = contract.input.invocationReferences[0];
  const priorResults = [];
  if (isChild) {
    for (const invocation of await graph.getInvocations(reference.sourceActionId)) {
      if (invocation.childInteractionNodeId === context.inputGraph.id || invocation.state.lifecycle !== "succeeded") continue;
      if (!invocation.state.finalLayerId) throw new Error("Returned vacation call has no final Layer identity.");
      priorResults.push({ rootLayer: await graph.getLayer(invocation.state.finalLayerId) });
    }
  }
  const title = isChild ? `Vacation comparison — ${destination}` : "Choose a vacation destination";
  const previousTitles = priorResults.map((result) => result.rootLayer.nodes.map((node) => node.title).join(", "));
  const node = new NodeObject("compass", title, isChild
    ? `This deterministic example now includes ${destination}${previousTitles.length ? ` alongside the earlier analysis: ${previousTitles.join("; ")}` : " as its first candidate"}. Compare the trip's purpose, budget and travel effort before choosing; the nested destination brief supports this overall comparison.`
    : "Enter and confirm one destination, then choose Analyze destination. Each completed analysis updates this overall comparison. Earlier candidate results remain available beside Invoke.", "concept", "vacation-analysis");
  await graph.submitNode(node);
  const layer = new LayerObject([node], [], centered(node), "vacation-overall");
  await graph.submitLayer(layer);
  if (isChild) {
    const detail = new NodeObject("map-pin", `${destination} brief`, `Illustrative fixture brief for ${destination}: consider the activities you want, the trip budget and the effort of getting there. This is not live travel research or a model recommendation.`, "concept", "destination-brief");
    await graph.submitNode(detail);
    const detailLayer = new LayerObject([detail], [], centered(detail), "destination-detail");
    await graph.submitLayer(detailLayer);
    await graph.addAction(node, { kind: "navigate", relation: "expand", sourceLayer: layer, label: `${destination} brief`, target: detailLayer, clientKey: "destination-detail" });
    for (const [index, result] of priorResults.entries()) {
      await graph.addAction(node, { kind: "navigate", relation: "reference", sourceLayer: layer, label: previousTitles[index], target: result.rootLayer.layer, clientKey: `prior-destination-${result.rootLayer.layer.id}` });
    }
  } else {
    // Exercise declaration lowering at the real graph write seam, without IDs.
    const destinationInput = { kind: "input", sourceLayer: layer, label: "Destination", control: "text", prompt: "Destination", clientKey: "destination-input" };
    await graph.addAction(node, { kind: "invoke", reusable: true, sourceLayer: layer, label: "Analyze destination", interactionText: VACATION_TASK, inputActions: [destinationInput], clientKey: "destination-invoke" });
    if (bindingTest) {
      await graph.addAction(node, { kind: "input", sourceLayer: layer, label: "Unrelated notes", control: "text", prompt: "Unrelated notes", clientKey: "unrelated-input" });
      await graph.addAction(node, { kind: "invoke", sourceLayer: layer, label: "Review travel effort", interactionText: VACATION_TASK, inputActions: [destinationInput], clientKey: "second-destination-invoke" });
    }
  }
  await graph.addAction(context.inputGraph.id, { kind: "navigate", relation: "expand", label: "Vacation comparison", target: layer, clientKey: "response" });
  await stageResponseLinks(graph, contract, layer);
  const current = await graph.getCurrent();
  const advanced = await graph.advanceCurrent(layer, current.headRevision, "vacation-progress");
  observed.advances.push({ interactionNode: context.inputGraph.id, revision: advanced.revision });
  await wait(1000);
  await graph.returnCurrent(layer, advanced.revision, "vacation-return");
}

async function stageResponseLinks(graph, contract, layer) {
  const destination = contract.input.answers.find((answer) => answer.question.prompt === "Destination")?.value.text;
  for (const requirement of contract.returnRequirements) {
    if (requirement.kind !== "navigate.response") continue;
    await graph.addAction(requirement.nodeId, {
      kind: "navigate", relation: "reference", label: destination ? `Overall analysis · ${destination}` : "See the new response", target: layer,
      clientKey: `attached-response-${contract.interactionNodeId}-${requirement.nodeId}`,
    });
  }
}

async function runMultipleInputs(graph, context, contract, observed) {
  const answers = Object.fromEntries(contract.input.answers.map(answer => [answer.question.prompt, answer.value.text]));
  const child = contract.input.invocationReferences.length > 0;
  const itinerary = child && context.inputGraph.detail === "Analyze itinerary inputs";
  const title = child ? itinerary ? `Itinerary — ${answers.Destination}` : `Budget — ${answers.Budget}`
    : contract.input.answers.length ? "Notes response" : "Plan a trip";
  const node = new NodeObject("compass", title, child
    ? `Accepted arguments: ${JSON.stringify(answers)}. This result updates the source trip analysis and remains available through its Navigate action.`
    : title === "Notes response" ? `Accepted ordinary input: ${answers["Unrelated notes"]}`
    : "Destination and trip pace belong to the itinerary Invoke. Budget and days belong to the budget Invoke. Unrelated notes go to chat through Send. Current valid values are accepted at that boundary; Undo restores the saved baseline.", "concept", "multiple-plan");
  await graph.submitNode(node);
  const layer = new LayerObject([node], [], centered(node), "multiple-inputs");
  await graph.submitLayer(layer);
  if (title === "Plan a trip") {
    const input = (label, key) => ({ kind: "input", sourceLayer: layer, label, control: "text", prompt: label, clientKey: key });
    await graph.addAction(node, { kind: "invoke", sourceLayer: layer, label: "Build itinerary", interactionText: "Analyze itinerary inputs", inputActions: [input("Destination", "destination"), input("Trip pace", "pace")], clientKey: "itinerary" });
    await graph.addAction(node, { kind: "invoke", sourceLayer: layer, label: "Estimate budget", interactionText: "Analyze budget inputs", inputActions: [input("Budget", "budget"), input("Days", "days")], clientKey: "budget-invoke" });
    await graph.addAction(node, input("Unrelated notes", "notes"));
  }
  await graph.addAction(context.inputGraph.id, { kind: "navigate", relation: "expand", label: title, target: layer, clientKey: "response" });
  for (const requirement of contract.returnRequirements) if (requirement.kind === "navigate.response") {
    await graph.addAction(requirement.nodeId, { kind: "navigate", relation: "reference", label: `Open ${title}`, target: layer, clientKey: `attached-response-${context.inputGraph.id}-${requirement.nodeId}` });
  }
  const current = await graph.getCurrent();
  const advanced = await graph.advanceCurrent(layer, current.headRevision, "multiple-progress");
  observed.advances.push({ interactionNode: context.inputGraph.id, revision: advanced.revision });
  await wait(500);
  await graph.returnCurrent(layer, advanced.revision, "multiple-return");
}
