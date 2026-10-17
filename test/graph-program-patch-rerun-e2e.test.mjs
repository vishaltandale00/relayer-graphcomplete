import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createDesktopGraphRuntime } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";

/**
 * Zero-inference proof that a retry can send edits to a named saved graph program.
 * A fixture harness runs real `node --input-type=module` stdin programs, the way
 * Codex and Claude do, against the real harness host and Rust graph server:
 * the first program is rejected, a patch heredoc fixes it, and the graph is accepted.
 */

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const client = pathToFileURL(join(root, "packages/graph-client/dist/index.js")).href;
const services = [];
const directories = [];

afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** Runs a heredoc program exactly as a harness shell would: the program is stdin, nothing else. */
async function runProgram(program, environment) {
  const child = execFileAsync(process.execPath, ["--input-type=module"], { env: environment });
  child.child.stdin.end(program);
  try {
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

const fullProgram = (interactionNodeId, outcome = "repair") => `import { RelayerGraphClient, NodeObject, LayerObject, LayerLayoutObject, NodePlacementObject } from "${client}";
const graph = RelayerGraphClient.fromEnv();
${outcome === "lost-ack" ? `const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (String(args[0]).endsWith("/api/graph/submit") && response.ok) {
    await response.arrayBuffer();
    throw new TypeError("lost submit acknowledgement after commit");
  }
  return response;
};` : ""}
const answer = new NodeObject("info", "Patched answer", "The second run of this program was a patch.", "concept", "answer");
await graph.submitNode(answer);
const layer = new LayerObject([answer], [], new LayerLayoutObject([new NodePlacementObject(answer, 0.5, 0.5)], "default"), "answer-layer");
await graph.submitLayer(layer);
await graph.submit(${interactionNodeId});
`;

const patchProgram = (interactionNodeId, id) => `import { rerunGraphProgram } from "${client}";
await rerunGraphProgram(${JSON.stringify(id)}, [{
  find: "await graph.submit(${interactionNodeId});",
  replace: 'await graph.addAction(${interactionNodeId}, { kind: "navigate", relation: "expand", label: "Answer", target: layer, clientKey: "root" });\\nawait graph.submit(${interactionNodeId});',
}]);
`;

function fixtureFactory(state, outcome) {
  return () => ({
    traceSupport: () => ({ prompt: "none", messages: "none", reasoningSummaries: "none", modelCalls: "none", toolCalls: "none", usage: "none", childStreams: "none", nativeArtifacts: "none" }),
    state: () => ({}),
    async complete(context) {
      const capability = context.graph.acquireCapability();
      state.programDirectory = capability.programDirectory;
      const environment = {
        PATH: process.env.PATH,
        RELAYER_GRAPH_URL: capability.url,
        RELAYER_GRAPH_TOKEN: capability.token,
        RELAYER_NODE_ID: String(capability.nodeId),
        RELAYER_GRAPH_PROGRAM_DIR: capability.programDirectory,
      };
      state.first = await runProgram(fullProgram(context.inputGraph.id, outcome), environment);
      // The model reads the id from the program's own output, exactly as the prompt says.
      state.firstId = /graph program id: ([0-9a-f]{8})/.exec(state.first.stdout)?.[1];
      state.savedFirst = await readFile(join(capability.programDirectory, "programs", `${state.firstId}.mjs`), "utf8");
      state.second = await runProgram(patchProgram(context.inputGraph.id, state.firstId), environment);
      state.secondId = /running as ([0-9a-f]{8})/.exec(state.second.stdout)?.[1];
      state.savedSecond = await readFile(join(capability.programDirectory, "programs", `${state.secondId}.mjs`), "utf8");
      if (outcome === "after-accept") {
        state.third = await runProgram(`import { rerunGraphProgram } from "${client}";
await rerunGraphProgram("${state.secondId}", [{ find: "Patched answer", replace: "Unauthorized revision" }]);
`, environment);
        if (state.third.code === 0) throw new Error("accepted graph unexpectedly changed");
        throw new Error("rerun rejected after graph acceptance");
      }
      if (state.second.code !== 0) throw new Error(state.second.stderr);
    },
  });
}

it.each(["repair", "lost-ack", "after-accept"])("preserves named repair and accepted graph authority for %s", async (outcome) => {
  const directory = await mkdtemp(join(tmpdir(), "relayer-patch-rerun-e2e-"));
  directories.push(directory);
  const projectPath = join(directory, "project");
  await mkdir(projectPath);
  const configurationPath = join(directory, "fixture.yaml");
  await writeFile(configurationPath, "schemaVersion: 1\nname: fixture-patch-rerun\nimplementation: fixture.patch-rerun\nimplementationVersion: 1\npermissionBindings:\n  ask: {}\n  auto: {}\n  full: {}\nmodelCompatibility:\n  - providerId: codex\nexecutionAccessContracts: [managed-runtime@1]\nsettings: {}\n");
  const state = {};
  const runtime = createDesktopGraphRuntime({
    userDataDirectory: directory,
    graphServerBinary: join(root, "target/debug/relayer-graph-server"),
    configurationPaths: [configurationPath],
    additionalImplementations: { "fixture.patch-rerun": fixtureFactory(state, outcome) },
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
    userDataDirectory: directory, binaryPath: join(root, "target/debug/relayer-app-server"),
    webDirectory: join(root, "desktop/renderer"), permissionCatalogPath: join(root, "permissions/desktop.json"),
    runtimeSession, defaultHarnessConfiguration: "fixture-patch-rerun", allowHarnessOverride: true,
  });
  services.push(product);
  const session = await product.start();
  await product.seedProviderCatalog({
    providerId: "codex", label: "Fixture", connected: true,
    models: [{ id: "fixture-model", label: "Fixture", order: 0, visible: true, available: true, providerDefault: true, metadata: {} }],
    systemFamily: { key: "codex", name: "Codex", modelIds: ["fixture-model"] },
  });
  const project = await request(session, "/api/projects", { path: projectPath });
  const family = await request(session, "/api/model-families", { name: "Fixture", enabled: true, members: [{ providerId: "codex", modelId: "fixture-model", roles: [{ name: "orchestrator" }] }] });
  const thread = await request(session, "/api/threads", {
    title: "Patch rerun", initialMessage: "Answer with a patched program", projectId: project.id,
    permissionProfileId: "auto", harnessId: "fixture-patch-rerun",
    modelSelection: { familyId: family.id, providerId: "codex", modelId: "fixture-model" },
  });
  const detail = await waitForStatus(session, thread.id, "accepted");

  // The first run was a real graph rejection: no root action yet. It still printed its id.
  expect(state.first.code).not.toBe(0);
  expect(state.first.stderr).toMatch(/root/i);
  expect(state.firstId).toMatch(/^[0-9a-f]{8}$/);
  expect(state.savedFirst).toBe(fullProgram(detail.interactions[0].graphNodeId, outcome));
  // The patch ran the edited program with the same clientKeys and saved it under its own id.
  if (outcome === "lost-ack") {
    expect(state.second.code).not.toBe(0);
    expect(state.second.stderr).toContain("lost submit acknowledgement after commit");
  } else expect(state.second).toMatchObject({ code: 0 });
  if (outcome === "after-accept") {
    expect(state.third.code).not.toBe(0);
    expect(state.third.stderr).toContain("authority_generation_expired");
  }
  expect(state.second.stdout).toContain(`graph program id: ${state.secondId}`);
  expect(state.savedSecond).toContain('clientKey: "root"');
  expect(state.savedSecond).not.toContain("rerunGraphProgram");
  // The accepted graph is the patched program's output.
  const output = detail.interactions[0].completionOutput;
  expect(output.rootLayer.nodes.map((node) => node.title)).toEqual(["Patched answer"]);
  // The host removed the saved programs with the turn.
  await expect(stat(state.programDirectory)).rejects.toThrow();
}, 60_000);

async function request(session, path, body) {
  const response = await fetch(new URL(path, session.origin), {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: `${session.cookie.name}=${session.cookie.value}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error || `Product request failed (${response.status}).`), { status: response.status });
  return value;
}

async function waitForStatus(session, threadId, status) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const detail = await request(session, `/api/threads/${threadId}`);
    const turn = detail.interactions[0];
    if (turn?.completionStatus === status) return detail;
    if (turn?.completionStatus === "failed") throw new Error(`Turn failed: ${turn.completionError}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Turn did not reach ${status}.`);
}
