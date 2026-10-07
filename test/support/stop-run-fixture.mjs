import { createServer, request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RelayerGraphClient, NodeObject, LayerObject, LayerLayoutObject, NodePlacementObject } from "@relayer/graph-client";
import { CodexBasicHarness } from "../../packages/harness-host/dist/implementations/codex-basic.js";
import { PrimeAgentHarness } from "../../packages/harness-host/dist/implementations/prime-agent.js";
import { GraphCompleteRuntimeService, RECURSIVE_TEMPORAL_FEATURES } from "../../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../../desktop/main/services/relayer-app-server.mjs";

const repository = resolve(import.meta.dirname, "../..");
export async function waitFor(label, read, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`Timed out: ${label}`);
}
export async function stopRunFixture() {
  const directory = await mkdtemp(join(tmpdir(), "relayer-stop-"));
  const controls = new Map();
  let admissionGate;
  let releases = 0;
  let graphFault;
  const services = [];
  try {
  const factories = {};
  const configurationPaths = [];
  for (const provider of ["codex", "prime"]) {
    const path = join(directory, `${provider}.yaml`);
    const configuration = provider === "codex"
      ? await readFile(join(repository, "harnesses/codex-basic.yaml"), "utf8")
      : await readFile(join(repository, "harnesses/prime-agent-basic.yaml"), "utf8");
    // Keep the native adapter configuration, but give each injected provider a
    // distinct fixture implementation and an explicit deterministic model rule.
    const { parse, stringify } = await import("yaml");
    const config = parse(configuration);
    config.name = `fixture-stop-${provider}`;
    config.implementation = `fixture.stop-${provider}`;
    config.complete = { agentAuthored: false };
    config.modelCompatibility = [{ providerId: "fixture-openai" }];
    config.modelRules = { allow: [{ adapterId: "openai-api", modelIdRegex: ".*" }], deny: [] };
    delete config.modelDefaults;
    config.executionAccessContracts = ["secret@1"];
    await writeFile(path, stringify(config));
    configurationPaths.push(path);
    factories[config.implementation] = async (factoryContext) => {
      let context;
      let control;
      const begin = async () => {
        const graph = new RelayerGraphClient(context.graph.acquireCapability());
        const text = context.interactionInput.interaction.detail;
        control = { context, submitLate: () => graph.submit(context.inputGraph.id), readCurrent: () => graph.getCurrent(), text, aborts: 0, started: Promise.withResolvers(), prompt: Promise.withResolvers(), settled: Promise.withResolvers(), aborted: Promise.withResolvers() };
        controls.set(context.inputGraph.id, control);
        const node = new NodeObject("file", "Inspectable work", "Partial work is retained when this run is stopped.", "concept", "work");
        await graph.submitNode(node);
        control.partialNodeId = node.ref.id;
        if (String(text).includes("accept")) {
          const layer = new LayerObject([node], [], new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)], "default"), "result");
          await graph.submitLayer(layer);
          await graph.addAction(context.inputGraph.id, { kind: "navigate", relation: "expand", label: "Response", target: layer, clientKey: "response" });
          await graph.submit(context.inputGraph.id);
          control.started.resolve();
          if (!String(text).includes("race")) return;
        }
        if (!String(text).includes("accept")) {
          const layer = new LayerObject([node], [], new LayerLayoutObject([new NodePlacementObject(node, 0.5, 0.5)], "default"), "working");
          const savedLayer = await graph.submitLayer(layer);
          await graph.advanceCurrent(layer, 0, "working-current");
          control.partialLayerId = savedLayer.id;
          await graph.submitNode(new NodeObject("file", "Unaccepted draft", "Must not become a final response", "concept", "draft"));
        }
        context.trace.emit({ type: "tool.call.started", data: { tool: String(text).includes("tool") ? "fixture.long-tool" : "fixture.model-work" } });
        control.started.resolve();
        await control.prompt.promise;
      };
      const abort = async () => {
        control.aborts += 1;
        control.aborted.resolve();
        control.prompt.resolve();
        if (String(control.text).includes("abort failure")) throw new Error("Fixture native cancellation failed");
      };
      let native;
      if (provider === "codex") {
        native = new CodexBasicHarness({ ...factoryContext, configuration: { ...factoryContext.configuration, implementation: "codex.basic" } }, {
          codexPathOverride: "/fixture/no-inference",
          runAppServerTurn: async ({ signal, onThreadId, onTurnId }) => {
            onThreadId?.(`fixture-${factoryContext.threadId}`);
            onTurnId?.(`fixture-${factoryContext.threadId}`, "turn-1");
            let abortFailure;
            const onAbort = () => { void abort().catch((error) => { abortFailure = error; }); };
            signal.addEventListener("abort", onAbort, { once: true });
            try {
              await begin();
              if (!String(control.text).includes("accept") || String(control.text).includes("race")) await control.settled.promise;
              if (abortFailure) throw abortFailure;
            } finally { signal.removeEventListener("abort", onAbort); }
          },
        });
      } else {
        native = await PrimeAgentHarness.create({ ...factoryContext, configuration: { ...factoryContext.configuration, implementation: "prime.agent" } }, {
          loadModule: async () => ({
            AGENT_RUN_MODEL_SCOPE_VERSION: 1,
            createAgentRunModelScope: (value) => value,
            SessionManager: { create: () => "fixture-session", open: () => "fixture-session" },
            createHostRequestHandler: (handler) => handler,
            createAgentSessionServices: async () => ({ resourceLoader: { getAppendSystemPrompt: () => [] } }),
            createAgentSessionFromServices: async () => ({ session: {
              agent: { state: { thinkingLevel: "off" } },
              sessionManager: { appendThinkingLevelChange() {} },
              sessionFile: join(directory, `prime-${factoryContext.threadId}.jsonl`),
              promptAndWait: begin,
              abort,
              waitForRlmQuiescence: async () => { if (!String(control.text).includes("accept") || String(control.text).includes("race")) await control.settled.promise; },
              dispose() {}, async disposeAsync() {}, async reload() {},
            } }),
          }),
        });
      }
      return {
        complete(next, signal) { context = next; return native.complete(next, signal); },
        state: () => native.state(),
        traceSupport: () => native.traceSupport(),
        dispose: () => native.dispose?.(),
      };
    };
  }
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: directory,
    graphServerBinary: join(repository, "target/debug/relayer-graph-server"),
    configurationPaths, additionalImplementations: factories,
    temporalFeatures: RECURSIVE_TEMPORAL_FEATURES,
    acquireProviderExecution: async (providerId) => {
      if (admissionGate) { admissionGate.entered.resolve(); await admissionGate.release.promise; }
      return ({
      definition: { id: providerId, adapterId: "openai-api", accessContract: "secret@1", endpoint: "https://api.openai.com/v1" },
      descriptor: { adapterId: "openai-api", accessContract: "secret@1", implementationVersion: "2" },
      runtime: { async executionAccess() { return { kind: "secret", endpoint: "https://api.openai.com/v1", fields: { "api-key": "fixture-never-sent" } }; } },
      async release() { releases++; },
    }); },
  });
  services.push(runtime);
  const runtimeSession = await runtime.start();
  const graphProxy = createServer((incoming, outgoing) => {
    if (graphFault?.(incoming)) {
      outgoing.writeHead(500, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: { message: "Injected Stop cleanup failure" } }));
      return;
    }
    const upstream = httpRequest(new URL(incoming.url, runtimeSession.graphUrl), { method: incoming.method, headers: incoming.headers }, (response) => {
      outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
    });
    upstream.on("error", () => { outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(upstream);
  });
  await new Promise((resolve) => graphProxy.listen(0, "127.0.0.1", resolve));
  services.push({ close: () => new Promise((resolve) => graphProxy.close(resolve)) });
  const productOptions = {
    userDataDirectory: directory, binaryPath: join(repository, "target/debug/relayer-app-server"),
    webDirectory: join(repository, "desktop/renderer"), permissionCatalogPath: join(repository, "permissions/desktop.json"),
    runtimeSession: { ...runtimeSession, graphUrl: `http://127.0.0.1:${graphProxy.address().port}` }, defaultHarnessConfiguration: "fixture-stop-codex", enableReadOnlySession: true,
  };
  let product = new RelayerAppServerService(productOptions);
  services.push(product);
  let session = await product.start();
  const request = async (path, options = {}) => {
    const response = await fetch(new URL(path, session.origin), { ...options, headers: { Cookie: `${session.cookie.name}=${session.cookie.value}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(JSON.stringify(body)), { status: response.status });
    return body;
  };
  const definitionStore = product.providerDefinitionStore();
  const definitions = await definitionStore.load();
  await definitionStore.save([...definitions.filter((item) => item.id !== "fixture-openai"), { id: "fixture-openai", adapterId: "openai-api", label: "Deterministic provider", endpoint: "https://api.openai.com/v1", accessContract: "secret@1", credentialReference: "fixture-only", lifecycleState: "active", removedAt: null }]);
  await product.seedProviderCatalog({ providerId: "fixture-openai", adapterId: "openai-api", adapterImplementationVersion: "2", accessContract: "secret@1", label: "Deterministic provider", connected: true,
    models: [{ id: "gpt-fixture", label: "Fixture", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }],
  });
  const family = await request("/api/model-families", { method: "POST", body: JSON.stringify({ name: "Deterministic models", enabled: true, members: [{ providerId: "fixture-openai", modelId: "gpt-fixture", roles: [{ name: "orchestrator" }] }] }) });
  const modelSelection = { familyId: family.id, providerId: "fixture-openai", modelId: "gpt-fixture" };
  return { directory, get session() { return session; }, runtimeSession, runtime, get product() { return product; }, controls, request, modelSelection,
    async restartProduct() {
      await product.close();
      admissionGate?.release.resolve();
      for (const c of controls.values()) { c.prompt.resolve(); c.settled.resolve(); }
      await waitFor("old native runs settled", () => [...runtime.harnessHost.host.sessions.values()].every((s) => s.activeCompletions.size === 0));
      const previous = product;
      product = new RelayerAppServerService(productOptions);
      services[services.indexOf(previous)] = product;
      session = await product.start();
    },
    get releases() { return releases; },
    failGraph(predicate) { graphFault = predicate; },
    rejectStoppedPersistence() {
      const db = new DatabaseSync(join(directory, "product-data/product.sqlite3"));
      db.exec("CREATE TRIGGER fixture_reject_stopped BEFORE UPDATE OF completion_status ON interactions WHEN NEW.completion_status='stopped' BEGIN SELECT RAISE(ABORT,'fixture stopped persistence failure'); END");
      db.close();
    },
    async current(completionId) {
      const response = await fetch(new URL(`/api/control/interactions/${completionId}/current`, runtimeSession.graphUrl), { headers: { authorization: `Bearer ${runtimeSession.graphControlToken}` } });
      if (!response.ok) throw new Error(`Current read failed: ${response.status}`);
      return response.json();
    },
    holdAdmission() { admissionGate = { entered: Promise.withResolvers(), release: Promise.withResolvers() }; return admissionGate; },
    async create(provider, text) { return request("/api/threads", { method: "POST", body: JSON.stringify({ initialMessage: text, harnessId: `fixture-stop-${provider}`, permissionProfileId: "full", modelSelection }) }); },
    async close() { admissionGate?.release.resolve(); for (const c of controls.values()) { c.prompt.resolve(); c.settled.resolve(); } for (const service of services.reverse()) await service.close(); await rm(directory, { recursive: true, force: true }); },
  };
  } catch (error) {
    for (const c of controls.values()) { c.prompt.resolve(); c.settled.resolve(); }
    for (const service of services.reverse()) await service.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
