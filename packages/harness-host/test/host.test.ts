import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { InteractionInput, ResolvedPersonalPresentation } from "@relayer/graph-client";
import {
  HarnessExecutionFailure,
  HarnessHost,
  startHarnessHost,
  type HarnessHostOptions,
  type HarnessInvokedCompletion,
} from "../src/host.js";
import { nativeExecutionHandle } from "../src/completion-execution.js";
import { PrimeAgentHarness } from "../src/implementations/prime-agent.js";
import type {
  Harness,
  HarnessConfiguration,
  HarnessExecutionAccessLease,
  HarnessFactoryContext,
  HarnessModelPlan,
  HarnessRunContext,
  HarnessSessionState,
  InteractionModelSelection,
} from "../src/types.js";

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
const emptyState = (): HarnessSessionState => ({});
const graph = (nodeId = 1, token = "token") => ({ url: "http://127.0.0.1:43123", token, nodeId });
const invoked = (
  inputGraph: ReturnType<typeof graph>,
  sourceCompletionId = 1,
  actionId = inputGraph.nodeId + 100,
) => ({
  capability: inputGraph,
  origin: { kind: "invoke" as const, sourceCompletionId, actionId },
});
const graphNode = (nodeId = 1, leasedActionId?: number) => ({
  id: nodeId,
  ...(leasedActionId === undefined ? {} : { leasedActionId }),
  kind: "user-interaction",
  icon: "user",
  title: "Question",
  detail: "Question",
  state: "accepted" as const,
});
const interactionInput = (nodeId = 1, contexts: InteractionInput["contexts"] = []): InteractionInput => ({
  interaction: graphNode(nodeId),
  contexts,
});
const personalPresentation = (interactionNodeId: number, versionInteractionNodeId: number, preference: boolean): ResolvedPersonalPresentation => ({
  attachment: { interactionNodeId, versionInteractionNodeId, rootLayerId: versionInteractionNodeId + 1 },
  graph: {
    nodeId: versionInteractionNodeId,
    rootLayerId: versionInteractionNodeId + 1,
    rootAction: { id: versionInteractionNodeId + 2, sourceNodeId: versionInteractionNodeId, kind: "navigate", relation: "expand", label: "Personal presentation", variant: "pill", targetLayerId: versionInteractionNodeId + 1, state: "accepted" },
    layers: [{
      layer: { id: versionInteractionNodeId + 1, nodes: [versionInteractionNodeId + 3], edges: [], state: "accepted" },
      nodes: [{ id: versionInteractionNodeId + 3, kind: preference ? "presentation-preference" : "personal-presentation-manifest", icon: preference ? "compass" : "settings", title: preference ? "Decision-useful center" : "Neutral", detail: preference ? "Foreground the conclusion." : "No guidance.", state: "accepted" }],
      edges: [], actions: [],
    }],
  },
});
const graphReadResponse = (url: string, nodeId = 1, contexts: InteractionInput["contexts"] = [], leasedActionId?: number) => new Response(
  JSON.stringify(url.endsWith("/personal-presentation")
    ? { error: { code: "personal_presentation_not_attached" } }
    : url.endsWith("/input") ? interactionInput(nodeId, contexts) : { node: graphNode(nodeId, leasedActionId) }),
  { status: url.endsWith("/personal-presentation") ? 404 : 200, headers: { "content-type": "application/json" } },
);
const testConfiguration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "test-default",
  implementation: "test",
  implementationVersion: 1,
  permissionBindings: { ask: {}, auto: {}, full: {} },
  settings: {},
};
const completeEnabledConfiguration: HarnessConfiguration = {
  ...testConfiguration,
  name: "test-complete-enabled",
  complete: { agentAuthored: true },
};
const graphSearchConfiguration = (search: "disabled" | "query-v1"): HarnessConfiguration => ({
  ...testConfiguration,
  graphCapabilityProfile: { search },
});
const legacyConfiguration = (configuration: HarnessConfiguration) => {
  const { permissionBindings: _permissionBindings, ...legacy } = configuration;
  return legacy;
};

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const completionNotFound = () => jsonResponse({ error: { code: "completion_not_found" } }, 404);
const interactiveNodeBody = (id = 1) => ({ node: graphNode(id) });
const inspectionFetch = (options?: { nodes?: () => Array<{ id: number }> }) => vi.fn(async (url: string) => {
  if (url.endsWith("/output")) return completionNotFound();
  if (url.endsWith("/neighbors")) return jsonResponse({ nodes: options?.nodes ? options.nodes() : [] });
  return jsonResponse(interactiveNodeBody());
});
const tempDirectory = (prefix: string) => mkdtemp(join(tmpdir(), prefix));
const cleanup = (directory: string) => rm(directory, { recursive: true, force: true });
const requiredTracePolicy = {
  mode: "required",
  requiredFeatures: {},
  includeNativeArtifacts: false,
  maxBytesPerTurn: 10_000,
  maxEventsPerTurn: 100,
} as const;
type CaseOutcome = { status: "fulfilled"; value: string } | { status: "rejected"; reason: Error };
const runLabeledCases = async (cases: ReadonlyArray<readonly [string, () => Promise<void>]>) => {
  const outcomes: CaseOutcome[] = [];
  for (const [label, run] of cases) {
    try {
      await run();
      outcomes.push({ status: "fulfilled", value: label });
    } catch (error) {
      outcomes.push({ status: "rejected", reason: new Error(`Case failed: ${label}`, { cause: error }) });
    }
  }
  expect(outcomes).toEqual(cases.map(([label]) => ({ status: "fulfilled", value: label })));
};
const capturingFactory = (sink: { state: HarnessSessionState | undefined }) => (context: HarnessFactoryContext): Harness => {
  sink.state = context.savedState;
  return { async complete() {}, state: () => context.savedState ?? emptyState() };
};
const silenceWarnings = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

