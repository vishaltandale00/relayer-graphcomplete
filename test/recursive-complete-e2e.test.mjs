import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  LayerLayoutObject,
  LayerObject,
  NodeObject,
  NodePlacementObject,
  RelayerGraphClient,
} from "@relayer/graph-client";
import { afterEach, describe, expect, it } from "vitest";

import {
  GraphCompleteRuntimeService,
  RECURSIVE_TEMPORAL_FEATURES,
} from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { complete } from "../src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const CHILD_TASK = "Handle the delegated half";
const services = [];
const directories = [];
const closers = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const service of services.splice(0).reverse()) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** Counts every broker request an awaiting execution actually makes. */
async function countingBrokerProxy(targetOrigin) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const body = Buffer.concat(chunks);
      const headers = { ...request.headers };
      delete headers.host;
      delete headers["content-length"];
      try {
        const upstream = await fetch(new URL(request.url, targetOrigin), {
          method: request.method,
          headers,
          ...(body.length > 0 ? { body } : {}),
        });
        const text = await upstream.text();
        response.writeHead(upstream.status, { "content-type": "application/json" });
        response.end(text);
      } catch (error) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  closers.push(() => new Promise((closed) => server.close(closed)));
  return { requests, origin: `http://127.0.0.1:${server.address().port}` };
}

function centered(node) {
  return new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)]);
}

/**
 * A harness that exercises the real recursive seam without a provider.
 *
 * The parent publishes a current, authors an accepted invoke action, prepares a child from
 * it, and calls the exported `complete(inputGraph)` through the execution-scoped broker.
 */
function recursiveFixtureFactory(observed, brokerOrigin) {
  return () => ({
    supportsInvokedComplete: true,
    traceSupport: () => ({
      prompt: "none", messages: "none", reasoningSummaries: "none", modelCalls: "none",
      toolCalls: "none", usage: "none", childStreams: "none", nativeArtifacts: "none",
    }),
    state: () => ({}),
    async complete(context, signal) {
      try {
        return await run(context, signal, observed, brokerOrigin);
      } catch (error) {
        (observed.errors ??= []).push(`${context.inputGraph.detail}: [${error?.code}] ${error?.message}`);
        throw error;
      }
    },
  });
}

/** Records only whether the production execution scope carried broker authority. */
function brokerScopeFixtureFactory(observed) {
  return () => ({
    traceSupport: () => ({
      prompt: "none", messages: "none", reasoningSummaries: "none", modelCalls: "none",
      toolCalls: "none", usage: "none", childStreams: "none", nativeArtifacts: "none",
    }),
    state: () => ({}),
    async complete(context) {
      observed.completionBroker = context.completionBroker === undefined
        ? null
        : {
          url: context.completionBroker.url,
          tokenPresent: context.completionBroker.token.length >= 32,
        };
      const graph = new RelayerGraphClient(context.graph.acquireCapability());
      const result = new NodeObject("check-circle", "Preflight complete", "No inference ran.", "concept", "preflight-result");
      await graph.submitNode(result);
      const layer = new LayerObject([result], [], centered(result), "preflight-layer");
      await graph.submitLayer(layer);
      await graph.addAction(context.inputGraph.id, {
        kind: "navigate", relation: "expand", label: "Response", target: layer, clientKey: "preflight-root",
      });
      await graph.submit(context.inputGraph.id);
    },
  });
}

async function run(context, signal, observed, brokerOrigin) {
  {
      const graph = new RelayerGraphClient(context.graph.acquireCapability());
      if (context.inputGraph.detail === CHILD_TASK) {
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
        interactionText: CHILD_TASK,
        clientKey: "delegate",
      });
      const advanced = await graph.advanceCurrent(planLayer, current.headRevision, "publish-plan");
      observed.parentAdvancedRevision = advanced.revision;

      const inputGraph = await graph.prepareComplete(delegate);
      observed.preparedChild = inputGraph.interactionNode;
      process.env.RELAYER_COMPLETE_URL = `${brokerOrigin()}/api/completions`;
      process.env.RELAYER_COMPLETE_TOKEN = context.completionBroker.token;
      const child = complete(inputGraph);
      observed.childCompletionId = child.completionId;

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
}

