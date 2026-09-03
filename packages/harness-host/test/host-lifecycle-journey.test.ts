import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HarnessHost, startHarnessHost, type RunningHarnessHost } from "../src/host.js";
import type { HarnessConfiguration, HarnessFactoryContext, HarnessSessionState } from "../src/types.js";

const completion = {
  nodeId: 1,
  rootAction: { id: 4, sourceNodeId: 1, sourceLayerId: null, kind: "navigate" as const, relation: "expand" as const, label: "Response", variant: "pill" as const, targetLayerId: 3, state: "accepted" as const },
  rootLayer: {
    layer: { id: 3, nodes: [2], edges: [], state: "accepted" as const },
    nodes: [{ id: 2, kind: "concept", icon: "box", title: "Answer", detail: "Detail", state: "accepted" as const }],
    edges: [],
    actions: [],
  },
};

const testConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "test-default",
  implementation: "test",
  implementationVersion: 1,
  permissionBindings: { ask: {}, auto: {}, full: {} },
  settings: {},
};

interface JourneyHarnessRecord {
  factoryCalls: number;
  completeCalls: { nodeId: number; token: string; model: unknown; presentationVersion: number | undefined; leasedActionId: number | undefined }[];
  restoredStates: (HarnessSessionState | undefined)[];
  disposeCalls: number;
  acceptedOutputs: Set<number>;
  graphReads: number;
  providerSessionByThread: Map<number, string>;
  failNode: number;
  approvalWaits: Promise<unknown>[];
}

function journeyHarness(directory: string): { implementations: Record<string, (context: HarnessFactoryContext) => unknown>; record: JourneyHarnessRecord } {
  const record: JourneyHarnessRecord = {
    factoryCalls: 0,
    completeCalls: [],
    restoredStates: [],
    disposeCalls: 0,
    acceptedOutputs: new Set(),
    graphReads: 0,
    providerSessionByThread: new Map(),
    failNode: 9,
    approvalWaits: [],
  };
  const implementations = {
    test: (context: HarnessFactoryContext) => {
      record.factoryCalls += 1;
      record.restoredStates.push(context.savedState);
      const instanceAccepted: number[] = [];
      let instanceAttempts = 0;
      return {
        async complete(runContext: { inputGraph: { id: number; leasedActionId?: number }; graph: { acquireCapability(): { token: string; nodeId: number } }; model?: unknown; personalPresentation?: { attachment?: { versionInteractionNodeId?: number } }; approvals: { request: (input: unknown) => Promise<unknown> }; threadId?: number }, signal?: AbortSignal) {
          const nodeId = runContext.inputGraph.id;
          instanceAttempts += 1;
          const capability = runContext.graph.acquireCapability();
          record.completeCalls.push({
            nodeId,
            token: capability.token,
            model: runContext.model,
            presentationVersion: runContext.personalPresentation?.attachment?.versionInteractionNodeId,
            leasedActionId: runContext.inputGraph.leasedActionId,
          });
          if (nodeId === record.failNode) throw new Error("model failed");
          if (nodeId >= 40) {
            const waiting = runContext.approvals.request({
              providerItemId: "private-provider-item",
              title: "Run tests",
              reason: "Verify the requested change.",
              action: { kind: "command", command: "npm test", workingDirectory: directory },
              scopeKeys: ["command:npm test"],
              scopeDescription: "Run npm test for this session.",
            });
            record.approvalWaits.push(waiting);
            await waiting;
          }
          record.acceptedOutputs.add(nodeId);
          instanceAccepted.push(nodeId);
        },
        state: () => ({ providerSessionId: `scope-${instanceAccepted.join(".") || "empty"}:${instanceAttempts}` }),
        async dispose() { record.disposeCalls += 1; },
      };
    },
  };
  return { implementations, record };
}

