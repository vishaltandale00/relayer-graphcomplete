import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { nativeExecutionHandle } from "@relayer/harness-host";
import { complete } from "../src/index.js";
import { EvalService } from "../desktop/eval-main/eval-service.mjs";
import { createDesktopGraphRuntime } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { RelayerGraphClient, NodeObject, LayerObject, LayerLayoutObject, NodePlacementObject } from "../packages/graph-client/dist/index.js";

const root = resolve(import.meta.dirname, "..");
const services = [];
const directories = [];
afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// No inference: the real product prepares two calls through the real host and
// graph server and Eval, including a first-turn specialist whose trace export
// is consumed exactly once across the follow-up. A legacy configuration must
// acquire planning on NEW messages without rewriting the pinned configuration.
it("automatically prepares living plans on new product turns using a legacy supported harness configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relayer-living-plan-product-"));
  directories.push(directory);
  const configurationPath = join(directory, "fixture.yaml");
  await writeFile(configurationPath, "schemaVersion: 1\nname: fixture-living-plan\nimplementation: codex.basic\nimplementationVersion: 1\ncomplete:\n  agentAuthored: true\ngraphCapabilityProfile:\n  search: query-v1\npermissionBindings:\n  ask: {}\n  auto: {}\n  full: {}\nmodelCompatibility:\n  - providerId: codex\nexecutionAccessContracts: [managed-runtime@1]\nsettings: {}\n");
  const observed = [];
  const children = [];
  const traceExports = new Map();
  const runtime = createDesktopGraphRuntime({
    userDataDirectory: directory,
    startupTimeoutMs: 30_000,
    graphServerBinary: join(root, "target/debug/relayer-graph-server"),
    configurationPaths: [configurationPath],
    temporalFeatures: { schemaRead: true, rootCurrentWrite: true, projectionUi: true, invokeResolution: true, providerRecursion: true },
    candidateTrace: { directory: join(directory, "spool"), policy: { mode: "required", requiredFeatures: {}, includeNativeArtifacts: false, maxBytesPerTurn: 1_000_000, maxEventsPerTurn: 1_000 } },
    additionalImplementations: { "codex.basic": () => ({
      supportsInvokedComplete: true,
      traceSupport: () => ({ prompt: "none", messages: "none", reasoningSummaries: "none", modelCalls: "none", toolCalls: "none", usage: "none", childStreams: "none", nativeArtifacts: "none" }), state: () => ({}),
      complete(context) {
        return nativeExecutionHandle(author(context).catch(error => { console.error("AUTHOR_ERROR", error); throw error; }), undefined, Promise.resolve({ schemaVersion: 1, provider: "codex", sessionId: `fixture-${context.inputGraph.id}` }));
      },
    }) },
    acquireProviderExecution: async (providerId) => ({
      definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
      descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
      runtime: { async executionAccess() { return { kind: "managed-runtime", environment: {} }; } }, async release() {},
    }),
  });
  async function author(context) {
    const graph = new RelayerGraphClient(context.graph.acquireCapability());
    const contract = await graph.getContract();
    expect(contract.returnRequirements).toContainEqual({ kind: "plan.contribution" });
    const found = await graph.search({ queryContractVersion: 1,
      query: "MATCH (n:Content) WHERE n.kind = $kind RETURN n AS plan ORDER BY plan DESC LIMIT 8",
      parameters: { kind: { type: "string", value: "interaction-plan" } } });
    const standalone = context.inputGraph.detail.includes("PUBLIC_SHARE_BOUNDARY");
    const prior = standalone ? undefined : observed.at(-1);
    if (prior) {
      expect(JSON.stringify(found)).toContain(`content:${prior.node.id}`);
      const read = await graph.getPlan(prior.node.id);
      expect(read.interactionNodeId).toBe(prior.interactionNodeId);
    }
    const plan = await graph.publishPlan({ clientKey: "current", title: "Repair café", detail: prior
      ? "Budget resolved at $120; allocation updated. Interface: compare revised stations and ask remaining questions."
      : "Stations under review; budget awaiting user. Interface: useful overview and a budget decision." });
    if (prior) expect(plan.readPlanNodeIds).toContain(prior.node.id);
    if (!standalone) (context.origin.kind === "invoke" ? children : observed).push(plan);
    const answer = new NodeObject("info", "Repair café", "A useful response separate from the internal plan.", "concept", "answer");
    await graph.submitNode(answer);
    const layer = new LayerObject([answer], [], new LayerLayoutObject([new NodePlacementObject(answer, 0.5, 0.5)], "default"), "answer-layer");
    await graph.submitLayer(layer);
    await graph.addAction(context.inputGraph.id, { kind: "navigate", relation: "expand", label: "Response", target: layer, clientKey: "root" });
    for (const required of contract.returnRequirements) {
      if (required.kind === "navigate.response" && required.nodeId !== context.inputGraph.id) {
        await graph.addAction(required.nodeId, { kind: "navigate", relation: "reference", label: "Review findings", target: layer, clientKey: `integrated-${required.nodeId}` });
      }
    }
    if (!standalone && context.origin.kind === "root" && observed.length === 1) {
      const invocation = await graph.addAction(answer, { kind: "invoke", sourceLayer: layer, label: "Review intake", interactionText: "Review intake and safety", reusable: false, clientKey: "review" });
      const current = await graph.getCurrent();
      await graph.advanceCurrent(layer, current.headRevision, "working-overview");
      const input = await graph.prepareComplete(invocation);
      vi.stubEnv("RELAYER_COMPLETE_URL", context.completionBroker.url);
      vi.stubEnv("RELAYER_COMPLETE_TOKEN", context.completionBroker.token);
      const child = complete(input);
      await child.result;
      await graph.getPlan(children[0].node.id);
      observed[0] = await graph.publishPlan({ clientKey: "integrated", title: "Review incorporated", detail: "Review complete; budget remains pending. Interface: useful overview with review support." });
    }
    if (context.origin.kind === "invoke") {
      const current = await graph.getCurrent();
      await graph.advanceCurrent(layer, current.headRevision, "review-published");
    }
    await graph.submit(context.inputGraph.id);
  }
  services.push(runtime);
  const runtimeSession = await runtime.start();
  const product = new RelayerAppServerService({ userDataDirectory: directory, startupTimeoutMs: 30_000,
    binaryPath: join(root, "target/debug/relayer-app-server"), webDirectory: join(root, "desktop/renderer"),
    permissionCatalogPath: join(root, "permissions/desktop.json"), runtimeSession,
    defaultHarnessConfiguration: "fixture-living-plan", allowHarnessOverride: true });
  services.push(product);
  const session = await product.start();
  await product.seedProviderCatalog({ providerId: "codex", label: "Fixture", connected: true,
    models: [{ id: "fixture-model", label: "Fixture", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }],
    systemFamily: { key: "codex", name: "Codex", modelIds: ["fixture-model"] } });
  const family = await request(session, "/api/model-families", { name: "Fixture", enabled: true, members: [{ providerId: "codex", modelId: "fixture-model" }] });
  const modelSelection = { familyId: family.id, providerId: "codex", modelId: "fixture-model" };
  const evalService = await new EvalService({ stateFile: join(directory, "eval/test-runs.json"), productSession: session,
    configurationPaths: [configurationPath], targetKey: "macos-arm64", candidateTraceRequired: true,
    selectModel: async () => ({ ...modelSelection, harnessId: "fixture-living-plan" }),
    candidateTraceExporter: (id, target, correlation) => {
      traceExports.set(id, (traceExports.get(id) ?? 0) + 1);
      return runtime.exportCandidateTrace(id, target, correlation);
    } }).open();
  const created = await evalService.createRun({ testCaseIds: ["living-plan.interaction-continuity"], harnessConfigurationNames: ["fixture-living-plan"], judgeConfigurationName: "deterministic-graph-contract" });
  const deadline = Date.now() + 40_000;
  let run;
  do {
    run = evalService.getRun(created.id);
    if (["passed", "failed", "error"].includes(run.status)) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 30));
  } while (Date.now() < deadline);
  expect(run.status, JSON.stringify(run.executions.map(e => ({ error: e.error, checks: e.checks })))).toBe("passed");
  const execution = run.executions[0];
  expect(execution.semanticChildren).toHaveLength(1);
  expect(execution.semanticChildren[0].candidateTrace.status).toBe("complete");
  expect([...traceExports.values()]).toEqual([1, 1, 1]);
  const thread = { id: execution.threadIds[0] };
  const detail = await request(session, `/api/threads/${thread.id}`);
  expect(observed).toHaveLength(2);
  expect(new Set(observed.map(plan => plan.interactionNodeId)).size).toBe(2);
  expect(children).toHaveLength(1);
  for (const turn of detail.interactions) {
    expect(turn.completionOutput.rootLayer.nodes.map(node => node.kind)).toEqual(["concept"]);
    expect(JSON.stringify(turn.completionOutput)).not.toContain("interaction-plan");
  }
  const exported = new TextDecoder().decode(await product.exportConversation(thread.id));
  expect(exported).not.toContain("interaction-plan");
  expect(exported).not.toContain("Interface: compare revised stations");
  // Native callable history requires a newer hosted share format. Exercise the
  // supported ordinary share serializer on a separate planned response instead.
  const shareThread = await request(session, "/api/threads", { title: "Share boundary", initialMessage: "PUBLIC_SHARE_BOUNDARY", permissionProfileId: "auto", harnessId: "fixture-living-plan", modelSelection });
  const shareDeadline = Date.now() + 30_000;
  let shareTurn;
  do {
    shareTurn = (await request(session, `/api/threads/${shareThread.id}`)).interactions[0];
    if (shareTurn.completionStatus === "accepted") break;
    if (shareTurn.completionStatus === "failed") throw new Error(shareTurn.completionError);
    await new Promise(resolveWait => setTimeout(resolveWait, 30));
  } while (Date.now() < shareDeadline);
  expect(shareTurn.completionStatus).toBe("accepted");
  const shared = new TextDecoder().decode(await product.exportShareSnapshot(shareThread.id, "Repair café"));
  expect(shared).not.toContain("interaction-plan");
  expect(shared).not.toContain("Interface: useful overview");
}, 90_000);

async function request(session, path, body) {
  const response = await fetch(new URL(path, session.origin), { method: body === undefined ? "GET" : "POST",
    headers: { Cookie: `${session.cookie.name}=${session.cookie.value}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Product request failed (${response.status}).`);
  return value;
}