async function startRecursiveStack(observed, {
  temporalFeatures = RECURSIVE_TEMPORAL_FEATURES,
  implementationFactory,
} = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-recursive-e2e-"));
  directories.push(dataDirectory);
  const configurationPath = join(dataDirectory, "fixture-recursive.yaml");
  await writeFile(configurationPath, [
    "schemaVersion: 1",
    "name: fixture-recursive",
    "implementation: fixture.recursive",
    "implementationVersion: 1",
    "permissionBindings:",
    "  ask: {}",
    "  auto: {}",
    "  full: {}",
    "modelCompatibility:",
    "  - providerId: codex",
    "executionAccessContracts: [managed-runtime@1]",
    "settings: {}",
    "",
  ].join("\n"));

  let proxy;
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: dataDirectory,
    graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
    configurationPaths: [configurationPath],
    temporalFeatures,
    additionalImplementations: {
      "fixture.recursive": implementationFactory ?? recursiveFixtureFactory(observed, () => proxy.origin),
    },
    acquireProviderExecution: async (providerId) => ({
      definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
      descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
      runtime: { async executionAccess() { return { kind: "managed-runtime", environment: {} }; } },
      async release() {},
    }),
  });
  services.push(runtime);
  const runtimeSession = await runtime.start();
  const product = new RelayerAppServerService({
    userDataDirectory: dataDirectory,
    binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
    webDirectory: join(repositoryRoot, "desktop", "renderer"),
    permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
    runtimeSession,
    defaultHarnessConfiguration: "fixture-recursive",
    allowHarnessOverride: true,
  });
  services.push(product);
  const session = await product.start();
  proxy = await countingBrokerProxy(session.origin);
  await product.publishProviderCatalog({
    providerId: "codex",
    label: "Fixture provider",
    connected: true,
    models: [{ id: "fixture-model", label: "Fixture model", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }],
    systemFamily: { key: "codex", name: "Codex", modelIds: ["fixture-model"] },
  });
  const family = await productRequest(session, "/api/model-families", {
    method: "POST",
    body: JSON.stringify({
      name: "Fixture models",
      enabled: true,
      members: [{ providerId: "codex", modelId: "fixture-model" }],
    }),
  });
  return {
    session,
    runtimeSession,
    proxy,
    selection: { familyId: family.id, providerId: "codex", modelId: "fixture-model" },
  };
}