function graphResponse(url: string, record: JourneyHarnessRecord, authorization: string | null): Response {
  record.graphReads += 1;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const nodeId = authorization === "Bearer second-token" ? 2 : authorization === "Bearer approval-token" ? 41 : authorization === "Bearer cancel-token" ? 42 : authorization === "Bearer failure-token" ? record.failNode : authorization === "Bearer gate-token" || authorization === "Bearer compat-token" ? 31 : 1;
  if (url.endsWith("/output")) {
    return record.acceptedOutputs.has(nodeId)
      ? json({ ...completion, nodeId })
      : json({ error: { code: "completion_not_found" } }, 404);
  }
  if (url.endsWith("/personal-presentation")) {
    return json({
      attachment: { interactionNodeId: 1, versionInteractionNodeId: 90, rootLayerId: 91 },
      graph: {
        nodeId: 90,
        rootLayerId: 91,
        rootAction: { id: 92, sourceNodeId: 90, kind: "navigate", relation: "expand", label: "Personal presentation", variant: "pill", targetLayerId: 91, state: "accepted" },
        layers: [{
          layer: { id: 91, nodes: [93], edges: [], state: "accepted" },
          nodes: [{ id: 93, kind: "presentation-preference", icon: "compass", title: "Decision-useful center", detail: "Foreground the conclusion.", state: "accepted" }],
          edges: [], actions: [],
        }],
      },
    });
  }
  return json({ node: { id: nodeId, ...(nodeId === 1 ? { leasedActionId: 77 } : {}), kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } });
}

