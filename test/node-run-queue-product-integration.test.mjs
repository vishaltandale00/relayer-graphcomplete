import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { GraphCompleteRuntimeService, RECURSIVE_TEMPORAL_FEATURES } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { completionContractFixtureFactory } from "../scripts/fixtures/completion-contract-harness.mjs";

// PAR-009 (#718), on the durable invoke path: the real app server, graph server and harness host
// with a deterministic fixture harness and no paid inference. One reusable action on one node is
// invoked three times. The second waits as queued and starts once the first is accepted, and its
// child reads that result when it starts. The third is stopped while queued: its graph current
// stops, and it never reaches the harness. The fixture children wait a second before returning,
// which keeps the later runs queued while the test acts on them.
it("queues durable invokes on one node, starts each after the run ahead, and stops a queued one before it starts", async () => {
  const repository = resolve(import.meta.dirname, "..");
  const directory = await mkdtemp(join(tmpdir(), "relayer-node-queue-"));
  const config = join(directory, "fixture.yaml");
  const observed = { contracts: [], advances: [], invocations: [], results: [], errors: [] };
  await writeFile(config, "schemaVersion: 1\nname: fixture-node-queue\nimplementation: fixture.node-queue\nimplementationVersion: 1\ncomplete:\n  agentAuthored: true\npermissionBindings:\n  ask: {}\n  auto: {}\n  full: {}\nmodelCompatibility:\n  - providerId: codex\nexecutionAccessContracts: [managed-runtime@1]\nsettings: {}\n");
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: directory, graphServerBinary: join(repository, "target/debug/relayer-graph-server"),
    configurationPaths: [config], temporalFeatures: RECURSIVE_TEMPORAL_FEATURES, interactionPermissions: true,
    additionalImplementations: { "fixture.node-queue": completionContractFixtureFactory(observed) },
    acquireProviderExecution: async (providerId) => ({
      definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
      descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
      runtime: { executionAccess: async () => ({ kind: "managed-runtime", environment: {} }) }, release: async () => {},
    }),
  });
  let product;
  try {
    const runtimeSession = await runtime.start();
    product = new RelayerAppServerService({
      userDataDirectory: directory, binaryPath: join(repository, "target/debug/relayer-app-server"),
      webDirectory: join(repository, "desktop/renderer"), permissionCatalogPath: join(repository, "permissions/desktop.json"),
      runtimeSession, defaultHarnessConfiguration: "fixture-node-queue",
    });
    const session = await product.start();
    const request = async (path, options = {}) => {
      const response = await fetch(`${session.origin}${path}`, { ...options, headers: { cookie: `${session.cookie.name}=${session.cookie.value}`, "content-type": "application/json", ...options.headers } });
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(JSON.stringify(value)), { status: response.status });
      return value;
    };
    const graphCurrent = async (nodeId) => {
      const response = await fetch(new URL(`/api/control/interactions/${nodeId}/current`, runtimeSession.graphUrl), {
        headers: { Authorization: `Bearer ${runtimeSession.graphControlToken}` },
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    await product.seedProviderCatalog({ providerId: "codex", label: "Fixture", connected: true, models: [{ id: "fixture-model", label: "Fixture", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }] });
    const family = await request("/api/model-families", { method: "POST", body: JSON.stringify({ name: "Fixture", enabled: true, members: [{ providerId: "codex", modelId: "fixture-model" }] }) });
    const thread = await request("/api/threads", { method: "POST", body: JSON.stringify({ title: "Vacation queue", initialMessage: "Choose a vacation destination", modelSelection: { familyId: family.id, providerId: "codex", modelId: "fixture-model" } }) });
    const until = async (predicate) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const detail = await request(`/api/threads/${thread.id}`);
        if (predicate(detail)) return detail;
        await new Promise((resolveWait) => setTimeout(resolveWait, 40));
      }
      throw new Error(JSON.stringify({ detail: await request(`/api/threads/${thread.id}`), observed }));
    };
    const statusOf = (detail, id) => detail.interactions.find((interaction) => interaction.id === id)?.completionStatus;
    const parent = (await until((detail) => statusOf(detail, thread.rootInteractionId) === "accepted")).interactions[0];
    const layer = parent.completionOutput.rootLayer;
    const destination = layer.actions.find((action) => (action.input ?? action).prompt === "Destination");
    const analyze = layer.actions.find((action) => action.kind === "invoke");
    const invokeWith = async (text, key) => {
      const draft = await request(`/api/threads/${thread.id}/input-draft`);
      const committed = await request(`/api/threads/${thread.id}/input-draft/attachments`, { method: "PUT", body: JSON.stringify({ occurrence: { presentingInteractionNodeId: parent.graphNodeId, presentingLayerId: layer.layer.id, actionId: destination.id }, value: { text }, expectedRevision: draft.revision }) });
      return request(`/api/threads/${thread.id}/interactions/${parent.id}/actions/${analyze.id}/invoke`, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ inputDraftRevision: committed.revision }) });
    };

    const first = await invokeWith("Kyoto", "kyoto");
    expect(first.invocation).toMatchObject({ durable: true, reusable: true });
    expect(first.interaction.completionStatus).toBe("running");
    const second = await invokeWith("Lisbon", "lisbon");
    expect(second.interaction.completionStatus).toBe("queued");
    const third = await invokeWith("Porto", "porto");
    expect(third.interaction.completionStatus).toBe("queued");

    // The queued third run stops without starting: its graph current stops, no contract reaches it.
    const stopped = await request(`/api/threads/${thread.id}/interactions/${third.interaction.id}/stop`, { method: "POST" });
    expect(["submitted", "stopped"]).toContain(stopped.completionStatus);
    const afterStop = await until((detail) => statusOf(detail, third.interaction.id) === "stopped");
    const stoppedRun = afterStop.interactions.find((interaction) => interaction.id === third.interaction.id);
    expect(stoppedRun.graphNodeId).not.toBeNull();
    expect((await graphCurrent(stoppedRun.graphNodeId)).lifecycle).toBe("stopped");
    expect(statusOf(afterStop, second.interaction.id)).toBe("queued");

    // The first run is accepted, and only then does the second start. Its child read the graph
    // when it started, so its analysis includes the first run's accepted result.
    const done = await until((detail) => statusOf(detail, second.interaction.id) === "accepted");
    expect(statusOf(done, first.interaction.id)).toBe("accepted");
    const secondRun = done.interactions.find((interaction) => interaction.id === second.interaction.id);
    const firstRun = done.interactions.find((interaction) => interaction.id === first.interaction.id);
    const contractNodes = observed.contracts.map((contract) => contract.interactionNodeId);
    expect(contractNodes.indexOf(secondRun.graphNodeId)).toBeGreaterThan(contractNodes.indexOf(firstRun.graphNodeId));
    expect(contractNodes).not.toContain(stoppedRun.graphNodeId);
    expect(secondRun.completionOutput.rootLayer.nodes[0].detail).toContain("Vacation comparison — Kyoto");
    expect(observed.errors).toEqual([]);
  } finally {
    await product?.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