describe("HarnessHost", () => {
  it("classifies completion failure boundaries by observable effects", async () => {
    expect(new HarnessExecutionFailure("not started", "authentication", "none"),
      "adapter-attested no-effect failure").toMatchObject({ failureCategory: "authentication", effectBoundary: "none" });

    type BoundaryCase = {
      readonly label: string;
      readonly configuration?: HarnessConfiguration;
      readonly model?: InteractionModelSelection;
      readonly traceContext?: { productInteractionId: number };
      readonly expected: Record<string, unknown>;
      readonly build: (directory: string) => {
        harness: Harness;
        fetch?: ReturnType<typeof vi.fn>;
        trace?: HarnessHostOptions["trace"];
        accessBroker?: HarnessHostOptions["accessBroker"];
      };
      readonly after?: (directory: string, host: HarnessHost) => Promise<void>;
    };
    const cases: readonly BoundaryCase[] = [
      {
        label: "partial streamed output is classified and preserved without becoming replayable",
        traceContext: { productInteractionId: 31 },
        expected: { effectBoundary: "partial_output" },
        build: (directory) => ({
          trace: { directory: join(directory, "traces"), policy: requiredTracePolicy },
          harness: {
            async complete(context) {
              context.trace.emit({ type: "message", data: { text: "inspectable partial answer" } });
              throw new Error("stream disconnected");
            },
            state: emptyState,
          },
        }),
        after: async (directory, host) => {
          const exported = join(directory, "exported");
          await host.exportCandidateTrace(31, exported, {
            runId: "run", executionId: "execution", interactionId: "31", harnessConfigurationName: "test-default",
          });
          expect(await readFile(join(exported, "events.jsonl"), "utf8"), "partial output stays inspectable")
            .toContain("inspectable partial answer");
        },
      },
      {
        label: "an observable partial graph write is protected",
        expected: { effectBoundary: "graph_write" },
        build: () => {
          let wroteGraph = false;
          return {
            fetch: inspectionFetch({ nodes: () => (wroteGraph ? [{ id: 2 }] : []) }),
            harness: { async complete() { wroteGraph = true; throw new Error("crash after write"); }, state: emptyState },
          };
        },
      },
      {
        label: "a started tool call stays protected when later graph inspection is empty",
        expected: { effectBoundary: "tool_effect" },
        build: () => ({
          harness: {
            async complete(context) {
              context.trace.emit({ type: "tool.call.started", data: { name: "write-file" } });
              throw new Error("tool result connection lost");
            },
            state: emptyState,
          },
        }),
      },
      {
        label: "an untyped provider failure after execution starts fails closed as unknown",
        model: { providerId: "provider", adapterId: "openai-api", modelId: "gpt-test" },
        expected: { effectBoundary: "unknown" },
        configuration: {
          ...testConfiguration,
          modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt-test" }], deny: [] },
          executionAccessContracts: ["secret@1"],
        },
        build: () => ({
          accessBroker: { async acquire() { return { access: { kind: "secret", contract: "secret@1", providerId: "provider", adapterId: "openai-api", adapterImplementationVersion: "1", endpoint: "https://api.openai.com/v1", fields: { "api-key": "secret" } }, async release() {} }; } },
          harness: { async complete() { throw new Error("model not found"); }, state: emptyState },
        }),
      },
      {
        label: "a selected model without access contracts rejects as a configuration failure",
        model: { providerId: "provider", adapterId: "openai-api", modelId: "gpt-test" },
        expected: { failureCategory: "configuration", effectBoundary: "none" },
        build: () => ({ harness: { async complete() {}, state: emptyState } }),
      },
    ];
    expect(cases, "failure boundary inventory").toHaveLength(5);
    await runLabeledCases(cases.map((row) => [row.label, async () => {
      const directory = await tempDirectory("relayer-boundary-");
      try {
        const built = row.build(directory);
        vi.stubGlobal("fetch", built.fetch ?? inspectionFetch());
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          ...(built.trace === undefined ? {} : { trace: built.trace }),
          ...(built.accessBroker === undefined ? {} : { accessBroker: built.accessBroker }),
          implementations: { test: () => built.harness },
        });
        await host.initialize();
        await host.createSession({
          threadId: 1, permissionProfileId: "auto",
          configuration: row.configuration ?? testConfiguration,
          workingDirectory: directory,
        });
        await expect(host.complete(1, 1, graph(), row.model, undefined, row.traceContext), row.label)
          .rejects.toMatchObject(row.expected);
        if (row.after) await row.after(directory, host);
      } finally {
        vi.unstubAllGlobals();
        await cleanup(directory);
      }
    }]));
  }, 30_000);

  it("keeps accepted work durable and trace coverage enforced around inference", async () => {
    // Already-accepted completions resolve from the graph without rerunning the harness.
    {
      const directory = await tempDirectory("relayer-harness-idempotent-");
      let calls = 0;
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(completion)));
      try {
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => ({ async complete() { calls += 1; }, state: emptyState }) },
        });
        await host.initialize();
        await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });

        await expect(host.complete(1, 1, graph()), "accepted output short-circuits inference").resolves.toMatchObject({ output: completion });
        expect(calls, "no harness execution for accepted output").toBe(0);
      } finally {
        vi.unstubAllGlobals();
        await cleanup(directory);
      }
    }

    // A harness unwind after graph.submit adopts the accepted graph and never repeats execution.
    {
      const directory = await tempDirectory("relayer-accepted-recovery-");
      let accepted = false;
      let calls = 0;
      vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
        ? (accepted ? jsonResponse(completion) : completionNotFound())
        : jsonResponse(interactiveNodeBody())));
      try {
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"), controlToken: "control",
          implementations: { test: () => ({ async complete() {
            calls += 1;
            accepted = true;
            throw new Error("crash after graph.submit");
          }, state: emptyState }) },
        });
        await host.initialize();
        await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
        await expect(host.complete(1, 1, graph()), "unwind failure adopts the submitted graph").resolves.toMatchObject({ output: completion });
        await expect(host.complete(1, 1, graph()), "adopted graph answers the retry").resolves.toMatchObject({ output: completion });
        expect(calls, "execution never repeats after adoption").toBe(1);
      } finally {
        vi.unstubAllGlobals();
        await cleanup(directory);
      }
    }

    // Missing required trace coverage rejects before paid inference starts.
    {
      const directory = await tempDirectory("relayer-harness-trace-preflight-");
      let completionCalls = 0;
      vi.stubGlobal("fetch", inspectionFetch());
      try {
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          trace: {
            directory: join(directory, "traces"),
            policy: { ...requiredTracePolicy, requiredFeatures: { modelCalls: "full" }, maxBytesPerTurn: 1_000 },
          },
          implementations: { test: () => ({
            traceSupport: () => ({
              prompt: "full", messages: "none", reasoningSummaries: "none", modelCalls: "none",
              toolCalls: "none", usage: "none", childStreams: "none", nativeArtifacts: "none",
            }),
            async complete() { completionCalls += 1; },
            state: emptyState,
          }) },
        });
        await host.initialize();
        await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });

        await expect(host.complete(1, 1, graph(), undefined, undefined, { productInteractionId: 9 }),
          "required trace coverage gates inference").rejects.toThrow("before inference");
        expect(completionCalls, "no paid inference without coverage").toBe(0);
      } finally {
        vi.unstubAllGlobals();
        await cleanup(directory);
      }
    }

    // A failed trace seal keeps the accepted graph and never reruns inference.
    {
      const directory = await tempDirectory("relayer-harness-trace-seal-failure-");
      const blockedTraceDirectory = join(directory, "blocked-trace-path");
      let accepted = false;
      let completionCalls = 0;
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.endsWith("/output")) return accepted ? jsonResponse(completion) : completionNotFound();
        return jsonResponse(interactiveNodeBody());
      }));
      try {
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          trace: { directory: blockedTraceDirectory, policy: requiredTracePolicy },
          implementations: { test: () => ({
            async complete() { completionCalls += 1; accepted = true; },
            state: emptyState,
          }) },
        });
        await host.initialize();
        await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
        await rm(blockedTraceDirectory, { recursive: true, force: true });
        await writeFile(blockedTraceDirectory, "not a directory");

        await expect(host.complete(1, 1, graph(), undefined, undefined, { productInteractionId: 11 }),
          "sealing failure never loses the accepted graph").resolves.toMatchObject({
          output: completion,
          trace: { status: "failed", error: expect.stringContaining("could not be sealed") },
        });
        expect(completionCalls, "sealing failure never reruns inference").toBe(1);
      } finally {
        vi.unstubAllGlobals();
        await cleanup(directory);
      }
    }

    // Attributed personal presentation must match the pinned trace version.
    {
      const directory = await tempDirectory("relayer-personal-presentation-pin-");
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({ async complete() {}, state: emptyState }) },
      });
      await host.initialize();
      await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
      try {
        vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
          ? completionNotFound()
          : graphReadResponse(url)));
        await expect(host.complete(1, 1, graph(), undefined, undefined, {
          productInteractionId: 7,
          personalPresentationVersionId: 90,
        }), "missing attributed presentation fails closed").rejects.toMatchObject({ code: "personal_presentation_not_attached" });

        vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
          ? completionNotFound()
          : url.endsWith("/personal-presentation")
            ? jsonResponse(personalPresentation(1, 91, true))
            : graphReadResponse(url)));
        await expect(host.complete(1, 1, graph(), undefined, undefined, {
          productInteractionId: 7,
          personalPresentationVersionId: 90,
        }), "mismatched presentation version fails closed").rejects.toThrow("does not match the pinned trace version");
      } finally {
        vi.unstubAllGlobals();
        await cleanup(directory);
      }
    }
  }, 30_000);

  it("supplies a distinct run scope without rebuilding the harness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-advance-"));
    const adopted: { url: string; token: string; nodeId: number }[] = [];
    const accepted = new Set<number>();
    const scopes: { acquireCapability(): unknown }[] = [];
    const inputs: InteractionInput[] = [];
    const personalPresentations: Array<ResolvedPersonalPresentation | undefined> = [];
    const leasedActionIds: Array<number | null | undefined> = [];
    const models: unknown[] = [];
    let revocationRequests = 0;
    let factoryCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      const nodeId = authorization === "Bearer second-token" ? 2 : 1;
      if (url.endsWith("/output")) {
        return accepted.has(nodeId)
          ? new Response(JSON.stringify({ ...completion, nodeId }), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/api/control/capabilities")) {
        revocationRequests += 1;
        return new Response(JSON.stringify({ revoked: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/personal-presentation")) {
        return new Response(JSON.stringify(personalPresentation(nodeId, nodeId === 1 ? 90 : 100, nodeId === 1)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${nodeId === 1 ? "first-token" : "second-token"}`);
      const contexts = nodeId === 1 ? [{
        type: "interaction.context" as const,
        targetNode: { id: 90, kind: "concept", icon: "box", title: "Attached", detail: "Context", state: "accepted" as const },
        annotations: ["first", "second"],
      }] : [];
      return graphReadResponse(url, nodeId, contexts, nodeId === 1 ? 77 : undefined);
    }));
    try {
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        accessBroker: { async acquire(model) { return { access: { kind: "managed-runtime", contract: "managed-runtime@1", providerId: model.providerId, adapterId: model.adapterId!, adapterImplementationVersion: "1", environment: {} }, async release() {} }; } },
        implementations: { test: () => {
          factoryCalls += 1;
          return {
            async complete(context) {
              scopes.push(context.graph);
              inputs.push(context.interactionInput);
              personalPresentations.push(context.personalPresentation);
              leasedActionIds.push(context.inputGraph.leasedActionId);
              models.push(context.model);
              adopted.push(context.graph.acquireCapability());
              accepted.add(context.inputGraph.id);
            },
            state: emptyState,
          };
        } },
      });
      await host.initialize();
      const base = { threadId: 1, permissionProfileId: "auto", configuration: { ...testConfiguration, executionAccessContracts: ["managed-runtime@1"] }, workingDirectory: directory };
      await host.createSession(base);

      await host.complete(1, 1, graph(1, "first-token"), { providerId: "codex", adapterId: "codex-subscription", modelId: "gpt-first" });
      await expect(host.complete(1, 2, graph(2, "second-token"), { providerId: "codex", adapterId: "codex-subscription", modelId: "gpt-second" })).resolves.toMatchObject({
        output: { nodeId: 2 },
      });
      expect(factoryCalls).toBe(1);
      expect(adopted.map(({ token, nodeId }) => [token, nodeId])).toEqual([["first-token", 1], ["second-token", 2]]);
      expect(models).toEqual([
        { providerId: "codex", adapterId: "codex-subscription", modelId: "gpt-first" },
        { providerId: "codex", adapterId: "codex-subscription", modelId: "gpt-second" },
      ]);
      expect(inputs[0]).toEqual(interactionInput(1, [{
        type: "interaction.context",
        targetNode: { id: 90, kind: "concept", icon: "box", title: "Attached", detail: "Context", state: "accepted" },
        annotations: ["first", "second"],
      }]));
      expect(inputs[1]).toEqual(interactionInput(2));
      expect(personalPresentations.map((value) => value?.attachment.versionInteractionNodeId)).toEqual([90, 100]);
      expect(personalPresentations[0]?.graph.layers[0]?.nodes[0]?.kind).toBe("presentation-preference");
      expect(personalPresentations[1]?.graph.layers[0]?.nodes[0]?.kind).toBe("personal-presentation-manifest");
      expect(leasedActionIds).toEqual([77, undefined]);
      expect(inputs[0]!.interaction).not.toHaveProperty("leasedActionId");
      expect(revocationRequests).toBe(0);
      expect(() => scopes[0]!.acquireCapability()).toThrow("no longer active");
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists, restores, and pins session state across host restarts", async () => {
    const directory = await tempDirectory("relayer-harness-host-");
    const stateFile = join(directory, "sessions.json");
    const capability = graph(1, "graph-token");
    const descriptor = { threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory };
    let restoredState: HarnessSessionState | undefined;
    let restoredFactoryCalls = 0;
    let firstApprovalSessionId: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
      ? completionNotFound()
      : url.endsWith("/personal-presentation")
        ? jsonResponse(personalPresentation(1, 90, true))
        : graphReadResponse(url)));

    try {
      // Phase 1: a failing completion still persists resumable state and exportable trace evidence.
      const failing = new HarnessHost({
        stateFile,
        controlToken: "control",
        trace: {
          directory: join(directory, "failure-traces"),
          policy: requiredTracePolicy,
        },
        implementations: {
          test: () => ({
            async complete() { throw new Error("model failed"); },
            state: () => ({ primeAgentSessionId: "resume-after-failure" }),
          }),
        },
      });
      await failing.initialize();
      await failing.createSession(descriptor);
      firstApprovalSessionId = failing.approvalEvents(1).harnessSessionId;
      await expect(failing.complete(descriptor.threadId, 1, capability, undefined, undefined, {
        productInteractionId: 7,
        personalPresentationVersionId: 90,
      }), "completion failure propagates").rejects.toThrow("model failed");
      const exportedTrace = await failing.exportCandidateTrace(7, join(directory, "failed-export"), {
        runId: "run", executionId: "execution", interactionId: "7", harnessConfigurationName: "test-default",
      });
      expect(exportedTrace, "failed export keeps attribution").toMatchObject({ status: "failed", personalPresentationVersionId: 90 });
      expect(JSON.parse(await readFile(join(directory, "failed-export", "manifest.json"), "utf8")),
        "failed export manifest keeps attribution").toMatchObject({
        status: "failed",
        personalPresentationVersionId: 90,
      });
      await expect(failing.createSession({ ...descriptor, configuration: { ...testConfiguration, name: "other" } }),
        "configuration identity is pinned per thread").rejects.toThrow("already pinned");

      const persisted = await readFile(stateFile, "utf8");
      expect((await stat(stateFile)).mode & 0o777, "state file is owner-only").toBe(0o600);
      expect(JSON.parse(persisted), "state stores resumable harness state without graph capabilities").toEqual({
        schemaVersion: 6,
        sessions: [{
          threadId: 1, permissionProfileId: "auto",
          configuration: testConfiguration,
          workingDirectory: directory,
          state: { primeAgentSessionId: "resume-after-failure" },
        }],
      });
      await failing.close();

      // Phase 2: a restart restores saved state, keeps pins, and rotates ephemeral approval identity.
      const restored = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: {
          test: (context: HarnessFactoryContext) => {
            restoredFactoryCalls += 1;
            restoredState = context.savedState;
            return {
              async complete() { throw new Error("unused"); },
              state: () => context.savedState ?? emptyState(),
            };
          },
        },
      });
      await restored.initialize();
      await expect(restored.complete(1, 1, graph()), "completions require registration after restart")
        .rejects.toThrow("must be registered");
      await expect(restored.createSession({ ...descriptor, configuration: graphSearchConfiguration("query-v1") }),
        "graph search authority stays pinned across restarts").rejects.toThrow("already pinned");
      expect(restoredFactoryCalls, "pinned rejection never builds a harness").toBe(0);
      await restored.createSession({ ...descriptor, configuration: graphSearchConfiguration("disabled") });
      expect(restoredFactoryCalls, "normalized registration builds one harness").toBe(1);
      expect(restoredState, "saved state survives omitted-to-disabled normalization").toEqual({ primeAgentSessionId: "resume-after-failure" });
      expect(restored.approvalEvents(1).harnessSessionId, "approval session identity is ephemeral").not.toBe(firstApprovalSessionId);
      expect(await readFile(stateFile, "utf8"), "approval session identity never persists").not.toContain(firstApprovalSessionId!);
      await restored.close();
    } finally {
      vi.unstubAllGlobals();
      await cleanup(directory);
    }

    // Phase 3: registration retries persistence once the state file path becomes writable.
    const retryDirectory = await tempDirectory("relayer-harness-persist-");
    const blocker = join(retryDirectory, "blocked");
    const retryStateFile = join(blocker, "sessions.json");
    const host = new HarnessHost({
      stateFile: retryStateFile,
      controlToken: "control",
      implementations: { test: () => ({ async complete() {}, state: emptyState }) },
    });
    const retryDescriptor = { threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: retryDirectory };
    try {
      await host.initialize();
      await writeFile(blocker, "not a directory", "utf8");
      await expect(host.createSession(retryDescriptor), "blocked state path rejects registration").rejects.toThrow();
      await rm(blocker);
      await mkdir(blocker);

      await host.createSession(retryDescriptor);
      expect(JSON.parse(await readFile(retryStateFile, "utf8")).sessions, "retry persists once writable").toHaveLength(1);
    } finally {
      await cleanup(retryDirectory);
    }
  }, 30_000);

  it("migrates every legacy host state schema", async () => {
    const cases: Array<readonly [string, () => Promise<void>]> = [];

    const activeProductCodex = [
      [4, "codex-basic", "medium", 1],
      [4, "codex-basic", "medium", 2],
      [4, "codex-basic-high", "high", 1],
      [4, "codex-basic-high", "high", 2],
      [5, "codex-basic", "medium", 1],
      [5, "codex-basic", "medium", 2],
      [5, "codex-basic-high", "high", 1],
      [5, "codex-basic-high", "high", 2],
    ] as const;
    for (const [schemaVersion, legacyName, legacyEffort, legacyRevision] of activeProductCodex) {
      cases.push([`product codex v${schemaVersion} ${legacyName} ${legacyEffort} revision ${legacyRevision}`, async () => {
        const directory = await tempDirectory("relayer-harness-state-product-codex-");
        const stateFile = join(directory, "sessions.json");
        const legacy: HarnessConfiguration = {
          ...testConfiguration,
          name: legacyName,
          implementation: "codex.basic",
          revision: legacyRevision,
          executionAccessContracts: ["managed-runtime@1", "secret@1"],
          settings: { modelReasoningEffort: legacyEffort, skipGitRepoCheck: true },
        };
        const current: HarnessConfiguration = {
          ...legacy,
          name: "codex-basic",
          revision: 3,
          settings: {
            modelReasoningEffort: "medium",
            promptProfile: "layered-navigation-multi-agent-v1",
            skipGitRepoCheck: true,
          },
        };
        const serialized = JSON.stringify({
          schemaVersion,
          sessions: [{
            threadId: 1,
            configuration: legacy,
            permissionProfileId: "auto",
            workingDirectory: directory,
            state: { providerSessionId: "existing-session" },
          }],
        });
        const restored: { state: HarnessSessionState | undefined } = { state: undefined };
        const warning = silenceWarnings();
        const host = new HarnessHost({
          stateFile,
          controlToken: "control",
          implementations: { "codex.basic": capturingFactory(restored) },
        });
        try {
          await writeFile(stateFile, serialized, { mode: 0o600 });

          await host.initialize();

          expect(await readFile(`${stateFile}.v${schemaVersion}.backup`, "utf8"), "pre-migration backup preserved").toBe(serialized);
          expect(warning, "schema migration stays silent").not.toHaveBeenCalled();
          expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
            schemaVersion: 6,
            sessions: [{ threadId: 1, configuration: legacy, state: { providerSessionId: "existing-session" } }],
          });

          await host.createSession({
            threadId: 1,
            permissionProfileId: "auto",
            configuration: current,
            workingDirectory: directory,
          });

          expect(warning, "retired product configuration migrates during registration").toHaveBeenCalledWith(
            "Migrating retired product Codex configuration for harness thread 1 during registration",
          );
          expect(restored.state, "provider session survives product migration").toEqual({ providerSessionId: "existing-session" });
          expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
            schemaVersion: 6,
            sessions: [{ threadId: 1, configuration: current, state: { providerSessionId: "existing-session" } }],
          });
        } finally {
          warning.mockRestore();
          await host.close();
          await cleanup(directory);
        }
      }]);
    }

    const deferredProductCodex = [
      ["codex-basic", "medium"],
      ["codex-basic-high", "high"],
    ] as const;
    for (const [legacyName, legacyEffort] of deferredProductCodex) {
      cases.push([`deferred product codex v5 ${legacyName} ${legacyEffort}`, async () => {
        const directory = await tempDirectory("relayer-harness-state-v5-deferred-product-codex-");
        const stateFile = join(directory, "sessions.json");
        const current: HarnessConfiguration = {
          ...testConfiguration,
          name: "codex-basic",
          implementation: "codex.basic",
          revision: 3,
          executionAccessContracts: ["managed-runtime@1", "secret@1"],
          settings: {
            modelReasoningEffort: "medium",
            promptProfile: "layered-navigation-multi-agent-v1",
            skipGitRepoCheck: true,
          },
        };
        const serialized = JSON.stringify({
          schemaVersion: 5,
          sessions: [],
          legacySessions: [{
            threadId: 1,
            configuration: {
              schemaVersion: 1,
              name: legacyName,
              implementation: "codex.basic",
              implementationVersion: 1,
              settings: { modelReasoningEffort: legacyEffort, skipGitRepoCheck: true },
            },
            workingDirectory: directory,
            state: { providerSessionId: "existing-session" },
          }],
        });
        const restored: { state: HarnessSessionState | undefined } = { state: undefined };
        const warning = silenceWarnings();
        const host = new HarnessHost({
          stateFile,
          controlToken: "control",
          implementations: { "codex.basic": capturingFactory(restored) },
        });
        try {
          await writeFile(stateFile, serialized, { mode: 0o600 });

          await host.initialize();

          expect(await readFile(`${stateFile}.v5.backup`, "utf8"), "pre-migration backup preserved").toBe(serialized);
          expect(warning, "deferred migration stays silent at startup").not.toHaveBeenCalled();
          expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
            schemaVersion: 6,
            legacySessions: [{
              threadId: 1,
              configuration: {
                name: legacyName,
                settings: { modelReasoningEffort: legacyEffort, skipGitRepoCheck: true },
              },
              state: { providerSessionId: "existing-session" },
            }],
          });

          await host.createSession({
            threadId: 1,
            permissionProfileId: "auto",
            configuration: current,
            workingDirectory: directory,
          });

          expect(warning, "deferred configuration migrates during registration").toHaveBeenCalledWith(
            "Migrating deferred product Codex configuration for harness thread 1 during registration",
          );
          expect(restored.state, "deferred provider session survives").toEqual({ providerSessionId: "existing-session" });
          const finalState = JSON.parse(await readFile(stateFile, "utf8"));
          expect(finalState).toMatchObject({
            schemaVersion: 6,
            sessions: [{ threadId: 1, configuration: current, state: { providerSessionId: "existing-session" } }],
          });
          expect(finalState, "legacy sessions retire after promotion").not.toHaveProperty("legacySessions");
        } finally {
          warning.mockRestore();
          await host.close();
          await cleanup(directory);
        }
      }]);
    }

    cases.push(["schema-v5 keeps an Eval codex-basic-high provider session", async () => {
      const directory = await tempDirectory("relayer-harness-state-v5-eval-codex-high-");
      const stateFile = join(directory, "sessions.json");
      const high: HarnessConfiguration = {
        ...testConfiguration,
        name: "codex-basic-high",
        implementation: "codex.basic",
        revision: 2,
        executionAccessContracts: ["managed-runtime@1", "secret@1"],
        settings: { modelReasoningEffort: "high", skipGitRepoCheck: true },
      };
      const restored: { state: HarnessSessionState | undefined } = { state: undefined };
      const warning = silenceWarnings();
      const host = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: { "codex.basic": capturingFactory(restored) },
      });
      try {
        await writeFile(stateFile, JSON.stringify({
          schemaVersion: 5,
          sessions: [{
            threadId: 1,
            configuration: high,
            permissionProfileId: "auto",
            workingDirectory: directory,
            state: { providerSessionId: "eval-session" },
          }],
        }), { mode: 0o600 });
        await host.initialize();
        await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: high, workingDirectory: directory });

        expect(warning, "current Eval configuration never re-migrates").not.toHaveBeenCalled();
        expect(restored.state, "Eval provider session survives").toEqual({ providerSessionId: "eval-session" });
        expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
          schemaVersion: 6,
          sessions: [{ threadId: 1, configuration: high, state: { providerSessionId: "eval-session" } }],
        });
      } finally {
        warning.mockRestore();
        await host.close();
        await cleanup(directory);
      }
    }]);

    cases.push(["schema-v4 resumes provider state when only catalog model compatibility was added", async () => {
      const directory = await tempDirectory("relayer-harness-model-metadata-");
      const stateFile = join(directory, "sessions.json");
      const currentConfiguration: HarnessConfiguration = {
        ...testConfiguration,
        modelCompatibility: [{ providerId: "codex" }],
        executionAccessContracts: ["managed-runtime@1"],
      };
      const restored: { state: HarnessSessionState | undefined } = { state: undefined };
      const host = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: { test: capturingFactory(restored) },
      });
      try {
        await writeFile(stateFile, JSON.stringify({
          schemaVersion: 4,
          sessions: [{
            threadId: 1,
            configuration: { ...testConfiguration, executionAccessContracts: ["managed-runtime@1"] },
            permissionProfileId: "auto",
            workingDirectory: directory,
            state: { providerSessionId: "existing-session" },
          }],
        }), { mode: 0o600 });
        await host.initialize();

        await host.createSession({
          threadId: 1,
          permissionProfileId: "auto",
          configuration: currentConfiguration,
          workingDirectory: directory,
        });

        expect(restored.state, "catalog metadata alone resumes provider state").toEqual({ providerSessionId: "existing-session" });
        expect(JSON.parse(await readFile(stateFile, "utf8")).sessions[0].configuration,
          "registration refreshes the stored configuration").toEqual(currentConfiguration);
      } finally {
        await host.close();
        await cleanup(directory);
      }
    }]);

    cases.push(["schema-v4 discards pre-access-contract ambient provider state", async () => {
      const directory = await tempDirectory("relayer-harness-state-v4-pre-access-");
      const stateFile = join(directory, "sessions.json");
      const previousConfiguration = {
        ...testConfiguration,
        modelCompatibility: [{ providerId: "codex" }],
      };
      const currentConfiguration: HarnessConfiguration = {
        ...previousConfiguration,
        modelRules: { allow: [{ adapterId: "codex-subscription", modelIdRegex: ".*" }], deny: [] },
        executionAccessContracts: ["managed-runtime@1"],
      };
      const serialized = JSON.stringify({
        schemaVersion: 4,
        sessions: [{
          threadId: 1,
          configuration: previousConfiguration,
          permissionProfileId: "auto",
          workingDirectory: directory,
          state: { providerSessionId: "ambient-session" },
        }],
      });
      const restored: { state: HarnessSessionState | undefined } = { state: undefined };
      const warning = silenceWarnings();
      const host = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: { test: (context: HarnessFactoryContext) => {
          restored.state = context.savedState;
          return { async complete() {}, state: emptyState };
        } },
      });
      try {
        await writeFile(stateFile, serialized, { mode: 0o600 });

        await host.initialize();

        expect(await readFile(`${stateFile}.v4.backup`, "utf8"), "pre-migration backup preserved").toBe(serialized);
        expect(warning, "ambient state retirement is announced").toHaveBeenCalledWith(
          "Discarding pre-access-contract provider state for harness thread 1 during schema v4 migration",
        );
        expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({
          schemaVersion: 6,
          sessions: [],
        });

        await host.createSession({
          threadId: 1,
          permissionProfileId: "auto",
          configuration: currentConfiguration,
          workingDirectory: directory,
        });

        expect(restored.state, "ambient state never resumes").toBeUndefined();
        expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({
          schemaVersion: 6,
          sessions: [{
            threadId: 1,
            configuration: currentConfiguration,
            permissionProfileId: "auto",
            workingDirectory: directory,
            state: {},
          }],
        });
      } finally {
        warning.mockRestore();
        await host.close();
        await cleanup(directory);
      }
    }]);

    cases.push(["schema-v4 rejects model policy corruption outside the pre-access-contract shape", async () => {
      const directory = await tempDirectory("relayer-harness-state-v4-invalid-policy-");
      const stateFile = join(directory, "sessions.json");
      const host = new HarnessHost({ stateFile, controlToken: "control", implementations: {} });
      try {
        await writeFile(stateFile, JSON.stringify({
          schemaVersion: 4,
          sessions: [{
            threadId: 1,
            configuration: {
              ...testConfiguration,
              modelCompatibility: [{ providerId: "codex" }],
              modelRules: { allow: [], deny: [] },
            },
            permissionProfileId: "auto",
            workingDirectory: directory,
            state: { providerSessionId: "untrusted-session" },
          }],
        }), { mode: 0o600 });

        await expect(host.initialize(), "corrupt policy fails closed").rejects.toThrow("require executionAccessContracts");
      } finally {
        await cleanup(directory);
      }
    }]);

    cases.push(["schema-v3 migrates on startup and resumes matching Auto sessions", async () => {
      const directory = await tempDirectory("relayer-harness-state-v3-");
      const stateFile = join(directory, "sessions.json");
      const serialized = JSON.stringify({
        schemaVersion: 3,
        sessions: [{
          threadId: 1,
          configuration: {
            schemaVersion: 1,
            name: testConfiguration.name,
            implementation: testConfiguration.implementation,
            implementationVersion: 1,
            settings: {},
          },
          workingDirectory: directory,
          state: { providerSessionId: "legacy-session" },
        }],
      });
      const restored: { state: HarnessSessionState | undefined } = { state: undefined };
      const host = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: { test: capturingFactory(restored) },
      });
      try {
        await writeFile(stateFile, serialized, { mode: 0o600 });

        await host.initialize();

        expect(await readFile(`${stateFile}.v3.backup`, "utf8"), "pre-migration backup preserved").toBe(serialized);
        expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({
          schemaVersion: 6,
          sessions: [],
          legacySessions: [{
            threadId: 1,
            configuration: legacyConfiguration(testConfiguration),
            workingDirectory: directory,
            state: { providerSessionId: "legacy-session" },
          }],
        });

        await host.createSession({
          threadId: 1,
          permissionProfileId: "auto",
          configuration: testConfiguration,
          workingDirectory: directory,
        });

        expect(restored.state, "matching Auto session resumes").toEqual({ providerSessionId: "legacy-session" });
        expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({
          schemaVersion: 6,
          sessions: [{
            threadId: 1,
            configuration: testConfiguration,
            permissionProfileId: "auto",
            workingDirectory: directory,
            state: { providerSessionId: "legacy-session" },
          }],
        });
      } finally {
        await host.close();
        await cleanup(directory);
      }
    }]);

    cases.push(["schema-v3 never carries provider state into a different permission profile", async () => {
      const directory = await tempDirectory("relayer-harness-state-v3-profile-");
      const stateFile = join(directory, "sessions.json");
      const restored: { state: HarnessSessionState | undefined } = { state: undefined };
      const host = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: { test: (context: HarnessFactoryContext) => {
          restored.state = context.savedState;
          return { async complete() {}, state: emptyState };
        } },
      });
      try {
        await writeFile(stateFile, JSON.stringify({
          schemaVersion: 3,
          sessions: [{
            threadId: 1,
            configuration: legacyConfiguration(testConfiguration),
            workingDirectory: directory,
            state: { providerSessionId: "legacy-session" },
          }],
        }), { mode: 0o600 });
        await host.initialize();

        await host.createSession({
          threadId: 1,
          permissionProfileId: "full",
          configuration: testConfiguration,
          workingDirectory: directory,
        });

        expect(restored.state, "profile change discards legacy state").toBeUndefined();
        const finalState = JSON.parse(await readFile(stateFile, "utf8"));
        expect(finalState).toMatchObject({
          schemaVersion: 6,
          sessions: [{ threadId: 1, permissionProfileId: "full", state: {} }],
        });
        expect(finalState, "consumed legacy sessions retire").not.toHaveProperty("legacySessions");
      } finally {
        await host.close();
        await cleanup(directory);
      }
    }]);

    cases.push(["schema-v3 resumes provider state with the sole bound Full profile", async () => {
      const directory = await tempDirectory("relayer-harness-state-v3-full-");
      const stateFile = join(directory, "sessions.json");
      const configuration = {
        ...testConfiguration,
        name: "prime-agent-basic",
        permissionBindings: { full: {} },
      };
      const restored: { state: HarnessSessionState | undefined } = { state: undefined };
      const host = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: { test: capturingFactory(restored) },
      });
      try {
        await writeFile(stateFile, JSON.stringify({
          schemaVersion: 3,
          sessions: [{
            threadId: 1,
            configuration: legacyConfiguration(configuration),
            workingDirectory: directory,
            state: { providerSessionId: "legacy-prime-session" },
          }],
        }), { mode: 0o600 });
        await host.initialize();

        await host.createSession({
          threadId: 1,
          permissionProfileId: "full",
          configuration,
          workingDirectory: directory,
        });

        expect(restored.state, "sole-bound Full profile resumes").toEqual({ providerSessionId: "legacy-prime-session" });
        expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
          schemaVersion: 6,
          sessions: [{ threadId: 1, permissionProfileId: "full" }],
        });
      } finally {
        await host.close();
        await cleanup(directory);
      }
    }]);

    cases.push(["schema-v3 never resumes provider state after configuration settings change", async () => {
      const directory = await tempDirectory("relayer-harness-state-v3-settings-");
      const stateFile = join(directory, "sessions.json");
      const currentConfiguration = { ...testConfiguration, settings: { model: "new" } };
      const restored: { state: HarnessSessionState | undefined } = { state: undefined };
      const host = new HarnessHost({
        stateFile,
        controlToken: "control",
        implementations: { test: (context: HarnessFactoryContext) => {
          restored.state = context.savedState;
          return { async complete() {}, state: emptyState };
        } },
      });
      try {
        await writeFile(stateFile, JSON.stringify({
          schemaVersion: 3,
          sessions: [{
            threadId: 1,
            configuration: { ...legacyConfiguration(testConfiguration), settings: { model: "old" } },
            workingDirectory: directory,
            state: { providerSessionId: "legacy-session" },
          }],
        }), { mode: 0o600 });
        await host.initialize();

        await host.createSession({
          threadId: 1,
          permissionProfileId: "auto",
          configuration: currentConfiguration,
          workingDirectory: directory,
        });

        expect(restored.state, "settings change discards legacy state").toBeUndefined();
        expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
          schemaVersion: 6,
          sessions: [{
            threadId: 1,
            configuration: currentConfiguration,
            permissionProfileId: "auto",
            state: {},
          }],
        });
      } finally {
        await host.close();
        await cleanup(directory);
      }
    }]);

    cases.push(["schema-v3 skips invalid entries without blocking valid session migration", async () => {
      const directory = await tempDirectory("relayer-harness-state-v3-invalid-");
      const stateFile = join(directory, "sessions.json");
      const warning = silenceWarnings();
      const host = new HarnessHost({ stateFile, controlToken: "control", implementations: {} });
      try {
        await writeFile(stateFile, JSON.stringify({
          schemaVersion: 3,
          sessions: [
            { threadId: "invalid", configuration: {}, workingDirectory: directory },
            { threadId: 2, configuration: legacyConfiguration(testConfiguration), workingDirectory: directory },
          ],
        }), { mode: 0o600 });

        await host.initialize();

        expect(warning, "one invalid entry yields one warning").toHaveBeenCalledOnce();
        expect(JSON.parse(await readFile(stateFile, "utf8")).legacySessions, "valid entries still migrate").toEqual([{
          threadId: 2,
          configuration: legacyConfiguration(testConfiguration),
          workingDirectory: directory,
        }]);
      } finally {
        warning.mockRestore();
        await host.close();
        await cleanup(directory);
      }
    }]);

    cases.push(["pre-v3 host state rejects instead of guessing a migration", async () => {
      const directory = await tempDirectory("relayer-harness-state-migration-");
      const stateFile = join(directory, "sessions.json");
      try {
        await writeFile(stateFile, JSON.stringify({
          schemaVersion: 1,
          sessions: [{
            threadId: 1, permissionProfileId: "auto",
            harnessKey: "codex.basic",
            workingDirectory: directory,
            graph: { url: "http://127.0.0.1:1", token: "legacy-secret", nodeId: 1 },
            state: { codexThreadId: "codex-thread" },
          }],
        }), { mode: 0o600 });
        const host = new HarnessHost({ stateFile, controlToken: "control", implementations: {} });

        await expect(host.initialize(), "unsupported schema fails closed").rejects.toThrow("expected schema version 3, 4, 5, or 6");
      } finally {
        await cleanup(directory);
      }
    }]);

    expect(cases, "migration case inventory").toHaveLength(20);
    await runLabeledCases(cases);
  }, 60_000);

  it("registers threads once, awaits async factories, and pins graph authority", async () => {
    // Asynchronous harness construction gates session registration.
    {
      const directory = await tempDirectory("relayer-harness-async-factory-");
      let releaseFactory!: () => void;
      const factoryReady = new Promise<void>((resolveReady) => { releaseFactory = resolveReady; });
      try {
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: {
            test: async () => {
              await factoryReady;
              return { async complete() {}, state: emptyState };
            },
          },
        });
        await host.initialize();
        const creating = host.createSession({
          threadId: 1, permissionProfileId: "auto",
          configuration: testConfiguration,
          workingDirectory: directory,
        });
        await new Promise((resolveTurn) => setTimeout(resolveTurn, 0));
        expect(host.sessionCount(), "registration waits for the factory").toBe(0);

        releaseFactory();
        await creating;
        expect(host.sessionCount(), "factory completion registers the session").toBe(1);
      } finally {
        await cleanup(directory);
      }
    }

    // Concurrent registration of one thread constructs exactly one harness.
    {
      const directory = await tempDirectory("relayer-harness-concurrent-factory-");
      let factoryCalls = 0;
      try {
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: async () => {
            factoryCalls += 1;
            await new Promise((resolveTurn) => setTimeout(resolveTurn, 5));
            return { async complete() {}, state: emptyState };
          } },
        });
        await host.initialize();
        const descriptor = { threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory };

        await Promise.all([host.createSession(descriptor), host.createSession(descriptor)]);

        expect(factoryCalls, "concurrent registration builds one harness").toBe(1);
        expect(host.sessionCount(), "concurrent registration yields one session").toBe(1);
      } finally {
        await cleanup(directory);
      }
    }

    // Omitted graph profiles normalize to disabled; live authority changes reject.
    {
      const directory = await tempDirectory("relayer-harness-live-graph-profile-");
      let factoryCalls = 0;
      try {
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => {
            factoryCalls += 1;
            return { async complete() {}, state: emptyState };
          } },
        });
        await host.initialize();
        const descriptor = { threadId: 1, permissionProfileId: "auto", workingDirectory: directory };

        await host.createSession({ ...descriptor, configuration: testConfiguration });
        await host.createSession({ ...descriptor, configuration: graphSearchConfiguration("disabled") });
        expect(factoryCalls, "omitted and disabled profiles share one harness").toBe(1);
        await expect(host.createSession({
          ...descriptor,
          configuration: graphSearchConfiguration("query-v1"),
        }), "live search-authority upgrade rejects").rejects.toThrow("already pinned");
        expect(factoryCalls, "pinned rejection never builds a harness").toBe(1);

        await host.createSession({
          ...descriptor,
          threadId: 2,
          configuration: graphSearchConfiguration("query-v1"),
        });
        expect(factoryCalls, "a new thread pins its own authority").toBe(2);
        await expect(host.createSession({
          ...descriptor,
          threadId: 2,
          configuration: graphSearchConfiguration("disabled"),
        }), "live search-authority downgrade rejects").rejects.toThrow("already pinned");
        expect(factoryCalls, "downgrade rejection builds nothing").toBe(2);
      } finally {
        await cleanup(directory);
      }
    }

    // Invalid initial harness state disposes the harness and rejects registration.
    {
      const directory = await tempDirectory("relayer-harness-invalid-state-");
      const dispose = vi.fn(async () => undefined);
      try {
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => ({
            async complete() {},
            state: () => ({ invalid: Number.NaN }),
            dispose,
          }) },
        });
        await host.initialize();

        await expect(host.createSession({
          threadId: 1, permissionProfileId: "auto",
          configuration: testConfiguration,
          workingDirectory: directory,
        }), "invalid implementation state fails closed").rejects.toThrow("invalid implementation state");
        expect(dispose, "invalid harness is disposed").toHaveBeenCalledTimes(1);
        expect(host.sessionCount(), "invalid harness never registers").toBe(0);
      } finally {
        await cleanup(directory);
      }
    }
  }, 20_000);

  it("serializes completions and makes close terminal for live and queued work", async () => {
    // Complete calls serialize per thread while each call keeps its own graph scope.
    {
      const directory = await tempDirectory("relayer-harness-serialized-rotation-");
      let completionStarted!: () => void;
      let finishCompletion!: () => void;
      const started = new Promise<void>((resolveStarted) => { completionStarted = resolveStarted; });
      const finish = new Promise<void>((resolveFinish) => { finishCompletion = resolveFinish; });
      const adopted: string[] = [];
      const accepted = new Set<number>();
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => url.endsWith("/output")
        ? (accepted.has(Number(/nodes\/(\d+)/.exec(url)?.[1]))
          ? jsonResponse(completion)
          : completionNotFound())
        : graphReadResponse(url, new Headers(init?.headers).get("authorization") === "Bearer second-token" ? 2 : 1)));
      try {
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => ({
            async complete(context) {
              adopted.push(context.graph.acquireCapability().token);
              if (adopted.length === 1) { completionStarted(); await finish; }
              accepted.add(context.inputGraph.id);
            },
            state: emptyState,
          }) },
        });
        await host.initialize();
        const first = { threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory };
        await host.createSession(first);

        const completing = host.complete(1, 1, graph(1, "first-token"));
        await started;
        const queued = host.complete(1, 2, graph(2, "second-token"));
        await new Promise((resolveTurn) => setTimeout(resolveTurn, 0));
        expect(adopted, "queued completion waits for the active one").toEqual(["first-token"]);

        finishCompletion();
        await completing;
        await queued;
        expect(adopted, "each serialized call adopts its own scope").toEqual(["first-token", "second-token"]);
      } finally {
        vi.unstubAllGlobals();
        await cleanup(directory);
      }
    }

    // A state-capture throw releases the per-thread queue.
    {
      const directory = await tempDirectory("relayer-harness-queue-");
      let stateCalls = 0;
      let accepted = false;
      vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
        ? (accepted ? jsonResponse(completion) : completionNotFound())
        : graphReadResponse(url)));
      try {
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => ({
            async complete() { accepted = true; },
            state() { if (stateCalls++ === 1) throw new Error("state failed"); return emptyState(); },
          }) },
        });
        await host.initialize();
        await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });

        await expect(host.complete(1, 1, graph()), "state capture failure surfaces").rejects.toThrow("state failed");
        await expect(host.complete(1, 2, graph()), "queue releases after capture failure").resolves.toMatchObject({ output: completion });
      } finally {
        vi.unstubAllGlobals();
        await cleanup(directory);
      }
    }

    // Close disposes live harnesses exactly once and is terminal.
    {
      const directory = await tempDirectory("relayer-harness-dispose-");
      const dispose = vi.fn(async () => undefined);
      try {
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => ({ async complete() {}, state: emptyState, dispose }) },
        });
        await host.initialize();
        const descriptor = { threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory };
        await host.createSession(descriptor);

        await host.close();
        await host.close();
        expect(dispose, "close disposes each harness once").toHaveBeenCalledTimes(1);
        expect(host.sessionCount(), "close empties the session table").toBe(0);
        await expect(host.createSession(descriptor), "registration after close rejects").rejects.toThrow("closed");
      } finally {
        await cleanup(directory);
      }
    }

    // Shutdown rejects admitted queued completions before disposing the harness.
    {
      const directory = await tempDirectory("relayer-harness-close-queue-");
      let completionStarted!: () => void;
      const started = new Promise<void>((resolveStarted) => { completionStarted = resolveStarted; });
      const calls: number[] = [];
      const dispose = vi.fn(async () => undefined);
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/output")) return completionNotFound();
        const nodeId = new Headers(init?.headers).get("authorization") === "Bearer queued-token" ? 2 : 1;
        return graphReadResponse(url, nodeId);
      }));
      try {
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          trace: { directory: join(directory, "shutdown-traces"), policy: requiredTracePolicy },
          implementations: { test: () => ({
            complete(context, signal) {
              calls.push(context.inputGraph.id);
              if (calls.length > 1) return Promise.resolve();
              completionStarted();
              return new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
            },
            state: emptyState,
            dispose,
          }) },
        });
        await host.initialize();
        await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });

        const active = host.complete(1, 1, graph(1, "active-token"), undefined, undefined, { productInteractionId: 10 });
        await started;
        const queued = host.complete(1, 2, graph(2, "queued-token"));
        const closing = host.close();

        await expect(active, "active completion rejects on shutdown").rejects.toThrow("closed");
        await expect(queued, "queued completion rejects before running").rejects.toThrow("closed");
        await closing;
        expect(calls, "queued work never starts during shutdown").toEqual([1]);
        expect(dispose, "shutdown disposes exactly once").toHaveBeenCalledTimes(1);
        await host.exportCandidateTrace(10, join(directory, "shutdown-export"), {
          runId: "run", executionId: "execution", interactionId: "10", harnessConfigurationName: "test-default",
        });
        expect(JSON.parse(await readFile(join(directory, "shutdown-export", "manifest.json"), "utf8")),
          "shutdown exports a partial trace").toMatchObject({ status: "partial" });
      } finally {
        vi.unstubAllGlobals();
        await cleanup(directory);
      }
    }

    // Concurrent initialization and close become terminal before trace cleanup mutates again.
    for (const force of [false, true]) {
      const directory = await tempDirectory(`relayer-harness-trace-${force ? "force" : "close"}-race-`);
      const spool = join(directory, "spool");
      const abandoned = join(spool, "abandoned.txt");
      try {
        await mkdir(spool, { mode: 0o700 });
        await writeFile(abandoned, "cleanup-owned\n");
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: {},
          trace: {
            directory: spool,
            policy: {
              mode: "required",
              requiredFeatures: {},
              includeNativeArtifacts: false,
              maxBytesPerTurn: 1_000,
              maxEventsPerTurn: 10,
            },
          },
        });

        const initializing = host.initialize();
        expect(host.initialize(), "initialize deduplicates").toBe(initializing);
        const closing = force ? host.forceClose() : host.close();
        expect(force ? host.forceClose() : host.close(), "close deduplicates").toBe(closing);
        await expect(initializing, `close wins the ${force ? "force" : "graceful"} race`).rejects.toThrow("closed");
        await closing;
        await expect(readFile(abandoned, "utf8"), "startup cleanup never runs after close").rejects.toThrow();
        const sentinel = join(spool, "post-close-sentinel.txt");
        await writeFile(sentinel, "survives\n");
        await Promise.resolve();
        await expect(readFile(sentinel, "utf8"), "post-close writes survive").resolves.toBe("survives\n");
        await expect(host.createSession({
          threadId: 1,
          permissionProfileId: "auto",
          configuration: testConfiguration,
          workingDirectory: directory,
        }), "registration after the race rejects").rejects.toThrow("closed");
        await expect(host.complete(1, 1, graph()), "completion after the race rejects").rejects.toThrow("closed");
      } finally {
        await cleanup(directory);
      }
    }

    // A close that wins initialization never migrates legacy state.
    {
      const directory = await tempDirectory("relayer-harness-close-migration-race-");
      const stateFile = join(directory, "sessions.json");
      const serialized = `${JSON.stringify({ schemaVersion: 3, sessions: [] }, null, 2)}\n`;
      try {
        await writeFile(stateFile, serialized, { mode: 0o600 });
        const host = new HarnessHost({ stateFile, controlToken: "control", implementations: {} });
        const initializing = host.initialize();
        const closing = host.close();
        await expect(initializing, "close wins initialization").rejects.toThrow("closed");
        await closing;
        await expect(readFile(`${stateFile}.v3.backup`, "utf8"), "no backup after a lost race").rejects.toThrow();
        await expect(readFile(stateFile, "utf8"), "state file stays untouched").resolves.toBe(serialized);
      } finally {
        await cleanup(directory);
      }
    }

    // The canonical force promise publishes before synchronous provider reentry.
    {
      const directory = await tempDirectory("relayer-harness-force-reentry-");
      let host!: HarnessHost;
      let reentered: Promise<void> | undefined;
      let markDisposed!: () => void;
      const disposed = new Promise<void>((resolve) => { markDisposed = resolve; });
      const dispose = vi.fn(() => { markDisposed(); });
      try {
        host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => ({
            async complete() {},
            state: emptyState,
            forceShutdown() { reentered = host.forceClose(); },
            dispose,
          }) },
        });
        await host.initialize();
        await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });

        const forcing = host.forceClose();
        expect(reentered, "synchronous reentry sees the canonical promise").toBe(forcing);
        expect(host.forceClose(), "force close deduplicates").toBe(forcing);
        await forcing;
        await disposed;
        expect(dispose, "forced close disposes once").toHaveBeenCalledOnce();
        await expect(host.createSession({
          threadId: 2,
          permissionProfileId: "auto",
          configuration: testConfiguration,
          workingDirectory: directory,
        }), "registration after force close rejects").rejects.toThrow("closed");
      } finally {
        await host?.forceClose().catch(() => {});
        await cleanup(directory);
      }
    }
  }, 60_000);

  it("disposes late harnesses through every close and force-close fallback", async () => {
    const pendingHarnessFixture = () => {
      let resolveHarness!: (harness: Harness) => void;
      const pendingHarness = new Promise<Harness>((resolve) => { resolveHarness = resolve; });
      let markFactoryStarted!: () => void;
      const factoryStarted = new Promise<void>((resolve) => { markFactoryStarted = resolve; });
      return { pendingHarness, resolveHarness, factoryStarted, markFactoryStarted };
    };

    const cases: Array<readonly [string, () => Promise<void>]> = [
      ["graceful close disposes a harness that finishes starting late", async () => {
        const directory = await tempDirectory("relayer-harness-close-during-factory-");
        let releaseFactory!: () => void;
        const factoryReady = new Promise<void>((resolveReady) => { releaseFactory = resolveReady; });
        const dispose = vi.fn(async () => undefined);
        try {
          const host = new HarnessHost({
            stateFile: join(directory, "sessions.json"),
            controlToken: "control",
            implementations: { test: async () => {
              await factoryReady;
              return { async complete() {}, state: emptyState, dispose };
            } },
          });
          await host.initialize();
          const creating = host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
          await new Promise((resolveTurn) => setTimeout(resolveTurn, 0));

          await host.close();
          releaseFactory();

          await expect(creating, "late registration rejects after graceful close").rejects.toThrow("closed while the session was starting");
          expect(dispose, "late harness is disposed").toHaveBeenCalledTimes(1);
          expect(host.sessionCount(), "late harness never registers").toBe(0);
        } finally {
          await cleanup(directory);
        }
      }],
      ["force close force-disposes a pending registration", async () => {
        const directory = await tempDirectory("relayer-harness-pending-force-close-");
        const { pendingHarness, resolveHarness, factoryStarted, markFactoryStarted } = pendingHarnessFixture();
        const forceShutdown = vi.fn();
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => { markFactoryStarted(); return pendingHarness; } },
        });
        try {
          await host.initialize();
          const registering = host.createSession({
            threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory,
          });

          await factoryStarted;
          await host.forceClose();
          resolveHarness({ async complete() {}, state: emptyState, forceShutdown });

          await expect(registering, "late registration rejects after force close").rejects.toThrow("force-closed while the session was starting");
          expect(forceShutdown, "force disposer runs for the late harness").toHaveBeenCalledOnce();
        } finally {
          resolveHarness({ async complete() {}, state: emptyState, forceShutdown });
          await host.forceClose().catch(() => {});
          await cleanup(directory);
        }
      }],
      ["force close contains a late force-dispose throw and falls back to bounded disposal", async () => {
        const directory = await tempDirectory("relayer-harness-late-force-throw-");
        const { pendingHarness, resolveHarness, factoryStarted, markFactoryStarted } = pendingHarnessFixture();
        const forceShutdown = vi.fn(() => { throw new Error("late force cleanup failed"); });
        const dispose = vi.fn(() => new Promise<void>(() => {}));
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => { markFactoryStarted(); return pendingHarness; } },
        });
        try {
          await host.initialize();
          const registering = host.createSession({
            threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory,
          });
          await factoryStarted;
          await host.forceClose();
          resolveHarness({ async complete() {}, state: emptyState, forceShutdown, dispose });

          await expect(registering, "late registration rejects after force close").rejects.toThrow("Harness host force-closed while the session was starting");
          expect(forceShutdown, "throwing force disposer is attempted once").toHaveBeenCalledOnce();
          expect(dispose, "bounded fallback disposal follows").toHaveBeenCalledOnce();
          await expect(host.forceClose(), "force close stays terminal after containment").resolves.toBeUndefined();
        } finally {
          resolveHarness({ async complete() {}, state: emptyState, forceShutdown, dispose });
          await host.forceClose().catch(() => {});
          await cleanup(directory);
        }
      }],
      ["force close falls back to bounded disposal without a force disposer", async () => {
        const directory = await tempDirectory("relayer-harness-pending-force-fallback-");
        const { pendingHarness, resolveHarness, factoryStarted, markFactoryStarted } = pendingHarnessFixture();
        const dispose = vi.fn(() => new Promise<void>(() => {}));
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => { markFactoryStarted(); return pendingHarness; } },
        });
        try {
          await host.initialize();
          const registering = host.createSession({
            threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory,
          });
          await factoryStarted;
          await host.forceClose();

          resolveHarness({ async complete() {}, state: emptyState, dispose });

          await expect(registering, "late registration rejects after force close").rejects.toThrow("force-closed while the session was starting");
          expect(dispose, "bounded disposal runs without a force disposer").toHaveBeenCalledOnce();
        } finally {
          resolveHarness({ async complete() {}, state: emptyState, dispose });
          await host.forceClose().catch(() => {});
          await cleanup(directory);
        }
      }],
      ["force close keeps a stalled graceful disposal reachable until it drains", async () => {
        const directory = await tempDirectory("relayer-harness-late-grace-force-");
        const { pendingHarness, resolveHarness, factoryStarted, markFactoryStarted } = pendingHarnessFixture();
        let markDisposeStarted!: () => void;
        let releaseDispose!: () => void;
        const disposeStarted = new Promise<void>((resolve) => { markDisposeStarted = resolve; });
        const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve; });
        const forceShutdown = vi.fn(() => releaseDispose());
        const dispose = vi.fn(async () => { markDisposeStarted(); await disposeGate; });
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => { markFactoryStarted(); return pendingHarness; } },
        });
        try {
          await host.initialize();
          const registering = host.createSession({
            threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory,
          });
          await factoryStarted;
          await host.close();
          resolveHarness({ async complete() {}, state: emptyState, dispose, forceShutdown });
          await disposeStarted;

          await host.forceClose();
          await expect(registering, "late registration rejects after graceful close").rejects.toThrow("closed while the session was starting");

          expect(dispose, "graceful disposal keeps running").toHaveBeenCalledOnce();
          expect(forceShutdown, "force close unblocks the stalled disposal").toHaveBeenCalledOnce();
        } finally {
          releaseDispose();
          resolveHarness({ async complete() {}, state: emptyState, dispose, forceShutdown });
          await host.forceClose().catch(() => {});
          await cleanup(directory);
        }
      }],
      ["a late Prime harness completes graceful fallback after forced native disposal throws", async () => {
        const directory = await tempDirectory("relayer-harness-late-prime-force-throw-");
        const { pendingHarness, resolveHarness, factoryStarted, markFactoryStarted } = pendingHarnessFixture();
        let markFallbackFinished!: () => void;
        const fallbackFinished = new Promise<void>((resolve) => { markFallbackFinished = resolve; });
        let nativeAttempts = 0;
        const nativeDispose = vi.fn(() => {
          nativeAttempts += 1;
          if (nativeAttempts === 1) throw new Error("late Prime native cleanup failed");
        });
        const session = {
          promptAndWait: vi.fn(async () => undefined),
          waitForRlmQuiescence: vi.fn(async () => undefined),
          abort: vi.fn(async () => undefined),
          dispose: nativeDispose,
          disposeAsync: vi.fn(async () => {
            session.dispose();
            markFallbackFinished();
          }),
        };
        const harness = await PrimeAgentHarness.create({
          threadId: 1,
          workingDirectory: directory,
          permissionProfileId: "full",
          permissionBinding: {},
          configuration: {
            schemaVersion: 1,
            name: "prime-agent-test",
            implementation: "prime.agent",
            implementationVersion: 1,
            permissionBindings: { full: {} },
            settings: {},
          },
        }, { loadModule: async () => ({
          SessionManager: { create: vi.fn(() => "new-session"), open: vi.fn() },
          createHostRequestHandler: (handler: unknown) => handler,
          createAgentSessionServices: vi.fn(async () => ({ modelRegistry: { find: vi.fn() } })),
          createAgentSessionFromServices: vi.fn(async () => ({ session })),
        }) as never });
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => { markFactoryStarted(); return pendingHarness; } },
        });
        try {
          await host.initialize();
          const registering = host.createSession({
            threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory,
          });
          await factoryStarted;
          await host.forceClose();

          resolveHarness(harness);

          await expect(registering, "late registration rejects after force close").rejects.toThrow("Harness host force-closed while the session was starting");
          await fallbackFinished;
          expect(session.abort, "graceful fallback aborts the session").toHaveBeenCalledOnce();
          expect(session.disposeAsync, "graceful fallback disposes asynchronously").toHaveBeenCalledOnce();
          expect(nativeDispose, "native disposal is retried through the fallback").toHaveBeenCalledTimes(2);
        } finally {
          resolveHarness(harness);
          await host.forceClose().catch(() => {});
          await cleanup(directory);
        }
      }],
      ["force close severs the listener and sockets while graceful disposal stalls", async () => {
        const directory = await tempDirectory("relayer-harness-force-close-");
        let running: Awaited<ReturnType<typeof startHarnessHost>> | undefined;
        let releaseDispose!: () => void;
        let markDisposeStarted!: () => void;
        const disposeStarted = new Promise<void>((resolveStarted) => { markDisposeStarted = resolveStarted; });
        const disposeGate = new Promise<void>((resolveDispose) => { releaseDispose = resolveDispose; });
        const forceShutdown = vi.fn();
        const dispose = vi.fn(async () => {
          markDisposeStarted();
          await disposeGate;
        });
        try {
          running = await startHarnessHost({
            stateFile: join(directory, "sessions.json"),
            controlToken: "control",
            implementations: { test: () => ({
              async complete() {},
              state: emptyState,
              dispose,
              forceShutdown,
            }) },
          });
          await running.host.createSession({
            threadId: 1,
            permissionProfileId: "auto",
            configuration: testConfiguration,
            workingDirectory: directory,
          });
          const address = new URL(running.url);
          const socket = connect(Number(address.port), address.hostname);
          await new Promise<void>((resolveConnect, reject) => {
            socket.once("connect", resolveConnect);
            socket.once("error", reject);
          });
          const socketClosed = new Promise<void>((resolveClose) => socket.once("close", () => resolveClose()));
          socket.write("POST /sessions HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{");

          const closing = running.close();
          await disposeStarted;
          const forced = running.forceClose();
          const forcedAgain = running.forceClose();
          expect(forceShutdown, "force close reaches the stalled harness").toHaveBeenCalledOnce();
          await socketClosed;
          await expect(fetch(`${running.url}/sessions`, { method: "POST" }), "listener stops accepting work").rejects.toThrow();
          releaseDispose();
          await Promise.all([forced, forcedAgain]);
          await closing;
          expect(dispose, "graceful disposal still completes once").toHaveBeenCalledOnce();
          expect(forceShutdown, "force shutdown is invoked once").toHaveBeenCalledOnce();
        } finally {
          releaseDispose();
          await running?.forceClose();
          await cleanup(directory);
        }
      }],
    ];
    expect(cases, "late disposal inventory").toHaveLength(7);
    await runLabeledCases(cases);
  }, 60_000);

  it("runs invoked completions once, recovers them by binding, and unwinds before disposal", async () => {
    const cases: Array<readonly [string, () => Promise<void>]> = [
      ["disabled Complete authority rejects broker and invoke-origin execution", async () => {
        const directory = await tempDirectory("relayer-complete-authority-");
        let calls = 0;
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => ({
            supportsInvokedComplete: true,
            async complete() { calls += 1; },
            state: emptyState,
          }) },
        });
        try {
          await host.initialize();
          await host.createSession({
            threadId: 1,
            permissionProfileId: "auto",
            configuration: testConfiguration,
            workingDirectory: directory,
          });
          const completionBroker = {
            url: "http://127.0.0.1:43125/api/completions",
            token: "12345678901234567890123456789012",
          };

          await expect(host.complete(
            1, 1, graph(), undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            completionBroker,
          ), "broker authority rejects without Complete").rejects.toThrow("does not allow agent-authored Complete");
          await expect(host.complete(1, { ...invoked(graph(2)), completionBroker }),
            "invoke origin rejects without Complete").rejects.toThrow("does not allow agent-authored Complete");
          expect(calls, "no execution without authority").toBe(0);
        } finally {
          await host.close();
          await cleanup(directory);
        }
      }],
      ["in-flight retries join the running provider", async () => {
        const directory = await tempDirectory("relayer-harness-recursive-retry-");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let starts = 0;
        let accepted = false;
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
          if (url.endsWith("/output")) return accepted ? jsonResponse(completion) : completionNotFound();
          const nodeId = Number(/nodes\/(\d+)/u.exec(url)?.[1] ?? 2);
          return graphReadResponse(url, nodeId, [], nodeId + 100);
        }));
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => ({
            supportsInvokedComplete: true,
            async complete() {
              starts += 1;
              await gate;
              accepted = true;
            },
            state: emptyState,
          }) },
        });
        await host.initialize();
        await host.createSession({
          threadId: 1,
          permissionProfileId: "auto",
          configuration: completeEnabledConfiguration,
          workingDirectory: directory,
        });
        try {
          const capability = graph(2, "child-token");
          const first = host.complete(1, invoked(capability));
          const retry = host.complete(1, invoked(capability));
          await vi.waitFor(() => expect(starts, "provider starts once").toBe(1));
          release();
          await expect(Promise.all([first, retry]), "both callers receive the result").resolves.toHaveLength(2);
          expect(starts, "retry never restarts the provider").toBe(1);
        } finally {
          vi.unstubAllGlobals();
          await cleanup(directory);
        }
      }],
      ["settled invoked failures replay without restarting the provider", async () => {
        const directory = await tempDirectory("relayer-harness-recursive-settled-retry-");
        let starts = 0;
        vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
          ? completionNotFound()
          : graphReadResponse(url, 2, [], 102)));
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => ({
            supportsInvokedComplete: true,
            async complete() {
              starts += 1;
              throw new Error("invoked provider failed");
            },
            state: emptyState,
          }) },
        });
        try {
          await host.initialize();
          await host.createSession({
            threadId: 1,
            permissionProfileId: "auto",
            configuration: completeEnabledConfiguration,
            workingDirectory: directory,
          });
          const capability = graph(2, "child-token");

          const first = host.complete(1, invoked(capability));
          await expect(first, "failure surfaces once").rejects.toThrow("invoked provider failed");
          const retry = host.complete(1, invoked(capability));

          await expect(retry, "failure replays from the settled record").rejects.toThrow("invoked provider failed");
          expect(starts, "settled failure never restarts the provider").toBe(1);
        } finally {
          vi.unstubAllGlobals();
          await cleanup(directory);
        }
      }],
      ["accepted invoked results recover before requiring a new provider attachment", async () => {
        const directory = await tempDirectory("relayer-harness-invoked-accepted-recovery-");
        let starts = 0;
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
          const nodeId = Number(/nodes\/(\d+)/u.exec(url)?.[1] ?? 2);
          if (url.endsWith("/output")) {
            return nodeId === 2 ? jsonResponse(completion) : completionNotFound();
          }
          return graphReadResponse(url, nodeId, [], nodeId + 100);
        }));
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => ({
            async complete() { starts += 1; },
            state: emptyState,
          }) },
        });
        try {
          await host.initialize();
          await host.createSession({
            threadId: 1,
            permissionProfileId: "auto",
            configuration: completeEnabledConfiguration,
            workingDirectory: directory,
          });

          await expect(host.complete(1, invoked(graph(3, "unsupported-token"))),
            "unsupported adapters reject invoked recovery").rejects.toThrow("does not support agent-invoked Complete");
          await expect(host.complete(1, invoked(graph(2, "recovered-token"))),
            "accepted output recovers without attachment").resolves.toEqual({ completionId: 2 });
          expect(starts, "recovery never runs the provider").toBe(0);
        } finally {
          vi.unstubAllGlobals();
          await cleanup(directory);
        }
      }],
      ["conflicting bindings never transfer an in-flight invoked result", async () => {
        const directory = await tempDirectory("relayer-harness-recursive-binding-conflict-");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let starts = 0;
        let accepted = false;
        vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
          ? (accepted ? jsonResponse(completion) : completionNotFound())
          : graphReadResponse(url, 2, [], 102)));
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => ({
            supportsInvokedComplete: true,
            async complete() {
              starts += 1;
              await gate;
              accepted = true;
            },
            state: emptyState,
          }) },
        });
        try {
          await host.initialize();
          await host.createSession({
            threadId: 1,
            permissionProfileId: "auto",
            configuration: completeEnabledConfiguration,
            workingDirectory: directory,
          });
          await expect(host.complete(1, {
            capability: graph(4, "root-smuggle-token"),
            origin: ({ kind: "root", sourceCompletionId: 1, actionId: 104 } as unknown as HarnessInvokedCompletion["origin"]),
          }), "forged root provenance rejects").rejects.toThrow("invalid trusted origin provenance");
          await expect(host.complete(1, invoked(graph(3, "forged-token"), 1, 999)),
            "action lease must match the graph").rejects.toThrow("does not match its graph-owned action lease");
          expect(starts, "invalid bindings never start the provider").toBe(0);
          const running = host.complete(1, invoked(graph(2, "child-token")));
          await vi.waitFor(() => expect(starts, "provider starts once").toBe(1));

          const reorderedRetry = host.complete(1, {
            capability: { nodeId: 2, token: "child-token", url: "http://127.0.0.1:43123" },
            origin: { actionId: 102, sourceCompletionId: 1, kind: "invoke" },
          });

          const rotatedCapabilityRetry = host.complete(1, invoked(graph(2, "foreign-token")));
          await expect(host.complete(1, invoked(graph(2, "child-token"), 1, 999)),
            "conflicting action leases reject").rejects.toThrow("different graph binding");
          await expect(host.complete(1, {
            ...invoked(graph(2, "child-token")),
            model: { providerId: "provider", adapterId: "openai-api", modelId: "different-model" },
          }), "conflicting model selections reject").rejects.toThrow("different graph binding");

          release();
          await expect(Promise.all([running, reorderedRetry, rotatedCapabilityRetry]),
            "equivalent bindings join the in-flight completion").resolves.toHaveLength(3);
          expect(starts, "equivalent retries never restart the provider").toBe(1);
        } finally {
          vi.unstubAllGlobals();
          await cleanup(directory);
        }
      }],
      ["provider-owned invoked completions run concurrently with exact cancellation", async () => {
        const directory = await tempDirectory("relayer-harness-recursive-concurrency-");
        const started = new Set<number>();
        const accepted = new Set<number>();
        const releases = new Map<number, () => void>();
        vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
          if (url.endsWith("/output")) {
            const nodeId = Number(/nodes\/(\d+)/.exec(url)?.[1]);
            return accepted.has(nodeId) ? jsonResponse(completion) : completionNotFound();
          }
          const token = new Headers(init?.headers).get("authorization");
          const nodeId = token === "Bearer child-b-token" ? 3 : 2;
          return graphReadResponse(url, nodeId, [], nodeId + 100);
        }));
        try {
          const host = new HarnessHost({
            stateFile: join(directory, "sessions.json"),
            controlToken: "control",
            implementations: { test: () => ({
              supportsInvokedComplete: true,
              complete(context, signal) {
                const id = context.inputGraph.id;
                started.add(id);
                return new Promise<void>((resolve, reject) => {
                  releases.set(id, () => { accepted.add(id); resolve(); });
                  signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
                });
              },
              state: emptyState,
            }) },
          });
          await host.initialize();
          await host.createSession({
            threadId: 1,
            permissionProfileId: "auto",
            configuration: completeEnabledConfiguration,
            workingDirectory: directory,
          });

          const first = host.complete(1, invoked(graph(2, "child-a-token")));
          const second = host.complete(1, invoked(graph(3, "child-b-token")));
          await vi.waitFor(() => expect([...started].sort(), "both invoked completions run concurrently").toEqual([2, 3]));

          expect(host.cancel(1, 2), "cancellation targets one exact completion").toBe(true);
          releases.get(3)!();
          await expect(first, "cancelled completion rejects").rejects.toThrow("cancelled for thread 1");
          await expect(second, "sibling completion survives").resolves.toEqual({ completionId: 3 });
          expect(host.cancel(1, 3), "settled completions cannot be cancelled").toBe(false);
        } finally {
          vi.unstubAllGlobals();
          await cleanup(directory);
        }
      }],
      ["close waits for invoked cleanup before disposing the provider session", async () => {
        const directory = await tempDirectory("relayer-harness-recursive-close-");
        let started!: () => void;
        const didStart = new Promise<void>((resolve) => { started = resolve; });
        let unwound = false;
        let disposed = false;
        vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
          ? completionNotFound()
          : graphReadResponse(url, 2, [], 102)));
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => ({
            supportsInvokedComplete: true,
            complete(_context, signal) {
              started();
              return new Promise<void>((_resolve, reject) => {
                signal?.addEventListener("abort", () => {
                  setTimeout(() => {
                    unwound = true;
                    reject(signal.reason);
                  }, 10);
                }, { once: true });
              });
            },
            state: emptyState,
            dispose() {
              expect(unwound).toBe(true);
              disposed = true;
            },
          }) },
        });
        try {
          await host.initialize();
          await host.createSession({
            threadId: 1,
            permissionProfileId: "auto",
            configuration: completeEnabledConfiguration,
            workingDirectory: directory,
          });
          const running = host.complete(1, invoked(graph(2, "child-token")));
          await didStart;
          const closing = host.close();
          await expect(running, "close rejects the invoked completion").rejects.toThrow("Harness host closed");
          await expect(closing, "close resolves after cleanup").resolves.toBeUndefined();
          expect(disposed, "disposal follows unwind").toBe(true);
        } finally {
          vi.unstubAllGlobals();
          await cleanup(directory);
        }
      }],
    ];
    expect(cases, "invoked completion inventory").toHaveLength(7);
    await runLabeledCases(cases);
  }, 60_000);

  it("starts an invoked completion over HTTP once, acknowledges native attachment, and cancels its exact completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-recursive-start-route-"));
    const nativeFetch = globalThis.fetch;
    let running: Awaited<ReturnType<typeof startHarnessHost>> | undefined;
    let starts = 0;
    let observedCompletionBroker: unknown;
    let resolveAttachment!: (attachment: { schemaVersion: number; provider: string; threadId: string; turnId: string }) => void;
    const attached = new Promise<{ schemaVersion: number; provider: string; threadId: string; turnId: string }>((resolve) => {
      resolveAttachment = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith("http://127.0.0.1:43123")) return nativeFetch(input, init);
      if (url.endsWith("/output")) {
        return new Response(JSON.stringify({ error: { code: "completion_not_found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/neighbors")) {
        return new Response(JSON.stringify({ nodes: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return graphReadResponse(url, 2, [], 102);
    }));
    try {
      running = await startHarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        trace: {
          directory: join(directory, "traces"),
          policy: { mode: "required", requiredFeatures: {}, includeNativeArtifacts: false, maxBytesPerTurn: 10_000, maxEventsPerTurn: 100 },
        },
        implementations: { test: () => ({
          supportsInvokedComplete: true,
          complete(context, signal) {
            starts += 1;
            observedCompletionBroker = context.completionBroker;
            context.trace.emit({ type: "message", data: { text: "attributed invoked completion" } });
            const execution = new Promise<void>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
            return nativeExecutionHandle(execution, undefined, attached);
          },
          state: emptyState,
        }) },
      });
      await running.host.createSession({
        threadId: 1,
        permissionProfileId: "auto",
        configuration: completeEnabledConfiguration,
        workingDirectory: directory,
      });
      const invocation = {
        ...invoked(graph(2, "child-token")),
        traceContext: { productInteractionId: 29 },
        completionBroker: {
          url: "http://127.0.0.1:43125/api/completions",
          token: "12345678901234567890123456789012",
        },
      };
      const request = () => fetch(`${running!.url}/sessions/1/invoked-completions`, {
        method: "POST",
        headers: { authorization: "Bearer control", "content-type": "application/json" },
        body: JSON.stringify(invocation),
      });

      const first = request();
      const retry = request();
      await vi.waitFor(() => expect(starts).toBe(1));
      resolveAttachment({ schemaVersion: 1, provider: "codex", threadId: "native-thread", turnId: "native-turn" });

      const [firstResponse, retryResponse] = await Promise.all([first, retry]);
      expect(firstResponse.status).toBe(201);
      expect(retryResponse.status).toBe(201);
      const acknowledgement = {
        completionId: 2,
        attachment: { schemaVersion: 1, provider: "codex", threadId: "native-thread", turnId: "native-turn" },
      };
      await expect(firstResponse.json()).resolves.toEqual(acknowledgement);
      await expect(retryResponse.json()).resolves.toEqual(acknowledgement);
      expect(starts).toBe(1);
      expect(observedCompletionBroker).toEqual(invocation.completionBroker);

      const conflictingAttribution = await fetch(`${running.url}/sessions/1/invoked-completions`, {
        method: "POST",
        headers: { authorization: "Bearer control", "content-type": "application/json" },
        body: JSON.stringify({ ...invocation, traceContext: { productInteractionId: 30 } }),
      });
      expect(conflictingAttribution.status).toBe(500);
      await expect(conflictingAttribution.json()).resolves.toMatchObject({
        error: expect.stringContaining("different graph binding"),
      });
      expect(starts).toBe(1);

      const malformed = await fetch(`${running.url}/sessions/1/invoked-completions`, {
        method: "POST",
        headers: { authorization: "Bearer control", "content-type": "application/json" },
        body: JSON.stringify({ ...invocation, interactionId: 2 }),
      });
      expect(malformed.status).toBe(400);
      await expect(malformed.json()).resolves.toMatchObject({ error: "invalid_invoked_completion" });
      expect(starts).toBe(1);

      const cancelled = await fetch(`${running.url}/sessions/1/cancel?completionId=2`, {
        method: "POST",
        headers: { authorization: "Bearer control" },
      });
      expect(cancelled.status).toBe(200);
      await expect(cancelled.json()).resolves.toEqual({ cancelled: true });
      await expect(running.host.observeInvokedCompletion(1, 2)).rejects.toThrow("cancelled for thread 1");
      expect(running.host.cancel(1, 2)).toBe(false);
      const exported = join(directory, "exported-child-trace");
      const descriptor = await running.host.exportCandidateTrace(29, exported, {
        runId: "recursive-live-run",
        executionId: "child-2",
        interactionId: "29",
        harnessConfigurationName: "test-default",
      });
      expect(descriptor.status).toBe("partial");
      expect(descriptor.truncated).not.toBe(true);
      const manifest = JSON.parse(await readFile(join(exported, "manifest.json"), "utf8"));
      const events = await readFile(join(exported, "events.jsonl"), "utf8");
      expect(manifest).toMatchObject({ interactionNodeId: 2, productInteractionId: 29 });
      expect(events).toContain("attributed invoked completion");
      expect(events).toContain('\"type\":\"execution.scope\"');
      expect(events).toContain('\"completionBrokerAvailable\":true');
      expect(events).not.toContain("child-token");
      expect(events).not.toContain(invocation.completionBroker.token);
      expect(events).not.toContain(invocation.completionBroker.url);
    } finally {
      await running?.close();
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });


  it("leases provider access and binds family admissions across failure, timeout, and close", async () => {
    const secretAccessBroker = (release: () => void) => ({
      acquire: vi.fn(async (): Promise<HarnessExecutionAccessLease> => ({
        access: {
          kind: "secret",
          contract: "secret@1",
          providerId: "openai-work",
          adapterId: "openai-api",
          adapterImplementationVersion: "7",
          endpoint: "https://api.openai.test",
          fields: { "api-key": "never-persist-me" },
        },
        release,
      })),
    });

    const cases: Array<readonly [string, () => Promise<void>]> = [
      ["execution-scoped leases release once when the harness fails and secrets never persist", async () => {
        const directory = await tempDirectory("relayer-harness-access-broker-");
        const release = vi.fn();
        const acquire = vi.fn(async () => ({
          access: {
            kind: "secret" as const,
            contract: "secret@1" as const,
            providerId: "openai-work",
            adapterId: "openai-api",
            adapterImplementationVersion: "1",
            endpoint: "https://api.openai.test",
            fields: { "api-key": "never-persist-me" },
          },
          release,
        }));
        vi.stubGlobal("fetch", inspectionFetch());
        try {
          const host = new HarnessHost({
            stateFile: join(directory, "sessions.json"), controlToken: "control", accessBroker: { acquire },
            implementations: { test: () => ({ async complete(context) {
              expect(context.access?.kind, "secret access reaches the harness").toBe("secret");
              throw new Error("provider failed");
            }, state: emptyState }) },
          });
          await host.initialize();
          await host.createSession({
            threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
            configuration: {
              ...testConfiguration,
              // Migrated configurations can retain this projection for old readers;
              // adapter-aware modelRules are authoritative in the host.
              modelCompatibility: [{ providerId: "codex" }],
              modelRules: { allow: [{ adapterId: "openai-api", modelIdRegex: ".*" }], deny: [] },
              executionAccessContracts: ["secret@1"],
            },
          });
          await expect(host.complete(1, 1, graph(), { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" }),
            "harness failure propagates").rejects.toThrow("provider failed");
          expect(acquire, "lease acquisition carries contracts and signal").toHaveBeenCalledWith(
            { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" },
            ["secret@1"],
            expect.any(AbortSignal),
          );
          expect(release, "failure releases the lease exactly once").toHaveBeenCalledOnce();
          expect(await readFile(join(directory, "sessions.json"), "utf8"), "secrets never persist").not.toContain("never-persist-me");
        } finally {
          vi.unstubAllGlobals();
          await cleanup(directory);
        }
      }],
      ["trusted pre-admission survives attempt setup and is consumed exactly once", async () => {
        const directory = await tempDirectory("relayer-harness-pre-admission-");
        const release = vi.fn(() => undefined);
        const broker = secretAccessBroker(release);
        let accepted = false;
        vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
          ? (accepted ? jsonResponse(completion) : completionNotFound())
          : jsonResponse(interactiveNodeBody())));
        try {
          const host = new HarnessHost({
            stateFile: join(directory, "sessions.json"), controlToken: "control", accessBroker: broker,
            implementations: { test: () => ({ async complete(context) {
              expect(context.access?.adapterImplementationVersion, "effective adapter version reaches the harness").toBe("7");
              accepted = true;
            }, state: emptyState }) },
          });
          await host.initialize();
          await host.createSession({
            threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
            configuration: {
              ...testConfiguration,
              modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt-5.2" }], deny: [] },
              executionAccessContracts: ["secret@1"],
            },
          });
          const model = { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" };
          const admission = await host.admitProviderExecution(1, model, new AbortController().signal);
          expect(admission.adapterImplementationVersion, "admission reports the adapter version").toBe("7");
          expect(release, "admission holds the lease").not.toHaveBeenCalled();
          await expect(host.complete(1, 1, graph(), model, undefined, undefined, admission.executionLeaseId),
            "pre-admitted lease runs the attempt").resolves.toMatchObject({ output: completion });
          expect(broker.acquire, "access is acquired exactly once").toHaveBeenCalledOnce();
          expect(release, "successful execution keeps the lease claimed").not.toHaveBeenCalled();
          accepted = false;
          await expect(host.complete(1, 1, graph(), model, undefined, undefined, admission.executionLeaseId),
            "a consumed lease cannot run again").rejects.toThrow("invalid or expired");
          expect(await host.releaseProviderExecution(admission.executionLeaseId), "explicit release succeeds").toBe(true);
          expect(release, "release forwards to the broker").toHaveBeenCalledOnce();
          expect(await host.releaseProviderExecution(admission.executionLeaseId), "release is idempotent").toBe(false);

          accepted = false;
          const cancelled = await host.admitProviderExecution(1, model, new AbortController().signal);
          expect(await host.releaseProviderExecution(cancelled.executionLeaseId), "unused admissions release").toBe(true);
          expect(release, "every release reaches the broker").toHaveBeenCalledTimes(2);
          await expect(host.complete(1, 1, graph(), model, undefined, undefined, cancelled.executionLeaseId),
            "released leases cannot run").rejects.toThrow("invalid or expired");
        } finally {
          vi.unstubAllGlobals();
          await cleanup(directory);
        }
      }],
      ["claimed leases survive execution and terminal-ack timeouts", async () => {
        vi.useFakeTimers();
        const directory = await tempDirectory("relayer-harness-lease-timeouts-");
        const release = vi.fn();
        let finishHarness!: () => void;
        const harnessFinished = new Promise<void>((resolve) => { finishHarness = resolve; });
        let harnessStarted!: () => void;
        const started = new Promise<void>((resolve) => { harnessStarted = resolve; });
        let accepted = false;
        vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
          ? (accepted ? jsonResponse(completion) : completionNotFound())
          : jsonResponse(interactiveNodeBody())));
        try {
          const host = new HarnessHost({
            stateFile: join(directory, "sessions.json"), controlToken: "control",
            accessBroker: { async acquire() {
              return {
                access: {
                  kind: "secret", contract: "secret@1", providerId: "openai-work", adapterId: "openai-api",
                  adapterImplementationVersion: "7", endpoint: "https://api.openai.test", fields: { "api-key": "opaque" },
                },
                release,
              };
            } },
            implementations: { test: () => ({ async complete() {
              harnessStarted();
              await harnessFinished;
              accepted = true;
            }, state: emptyState }) },
          });
          await host.initialize();
          await host.createSession({
            threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
            configuration: {
              ...testConfiguration,
              modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt-5.2" }], deny: [] },
              executionAccessContracts: ["secret@1"],
            },
          });
          const model = { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" };
          const admission = await host.admitProviderExecution(1, model, new AbortController().signal);
          const running = host.complete(1, 1, graph(), model, undefined, undefined, admission.executionLeaseId);
          await started;
          await vi.advanceTimersByTimeAsync(60_000);
          expect(release, "execution timeout keeps the lease claimed").not.toHaveBeenCalled();

          finishHarness();
          await running;
          await vi.advanceTimersByTimeAsync(29_999);
          expect(release, "early ack window keeps the lease claimed").not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(60_001);
          expect(release, "terminal-ack timeout keeps the lease claimed").not.toHaveBeenCalled();
          expect(await host.releaseProviderExecution(admission.executionLeaseId), "explicit release still works").toBe(true);
          expect(release, "release reaches the broker once").toHaveBeenCalledOnce();
        } finally {
          vi.useRealTimers();
          vi.unstubAllGlobals();
          await cleanup(directory);
        }
      }],
      ["family admission dedupes by provider definition and aliases the orchestrator", async () => {
        const directory = await tempDirectory("relayer-harness-family-admission-");
        const releases: string[] = [];
        const acquired: string[] = [];
        let accepted = false;
        let observedContext: HarnessRunContext | undefined;
        const plan: HarnessModelPlan = {
          familyId: 17,
          familyRevision: 3,
          orchestrator: { providerId: "anthropic-work", adapterId: "anthropic-api", accessContract: "secret@1", modelId: "claude-opus" },
          roster: [
            { providerId: "openai-work", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt-large" },
            { providerId: "openai-work", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt-small" },
            { providerId: "anthropic-work", adapterId: "anthropic-api", accessContract: "secret@1", modelId: "claude-opus" },
          ],
        };
        const policy = {
          configurationRevision: 2,
          configurationDigest: `sha256:${"a".repeat(64)}`,
          executionAccessContracts: ["secret@1"],
          modelRules: { allow: [{ adapterId: "openai-api", modelIdRegex: ".*" }, { adapterId: "anthropic-api", modelIdRegex: ".*" }], deny: [] },
        };
        vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/output")
          ? (accepted ? jsonResponse(completion) : completionNotFound())
          : graphReadResponse(url)));
        try {
          const host = new HarnessHost({
            stateFile: join(directory, "sessions.json"), controlToken: "control",
            accessBroker: { async acquire(route) {
              acquired.push(route.providerId);
              const version = route.providerId === "openai-work" ? "openai-adapter@7" : "anthropic-adapter@4";
              return {
                access: {
                  kind: "secret", contract: "secret@1", providerId: route.providerId, adapterId: route.adapterId!,
                  adapterImplementationVersion: version, endpoint: `https://${route.providerId}.test`, fields: { "api-key": route.providerId },
                },
                release() { releases.push(route.providerId); },
              };
            } },
            implementations: { test: () => ({ async complete(context) {
              observedContext = context;
              expect(context.model, "orchestrator aliases the family model").toEqual(plan.orchestrator);
              expect(context.access?.providerId, "orchestrator access is primary").toBe("anthropic-work");
              expect(context.accessBundle?.byProviderId["openai-work"]?.providerId, "roster access bundled by provider").toBe("openai-work");
              expect(context.accessBundle?.byProviderId["anthropic-work"]?.providerId, "orchestrator provider bundled").toBe("anthropic-work");
              expect(Object.isFrozen(context.modelPlan), "model plan frozen").toBe(true);
              expect(Object.isFrozen(context.modelPlan?.roster), "roster frozen").toBe(true);
              expect(Object.isFrozen(context.accessBundle?.byProviderId), "access bundle frozen").toBe(true);
              accepted = true;
            }, state: emptyState }) },
          });
          await host.initialize();
          await host.createSession({
            threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
            configuration: {
              ...testConfiguration,
              revision: 1,
              modelRules: policy.modelRules,
              executionAccessContracts: ["secret@1"],
            },
          });

          const admission = await host.admitModelPlanExecution(
            1, 29, "attempt-family-29", plan, new AbortController().signal, policy,
          );
          expect(acquired, "one acquisition per provider definition").toEqual(["openai-work", "anthropic-work"]);
          expect(admission.admittedPlan.roster.map((route) => route.adapterImplementationVersion),
            "roster keeps order with deduped versions").toEqual([
            "openai-adapter@7", "openai-adapter@7", "anthropic-adapter@4",
          ]);
          expect(admission.admittedPlan.orchestrator.adapterImplementationVersion, "orchestrator version resolved").toBe("anthropic-adapter@4");
          expect(admission.admittedPlan.harnessPolicyDigest, "policy digest stable").toMatch(/^sha256:[0-9a-f]{64}$/u);
          expect(admission.admittedPlan.digest, "plan digest stable").toMatch(/^sha256:[0-9a-f]{64}$/u);
          expect(await readFile(join(directory, "sessions.json"), "utf8"), "access secrets never persist").not.toContain("api-key");
          expect(releases, "admission holds every lease").toEqual([]);

          await expect(host.complete(
            1, 29, graph(), plan.orchestrator, undefined, undefined,
            admission.executionLeaseId, policy, plan, "attempt-family-29",
          ), "admitted family runs").resolves.toMatchObject({ output: completion });
          expect(observedContext?.modelPlan, "harness sees the admitted plan").toEqual(admission.admittedPlan);
          expect(releases, "execution keeps leases claimed").toEqual([]);
          accepted = false;
          await expect(host.complete(
            1, 29, graph(), plan.orchestrator, undefined, undefined,
            admission.executionLeaseId, policy, plan, "attempt-family-29",
          ), "consumed family lease rejects").rejects.toThrow("invalid or expired");
          expect(await host.releaseProviderExecution(admission.executionLeaseId), "release succeeds").toBe(true);
          expect(releases, "release unwinds every provider in reverse").toEqual(["anthropic-work", "openai-work"]);
        } finally {
          vi.unstubAllGlobals();
          await cleanup(directory);
        }
      }],
      ["family acquisition rolls back already-acquired access on later failure", async () => {
        const directory = await tempDirectory("relayer-harness-family-rollback-");
        const release = vi.fn();
        const plan: HarnessModelPlan = {
          familyId: 1,
          familyRevision: 1,
          orchestrator: { providerId: "provider-a", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt" },
          roster: [
            { providerId: "provider-a", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt" },
            { providerId: "provider-b", adapterId: "anthropic-api", accessContract: "secret@1", modelId: "claude" },
          ],
        };
        const policy = {
          configurationRevision: 2,
          configurationDigest: `sha256:${"b".repeat(64)}`,
          executionAccessContracts: ["secret@1"],
          modelRules: { allow: [{ adapterId: "openai-api", modelIdRegex: ".*" }, { adapterId: "anthropic-api", modelIdRegex: ".*" }], deny: [] },
        };
        try {
          const host = new HarnessHost({
            stateFile: join(directory, "sessions.json"), controlToken: "control",
            accessBroker: { async acquire(route) {
              if (route.providerId === "provider-b") throw new Error("provider-b unavailable");
              return {
                access: {
                  kind: "secret", contract: "secret@1", providerId: route.providerId, adapterId: route.adapterId!,
                  adapterImplementationVersion: "1", endpoint: "https://provider-a.test", fields: { "api-key": "secret" },
                },
                release,
              };
            } },
            implementations: { test: () => ({ async complete() {}, state: emptyState }) },
          });
          await host.initialize();
          await host.createSession({
            threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
            configuration: { ...testConfiguration, revision: 1, modelRules: policy.modelRules, executionAccessContracts: ["secret@1"] },
          });
          await expect(host.admitModelPlanExecution(
            1, 1, "attempt-rollback", plan, new AbortController().signal, policy,
          ), "later provider failure rejects the family").rejects.toThrow("provider-b unavailable");
          expect(release, "already-acquired access rolls back").toHaveBeenCalledOnce();
          await host.close();
        } finally {
          await cleanup(directory);
        }
      }],
      ["family admission binds to interaction, attempt, plan, and harness policy", async () => {
        const directory = await tempDirectory("relayer-harness-family-binding-");
        const release = vi.fn();
        const plan: HarnessModelPlan = {
          familyId: 1,
          familyRevision: 1,
          orchestrator: { providerId: "provider-a", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt" },
          roster: [{ providerId: "provider-a", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt" }],
        };
        const policy = {
          configurationRevision: 2,
          configurationDigest: `sha256:${"c".repeat(64)}`,
          executionAccessContracts: ["secret@1"],
          modelRules: { allow: [{ adapterId: "openai-api", modelIdRegex: ".*" }], deny: [] },
        };
        vi.stubGlobal("fetch", inspectionFetch());
        try {
          const host = new HarnessHost({
            stateFile: join(directory, "sessions.json"), controlToken: "control",
            accessBroker: { async acquire(route) {
              return {
                access: {
                  kind: "secret", contract: "secret@1", providerId: route.providerId, adapterId: route.adapterId!,
                  adapterImplementationVersion: "1", endpoint: "https://provider-a.test", fields: { "api-key": "secret" },
                },
                release,
              };
            } },
            implementations: { test: () => ({ async complete() {}, state: emptyState }) },
          });
          await host.initialize();
          await host.createSession({
            threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
            configuration: { ...testConfiguration, revision: 1, modelRules: policy.modelRules, executionAccessContracts: ["secret@1"] },
          });
          await expect(host.admitModelPlanExecution(
            1, 44, "attempt-missing-contracts", plan, new AbortController().signal,
            { configurationRevision: 2, configurationDigest: policy.configurationDigest, modelRules: policy.modelRules },
          ), "policy without contracts rejects").rejects.toThrow("requires executionAccessContracts");
          await expect(host.admitModelPlanExecution(
            1, 44, "attempt-mismatched-contracts", plan, new AbortController().signal,
            { ...policy, executionAccessContracts: ["managed-runtime@1"] },
          ), "mismatched contracts reject").rejects.toThrow("do not match the pinned harness configuration");
          const admission = await host.admitModelPlanExecution(
            1, 44, "attempt-bound", plan, new AbortController().signal, policy,
          );
          await host.createSession({
            threadId: 2, permissionProfileId: "auto", workingDirectory: directory,
            configuration: {
              ...testConfiguration,
              revision: 1,
              modelRules: policy.modelRules,
              executionAccessContracts: ["secret@1", "managed-runtime@1"],
            },
          });
          const expandedPolicyAdmission = await host.admitModelPlanExecution(
            2, 44, "attempt-expanded-contracts", plan, new AbortController().signal,
            { ...policy, executionAccessContracts: ["secret@1", "managed-runtime@1"] },
          );
          expect(expandedPolicyAdmission.admittedPlan.harnessPolicyDigest,
            "policy digests track the pinned contracts").not.toBe(admission.admittedPlan.harnessPolicyDigest);
          expect(await host.releaseProviderExecution(expandedPolicyAdmission.executionLeaseId), "expanded lease releases").toBe(true);
          await expect(host.complete(
            1, 44, graph(), plan.orchestrator, undefined, undefined,
            admission.executionLeaseId, policy, plan, "attempt-other",
          ), "attempt identity is bound").rejects.toThrow("invalid or expired");
          await expect(host.complete(
            1, 45, graph(), plan.orchestrator, undefined, undefined,
            admission.executionLeaseId, policy, plan, "attempt-bound",
          ), "interaction identity is bound").rejects.toThrow("invalid or expired");
          await expect(host.complete(
            1, 44, graph(), plan.orchestrator, undefined, undefined,
            admission.executionLeaseId, policy, { ...plan, familyRevision: 2 }, "attempt-bound",
          ), "plan identity is bound").rejects.toThrow("invalid or expired");
          await expect(host.complete(
            1, 44, graph(), plan.orchestrator, undefined, undefined,
            admission.executionLeaseId, { ...policy, configurationDigest: `sha256:${"d".repeat(64)}` }, plan, "attempt-bound",
          ), "policy identity is bound").rejects.toThrow(/stale or conflicts|invalid or expired/u);
          expect(release, "rejected bindings never consume leases").toHaveBeenCalledOnce();
          expect(await host.releaseProviderExecution(admission.executionLeaseId), "bound lease releases").toBe(true);
          expect(release, "release reaches both providers").toHaveBeenCalledTimes(2);
        } finally {
          vi.unstubAllGlobals();
          await cleanup(directory);
        }
      }],
      ["close aborts an active family completion without releasing before acknowledgement", async () => {
        const directory = await tempDirectory("relayer-harness-family-close-");
        const release = vi.fn();
        let harnessStarted!: () => void;
        const started = new Promise<void>((resolve) => { harnessStarted = resolve; });
        const plan = {
          familyId: 1,
          familyRevision: 1,
          orchestrator: { providerId: "provider-a", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt" },
          roster: [{ providerId: "provider-a", adapterId: "openai-api", accessContract: "secret@1", modelId: "gpt" }],
        };
        const policy = {
          configurationRevision: 2,
          configurationDigest: `sha256:${"e".repeat(64)}`,
          executionAccessContracts: ["secret@1"],
          modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt" }], deny: [] },
        };
        vi.stubGlobal("fetch", inspectionFetch());
        try {
          const host = new HarnessHost({
            stateFile: join(directory, "sessions.json"), controlToken: "control",
            accessBroker: { async acquire() {
              return {
                access: {
                  kind: "secret", contract: "secret@1", providerId: "provider-a", adapterId: "openai-api",
                  adapterImplementationVersion: "1", endpoint: "https://provider-a.test", fields: { "api-key": "opaque" },
                },
                release,
              };
            } },
            implementations: { test: () => ({ async complete(_context, signal) {
              harnessStarted();
              await new Promise<never>((_resolve, reject) => {
                const abort = () => reject(signal?.reason ?? new Error("aborted"));
                signal?.addEventListener("abort", abort, { once: true });
                if (signal?.aborted) abort();
              });
            }, state: emptyState }) },
          });
          await host.initialize();
          await host.createSession({
            threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
            configuration: { ...testConfiguration, revision: 1, modelRules: policy.modelRules, executionAccessContracts: ["secret@1"] },
          });
          const admission = await host.admitModelPlanExecution(
            1, 9, "attempt-close", plan, new AbortController().signal, policy,
          );
          const completionRun = host.complete(
            1, 9, graph(), plan.orchestrator, undefined, undefined,
            admission.executionLeaseId, policy, plan, "attempt-close",
          ).then(() => undefined, (error: unknown) => error);
          await started;
          await host.close();
          expect(await completionRun, "close aborts the active family completion").toBeInstanceOf(Error);
          expect(release, "leases stay claimed until durable acknowledgement").not.toHaveBeenCalled();
          expect(await host.releaseProviderExecution(admission.executionLeaseId), "explicit acknowledgement releases").toBe(true);
          expect(release, "release reaches the broker once").toHaveBeenCalledOnce();
        } finally {
          vi.unstubAllGlobals();
          await cleanup(directory);
        }
      }],
    ];
    expect(cases, "provider access inventory").toHaveLength(7);
    await runLabeledCases(cases);
  }, 60_000);

  it("enforces model selection and execution policy before graph access", async () => {
    const cases: Array<readonly [string, () => Promise<void>]> = [
      ["pinned compatibility rejects incompatible models before graph access", async () => {
        const directory = await tempDirectory("relayer-harness-model-compatibility-");
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        try {
          const host = new HarnessHost({
            stateFile: join(directory, "sessions.json"),
            controlToken: "control",
            implementations: { test: () => ({ async complete() {}, state: emptyState }) },
          });
          await host.initialize();
          await host.createSession({
            threadId: 1,
            permissionProfileId: "auto",
            configuration: {
              ...testConfiguration,
              modelCompatibility: [{ providerId: "codex", modelIds: ["allowed"] }],
              executionAccessContracts: ["managed-runtime@1"],
            },
            workingDirectory: directory,
          });

          await expect(host.complete(1, 1, graph(), { providerId: "codex", modelId: "blocked" }),
            "incompatible model rejects").rejects.toThrow("not compatible with this configuration");
          expect(fetchMock, "rejection happens before any graph access").not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
          await cleanup(directory);
        }
      }],
      ["adapter rules deny wins and adapter-less selections reject before graph access", async () => {
        const directory = await tempDirectory("relayer-harness-model-rules-");
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        try {
          const host = new HarnessHost({
            stateFile: join(directory, "sessions.json"),
            controlToken: "control",
            implementations: { test: () => ({ async complete() {}, state: emptyState }) },
          });
          await host.initialize();
          await host.createSession({
            threadId: 1,
            permissionProfileId: "auto",
            configuration: {
              ...testConfiguration,
              modelRules: {
                allow: [{ adapterId: "openai-api", modelIdRegex: "^gpt-" }],
                deny: [{ adapterId: "openai-api", modelIdExact: "gpt-preview" }],
              },
              executionAccessContracts: ["secret@1"],
            },
            workingDirectory: directory,
          });

          await expect(host.complete(1, 1, graph(), {
            providerId: "openai-work",
            adapterId: "openai-api",
            modelId: "gpt-preview",
          }), "deny rule wins").rejects.toThrow("not compatible with this configuration");
          await expect(host.complete(1, 1, graph(), {
            providerId: "openai-work",
            modelId: "gpt-5.2",
          }), "adapter-less selection rejects").rejects.toThrow("not compatible with this configuration");
          expect(fetchMock, "rejection happens before any graph access").not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
          await cleanup(directory);
        }
      }],
      ["the saved dynamic policy is enforced on the very next send", async () => {
        const directory = await tempDirectory("relayer-harness-current-policy-");
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        try {
          const host = new HarnessHost({
            stateFile: join(directory, "sessions.json"), controlToken: "control",
            implementations: { test: () => ({ async complete() {}, state: emptyState }) },
          });
          await host.initialize();
          await host.createSession({
            threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
            configuration: {
              ...testConfiguration,
              revision: 1,
              executionAccessContracts: ["secret@1"],
              modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt-5.2" }], deny: [] },
            },
          });
          await expect(host.complete(
            1,
            1,
            graph(),
            { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" },
            undefined,
            undefined,
            undefined,
            {
              configurationRevision: 2,
              configurationDigest: `sha256:${"a".repeat(64)}`,
              modelRules: {
                allow: [{ adapterId: "openai-api", modelIdExact: "gpt-5.2" }],
                deny: [{ adapterId: "openai-api", modelIdExact: "gpt-5.2" }],
              },
            },
          ), "dynamic deny policy applies immediately").rejects.toThrow("not compatible with this configuration");
          await expect(host.complete(
            1,
            1,
            graph(),
            { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" },
          ), "policy omission rejects once a dynamic policy is saved").rejects.toThrow("Current harness execution policy is required");
          expect(fetchMock, "policy enforcement precedes graph access").not.toHaveBeenCalled();
          await host.close();
        } finally {
          vi.unstubAllGlobals();
          await cleanup(directory);
        }
      }],
      ["admission rejects policy omission after observing a dynamic policy", async () => {
        const directory = await tempDirectory("relayer-harness-current-admission-policy-");
        const release = vi.fn();
        const acquire = vi.fn(async () => ({
          access: {
            kind: "secret" as const,
            contract: "secret@1" as const,
            providerId: "openai-work",
            adapterId: "openai-api",
            adapterImplementationVersion: "1",
            endpoint: "https://api.openai.test",
            fields: { "api-key": "secret" },
          },
          release,
        }));
        try {
          const host = new HarnessHost({
            stateFile: join(directory, "sessions.json"), controlToken: "control", accessBroker: { acquire },
            implementations: { test: () => ({ async complete() {}, state: emptyState }) },
          });
          await host.initialize();
          await host.createSession({
            threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
            configuration: {
              ...testConfiguration,
              revision: 1,
              executionAccessContracts: ["secret@1"],
              modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt-5.2" }], deny: [] },
            },
          });
          const model = { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" };
          const policy = {
            configurationRevision: 2,
            configurationDigest: `sha256:${"a".repeat(64)}`,
            modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt-5.2" }], deny: [] },
          };
          const admission = await host.admitProviderExecution(1, model, new AbortController().signal, policy);
          await host.releaseProviderExecution(admission.executionLeaseId);

          await expect(host.admitProviderExecution(1, model, new AbortController().signal),
            "policy omission rejects after a dynamic policy").rejects.toThrow("Current harness execution policy is required");
          expect(acquire, "first admission acquires once").toHaveBeenCalledOnce();
          expect(release, "release matches the single acquisition").toHaveBeenCalledOnce();
          await host.close();
        } finally {
          await cleanup(directory);
        }
      }],
      ["HTTP harness policy may omit the optional modelRules field", async () => {
        const directory = await tempDirectory("relayer-harness-policy-without-rules-");
        const release = vi.fn();
        let running: Awaited<ReturnType<typeof startHarnessHost>> | undefined;
        try {
          running = await startHarnessHost({
            stateFile: join(directory, "sessions.json"),
            controlToken: "control",
            accessBroker: { async acquire(model) {
              return {
                access: {
                  kind: "secret", contract: "secret@1", providerId: model.providerId, adapterId: model.adapterId!,
                  adapterImplementationVersion: "1", endpoint: "https://api.openai.test", fields: { "api-key": "opaque" },
                },
                release,
              };
            } },
            implementations: { test: () => ({ async complete() {}, state: emptyState }) },
          });
          await running.host.createSession({
            threadId: 1, permissionProfileId: "auto", workingDirectory: directory,
            configuration: {
              ...testConfiguration,
              revision: 1,
              modelCompatibility: [{ providerId: "openai-work" }],
              executionAccessContracts: ["secret@1"],
            },
          });

          const admission = await fetch(`${running.url}/sessions/1/execution-leases`, {
            method: "POST",
            headers: { authorization: "Bearer control", "content-type": "application/json" },
            body: JSON.stringify({
              model: { providerId: "openai-work", adapterId: "openai-api", modelId: "gpt-5.2" },
              harnessPolicy: {
                configurationRevision: 2,
                configurationDigest: `sha256:${"a".repeat(64)}`,
              },
            }),
          });
          expect(admission.status, "omitted modelRules admits").toBe(201);
          const admitted = await admission.json() as { executionLeaseId: string; adapterImplementationVersion: string };
          expect(admitted.adapterImplementationVersion, "adapter version resolves").toBe("1");
          const released = await fetch(`${running.url}/sessions/1/execution-leases/${admitted.executionLeaseId}`, {
            method: "DELETE",
            headers: { authorization: "Bearer control" },
          });
          expect(released.status, "lease releases over HTTP").toBe(200);
          expect(release, "release reaches the broker").toHaveBeenCalledOnce();
        } finally {
          await running?.close();
          await cleanup(directory);
        }
      }],
      ["graph capabilities must target the authenticated loopback server", async () => {
        const host = new HarnessHost({ stateFile: "/tmp/unused-harness-state.json", controlToken: "control", implementations: {} });
        await expect(host.complete(1, 1, { url: "https://example.com", token: "secret", nodeId: 1 }),
          "remote capabilities reject").rejects.toThrow("127.0.0.1 HTTP");
      }],
      ["product stable-ID rules govern interaction model identities", async () => {
        const host = new HarnessHost({ stateFile: "/tmp/unused-harness-state.json", controlToken: "control", implementations: {} });
        const capability = graph();
        const identityCases: ReadonlyArray<readonly [string, InteractionModelSelection, string]> = [
          ["unicode-length ids pass identity before thread lookup", { providerId: "codex", modelId: "🧠".repeat(200) }, "Unknown harness thread"],
          ["byte-order-mark ids pass identity before thread lookup", { providerId: "codex", modelId: "\uFEFFmodel\uFEFF" }, "Unknown harness thread"],
          ["provider ids with leading whitespace reject", { providerId: " codex", modelId: "model" }, "invalid model selection"],
          ["model ids with trailing newline reject", { providerId: "codex", modelId: "model\n" }, "invalid model selection"],
          ["model ids with lone surrogates reject", { providerId: "codex", modelId: "model\uD800" }, "invalid model selection"],
          ["ascii model ids over 200 characters reject", { providerId: "codex", modelId: "m".repeat(201) }, "invalid model selection"],
          ["unicode model ids over 200 characters reject", { providerId: "codex", modelId: "🧠".repeat(201) }, "invalid model selection"],
        ];
        expect(identityCases, "stable-ID rule inventory").toHaveLength(7);
        for (const [label, model, message] of identityCases) {
          await expect(host.complete(1, 1, capability, model), label).rejects.toThrow(message);
        }
      }],
    ];
    expect(cases, "model policy inventory").toHaveLength(7);
    await runLabeledCases(cases);
  }, 60_000);

  it("exposes cancellation, approvals, and readiness through the control plane", async () => {
    // Cancellation drives the active completion through its abort signal.
    {
      const directory = await tempDirectory("relayer-harness-cancel-");
      let completionStarted!: () => void;
      const started = new Promise<void>((resolveStarted) => { completionStarted = resolveStarted; });
      vi.stubGlobal("fetch", inspectionFetch());
      try {
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          trace: { directory: join(directory, "cancel-traces"), policy: requiredTracePolicy },
          implementations: { test: () => ({
            complete(_interaction, signal) {
              completionStarted();
              return new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
            },
            state: emptyState,
          }) },
        });
        await host.initialize();
        await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });

        const completing = host.complete(1, 1, graph(), undefined, undefined, { productInteractionId: 8 });
        await started;
        expect(host.cancel(1, 2), "unknown completions cannot be cancelled").toBe(false);
        expect(host.cancel(1, 1), "the active completion cancels").toBe(true);
        await expect(completing, "cancellation rejects the completion").rejects.toThrow("cancelled for thread 1");
        expect(host.cancel(1), "no completion stays cancelled").toBe(false);
        await host.exportCandidateTrace(8, join(directory, "cancelled-export"), {
          runId: "run", executionId: "execution", interactionId: "8", harnessConfigurationName: "test-default",
        });
        const cancelledManifest = JSON.parse(await readFile(join(directory, "cancelled-export", "manifest.json"), "utf8"));
        const cancelledEvents = await readFile(join(directory, "cancelled-export", "events.jsonl"), "utf8");
        expect(cancelledManifest, "cancelled export stays partial").toMatchObject({ status: "partial" });
        expect(cancelledEvents, "cancelled export records the event").toContain('"type":"cancelled"');
      } finally {
        vi.unstubAllGlobals();
        await cleanup(directory);
      }
    }

    // Pre-aborted caller signals reject after the required interaction identity.
    {
      const directory = await tempDirectory("relayer-harness-signal-");
      const host = new HarnessHost({
        stateFile: join(directory, "sessions.json"),
        controlToken: "control",
        implementations: { test: () => ({ async complete() {}, state: emptyState }) },
      });
      try {
        await host.initialize();
        await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: testConfiguration, workingDirectory: directory });
        const controller = new AbortController();
        controller.abort(new Error("legacy caller cancelled"));

        await expect(host.complete(1, 1, graph(), controller.signal),
          "pre-aborted signals propagate their reason").rejects.toThrow("legacy caller cancelled");
      } finally {
        await host.close();
        await cleanup(directory);
      }
    }

    // Cancelling a waiting approval closes it and returns the terminal outcome to the harness.
    {
      const directory = await tempDirectory("relayer-harness-approval-cancel-");
      let approvalStarted!: () => void;
      const started = new Promise<void>((resolve) => { approvalStarted = resolve; });
      vi.stubGlobal("fetch", inspectionFetch());
      try {
        const host = new HarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => ({
            async complete(context) {
              const waiting = context.approvals.request({
                providerItemId: "provider-1",
                title: "Run tests",
                reason: "Verify the requested change.",
                action: { kind: "command", command: "npm test", workingDirectory: directory },
                scopeKeys: ["command:npm test"],
                scopeDescription: "Run npm test for this session.",
              });
              approvalStarted();
              await waiting;
            },
            state: emptyState,
          }) },
        });
        await host.initialize();
        await host.createSession({ threadId: 1, permissionProfileId: "ask", configuration: testConfiguration, workingDirectory: directory });
        const completing = host.complete(1, 44, graph());
        await started;

        expect(host.cancel(1), "thread cancellation reaches the waiting approval").toBe(true);

        await expect(completing, "approval cancellation rejects the completion").rejects.toThrow("cancelled");
        expect(host.approvalEvents(1), "approval history records the terminal outcome").toMatchObject({
          pendingRequests: [],
          events: [
            { sequence: 1, type: "requested" },
            { sequence: 2, type: "resolved", resolution: { outcome: "cancelled", actor: "host" } },
          ],
        });
      } finally {
        vi.unstubAllGlobals();
        await cleanup(directory);
      }
    }

    // Host readiness requires successful trace spool startup cleanup.
    {
      const directory = await tempDirectory("relayer-harness-trace-readiness-");
      const spool = join(directory, "spool");
      try {
        await writeFile(spool, "not a directory\n");
        await expect(startHarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: {},
          trace: {
            directory: spool,
            policy: {
              mode: "required",
              requiredFeatures: {},
              includeNativeArtifacts: false,
              maxBytesPerTurn: 1_000,
              maxEventsPerTurn: 10,
            },
          },
        }), "readiness fails closed on a broken spool").rejects.toThrow("spool must be a real directory");
        await expect(readFile(spool, "utf8"), "failed startup never mutates the spool").resolves.toBe("not a directory\n");
      } finally {
        await cleanup(directory);
      }
    }

    // IPv6 bindings report bracketed URLs.
    {
      const directory = await tempDirectory("relayer-harness-ipv6-");
      let running: Awaited<ReturnType<typeof startHarnessHost>> | undefined;
      try {
        running = await startHarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          host: "::1",
          implementations: {},
        });
        expect(running.url, "IPv6 URLs stay parseable").toMatch(/^http:\/\/\[::1\]:\d+$/);
      } finally {
        await running?.close();
        await cleanup(directory);
      }
    }

    // Authenticated cancellation is exposed through the host API.
    {
      const directory = await tempDirectory("relayer-harness-cancel-route-");
      let running: Awaited<ReturnType<typeof startHarnessHost>> | undefined;
      try {
        running = await startHarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: {},
        });
        const response = await fetch(`${running.url}/sessions/1/cancel`, {
          method: "POST",
          headers: { authorization: "Bearer control" },
        });

        expect(response.status, "cancel route answers").toBe(200);
        expect(await response.json(), "idle threads report no cancellation").toEqual({ cancelled: false });
        const invalid = await fetch(`${running.url}/sessions/1/cancel?completionId=not-a-number`, {
          method: "POST",
          headers: { authorization: "Bearer control" },
        });
        expect(invalid.status, "invalid completion ids reject").toBe(400);
        expect(await invalid.json(), "invalid ids name their error").toEqual({ error: "invalid_completion_id" });
      } finally {
        await running?.close();
        await cleanup(directory);
      }
    }

    // HTTP approval decisions bypass the session lock while one completion waits.
    {
      const directory = await tempDirectory("relayer-harness-approval-route-");
      const nativeFetch = globalThis.fetch;
      let running: Awaited<ReturnType<typeof startHarnessHost>> | undefined;
      let accepted = false;
      let approvalStarted!: () => void;
      const started = new Promise<void>((resolve) => { approvalStarted = resolve; });
      const observedDecisions: unknown[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (!url.startsWith("http://127.0.0.1:43123")) return nativeFetch(input, init);
        if (url.endsWith("/output")) {
          return accepted ? jsonResponse(completion) : completionNotFound();
        }
        return jsonResponse(interactiveNodeBody());
      }));
      try {
        running = await startHarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => ({
            async complete(context) {
              const waiting = context.approvals.request({
                providerItemId: "private-provider-item",
                title: "Run tests",
                reason: "Verify the requested change.",
                action: { kind: "command", command: "npm test", workingDirectory: directory },
                scopeKeys: ["command:npm test", `cwd:${directory}`],
                scopeDescription: `Run npm test in ${directory} for this session.`,
              });
              approvalStarted();
              observedDecisions.push(await waiting);
              accepted = true;
            },
            state: emptyState,
          }) },
        });
        await running.host.createSession({
          threadId: 1,
          permissionProfileId: "ask",
          configuration: testConfiguration,
          workingDirectory: directory,
        });

        const completing = fetch(`${running.url}/sessions/1/complete`, {
          method: "POST",
          headers: { authorization: "Bearer control", "content-type": "application/json" },
          body: JSON.stringify({ interactionId: 91, graph: graph() }),
        });
        await started;
        const snapshotResponse = await fetch(`${running.url}/sessions/1/approval-events?after=0`, {
          headers: { authorization: "Bearer control" },
        });
        const snapshot = await snapshotResponse.json() as {
          harnessSessionId: string;
          latestSequence: number;
          pendingRequests: { requestId: string; correlation: { interactionId: number } }[];
        };
        expect(snapshotResponse.status, "approval snapshot answers").toBe(200);
        expect(snapshot, "pending approval is visible").toMatchObject({
          latestSequence: 1,
          pendingRequests: [{ correlation: { interactionId: 91 } }],
        });
        expect(JSON.stringify(snapshot), "provider item identity stays private").not.toContain("private-provider-item");

        const requestId = snapshot.pendingRequests[0]!.requestId;
        const decisionResponse = await fetch(`${running.url}/sessions/1/approvals/${requestId}/decision`, {
          method: "POST",
          headers: { authorization: "Bearer control", "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve_once", rationale: "Reviewed in Relayer." }),
        });
        expect(decisionResponse.status, "decisions bypass the session lock").toBe(200);
        expect(await decisionResponse.json(), "decision echoes the outcome").toMatchObject({
          requestId,
          correlation: { threadId: 1, interactionId: 91, harnessSessionId: snapshot.harnessSessionId },
          outcome: "approved",
          actor: "user",
          decision: "approve_once",
        });

        const completionResponse = await completing;
        expect(completionResponse.status, "waiting completion resumes after approval").toBe(200);
        expect(await completionResponse.json(), "completion carries the accepted output").toMatchObject({ output: completion });
        expect(observedDecisions, "harness observes the decision").toEqual([expect.objectContaining({ requestId, decision: "approve_once", actor: "user" })]);

        const terminalSnapshot = await fetch(`${running.url}/sessions/1/approval-events?after=1`, {
          headers: { authorization: "Bearer control" },
        });
        expect(await terminalSnapshot.json(), "terminal snapshot closes the request").toMatchObject({
          latestSequence: 2,
          pendingRequests: [],
          events: [{ sequence: 2, type: "resolved", resolution: { requestId, outcome: "approved" } }],
        });
        const duplicate = await fetch(`${running.url}/sessions/1/approvals/${requestId}/decision`, {
          method: "POST",
          headers: { authorization: "Bearer control", "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve_once" }),
        });
        expect(duplicate.status, "duplicate decisions conflict").toBe(409);

        const persisted = await readFile(join(directory, "sessions.json"), "utf8");
        expect(persisted, "approval session identity never persists").not.toContain(snapshot.harnessSessionId);
        expect(persisted, "approval request identity never persists").not.toContain(requestId);
      } finally {
        await running?.close();
        vi.unstubAllGlobals();
        await cleanup(directory);
      }
    }

    // A disconnected HTTP completion aborts its waiting approval and releases the session lock.
    {
      const directory = await tempDirectory("relayer-harness-approval-disconnect-");
      const nativeFetch = globalThis.fetch;
      let running: Awaited<ReturnType<typeof startHarnessHost>> | undefined;
      let accepted = false;
      let approvalStarted!: () => void;
      const started = new Promise<void>((resolve) => { approvalStarted = resolve; });
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (!url.startsWith("http://127.0.0.1:43123")) return nativeFetch(input, init);
        if (url.endsWith("/output")) {
          return accepted ? jsonResponse(completion) : completionNotFound();
        }
        return jsonResponse(interactiveNodeBody());
      }));
      try {
        running = await startHarnessHost({
          stateFile: join(directory, "sessions.json"),
          controlToken: "control",
          implementations: { test: () => ({
            async complete(context) {
              const waiting = context.approvals.request({
                providerItemId: "provider-disconnect",
                title: "Run tests",
                reason: "Verify the requested change.",
                action: { kind: "command", command: "npm test", workingDirectory: directory },
                scopeKeys: ["command:npm test", `cwd:${directory}`],
                scopeDescription: `Run npm test in ${directory} for this session.`,
              });
              approvalStarted();
              await waiting;
            },
            state: emptyState,
          }) },
        });
        await running.host.createSession({
          threadId: 1,
          permissionProfileId: "ask",
          configuration: testConfiguration,
          workingDirectory: directory,
        });
        const controller = new AbortController();
        const completing = fetch(`${running.url}/sessions/1/complete`, {
          method: "POST",
          headers: { authorization: "Bearer control", "content-type": "application/json" },
          body: JSON.stringify({ interactionId: 91, graph: graph() }),
          signal: controller.signal,
        });
        await started;
        expect(running.host.approvalEvents(1).pendingRequests, "approval waits while the client holds").toHaveLength(1);

        controller.abort();
        await expect(completing, "client disconnect rejects the request").rejects.toThrow();
        await vi.waitFor(() => expect(running!.host.approvalEvents(1)).toMatchObject({
          pendingRequests: [],
          events: [
            { type: "requested" },
            { type: "resolved", resolution: { outcome: "aborted", actor: "host" } },
          ],
        }));

        accepted = true;
        await expect(running.host.complete(1, 92, graph()),
          "session lock releases after disconnect").resolves.toMatchObject({ output: completion });
      } finally {
        await running?.close();
        vi.unstubAllGlobals();
        await cleanup(directory);
      }
    }
  }, 60_000);
});