describe("harness host product lifecycle journey", () => {
  const directoryPromise = mkdtemp(join(tmpdir(), "relayer-host-lifecycle-journey-"));
  let directory: string;
  let running: RunningHarnessHost;
  let record: JourneyHarnessRecord;
  let harnessImplementations: Record<string, (context: HarnessFactoryContext) => unknown>;
  const nativeFetch = globalThis.fetch;

  beforeAll(async () => {
    directory = await directoryPromise;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith("http://127.0.0.1:43123")) return nativeFetch(input, init);
      return graphResponse(url, record, new Headers(init?.headers).get("authorization"));
    }) as typeof fetch;
    const harness = journeyHarness(directory);
    record = harness.record;
    harnessImplementations = harness.implementations;
    running = await startHarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      trace: {
        directory: join(directory, "traces"),
        policy: { mode: "required", requiredFeatures: {}, includeNativeArtifacts: false, maxBytesPerTurn: 10_000, maxEventsPerTurn: 100 },
      },
      implementations: harness.implementations as never,
    });
  });

  afterAll(async () => {
    globalThis.fetch = nativeFetch;
    if (running) await running.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  const controlHeaders = { authorization: "Bearer control", "content-type": "application/json" };
  const postComplete = (threadId: number, interactionId: number, nodeId: number, token: string, model?: unknown) => (
    fetch(`${running.url}/sessions/${threadId}/complete`, {
      method: "POST",
      headers: controlHeaders,
      body: JSON.stringify({ interactionId, graph: { url: "http://127.0.0.1:43123", token, nodeId }, traceContext: { productInteractionId: interactionId }, ...(model ? { model } : {}) }),
    })
  );

  it("drives configure, scoped completions, approval, cancellation, failure persistence, restart, migration, and close through one host", async () => {
    // Phase: configure. Registering the product session creates owner-only resumable state.
    await running.host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
    expect(running.host.sessionCount(), "session registered").toBe(1);
    const stateMode = (await stat(join(directory, "sessions.json"))).mode & 0o777;
    expect(stateMode, "state file is owner-only").toBe(0o600);
    expect(record.factoryCalls, "harness constructed once at registration").toBe(1);

    // Phase: scoped completions. Two interactions reuse one harness with distinct graph scopes.
    const first = await postComplete(1, 71, 1, "first-token");
    expect(first.status, "first completion accepted").toBe(200);
    expect(await first.json(), "first completion output").toMatchObject({ output: { nodeId: 1 } });
    const second = await postComplete(1, 72, 2, "second-token");
    expect(second.status, "second completion accepted").toBe(200);
    expect(await second.json(), "second completion output").toMatchObject({ output: { nodeId: 2 } });
    expect(record.factoryCalls, "no harness rebuild for the second scope").toBe(1);
    expect(record.completeCalls.map((call) => [call.nodeId, call.token]), "each scope keeps its own graph capability").toEqual([[1, "first-token"], [2, "second-token"]]);
    expect(record.completeCalls.every((call) => call.presentationVersion === 90), "personal presentation attached to every scope").toBe(true);
    expect(record.completeCalls.map((call) => call.leasedActionId), "leased action identity reaches the harness without leaking into the interaction").toEqual([77, undefined]);
    const persistedAfterRuns = JSON.parse(await readFile(join(directory, "sessions.json"), "utf8"));
    expect(persistedAfterRuns, "provider state persisted after accepted work").toMatchObject({
      schemaVersion: 6,
      sessions: [{ threadId: 1, state: { providerSessionId: "scope-1.2:2" } }],
    });
    expect(JSON.stringify(persistedAfterRuns), "graph capabilities never persist into resumable state").not.toContain("first-token");

    // Phase: approval. The ask profile blocks execution on a product decision.
    await running.host.createSession({ threadId: 2, permissionProfileId: "ask", configuration: testConfiguration, workingDirectory: directory });
    const approving = postComplete(2, 91, 41, "approval-token");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snapshotResponse = await fetch(`${running.url}/sessions/2/approval-events?after=0`, { headers: { authorization: "Bearer control" } });
    const snapshot = await snapshotResponse.json() as { pendingRequests: { requestId: string; correlation: { interactionId: number } }[] };
    expect(snapshotResponse.status, "approval snapshot exposed").toBe(200);
    expect(snapshot.pendingRequests, "one pending request correlated to the interaction").toMatchObject([{ correlation: { interactionId: 91 } }]);
    expect(JSON.stringify(snapshot), "provider item identity never leaves the host").not.toContain("private-provider-item");
    const requestId = snapshot.pendingRequests[0]!.requestId;
    const decisionResponse = await fetch(`${running.url}/sessions/2/approvals/${requestId}/decision`, {
      method: "POST",
      headers: controlHeaders,
      body: JSON.stringify({ decision: "approve_once", rationale: "Reviewed in Relayer." }),
    });
    expect(decisionResponse.status, "approval decision accepted").toBe(200);
    expect(await decisionResponse.json(), "approval resolved as user-approved").toMatchObject({ outcome: "approved", actor: "user", decision: "approve_once" });
    const approvingBody = await approving;
    expect(approvingBody.status, "completion settles after approval").toBe(200);
    expect(await approvingBody.json(), "approved completion output").toMatchObject({ output: { nodeId: 41 } });
    const duplicate = await fetch(`${running.url}/sessions/2/approvals/${requestId}/decision`, {
      method: "POST",
      headers: controlHeaders,
      body: JSON.stringify({ decision: "approve_once" }),
    });
    expect(duplicate.status, "a decided approval cannot be decided again").toBe(409);
    expect(await readFile(join(directory, "sessions.json"), "utf8"), "approval identities never persist into resumable state").not.toContain(requestId);

    // Phase: cancellation. A waiting approval closes with a host-terminal outcome.
    await running.host.createSession({ threadId: 3, permissionProfileId: "ask", configuration: testConfiguration, workingDirectory: directory });
    const cancelling = postComplete(3, 93, 42, "cancel-token");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(running.host.cancel(3), "cancellation accepted while approval waits").toBe(true);
    const cancelledBody = await cancelling;
    expect(JSON.stringify(await cancelledBody.json()), "cancelled completion reports the terminal outcome").toContain("cancelled");
    const cancelledEvents = await (await fetch(`${running.url}/sessions/3/approval-events?after=0`, { headers: { authorization: "Bearer control" } })).json() as { pendingRequests: unknown[]; events: { type: string; resolution?: { outcome: string; actor: string } }[] };
    expect(cancelledEvents.pendingRequests, "no approval remains pending after cancellation").toEqual([]);
    expect(cancelledEvents.events.at(-1), "approval resolved as host-cancelled").toMatchObject({ type: "resolved", resolution: { outcome: "cancelled", actor: "host" } });

    // Phase: failure persistence. A failed completion still leaves resumable state and an exported trace.
    await running.host.createSession({ threadId: 4, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
    const failing = await postComplete(4, 94, record.failNode, "failure-token");
    expect(failing.status, "failed completion surfaces through the control seam").not.toBe(200);
    const persistedAfterFailure = JSON.parse(await readFile(join(directory, "sessions.json"), "utf8"));
    expect(JSON.stringify(persistedAfterFailure.sessions.find((session: { threadId: number }) => session.threadId === 4)), "failed thread still persists resumable state").toContain("scope-empty:1");
    const exported = await running.host.exportCandidateTrace(94, join(directory, "failed-export"), {
      runId: "run", executionId: "execution", interactionId: "94", harnessConfigurationName: "test-default",
    });
    expect(exported, "failed turn exports a trace receipt").toMatchObject({ status: "failed" });

    // Phase: restart and resume. Closing and restarting on the same state file resumes provider state
    // without rerunning accepted work.
    await running.close();
    expect(record.disposeCalls, "graceful close disposes every live harness exactly once").toBe(4);
    const resumedRunning = await startHarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      trace: {
        directory: join(directory, "traces"),
        policy: { mode: "required", requiredFeatures: {}, includeNativeArtifacts: false, maxBytesPerTurn: 10_000, maxEventsPerTurn: 100 },
      },
      implementations: harnessImplementations as never,
    });
    const postResumedComplete = (threadId: number, interactionId: number, nodeId: number, token: string) => (
      fetch(`${resumedRunning.url}/sessions/${threadId}/complete`, {
        method: "POST",
        headers: controlHeaders,
        body: JSON.stringify({ interactionId, graph: { url: "http://127.0.0.1:43123", token, nodeId }, traceContext: { productInteractionId: interactionId } }),
      })
    );
    try {
      await resumedRunning.host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
      expect(record.restoredStates.at(-1), "restart restores saved provider state into the harness factory").toEqual({ providerSessionId: "scope-1.2:2" });
      await rm(join(directory, "sessions.json"));
      await resumedRunning.host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
      expect((await stat(join(directory, "sessions.json")).catch(() => undefined))?.isFile(), "re-registration rewrites lost resumable state").toBe(true);
      const completeCallsBeforeResume = record.completeCalls.length;
      const resumed = await postResumedComplete(1, 73, 1, "first-token");
      expect(resumed.status, "accepted scope resumes over the control seam").toBe(200);
      expect(await resumed.json(), "resumed output is the accepted graph").toMatchObject({ output: { nodeId: 1 } });
      expect(record.completeCalls.length, "resume never reruns the harness").toBe(completeCallsBeforeResume);

      // Phase: migration. Legacy schema-v4 product state upgrades on registration and resumes its provider session.
      const legacyStateFile = join(directory, "legacy-sessions.json");
      const legacyConfiguration = {
        ...testConfiguration,
        name: "codex-basic",
        implementation: "codex.basic",
        revision: 2,
        executionAccessContracts: ["managed-runtime@1", "secret@1"],
        settings: { modelReasoningEffort: "medium", skipGitRepoCheck: true },
      };
      await writeFile(legacyStateFile, JSON.stringify({
        schemaVersion: 4,
        sessions: [{
          threadId: 1,
          configuration: legacyConfiguration,
          permissionProfileId: "auto",
          workingDirectory: directory,
          state: { providerSessionId: "legacy-session" },
        }],
      }), { mode: 0o600 });
      let migratedRestored: HarnessSessionState | undefined;
      const migrating = await startHarnessHost({
        stateFile: legacyStateFile,
        controlToken: "control",
        implementations: {
          "codex.basic": (context: HarnessFactoryContext) => {
            migratedRestored = context.savedState;
            return { async complete() {}, state: () => context.savedState ?? {} };
          },
        } as never,
      });
      try {
        await migrating.host.createSession({
          threadId: 1,
          permissionProfileId: "auto",
          configuration: {
            ...legacyConfiguration,
            revision: 3,
            settings: { modelReasoningEffort: "medium", promptProfile: "layered-navigation-multi-agent-v1", skipGitRepoCheck: true },
          },
          workingDirectory: directory,
        });
        const migrated = JSON.parse(await readFile(legacyStateFile, "utf8"));
        expect(migrated, "legacy state migrates to the current schema").toMatchObject({
          schemaVersion: 6,
          sessions: [{ threadId: 1, configuration: { name: "codex-basic", revision: 3 }, state: { providerSessionId: "legacy-session" } }],
        });
        expect(migrated.sessions[0].configuration.settings, "retired effort settings normalize into the prompt profile").toMatchObject({
          promptProfile: "layered-navigation-multi-agent-v1",
        });
        expect(migratedRestored, "provider session resumes through migration").toEqual({ providerSessionId: "legacy-session" });

        // Phase: close authority. Closing is terminal and disposes exactly once.
        await migrating.close();
        await migrating.close();
        await expect(migrating.host.createSession({ threadId: 9, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory }), "a closed host refuses new sessions")
          .rejects.toThrow("closed");
      } finally {
        await migrating.close().catch(() => undefined);
      }

      // Phase: terminal host. The resumed host closes with its state intact for the next boot.
      await resumedRunning.close();
      const persistedAtClose = JSON.parse(await readFile(join(directory, "sessions.json"), "utf8"));
      expect(JSON.stringify(persistedAtClose), "resumable state survives the journey's final close").toContain("providerSessionId");
    } finally {
      await resumedRunning.close().catch(() => undefined);
    }
  }, 60_000);

  it("holds configuration, broker, model, and trace authority gates before any paid inference", async () => {
    const gateDirectory = await mkdtemp(join(tmpdir(), "relayer-host-authority-gates-"));
    let completeCalls = 0;
    let factoryCalls = 0;
    const host = new HarnessHost({
      stateFile: join(gateDirectory, "sessions.json"),
      controlToken: "control",
      trace: {
        directory: join(gateDirectory, "traces"),
        policy: { mode: "required", requiredFeatures: { modelCalls: "full" }, includeNativeArtifacts: false, maxBytesPerTurn: 1_000, maxEventsPerTurn: 100 },
      },
      implementations: {
        test: () => {
          factoryCalls += 1;
          return {
            traceSupport: () => ({ prompt: "full", messages: "none", reasoningSummaries: "none", modelCalls: "none", toolCalls: "none", usage: "none", childStreams: "none", nativeArtifacts: "none" }),
            async complete() { completeCalls += 1; },
            state: () => ({}),
          };
        },
      } as never,
    });
    const gateGraph = { url: "http://127.0.0.1:43123", token: "gate-token", nodeId: 1 };
    try {
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: gateDirectory });

      // Gate: the first configuration pins the session; a renamed configuration cannot take it over.
      await expect(host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: { ...testConfiguration, name: "other" }, workingDirectory: gateDirectory }), "renamed configuration cannot retake a pinned session")
        .rejects.toThrow("already pinned");
      expect(factoryCalls, "pinning never rebuilds the harness").toBe(1);

      // Gate: omitted graph profiles refresh as disabled, but live search authority cannot change.
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: { ...testConfiguration, graphCapabilityProfile: { search: "disabled" } }, workingDirectory: gateDirectory });
      expect(factoryCalls, "profile refresh reuses the live harness").toBe(1);
      await expect(host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: { ...testConfiguration, graphCapabilityProfile: { search: "query-v1" } }, workingDirectory: gateDirectory }), "live search-authority change is rejected")
        .rejects.toThrow("already pinned");

      // Gate: agent-authored Complete stays disabled unless the pinned configuration grants it.
      const completionBroker = { url: "http://127.0.0.1:43125/api/completions", token: "12345678901234567890123456789012" };
      await expect(host.complete(1, 1, gateGraph, undefined, undefined, undefined, undefined, undefined, undefined, undefined, completionBroker), "broker authority refused without the grant")
        .rejects.toThrow("does not allow agent-authored Complete");
      await expect(host.complete(1, { capability: gateGraph, origin: { kind: "invoke" as const, sourceCompletionId: 1, actionId: 101 }, completionBroker }), "invoke origin refused without the grant")
        .rejects.toThrow("does not allow agent-authored Complete");
      expect(completeCalls, "no harness work before broker authority").toBe(0);

      // Gate: model compatibility is enforced before any graph access.
      await host.createSession({
        threadId: 2,
        permissionProfileId: "auto",
        configuration: { ...testConfiguration, modelCompatibility: [{ providerId: "codex", modelIds: ["allowed"] }], executionAccessContracts: ["managed-runtime@1"] },
        workingDirectory: gateDirectory,
      });
      const graphReadsBeforeCompatibility = record.graphReads;
      await expect(host.complete(2, 1, { ...gateGraph, token: "compat-token" }, { providerId: "codex", modelId: "blocked" }), "incompatible model rejected before graph access")
        .rejects.toThrow("not compatible with this configuration");
      expect(completeCalls, "no harness work before model compatibility").toBe(0);
      expect(record.graphReads, "no graph access before model compatibility").toBe(graphReadsBeforeCompatibility);

      // Gate: required trace coverage is enforced before invoking paid inference.
      await expect(host.complete(1, 1, gateGraph, undefined, undefined, { productInteractionId: 31 }), "missing trace coverage rejected before inference")
        .rejects.toThrow("before inference");
      expect(completeCalls, "no harness work before trace coverage").toBe(0);

      await host.close();
    } finally {
      await host.close().catch(() => undefined);
      await rm(gateDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});
