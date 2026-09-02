import {
  LayerLayoutObject,
  LayerObject,
  NodeObject,
  NodePlacementObject,
  RelayerGraphClient,
  css,
  html,
} from "@relayer/graph-client";
import { nativeExecutionHandle } from "@relayer/harness-host";

import { complete } from "../../src/index.js";

export const RECURSIVE_FIXTURE_CHILD_TASK = "Handle the delegated half";

function centered(node) {
  return new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)]);
}

/** Production-seam fixture shared by recursive runtime and Eval Desktop integration tests. */
export function recursiveCompleteFixtureFactory(
  observed,
  brokerUrl = (context) => context.completionBroker.url,
) {
  return () => ({
    supportsInvokedComplete: true,
    traceSupport: () => ({
      prompt: "none", messages: "none", reasoningSummaries: "none", modelCalls: "none",
      toolCalls: "none", usage: "none", childStreams: "none", nativeArtifacts: "none",
    }),
    state: () => ({}),
    complete(context, signal) {
      const execution = runRecursiveFixture(context, signal, observed, brokerUrl).catch((error) => {
        (observed.errors ??= []).push(`${context.inputGraph.detail}: [${error?.code}] ${error?.message}`);
        throw error;
      });
      return nativeExecutionHandle(execution, undefined, Promise.resolve({
        schemaVersion: 1,
        provider: "fixture",
        executionId: `fixture-${context.inputGraph.id}`,
      }));
    },
  });
}

async function runRecursiveFixture(context, signal, observed, brokerUrl) {
  const graph = new RelayerGraphClient(context.graph.acquireCapability());
  if (context.inputGraph.detail === RECURSIVE_FIXTURE_CHILD_TASK) {
    const current = await graph.getCurrent();
    const finding = new NodeObject("info", "Delegated finding", "The child did its own half.", "concept", "finding");
    await graph.submitNode(finding);
    const layer = new LayerObject([finding], [], centered(finding), "child-layer");
    await graph.submitLayer(layer);
    await graph.addAction(context.inputGraph.id, {
      kind: "navigate", relation: "expand", label: "Response", target: layer, clientKey: "child-root",
    });
    await graph.advanceCurrent(layer, current.headRevision, "child-advance");
    if (observed.childBlocks) {
      await new Promise((abort) => signal.addEventListener("abort", abort, { once: true }));
      throw new Error("child aborted");
    }
    await new Promise((wait) => setTimeout(wait, observed.childDelayMs ?? 0));
    await graph.returnCurrent(layer, current.headRevision + 1, "child-return");
    return;
  }

  const current = await graph.getCurrent();
  observed.parentStartRevision = current.headRevision;
  const plan = new NodeObject("box", "Plan", "Split the work in half.", "concept", "plan");
  const visualNodeDetailsRequested = context.personalPresentation?.graph.layers.some(({ nodes }) => (
    nodes.some(({ title }) => title === "Authored visual Node Details")
  )) === true;
  if (visualNodeDetailsRequested) {
    plan.detailAuthoring.setComponent(
      "plan-summary",
      html`<section><h2>Plan</h2><p>Split the work in half.</p></section>`,
      css`section { display: grid; gap: 0.5rem; } h2, p { margin: 0; }`,
    );
  }
  await graph.submitNode(plan);
  const planLayer = new LayerObject([plan], [], centered(plan), "plan-layer");
  await graph.submitLayer(planLayer);
  await graph.addAction(context.inputGraph.id, {
    kind: "navigate", relation: "expand", label: "Response", target: planLayer, clientKey: "parent-root",
  });
  const delegate = await graph.addAction(plan, {
    kind: "invoke",
    sourceLayer: planLayer,
    label: "Delegate",
    interactionText: RECURSIVE_FIXTURE_CHILD_TASK,
    clientKey: "delegate",
  });
  const advanced = await graph.advanceCurrent(planLayer, current.headRevision, "publish-plan");
  observed.parentAdvancedRevision = advanced.revision;

  const inputGraph = await graph.prepareComplete(delegate);
  observed.preparedChild = inputGraph.interactionNode;
  process.env.RELAYER_COMPLETE_URL = brokerUrl(context);
  process.env.RELAYER_COMPLETE_TOKEN = context.completionBroker.token;
  const child = complete(inputGraph);
  observed.childCompletionId = child.completionId;

  if (observed.fireAndForget) {
    observed.fireAndForgetStarted = true;
    await new Promise((ready) => setImmediate(ready));
    await graph.returnCurrent(planLayer, advanced.revision, "return-plan");
    return;
  }

  if (observed.childBlocks) {
    await new Promise((wait) => setTimeout(wait, 400));
    await child.stop("the parent no longer needs this branch");
    observed.stoppedChild = await child.current.snapshot();
  } else {
    const startedAt = Date.now();
    observed.childRootLayer = await child.result;
    observed.awaitedMs = Date.now() - startedAt;
  }
  await graph.returnCurrent(planLayer, advanced.revision, "return-plan");
}
