import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LayerLayoutObject, LayerObject, NodeObject, html, css, NodePlacementObject, RelayerGraphClient } from "@relayer/graph-client";
import { codexInstructionGraphCorpus } from "@relayer/harness-host";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";

const root = resolve(import.meta.dirname, "..");
const binaries = join(process.env.CARGO_TARGET_DIR || join(root, "target"), "debug");
const resources = [], directories = [];
afterEach(async () => {
  for (const service of resources.splice(0).reverse()) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function api(session, path, body) {
  const response = await fetch(new URL(path, session.origin), {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: `${session.cookie.name}=${session.cookie.value}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}

async function accepted(session, threadId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const detail = await api(session, `/api/threads/${threadId}`);
    const turn = detail.interactions[0];
    if (turn?.completionStatus === "failed") throw new Error(JSON.stringify(turn));
    if (turn?.completionStatus === "accepted") return turn;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  throw new Error("Instruction graph fixture did not reach acceptance");
}

it.each([
  { configurationName: "codex-instruction-graph-v1", versionKey: "codex-instruction-graph-v1" },
  { configurationName: "codex-instruction-graph-v2", versionKey: "codex-instruction-graph-v2" },
  { configurationName: "codex-basic", versionKey: "codex-instruction-graph-v2", searchDisabled: true },
])("publishes $configurationName at runtime startup and delivers its app-server-pinned manifest through HarnessHost before execution, including reopen", async ({ configurationName, versionKey, searchDisabled }) => {
  const directory = await mkdtemp(join(tmpdir(), "relayer-instruction-journey-")); directories.push(directory);
  let configurationPath = join(root, `harnesses/${configurationName}.yaml`);
  if (searchDisabled) {
    const productConfiguration = await readFile(configurationPath, "utf8");
    expect(productConfiguration).toContain("promptProfile: instruction-graph-v2");
    expect(productConfiguration).toContain("search: query-v1");
    configurationPath = join(directory, `${configurationName}.yaml`);
    await writeFile(configurationPath, productConfiguration.replace("search: query-v1", "search: disabled"));
  }
  const configurationPaths = configurationName === "codex-basic"
    ? [configurationPath] : [join(root, "harnesses/codex-basic.yaml"), configurationPath];
  const corpus = codexInstructionGraphCorpus(versionKey), seen = [];
  const open = async () => {
    const runtime = new GraphCompleteRuntimeService({
      userDataDirectory: directory, graphServerBinary: join(binaries, "relayer-graph-server"),
      temporalFeatures: versionKey.endsWith("v2") ? {schemaRead:true,rootCurrentWrite:true} : {},
      configurationPaths,
      additionalImplementations: { "codex.basic": () => ({
        supportsInvokedComplete: true,
        state: () => ({}),
        async complete(context) {
          const graph = new RelayerGraphClient(context.graph.acquireCapability());
          const manifest = context.instructionGraph;
          expect(context.interactionInput.completionContract).toBeDefined();
          expect(manifest).toMatchObject({ versionKey: corpus.versionKey, digest: corpus.digest });
          expect(await graph.getInstructionGraph()).toEqual(manifest);
          if (searchDisabled) {
            await expect(graph.searchInstructions({
              queryContractVersion: 1,
              query: "MATCH (n:Content) RETURN n.title AS title LIMIT 1",
              reason: { purpose: "search", detail: "Locate a topic through instruction metadata" },
            })).rejects.toMatchObject({ status: 403, code: "capability_not_granted" });
          }
          if (versionKey.endsWith("v2")) {
            expect(manifest.retrievalContractVersion).toBe(2);
            const nodeIds = [manifest.modules[0].nodeId], reason = {purpose:"authority",detail:"Check completion authority before writing"};
            const first = await graph.retrieveInstructions({requestKey:"first",nodeIds,reason});
            expect(first.entries[0]).toMatchObject({delivery:"body",detail:corpus.modules[0].detail});
            expect((await graph.retrieveInstructions({requestKey:"second",nodeIds,reason})).entries[0]).toMatchObject({delivery:"already-returned",bodyBytes:0});
            await expect(graph.getInstructionNode(nodeIds[0])).rejects.toThrow();
          } else {
            const module = await graph.getInstructionNode(manifest.modules[0].nodeId);
            expect(module.detail).toBe(corpus.modules[0].detail);
          }
          await expect(graph.getInstructionNode(context.inputGraph.id)).rejects.toThrow();
          seen.push(manifest);
          if (versionKey.endsWith("v2")) {
            // Execute the actual shipped recipes against the real client/server seam.
            const text = key => corpus.modules.find(module=>module.key===key).detail;
            const publish = text("publish-current").split("import { RelayerGraphClient }")[1].split("\nPublish useful")[0];
            const publication = publish.slice(publish.indexOf("\n")+1)
              .replace("const graph = RelayerGraphClient.fromEnv();", "")
              .replaceAll("INTERACTION_NODE_ID",String(context.inputGraph.id));
            const detail = text("detail-basic").split("\nanswer.detailAuthoring")[1].split("\nUse task-specific")[0];
            const finish = text("finish-current").split("\nconst current")[1].split("\nIf there is no")[0];
            const execute = new Function("graph","html","css","console",
              `return (async()=>{${publication.replace("const written =",`answer.detailAuthoring${detail}\nconst written =`)}\nconst current${finish}})()`);
            await execute(graph,html,css,{log(){}}).catch(error=>{console.error("V2 shipped recipe failed:",error);throw error;});
          } else {
          const answer = new NodeObject("check", "Result", "The task completed.", "concept", "answer");
          await graph.submitNode(answer);
          const layer = new LayerObject([answer], [], new LayerLayoutObject([new NodePlacementObject(answer, .5, .5)], "default"), "response");
          await graph.submitLayer(layer);
          await graph.addAction(context.inputGraph.id, { kind: "navigate", relation: "expand", label: "Answer", target: layer, clientKey: "response" });
          await graph.submit(context.inputGraph.id);
          }
        },
      }) },
      acquireProviderExecution: async providerId => ({
        definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
        descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
        runtime: { async executionAccess() { return { kind: "managed-runtime", environment: {} }; } },
        async release() {},
      }),
    });
    resources.push(runtime);
    const runtimeSession = await runtime.start();
    const product = new RelayerAppServerService({
      userDataDirectory: directory, binaryPath: join(binaries, "relayer-app-server"), webDirectory: join(root, "desktop/renderer"),
      permissionCatalogPath: join(root, "permissions/desktop.json"), runtimeSession,
      defaultHarnessConfiguration: configurationName, allowHarnessOverride: true,
    });
    resources.push(product);
    return { runtime, product, session: await product.start() };
  };
  let opened = await open();
  await opened.product.seedProviderCatalog({ providerId: "codex", label: "Fixture", connected: true,
    models: [{ id: "fixture-model", label: "Fixture", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }],
    systemFamily: { key: "codex", name: "Codex", modelIds: ["fixture-model"] } });
  const family = await api(opened.session, "/api/model-families", { name: "Fixture", enabled: true,
    members: [{ providerId: "codex", modelId: "fixture-model", roles: [{ name: "orchestrator" }] }] });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1) { await opened.product.close(); await opened.runtime.close(); opened = await open(); }
    const thread = await api(opened.session, "/api/threads", { title: "Instruction retrieval", initialMessage: "Complete the fixture task",
      permissionProfileId: "auto", harnessId: configurationName,
      modelSelection: { familyId: family.id, providerId: "codex", modelId: "fixture-model" } });
    const turn = await accepted(opened.session, thread.id);
    expect(turn.completionOutput.rootLayer.nodes[0].title).toBe(versionKey.endsWith("v2")?"Meaningful finding":"Result");
    expect(JSON.stringify(turn.completionOutput)).not.toContain("harness-instruction");
  }
  expect(seen).toHaveLength(2);
  expect(seen[1]).toEqual(seen[0]);
}, 30_000);

it.each(["identity", "publication"])("refuses startup before execution after an instruction %s failure", async failure => {
  const directory = await mkdtemp(join(tmpdir(), "relayer-instruction-refusal-")); directories.push(directory);
  let publicationRequests = 0;
  const runtime = new GraphCompleteRuntimeService({
    userDataDirectory: directory, graphServerBinary: join(binaries, "relayer-graph-server"),
    configurationPaths: [join(root, "harnesses/codex-instruction-graph-v1.yaml")],
    adaptConfiguration: configuration => failure === "identity" ? { ...configuration,
      settings: { ...configuration.settings, instructionGraphDigest: "0".repeat(64) } } : configuration,
    fetchRequest: async (input, init) => {
      if (new URL(input).pathname.startsWith("/api/control/instruction-graphs/")) {
        publicationRequests++;
        return new Response("{}", { status: 503 });
      }
      return fetch(input, init);
    },
    acquireProviderExecution: async () => { throw new Error("Must not acquire provider access during failed corpus preparation"); },
  });
  resources.push(runtime);
  await expect(runtime.start()).rejects.toThrow(failure === "identity" ? "reviewed corpus" : "publication failed (503)");
  expect(publicationRequests).toBe(failure === "identity" ? 0 : 1);
}, 15_000);
