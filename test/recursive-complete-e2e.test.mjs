import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LayerLayoutObject,
  LayerObject,
  NodeObject,
  NodePlacementObject,
  RelayerGraphClient,
} from "@relayer/graph-client";

import {
  GraphCompleteRuntimeService,
  RECURSIVE_TEMPORAL_FEATURES,
} from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import {
  RECURSIVE_FIXTURE_CHILD_TASK as CHILD_TASK,
  recursiveCompleteFixtureFactory as recursiveFixtureFactory,
} from "./support/recursive-complete-fixture.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const services = [];
const directories = [];
const closers = [];

function centered(node) {
  return new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)]);
}

async function teardown() {
  for (const close of closers.splice(0).reverse()) await close();
  for (const service of services.splice(0).reverse()) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
}

afterEach(teardown);

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
    "complete:",
    "  agentAuthored: true",
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
      "fixture.recursive": implementationFactory ?? recursiveFixtureFactory(
        observed,
        () => `${proxy.origin}/api/completions`,
      ),
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

// This proves the recursive seam against the real graph server, the real app server, and the
// real exported `complete(inputGraph)`, with no provider and no inference. Every earlier test
// of this seam mocked the transport, which is why four separate defects survived in it.
describe("recursive complete end to end", () => {
  it("gates broker authority on temporal features, settles a real semantic child, and honours a parent-requested stop", async () => {
    // Phase 1: broker authority is provided only when temporal provider recursion is enabled.
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

    expect(enabled.completionBroker, "the enabled arm receives broker authority").toMatchObject({
      tokenPresent: true,
    });
    expect(new URL(enabled.completionBroker.url), "the broker url is the loopback product completions API").toMatchObject({
      protocol: "http:",
      hostname: "127.0.0.1",
      pathname: "/api/completions",
    });
    expect(disabled.completionBroker, "the disabled arm receives no broker authority").toBeNull();
    await teardown();

    // Phase 2: the agent's own complete() call creates a real semantic child, advances both
    // pointers, and settles the parent from the child's returned layer.
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

    expect(observed.childCompletionId, "the agent's own complete() call produced a real semantic child")
      .toBe(observed.preparedChild);
    const child = detail.interactions.find((turn) => turn.graphNodeId === observed.childCompletionId);
    expect(child, "the child is a durable product interaction").toBeTruthy();
    expect(child.completionStatus, "the child settled accepted").toBe("accepted");
    const childMetadata = await graphMetadata(runtimeSession, observed.childCompletionId);
    expect(childMetadata.invocation.sourceInteractionNodeId, "the graph invocation names the parent")
      .toBe(parent.graphNodeId);

    expect(observed.childRootLayer.nodes.map((node) => node.title), "the parent consumed the child's returned layer, not a fabricated one")
      .toEqual(["Delegated finding"]);
    expect(observed.awaitedMs, "the parent actually awaited the child").toBeGreaterThan(1_000);

    const projection = await productRequest(
      session,
      `/api/state?currentProjectionAfter=0&currentProjectionCompletionId=${observed.childCompletionId}`,
    );
    const sequence = (completionId) => projection.currentProjection.events
      .filter((event) => event.completionId === completionId)
      .map((event) => [event.revision, event.previousRevision, event.lifecycle]);
    expect(sequence(parent.graphNodeId), "the parent pointer advanced through numbered outbox revisions").toEqual([
      [0, null, "active"],
      [1, 0, "active"],
      [2, 1, "succeeded"],
    ]);
    expect(sequence(observed.childCompletionId), "the child pointer advanced through numbered outbox revisions").toEqual([
      [0, null, "active"],
      [1, 0, "active"],
      [2, 1, "succeeded"],
    ]);

    const resultRequests = proxy.requests.filter((request) => request.includes("/result"));
    expect(resultRequests.length, "awaiting a 1.5s child costs a handful of requests, not one every 100ms")
      .toBeLessThanOrEqual(5);
    expect(resultRequests.at(-1), "the final poll resumes after a revision").toMatch(/afterRevision=\d+$/);
    expect(proxy.requests.filter((request) => request.endsWith("/api/completions")), "exactly one completion was prepared")
      .toHaveLength(1);
    await teardown();

    // Phase 3: a parent-requested stop reports stopped, keeps the child's retained current.
    const stopped = { childBlocks: true };
    const stopStack = await startRecursiveStack(stopped);

    const stopThread = await productRequest(stopStack.session, "/api/threads", {
      method: "POST",
      body: JSON.stringify({
        title: "Recursive stop",
        initialMessage: "Delegate the hard half",
        harnessId: "fixture-recursive",
        permissionProfileId: "auto",
        modelSelection: stopStack.selection,
      }),
    });
    await waitForStatus(stopStack.session, stopThread.id, 0, "accepted", stopped);

    expect(stopped.stoppedChild.lifecycle, "the child reports stopped, not failed").toBe("stopped");
    expect(stopped.stoppedChild.revision, "the child had advanced before the stop").toBeGreaterThan(1);
    expect(stopped.stoppedChild.currentLayerId, "the child keeps the layer it had published").not.toBeNull();
    expect(stopped.stoppedChild.safeReason, "the stop is attributed to the user").toBe("cancelled_by_user");
    const stoppedMetadata = await graphMetadata(stopStack.runtimeSession, stopped.childCompletionId);
    expect(stoppedMetadata.invocation.sourceInteractionNodeId, "the stopped child still names its parent").toBeTruthy();
    expect(stopStack.proxy.requests.filter((request) => request.endsWith("/stop")), "exactly one broker stop request")
      .toHaveLength(1);
  }, 180_000);
});
