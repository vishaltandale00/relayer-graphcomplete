import {
  LayerLayoutObject,
  LayerObject,
  NodeObject,
  NodePlacementObject,
  RelayerGraphClient,
  detailCapability,
  css,
  html,
} from "@relayer/graph-client";
import { nativeExecutionHandle } from "@relayer/harness-host";

import { complete } from "../../src/index.js";

export const RECURSIVE_FIXTURE_CHILD_TASK = "Handle the delegated half";

function centered(node) {
  return new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)], "default");
}

function visualNodeDetailsRequested(context) {
  return context.personalPresentation?.graph.layers.some(({ nodes }) => (
    nodes.some(({ title }) => title === "Authored visual Node Details")
  )) === true;
}

function authorVisualNodeDetail(node, componentId, markup) {
  node.detailAuthoring.setComponent(
    componentId,
    markup,
    css`section { display: grid; gap: 0.5rem; } h2, p { margin: 0; }`,
  );
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    const onAbort = () => reject(new Error("child aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parentAbortedError() {
  const error = new Error("parent aborted while waiting for child readiness");
  error.name = "AbortError";
  return error;
}

async function waitForChildReadiness(childReadiness, child, signal) {
  if (signal?.aborted) throw parentAbortedError();
  const childOutcomes = [
    childReadiness.promise,
    child.result.then(
      () => { throw new Error("child completed before publishing its current"); },
      (error) => { throw error; },
    ),
  ];
  if (!signal) {
    await Promise.race(childOutcomes);
    return;
  }
  let onAbort;
  const parentAborted = new Promise((_, reject) => {
    onAbort = () => reject(parentAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([...childOutcomes, parentAborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) throw parentAbortedError();
}

/** Production-seam fixture shared by recursive runtime and Eval Desktop integration tests. */
export function recursiveCompleteFixtureFactory(
  observed,
  brokerUrl = (context) => context.completionBroker.url,
  completeChild = complete,
) {
  return () => {
    const childReadinessByInteraction = new Map();
    return {
      supportsInvokedComplete: true,
      traceSupport: () => ({
        prompt: "none", messages: "none", reasoningSummaries: "none", modelCalls: "none",
        toolCalls: "none", usage: "none", childStreams: "none", nativeArtifacts: "none",
      }),
      state: () => ({}),
      complete(context, signal) {
        const isChild = context.inputGraph.detail === RECURSIVE_FIXTURE_CHILD_TASK;
        const childReadiness = isChild
          ? childReadinessByInteraction.get(context.inputGraph.id)
          : undefined;
        const execution = runRecursiveFixture(
          context,
          signal,
          observed,
          brokerUrl,
          completeChild,
          childReadinessByInteraction,
          childReadiness,
        ).catch((error) => {
          if (isChild) childReadiness?.reject(error);
          (observed.errors ??= []).push(`${context.inputGraph.detail}: [${error?.code}] ${error?.message} ${JSON.stringify(error?.issues ?? [])}`);
          throw error;
        });
        return nativeExecutionHandle(execution, undefined, Promise.resolve({
          schemaVersion: 1,
          provider: "fixture",
          executionId: `fixture-${context.inputGraph.id}`,
        }));
      },
    };
  };
}

async function runRecursiveFixture(
  context,
  signal,
  observed,
  brokerUrl,
  completeChild,
  childReadinessByInteraction,
  capturedChildReadiness,
) {
  const graph = new RelayerGraphClient(context.graph.acquireCapability());
  if (context.inputGraph.detail === RECURSIVE_FIXTURE_CHILD_TASK) {
    const current = await graph.getCurrent();
    const finding = new NodeObject("info", "Delegated finding", "The child did its own half.", "concept", "finding");
    if (visualNodeDetailsRequested(context)) {
      authorVisualNodeDetail(
        finding,
        "delegated-finding",
        html`<section><h2>Delegated finding</h2><p>The child did its own half.</p></section>`,
      );
    }
    await graph.submitNode(finding);
    const layer = new LayerObject([finding], [], centered(finding), "child-layer");
    await graph.submitLayer(layer);
    await graph.addAction(context.inputGraph.id, {
      kind: "navigate", relation: "expand", label: "Response", target: layer, clientKey: "child-root",
    });
    const contract = await graph.getContract();
    for (const requirement of contract?.returnRequirements ?? []) {
      if (requirement.kind !== "navigate.response") continue;
      const snapshot = await graph.getNodePresentation(requirement.nodeId);
      const addition = { kind: "navigate", relation: "reference", label: "Updated overall analysis", target: layer, clientKey: `integrated-response-${requirement.nodeId}` };
      await graph.addAction(requirement.nodeId, addition);
      if (snapshot.node.authoredDetail) {
        const prior = snapshot.node;
        const replacement = new NodeObject(prior.icon, prior.title, prior.detail, prior.kind, prior.clientKey);
        authorVisualNodeDetail(replacement, "integrated-analysis", html`<section><h2>Plan and delegated finding</h2><p>The delegated finding is now available in the updated overall analysis.</p><button gc=${detailCapability.reference("integrated", addition)}>Updated overall analysis</button></section>`);
        for (const action of snapshot.actions) {
          if (action.kind !== "invoke") throw new Error("Unexpected recursive fixture source action");
          const sourceLayer = new LayerObject([replacement], [], centered(replacement), action.sourceLayerClientKey);
          const retained = { kind: "invoke", sourceLayer, label: action.label, interactionText: action.interactionText, clientKey: action.clientKey };
          authorVisualNodeDetail(replacement, `retained-${action.id}`, html`<section><button gc=${detailCapability.invoke(`retained-${action.id}`, retained)}>Delegate</button></section>`);
        }
        await graph.replaceNodePresentation(requirement.nodeId, snapshot.revision, replacement);
      }
    }
    await graph.advanceCurrent(layer, current.headRevision, "child-advance");
    await observed.afterChildPublication?.(context);
    if (observed.childBlocks) {
      const aborted = waitForAbort(signal);
      capturedChildReadiness?.resolve();
      await aborted;
    }
    await new Promise((wait) => setTimeout(wait, observed.childDelayMs ?? 0));
    await graph.returnCurrent(layer, current.headRevision + 1, "child-return");
    return;
  }

  const current = await graph.getCurrent();
  observed.parentStartRevision = current.headRevision;
  const plan = new NodeObject("box", "Plan", "Split the work in half.", "concept", "plan");
  if (visualNodeDetailsRequested(context)) {
    authorVisualNodeDetail(
      plan,
      "plan-summary",
      html`<section><h2>Plan</h2><p>Split the work in half.</p></section>`,
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
  const blocksForChild = observed.childBlocks && !observed.fireAndForget;
  const childReadiness = blocksForChild ? deferred() : undefined;
  if (childReadiness) {
    void childReadiness.promise.catch(() => undefined);
    childReadinessByInteraction.set(inputGraph.interactionNode, childReadiness);
  }

  try {
    if (signal?.aborted) throw parentAbortedError();
    const child = completeChild(inputGraph);
    observed.childCompletionId = child.completionId;

    if (observed.fireAndForget) {
      observed.fireAndForgetStarted = true;
      await new Promise((ready) => setImmediate(ready));
      await graph.returnCurrent(planLayer, advanced.revision, "return-plan");
      return;
    }

    if (blocksForChild) {
      await waitForChildReadiness(childReadiness, child, signal);
      if (signal?.aborted) throw parentAbortedError();
      await child.stop("the parent no longer needs this branch");
      observed.stoppedChild = await child.current.snapshot();
    } else {
      const startedAt = Date.now();
      observed.childRootLayer = await child.result;
      observed.awaitedMs = Date.now() - startedAt;
    }
    await graph.returnCurrent(planLayer, advanced.revision, "return-plan");
  } finally {
    if (childReadiness && childReadinessByInteraction.get(inputGraph.interactionNode) === childReadiness) {
      childReadinessByInteraction.delete(inputGraph.interactionNode);
    }
  }
}