async function productRequest(session, path, options = {}) {
  const response = await fetch(new URL(path, session.origin), {
    ...options,
    headers: {
      ...options.headers,
      Cookie: `${session.cookie.name}=${session.cookie.value}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(value)}`);
  return value;
}

async function waitForStatus(session, threadId, turnIndex, status, observed, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await productRequest(session, `/api/threads/${threadId}`);
    const turn = detail.interactions[turnIndex];
    if (turn?.completionStatus === status) return detail;
    if (turn?.completionStatus === "failed" && status !== "failed") {
      throw new Error(`Turn ${turnIndex + 1} failed: ${turn.completionError}\n${(observed.errors ?? []).join("\n")}`);
    }
    await new Promise((wait) => setTimeout(wait, 20));
  }
  throw new Error(`Turn ${turnIndex + 1} did not reach ${status}.`);
}

async function graphMetadata(runtimeSession, nodeId) {
  const response = await fetch(new URL(`api/control/interactions/${nodeId}`, `${runtimeSession.graphUrl}/`), {
    headers: { authorization: `Bearer ${runtimeSession.graphControlToken}` },
  });
  if (!response.ok) throw new Error(`graph metadata ${nodeId} failed (${response.status})`);
  return response.json();
}

// These prove the recursive seam against the real graph server, the real app server, and the
// real exported `complete(inputGraph)`, with no provider and no inference. Every earlier test
// of this seam mocked the transport, which is why four separate defects survived in it.
describe("recursive complete end to end", () => {
  it("provides broker authority only when temporal provider recursion is enabled", async () => {
    const enabled = {};
    const enabledStack = await startRecursiveStack(enabled, {
      implementationFactory: brokerScopeFixtureFactory(enabled),
    });
    const enabledThread = await productRequest(enabledStack.session, "/api/threads", {
      method: "POST",
      body: JSON.stringify({
        title: "Enabled broker preflight",
        initialMessage: "Observe enabled broker authority",
        harnessId: "fixture-recursive",
        permissionProfileId: "auto",
        modelSelection: enabledStack.selection,
      }),
    });
    await waitForStatus(enabledStack.session, enabledThread.id, 0, "accepted", enabled);

    const disabled = {};
    const disabledStack = await startRecursiveStack(disabled, {
      temporalFeatures: {},
      implementationFactory: brokerScopeFixtureFactory(disabled),
    });
    const disabledThread = await productRequest(disabledStack.session, "/api/threads", {
      method: "POST",
      body: JSON.stringify({
        title: "Disabled broker preflight",
        initialMessage: "Observe disabled broker authority",
        harnessId: "fixture-recursive",
        permissionProfileId: "auto",
        modelSelection: disabledStack.selection,
      }),
    });
    await waitForStatus(disabledStack.session, disabledThread.id, 0, "accepted", disabled);

    expect(enabled.completionBroker).toMatchObject({
      tokenPresent: true,
    });
    expect(new URL(enabled.completionBroker.url)).toMatchObject({
      protocol: "http:",
      hostname: "127.0.0.1",
      pathname: "/api/completions",
    });
    expect(disabled.completionBroker).toBeNull();
  }, 60_000);

  it("creates a real semantic child, advances the pointer, and settles the parent from the child's returned layer", async () => {
    const observed = { childDelayMs: 1_500 };
    const { session, runtimeSession, proxy, selection } = await startRecursiveStack(observed);

    const thread = await productRequest(session, "/api/threads", {
      method: "POST",
      body: JSON.stringify({
        title: "Recursive seam",
        initialMessage: "Delegate the hard half",
        harnessId: "fixture-recursive",
        permissionProfileId: "auto",
        modelSelection: selection,
      }),
    });
    const detail = await waitForStatus(session, thread.id, 0, "accepted", observed);
    const parent = detail.interactions[0];

    // 1. The agent's own complete() call produced a real semantic child.
    expect(observed.childCompletionId).toBe(observed.preparedChild);
    const child = detail.interactions.find((turn) => turn.graphNodeId === observed.childCompletionId);
    expect(child, "the child is a durable product interaction").toBeTruthy();
    expect(child.completionStatus).toBe("accepted");
    const childMetadata = await graphMetadata(runtimeSession, observed.childCompletionId);
    expect(childMetadata.invocation.sourceInteractionNodeId).toBe(parent.graphNodeId);

    // 2. The parent consumed the child's returned layer, not a fabricated one.
    expect(observed.childRootLayer.nodes.map((node) => node.title)).toEqual(["Delegated finding"]);
    expect(observed.awaitedMs).toBeGreaterThan(1_000);

    // 3. Both pointers advanced through numbered outbox revisions.
    const projection = await productRequest(
      session,
      `/api/state?currentProjectionAfter=0&currentProjectionCompletionId=${observed.childCompletionId}`,
    );
    const sequence = (completionId) => projection.currentProjection.events
      .filter((event) => event.completionId === completionId)
      .map((event) => [event.revision, event.previousRevision, event.lifecycle]);
    expect(sequence(parent.graphNodeId)).toEqual([
      [0, null, "active"],
      [1, 0, "active"],
      [2, 1, "succeeded"],
    ]);
    expect(sequence(observed.childCompletionId)).toEqual([
      [0, null, "active"],
      [1, 0, "active"],
      [2, 1, "succeeded"],
    ]);

    // 4. Awaiting a 1.5s child cost a handful of requests, not one every 100ms.
    const resultRequests = proxy.requests.filter((request) => request.includes("/result"));
    expect(resultRequests.length).toBeLessThanOrEqual(5);
    expect(resultRequests.at(-1)).toMatch(/afterRevision=\d+$/);
    expect(proxy.requests.filter((request) => request.endsWith("/api/completions"))).toHaveLength(1);
  }, 60_000);

  it("stops a child on its parent's request and keeps the child's retained current", async () => {
    const observed = { childBlocks: true };
    const { session, runtimeSession, proxy, selection } = await startRecursiveStack(observed);

    const thread = await productRequest(session, "/api/threads", {
      method: "POST",
      body: JSON.stringify({
        title: "Recursive stop",
        initialMessage: "Delegate the hard half",
        harnessId: "fixture-recursive",
        permissionProfileId: "auto",
        modelSelection: selection,
      }),
    });
    await waitForStatus(session, thread.id, 0, "accepted", observed);

    // The child reports stopped, not failed, and keeps the layer it had published.
    expect(observed.stoppedChild.lifecycle).toBe("stopped");
    expect(observed.stoppedChild.revision).toBeGreaterThan(1);
    expect(observed.stoppedChild.currentLayerId).not.toBeNull();
    expect(observed.stoppedChild.safeReason).toBe("cancelled_by_user");
    const childMetadata = await graphMetadata(runtimeSession, observed.childCompletionId);
    expect(childMetadata.invocation.sourceInteractionNodeId).toBeTruthy();
    expect(proxy.requests.filter((request) => request.endsWith("/stop"))).toHaveLength(1);
  }, 60_000);
});
