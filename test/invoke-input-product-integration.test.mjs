import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { GraphCompleteRuntimeService, RECURSIVE_TEMPORAL_FEATURES } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { completionContractFixtureFactory } from "../scripts/fixtures/completion-contract-harness.mjs";

it("seals connected inputs, clears exact submissions, recovers their key, and preserves other inputs", async () => {
  const repository = resolve(import.meta.dirname, "..");
  const directory = await mkdtemp(join(tmpdir(), "relayer-invoke-binding-"));
  const config = join(directory, "fixture.yaml");
  const observed = { contracts: [], advances: [], invocations: [], results: [], errors: [] };
  await writeFile(config, "schemaVersion: 1\nname: fixture-bindings\nimplementation: fixture.bindings\nimplementationVersion: 1\ncomplete:\n  agentAuthored: true\npermissionBindings:\n  ask: {}\n  auto: {}\n  full: {}\nmodelCompatibility:\n  - providerId: codex\nexecutionAccessContracts: [managed-runtime@1]\nsettings: {}\n");
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: directory, graphServerBinary: join(repository, "target/debug/relayer-graph-server"),
    configurationPaths: [config], temporalFeatures: RECURSIVE_TEMPORAL_FEATURES, interactionPermissions: true,
    additionalImplementations: { "fixture.bindings": completionContractFixtureFactory(observed, { bindingTest: true }) },
    acquireProviderExecution: async (providerId) => ({
      definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
      descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
      runtime: { executionAccess: async () => ({ kind: "managed-runtime", environment: {} }) }, release: async () => {},
    }),
  });
  let product;
  let metadataProxy;
  try {
    const productOptions = { userDataDirectory: directory, binaryPath: join(repository, "target/debug/relayer-app-server"), webDirectory: join(repository, "desktop/renderer"), permissionCatalogPath: join(repository, "permissions/desktop.json"), runtimeSession: await runtime.start(), defaultHarnessConfiguration: "fixture-bindings", enableReadOnlySession: true };
    product = new RelayerAppServerService(productOptions);
    let session = await product.start();
    const request = async (path, options = {}) => {
      const response = await fetch(`${session.origin}${path}`, { ...options, headers: { cookie: `${session.cookie.name}=${session.cookie.value}`, "content-type": "application/json", ...options.headers } });
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(JSON.stringify(value)), { status: response.status });
      return value;
    };
    await product.seedProviderCatalog({ providerId: "codex", label: "Fixture", connected: true, models: [{ id: "fixture-model", label: "Fixture", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }] });
    const family = await request("/api/model-families", { method: "POST", body: JSON.stringify({ name: "Fixture", enabled: true, members: [{ providerId: "codex", modelId: "fixture-model" }] }) });
    const thread = await request("/api/threads", { method: "POST", body: JSON.stringify({ title: "Vacation inputs", initialMessage: "Choose a vacation destination", modelSelection: { familyId: family.id, providerId: "codex", modelId: "fixture-model" } }) });
    const allowedRefusals = new Map();
    const accepted = async (count, expectedIds = []) => {
      let detail;
      for (let attempt = 0; attempt < 100; attempt++) {
        detail = await request(`/api/threads/${thread.id}`);
        const unexpectedFailure = detail.interactions.find(interaction => interaction.completionStatus === "failed"
          && !allowedRefusals.has(interaction.id));
        if (unexpectedFailure || detail.interactions.length > count + allowedRefusals.size) throw new Error(JSON.stringify({ detail, observed }));
        if (detail.interactions.length === count + allowedRefusals.size
          && expectedIds.every(id => detail.interactions.some(interaction => interaction.id === id && interaction.completionStatus === "accepted"))
          && detail.interactions.every(interaction => interaction.completionStatus === "accepted"
            || (allowedRefusals.has(interaction.id) && interaction.completionStatus === "failed"))) return detail;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      throw new Error(JSON.stringify({ detail, observed }));
    };
    const parent = (await accepted(1)).interactions[0];
    const layer = parent.completionOutput.rootLayer;
    const destination = layer.actions.find((action) => (action.input ?? action).prompt === "Destination");
    const unrelated = layer.actions.find((action) => (action.input ?? action).prompt === "Unrelated notes");
    const consumers = layer.actions.filter((action) => action.kind === "invoke");
    expect(consumers.map((action) => action.inputActionIds)).toEqual([[destination.id], [destination.id]]);
    const invoke = (action, revision, key) => request(`/api/threads/${thread.id}/interactions/${parent.id}/actions/${action.id}/invoke`, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ inputDraftRevision: revision }) });
    const graphInventory = async () => {
      const response = await fetch(new URL("/api/control/accepted-closures", productOptions.runtimeSession.graphUrl), {
        method: "POST", headers: { Authorization: `Bearer ${productOptions.runtimeSession.graphControlToken}`, "content-type": "application/json" },
        body: JSON.stringify({ interactionNodeIds: [parent.graphNodeId] }),
      });
      expect(response.status).toBe(200);
      const snapshot = await response.json();
      expect(snapshot.closures).toHaveLength(1);
      expect(snapshot.closures[0].nodeId).toBe(parent.graphNodeId);
      expect(Array.isArray(snapshot.invocations)).toBe(true);
      return snapshot.invocations.map(call => call.invocation.invocationKey).sort();
    };
    const recordRefusal = async (key, action, beforeDraft, expectedNativeKeys, contractCount) => {
      const detail = await request(`/api/threads/${thread.id}`);
      const receipts = detail.actionInvocations.filter(call => call.invocationKey === key);
      expect(receipts).toHaveLength(1);
      const receipt = receipts[0];
      expect(receipt).toMatchObject({ sourceInteractionId: parent.id, actionId: action.id, durable: false,
        resultCompletionStatus: "failed", preparationRejected: true, preparationRecoverable: false });
      const refused = detail.interactions.find(interaction => interaction.id === receipt.resultInteractionId);
      expect(refused).toMatchObject({ completionStatus: "failed", graphNodeId: null });
      expect(refused.completionOutput).toBeNull();
      expect(await request(`/api/threads/${thread.id}/input-draft`)).toEqual(beforeDraft);
      expect(await graphInventory()).toEqual(expectedNativeKeys);
      expect(observed.contracts).toHaveLength(contractCount);
      allowedRefusals.set(refused.id, receipt);
      return refused;
    };
    const emptyDraft = await request(`/api/threads/${thread.id}/input-draft`);
    const initialContracts = observed.contracts.length;
    await expect(invoke(consumers[0], 0, "missing")).rejects.toMatchObject({ status: 422 });
    const missing = await recordRefusal("missing", consumers[0], emptyDraft, [], initialContracts);
    const commit = (action, text, revision) => request(`/api/threads/${thread.id}/input-draft/attachments`, { method: "PUT", body: JSON.stringify({ occurrence: { presentingInteractionNodeId: parent.graphNodeId, presentingLayerId: layer.layer.id, actionId: action.id }, value: { text }, expectedRevision: revision }) });
    await commit(destination, "Kyoto", 0);
    const mixed = await commit(unrelated, "Not an argument", 1);
    expect(mixed.attachments.map(input => [input.occurrence.actionId, input.composerEligible])).toEqual([[destination.id, false], [unrelated.id, true]]);
    const operatorToken = "ordinary-input-operator-fixture-token";
    const registered = await fetch(`${session.origin}/api/internal/input-operator-sessions`, { method: "POST", headers: { cookie: `${session.cookie.name}=${session.cookie.value}`, "content-type": "application/json" }, body: JSON.stringify({ token: operatorToken, threadId: thread.id, occurrences: [mixed.attachments.find(a => a.composerEligible).occurrence] }) });
    expect(registered.status).toBe(204);
    const ordinaryRequest = { text: "", inputId: "ordinary-chat", inputDraftRevision: mixed.revision };
    const ordinary = await request(`/api/threads/${thread.id}/interactions`, { method: "POST", headers: { cookie: `${session.readOnlyCookie.name}=${session.readOnlyCookie.value}; relayer_input_operator=${operatorToken}` }, body: JSON.stringify(ordinaryRequest) });
    const ordinaryDetail = await accepted(2, [parent.id, ordinary.id]);
    expect(ordinaryDetail.interactions.find(interaction => interaction.id === ordinary.id).submittedInputs.map(a => [a.action.prompt, a.value.text])).toEqual([["Unrelated notes", "Not an argument"]]);
    const ordinaryContract = observed.contracts.find(contract => contract.interactionNodeId === ordinary.graphNodeId);
    expect(ordinaryContract.input.answers.map(answer => [answer.question.prompt, answer.value.text])).toEqual([["Unrelated notes", "Not an argument"]]);
    const afterSend = await request(`/api/threads/${thread.id}/input-draft`);
    expect(afterSend.attachments.map(input => input.occurrence.actionId)).toEqual([destination.id]);
    await expect(request(`/api/threads/${thread.id}/interactions`, { method: "POST", headers: { cookie: `${session.readOnlyCookie.name}=${session.readOnlyCookie.value}; relayer_input_operator=${operatorToken}` }, body: JSON.stringify({ text: "", inputId: "operator-bound-only", inputDraftRevision: afterSend.revision }) })).rejects.toThrow();
    const replaySend = await request(`/api/threads/${thread.id}/interactions`, { method: "POST", body: JSON.stringify(ordinaryRequest) });
    expect(replaySend.id).toBe(ordinary.id);
    const { inputDraftRevision: _revision, ...unversionedReplay } = ordinaryRequest;
    expect((await request(`/api/threads/${thread.id}/interactions`, { method: "POST", body: JSON.stringify(unversionedReplay) })).id).toBe(ordinary.id);
    await expect(request(`/api/threads/${thread.id}/interactions`, { method: "POST", body: JSON.stringify({ text: "", inputId: "bound-only", inputDraftRevision: afterSend.revision }) })).rejects.toThrow();
    expect((await request(`/api/threads/${thread.id}`)).interactions.map(({id, text, completionStatus}) => ({id, text, completionStatus}))).toEqual([
      { id: parent.id, text: parent.text, completionStatus: "accepted" },
      { id: missing.id, text: missing.text, completionStatus: "failed" },
      { id: ordinary.id, text: ordinary.text, completionStatus: "accepted" },
    ]);
    const draft = await commit(unrelated, "Retain this other answer", afterSend.revision);
    const first = await invoke(consumers[0], draft.revision, "first");
    await accepted(3, [parent.id, ordinary.id, first.interaction.id]);
    expect(first.invocation).toMatchObject({ durable: true, reusable: true });
    const firstContract = observed.contracts.find((contract) => contract.interactionNodeId === first.interaction.graphNodeId);
    expect(firstContract.input.answers.map((answer) => [answer.question.prompt, answer.value.text])).toEqual([["Destination", "Kyoto"]]);
    const cleared = await request(`/api/threads/${thread.id}/input-draft`);
    expect(cleared.attachments.map((input) => input.occurrence.actionId)).toEqual([unrelated.id]);
    const replay = await invoke(consumers[0], draft.revision, "first");
    expect(replay.created).toBe(false);
    expect(replay.interaction.id).toBe(first.interaction.id);
    const nextDraft = await commit(destination, "Lisbon", cleared.revision);
    await expect(invoke(consumers[0], nextDraft.revision, "first")).rejects.toThrow();
    expect((await request(`/api/threads/${thread.id}/input-draft`)).attachments).toHaveLength(2);
    const second = await invoke(consumers[1], nextDraft.revision, "second");
    await accepted(4, [parent.id, ordinary.id, first.interaction.id, second.interaction.id]);
    expect(second.invocation).toMatchObject({ durable: true, reusable: false });
    const secondContract = observed.contracts.find((contract) => contract.interactionNodeId === second.interaction.graphNodeId);
    expect(secondContract.input.answers.map((answer) => answer.question.prompt)).toEqual(["Destination"]);
    expect(secondContract.input.answers.map((answer) => answer.value.text)).toEqual(["Lisbon"]);
    expect(second.interaction.graphNodeId).not.toBe(first.interaction.graphNodeId);
    const afterSecond = await request(`/api/threads/${thread.id}/input-draft`);
    expect(afterSecond.attachments.map((input) => input.occurrence.actionId)).toEqual([unrelated.id]);
    const thirdDraft = await commit(destination, "Berlin", afterSecond.revision);
    const beforeSingleRefusalContracts = observed.contracts.length;
    await expect(invoke(consumers[1], thirdDraft.revision, "another-single-call")).rejects.toThrow();
    const spent = await recordRefusal("another-single-call", consumers[1], thirdDraft, ["first", "second"], beforeSingleRefusalContracts);
    expect((await request(`/api/threads/${thread.id}/input-draft`)).attachments).toHaveLength(2);
    await expect(invoke(consumers[0], draft.revision, "stale")).rejects.toThrow();
    const finalDetail = await accepted(4, [parent.id, ordinary.id, first.interaction.id, second.interaction.id]);
    expect(finalDetail.interactions.map(interaction => interaction.id)).toEqual([parent.id, missing.id, ordinary.id, first.interaction.id, second.interaction.id, spent.id]);
    expect(finalDetail.actionInvocations.filter(call => call.preparationRejected).map(call => call.resultInteractionId)).toEqual([missing.id, spent.id]);
    const records = Buffer.from(await product.exportConversation(thread.id)).toString("utf8").trimEnd().split("\n").map(JSON.parse);
    const exportedOrdinary = records.find(record => record.recordType === "turn" && record.sequence === ordinary.sequence);
    expect(exportedOrdinary.submittedInputs.map(a => [a.action.prompt, a.value.text])).toEqual([["Unrelated notes", "Not an argument"]]);
    const beforeReopen = await request(`/api/threads/${thread.id}/input-draft`);
    await product.close();
    product = new RelayerAppServerService(productOptions);
    session = await product.start();
    const reopened = await request(`/api/threads/${thread.id}`);
    for (const calls of [reopened.actionInvocations, (await request(`/api/state?threadId=${thread.id}`)).actionInvocations]) {
      expect(calls.map(a => [a.resultInteractionId, a.durable, a.reusable])).toEqual([
        [missing.id, false, false], [first.interaction.id, true, true], [second.interaction.id, true, false], [spent.id, false, false],
      ]);
      expect(calls.filter(a => a.preparationRejected).map(a => a.resultInteractionId)).toEqual([missing.id, spent.id]);
    }
    expect(await request(`/api/threads/${thread.id}/input-draft`)).toEqual(beforeReopen);
    expect(observed.errors).toEqual([]);

    // Preserve the real terminal calls and storage. Only the graph metadata
    // read by the production API projection is faulted at the transport seam.
    let metadataMode = "exact";
    const projectedMetadata = [];
    metadataProxy = createServer(async (incoming, outgoing) => {
      try {
        const body = await new Promise((resolve, reject) => {
          const chunks = [];
          incoming.on("data", chunk => chunks.push(chunk));
          incoming.on("end", () => resolve(Buffer.concat(chunks)));
          incoming.on("error", reject);
        });
        const upstream = await fetch(new URL(incoming.url, productOptions.runtimeSession.graphUrl), {
          method: incoming.method, headers: incoming.headers,
          ...(["GET", "HEAD"].includes(incoming.method) ? {} : { body }),
        });
        const text = await upstream.text();
        const isMetadata = /^\/api\/control\/interactions\/\d+$/.test(incoming.url) && upstream.ok;
        const value = isMetadata ? JSON.parse(text) : null;
        const isCallMetadata = value?.durableInvocation;
        if (isCallMetadata) {
          projectedMetadata.push([metadataMode, value.durableInvocation.childInteractionNodeId]);
          if (metadataMode === "unavailable") {
            outgoing.writeHead(503, { "content-type": "application/json" });
            outgoing.end(JSON.stringify({ error: "Fixture metadata unavailable" }));
            return;
          }
          if (metadataMode === "omitted-policy") delete value.durableInvocation.actionSnapshot.reusable;
          if (["sourceCompletionId", "sourceActionId", "childInteractionNodeId"].includes(metadataMode)) value.durableInvocation[metadataMode] += 1000;
          if (metadataMode === "invocationKey") value.durableInvocation.invocationKey += "-wrong";
        }
        outgoing.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
        outgoing.end(isMetadata ? JSON.stringify(value) : text);
      } catch (error) {
        outgoing.writeHead(502, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: error.message }));
      }
    });
    await new Promise(resolve => metadataProxy.listen(0, "127.0.0.1", resolve));
    await product.close();
    product = new RelayerAppServerService({ ...productOptions, runtimeSession: {
      ...productOptions.runtimeSession, graphUrl: `http://127.0.0.1:${metadataProxy.address().port}`,
    } });
    session = await product.start();
    for (const mode of ["exact", "sourceCompletionId", "sourceActionId", "childInteractionNodeId", "invocationKey", "omitted-policy", "unavailable", "exact"]) {
      metadataMode = mode;
      const before = projectedMetadata.length;
      for (const path of [`/api/threads/${thread.id}`, `/api/state?threadId=${thread.id}`]) {
        const calls = (await request(path)).actionInvocations;
        expect(calls.map(a => [a.actionId, a.resultInteractionId, a.durable])).toEqual([
          [consumers[0].id, missing.id, false], [consumers[0].id, first.interaction.id, true],
          [consumers[1].id, second.interaction.id, true], [consumers[1].id, spent.id, false],
        ]);
        const nativeCalls = calls.filter(a => [first.interaction.id, second.interaction.id].includes(a.resultInteractionId));
        expect(nativeCalls).toHaveLength(2);
        if (mode === "exact") expect(nativeCalls.map(a => a.reusable)).toEqual([true, false]);
        else expect(nativeCalls.every(a => !Object.hasOwn(a, "reusable"))).toBe(true);
      }
      const reads = projectedMetadata.slice(before);
      expect(reads.every(([observedMode]) => observedMode === mode)).toBe(true);
      expect([...new Set(reads.map(([, childId]) => childId))].sort()).toEqual([first.interaction.graphNodeId, second.interaction.graphNodeId].sort());
    }
    expect(await request(`/api/threads/${thread.id}/input-draft`)).toEqual(beforeReopen);
    expect(observed.errors).toEqual([]);
    await product.close();
    product = new RelayerAppServerService({ ...productOptions, runtimeSession: null });
    session = await product.start();
    for (const path of [`/api/threads/${thread.id}`, `/api/state?threadId=${thread.id}`]) {
      const calls = (await request(path)).actionInvocations;
      expect(calls.map(a => [a.resultInteractionId, a.durable])).toEqual([
        [missing.id, false], [first.interaction.id, true], [second.interaction.id, true], [spent.id, false],
      ]);
      const nativeCalls = calls.filter(a => [first.interaction.id, second.interaction.id].includes(a.resultInteractionId));
      expect(nativeCalls.every(a => !Object.hasOwn(a, "reusable"))).toBe(true);
      // The refusal proof was captured before persistence, so reopening without
      // a runtime retains these exact inert receipts and spends no new call.
      expect(calls.filter(a => a.preparationRejected).map(a => a.resultInteractionId)).toEqual([missing.id, spent.id]);
    }
  } finally {
    await product?.close();
    if (metadataProxy) {
      metadataProxy.closeAllConnections();
      await new Promise(resolve => metadataProxy.close(resolve));
    }
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
