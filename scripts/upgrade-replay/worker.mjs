// One Node process per phase; each owns real graph/app-server child processes.
// Only vendor discovery, runtime preparation/checks and baseline model output are fixtures.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { artifactViewPlan } from "../../desktop/main/services/artifact-viewer.mjs";
import { availablePickerFamilies } from "../../desktop/renderer/src/model-picker-model.js";
import { fingerprintPath } from "@relayer/harness-host";
import { assertPreserved, sha256, until } from "./contract.mjs";

const options = JSON.parse(await readFile(process.argv[2], "utf8"));
const { phase, profile, modules, bin, harnesses, permissions, renderer, resultPath, baselinePath } = options;
const load = (path) => import(pathToFileURL(join(modules, path)).href);
const { GraphCompleteRuntimeService } = await load("main/services/graphcomplete-runtime.mjs");
const { RelayerAppServerService } = await load("main/services/relayer-app-server.mjs");
const { HARNESS_MANAGED_RUNTIME_REQUIREMENTS: requirements } = await load("shared/managed-runtime-requirements.mjs");
const { resolveManagedRuntimeRecipe } = await load("main/managed-runtimes/recipes.mjs");
const ids = ["codex-basic", "claude-basic", "prime-agent-basic"];
const html = "<!doctype html><title>Upgrade fixture v1</title><h1>Saved before upgrade</h1>\n";
let fixtureExecutions = 0;
const checks = [];
const preparations = [];
const publications = [];
const failures = [];
let product, composition, upgrade;
let primeStarted = false;
let primeAborted = false;
const report = { phase, workerPid: process.pid, passed: false, checkpoints: [] };
const checkpoint = (name) => report.checkpoints.push(name);

const runtime = new GraphCompleteRuntimeService({
  userDataDirectory: profile,
  graphServerBinary: join(bin, "relayer-graph-server"),
  configurationPaths: ids.map(id => join(harnesses, `${id}.yaml`)),
  coordinateHarnessReadiness: true,
  validateHarnessRuntime: async () => true,
  harnessRuntimeRecipe: ({ implementation }) => {
    const recipe = resolveManagedRuntimeRecipe(requirements[implementation].recipeId, "macos-arm64");
    return `${recipe.recipeId}#${recipe.recipeDigest}`;
  },
  acquireProviderExecution: async providerId => {
    assert.equal(phase, "seed", "Candidate must not acquire new model execution");
    return {
      definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
      descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
      runtime: { async executionAccess() { return { kind: "managed-runtime", environment: {} }; } },
      async release() {},
    };
  },
  additionalImplementations: { "codex.basic": context => ({
    state: () => ({}),
    traceSupport: () => Object.fromEntries(["prompt", "messages", "reasoningSummaries", "modelCalls", "toolCalls", "usage", "childStreams", "nativeArtifacts"].map(key => [key, "none"])),
    async complete(run) {
      fixtureExecutions++;
      assert.equal(phase, "seed", "Candidate must not author a replacement graph");
      const local = relative(profile, context.workingDirectory);
      assert.ok(local !== ".." && !local.startsWith("../") && !isAbsolute(local), "Fixture authoring must remain inside the disposable profile");
      const { RelayerGraphClient, NodeObject, LayerObject, LayerLayoutObject, NodePlacementObject } = await load("node_modules/@relayer/graph-client/dist/index.js");
      const graph = new RelayerGraphClient(run.graph.acquireCapability());
      await mkdir(join(context.workingDirectory, "site"), { recursive: true });
      await writeFile(join(context.workingDirectory, "site/upgrade.html"), html);
      const artifact = new NodeObject("globe", "Upgrade artifact", "Saved before upgrade", "artifact", "upgrade-artifact");
      artifact.artifact = { kind: "website", source: { file: "site/upgrade.html", root: "site" } };
      await graph.submitNode(artifact);
      const artifactLayer = LayerObject.forArtifact(artifact, "upgrade-artifact-layer");
      await graph.submitLayer(artifactLayer);
      const link = new NodeObject("globe", "Saved site", "Open the saved upgrade artifact", "concept", "saved-site");
      await graph.submitNode(link);
      const answer = new LayerObject([link], [], new LayerLayoutObject([new NodePlacementObject(link, 0.5, 0.5)], "default"), "upgrade-answer", link);
      await graph.submitLayer(answer);
      await graph.addAction(link, { kind: "navigate", relation: "expand", sourceLayer: answer, label: "Open saved artifact", target: artifactLayer, clientKey: "open-upgrade-artifact" });
      await graph.addAction(run.inputGraph.id, { kind: "navigate", relation: "expand", label: "Response", target: answer, clientKey: "response" });
      await graph.submit(run.inputGraph.id);
    },
  }) },
  startupTimeoutMs: 60_000,
});

async function request(path, body, method) {
  const session = await product.start();
  const response = await fetch(new URL(path, session.origin), {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { Cookie: `${session.cookie.name}=${session.cookie.value}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.ok, true, `${path} failed (${response.status}): ${JSON.stringify(value)}`);
  return value;
}

async function snapshot(threadId, familyId) {
  const detail = await request(`/api/threads/${threadId}`);
  assert.equal(detail.interactions.length, 1);
  const interaction = detail.interactions[0];
  assert.equal(interaction.completionStatus, "accepted");
  const output = interaction.completionOutput;
  const action = output.rootLayer.actions.find(({ clientKey }) => clientKey === "open-upgrade-artifact");
  assert.ok(action, "Saved navigate action missing");
  assert.equal(action.sourceLayerId, output.rootLayer.layer.id);
  const layer = await request(`/api/threads/${threadId}/interactions/${interaction.id}/layers/${action.targetLayerId}`);
  const node = layer.nodes.find(({ kind }) => kind === "artifact");
  assert.ok(node?.artifact, "Saved target layer must contain an artifact descriptor");
  const { folder } = await product.artifactFolder(threadId);
  assert.ok(!relative(profile, folder).startsWith("..") && !isAbsolute(relative(profile, folder)), "Saved artifact folder escaped the disposable profile");
  const plan = artifactViewPlan(node.artifact, folder);
  assert.equal(await readFile(plan.file, "utf8"), html);
  assert.equal(await fingerprintPath(plan.folder), node.artifact.fingerprint, "Accepted artifact fingerprint no longer matches saved bytes");
  const settings = await request("/api/model-settings");
  const family = settings.families.find(({ id }) => id === familyId);
  assert.ok(family?.enabled, "Saved custom family missing or disabled");
  return {
    thread: { id: detail.thread.id, title: detail.thread.title, rootInteractionId: detail.thread.rootInteractionId, harnessId: detail.thread.harnessId, permissionProfileId: detail.thread.permissionProfileId },
    interaction: { id: interaction.id, text: interaction.text, graphNodeId: interaction.graphNodeId, completionStatus: interaction.completionStatus, harnessConfigurationDigest: interaction.harnessConfigurationDigest, modelSelection: interaction.modelSelection },
    output,
    artifactLayer: layer,
    fileHash: sha256(await readFile(plan.file)),
    viewPlan: { kind: plan.kind, url: plan.url, entry: plan.entry, source: plan.source },
    family: { id: family.id, name: family.name, enabled: family.enabled, members: family.members.map(({ providerId, modelId }) => ({ providerId, modelId })) },
    defaults: settings.defaults,
    definitions: (await product.providerDefinitionStore().load()).map(({ id, adapterId, accessContract, lifecycleState, connectionGeneration }) => ({ id, adapterId, accessContract, lifecycleState, connectionGeneration })),
  };
}

async function assertUsable(baseline) {
  const settings = await request("/api/model-settings");
  const statuses = await product.providerStatuses();
  report.usableRoutes = [];
  for (const [providerId, harnessId] of [["codex", "codex-basic"], ["claude", "claude-basic"]]) {
    const family = settings.families.find(family => family.enabled && family.members.some(member => member.providerId === providerId));
    assert.ok(family, `${providerId} family missing`);
    assert.equal(statuses.get(providerId)?.connected, true);
    assert.equal(statuses.get(providerId)?.unavailableReason, null, `${providerId} still requires repair`);
    if (phase !== "seed") assert.ok(availablePickerFamilies(settings, harnessId).some(candidate => candidate.id === family.id), `${providerId} absent from production picker projection`);
    const model = family.members.find(member => member.providerId === providerId);
    const selection = await request("/api/model-selection/validate", { harnessId, familyId: family.id, providerId, modelId: model.modelId });
    assert.equal(selection.providerId, providerId);
    report.usableRoutes.push({ providerId, harnessId, familyId: family.id, modelId: selection.modelId });
  }
  if (phase !== "seed") assert.ok(availablePickerFamilies(settings, "codex-basic").some(family => family.id === baseline.familyId), "Saved custom default family is not usable");
  checkpoint(phase === "seed" ? "both-predecessor-subscriptions-pass-native-selection-validation" : "both-subscriptions-available-in-picker-projection-and-native-selection-validation");
}

// Controlled upstream responses enter through the real provider composition. No
// candidate phase seeds a catalog, publishes readiness directly, or repairs manually.
async function startComposition(session) {
  const { createProviderAdapterRegistry } = await load("main/providers/provider-adapter-contract.mjs");
  const { createProviderComposition } = await load("main/providers/provider-composition.mjs");
  const { createHarnessReadinessCoordinator, createPostUpgradeReadiness } = await load("main/services/harness-readiness.mjs");
  const definitions = await product.providerDefinitionStore().load();
  const registry = createProviderAdapterRegistry(["codex-subscription", "claude-subscription", "openrouter"].map(adapterId => ({
    adapterId, implementationVersion: "1", label: adapterId,
    accessContract: adapterId === "openrouter" ? "secret@1" : "managed-runtime@1",
    defaultEndpoint: adapterId === "openrouter" ? "https://fixture.invalid/v1" : null,
    connection: adapterId === "openrouter" ? { mode: "secret-fields", fields: [{ id: "key", label: "Fixture", kind: "secret" }] } : { mode: "managed-login", fields: [] },
    create: ({ definition }) => ({
      providerId: definition.id,
      async discover() {
        const id = definition.adapterId === "claude-subscription" ? "sonnet" : "fixture-model";
        return {
          provider: { id: definition.id, label: definition.label, status: "available" },
          models: [{ id, executionModel: id, label: id, visible: true, availability: "available", isDefault: true, supportedEfforts: [], inputModalities: ["text"], supportsPersonality: false, serviceTiers: [] }],
          systemFamily: { id: definition.id, label: definition.label, modelIds: [id] },
        };
      },
      async close() {},
    }),
  })));
  const readiness = createHarnessReadinessCoordinator({
    configurations: session.configurations,
    digestConfiguration: session.digestConfiguration,
    runtimeRequirements: requirements,
    recipeInstalled: async () => true,
    prepareRecipe: async (recipeId, { signal } = {}) => {
      preparations.push(recipeId);
      if (phase === "upgrade" && recipeId.startsWith("prime@")) {
        primeStarted = true;
        await new Promise((_, reject) => {
          const abort = () => { primeAborted = true; reject(signal.reason); };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      return {};
    },
    checkers: Object.fromEntries(Object.keys(requirements).map(implementation => [implementation, async () => {
      checks.push(implementation);
      return { available: true };
    }])),
    publishAvailability: async (updates, options) => {
      await product.publishHarnessReadiness(updates, options);
      publications.push(...updates.map(({ harnessId }) => harnessId));
    },
  });
  composition = createProviderComposition({
    registry,
    definitionStore: product.providerDefinitionStore(),
    credentialStore: { async get() { return { key: "fixture-only" }; }, async listReferences() { return []; } },
    publishCatalog: (snapshot, options) => product.publishProviderCatalog(snapshot, options),
    providerStatuses: () => product.providerStatuses(),
    evaluateReadiness: () => { throw new Error("Replay must not use Connect or Repair readiness"); },
    modelCatalogOptions: { backgroundIntervalMs: 60 * 60 * 1000 },
  });
  await composition.start();
  assert.deepEqual(await product.providerDefinitionStore().load(), definitions, "Startup must retain provider definitions and connection generations");
  assert.equal((await composition.readinessRoutes()).length, 3, "All saved provider routes must activate");
  upgrade = createPostUpgradeReadiness({
    readiness,
    updatesDue: () => product.harnessReadinessUpdatesDue(),
    composition,
    recipeForAdapter: adapterId => requirements[adapterId === "claude-subscription" ? "claude.basic" : "codex.basic"].recipeId,
    onError: error => failures.push(error.message),
  });
  upgrade.start();
}

try {
  const session = await runtime.start();
  report.configurations = [...session.configurations.values()].map(configuration => ({
    id: configuration.name, digest: session.digestConfiguration(configuration), recipe: runtime.harnessRuntimeRecipe(configuration),
  }));
  product = new RelayerAppServerService({ userDataDirectory: profile, binaryPath: join(bin, "relayer-app-server"), webDirectory: renderer, permissionCatalogPath: permissions, runtimeSession: session, startupTimeoutMs: 60_000 });
  await product.start();
  report.nativePids = [runtime.graphProcess.pid, product.child.pid];
  if (phase === "seed") {
    await product.publishHarnessReadiness(report.configurations.map(({ id, digest }) => ({ harnessId: id, configurationDigest: digest, generation: 1, available: true, unavailableReason: null })));
    // Public fixture setup happens only on the predecessor, before it is shut down.
    const store = product.providerDefinitionStore();
    await store.save([
      { id: "codex", adapterId: "codex-subscription", label: "Codex fixture", endpoint: null, accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active" },
      { id: "claude", adapterId: "claude-subscription", label: "Claude fixture", endpoint: null, accessContract: "managed-runtime@1", credentialReference: null, lifecycleState: "active" },
      { id: "router", adapterId: "openrouter", label: "Router fixture", endpoint: "https://fixture.invalid/v1", accessContract: "secret@1", credentialReference: "fixture-router", lifecycleState: "active" },
    ]);
    for (const id of ["codex", "claude", "router"]) {
      const modelId = id === "claude" ? "sonnet" : "fixture-model";
      await product.seedProviderCatalog({ providerId: id, label: `${id} fixture`, connected: true, models: [{ id: modelId, label: modelId, order: 0, visible: true, available: true, providerDefault: true, metadata: {} }], systemFamily: { key: id, name: `${id} fixture`, modelIds: [modelId] } });
    }
    const family = await request("/api/model-families", { name: "Upgrade fixture", enabled: true, members: [{ providerId: "codex", modelId: "fixture-model", roles: [{ name: "orchestrator" }] }] });
    await request("/api/model-settings/defaults", { providerId: "codex", familyId: family.id, harnessId: "codex-basic" }, "PUT");
    const thread = await request("/api/threads", { initialMessage: "Create the upgrade artifact", permissionProfileId: "auto", harnessId: "codex-basic", modelSelection: { familyId: family.id, providerId: "codex", modelId: "fixture-model" } });
    await until("predecessor accepts ordinary message", async () => {
      const detail = await request(`/api/threads/${thread.id}`);
      assert.notEqual(detail.interactions[0]?.completionStatus, "failed", JSON.stringify(detail.interactions[0]?.completionError));
      return detail.interactions[0]?.completionStatus === "accepted";
    });
    assert.equal(fixtureExecutions, 1);
    await assertUsable({ familyId: family.id });
    const settings = await request("/api/model-settings");
    assert.ok(ids.every(id => settings.harnesses.find(harness => harness.id === id)?.available === true), "All predecessor harnesses must begin ready");
    report.saved = await snapshot(thread.id, family.id);
    report.threadId = thread.id;
    report.familyId = family.id;
    checkpoint("predecessor-ready-connected-saved-graph-and-artifact");
  } else {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    report.dueBefore = await product.harnessReadinessUpdatesDue();
    assert.deepEqual([...report.dueBefore].sort(), phase === "upgrade" ? [...ids].sort() : phase === "recover" ? ["prime-agent-basic"] : []);
    if (phase === "upgrade") for (const configuration of report.configurations) assert.notEqual(configuration.digest, baseline.configurations.find(({ id }) => id === configuration.id).digest, "Pinned predecessor must cause a real configuration transition");
    checkpoint("native-startup-created-or-restored-exact-due-marks");
    await startComposition(session);
    if (phase === "upgrade") {
      await until("independent Codex and Claude readiness while Prime is held", async () => {
        const due = await product.harnessReadinessUpdatesDue();
        return primeStarted && due.length === 1 && due[0] === "prime-agent-basic";
      });
      assert.deepEqual([...publications].sort(), ["claude-basic", "codex-basic"]);
      assert.equal(primeAborted, false);
      await assertUsable(baseline);
      assert.equal(primeAborted, false, "Usability must be observed while Prime is still actively pending");
      const settings = await request("/api/model-settings");
      assert.equal(settings.harnesses.find(harness => harness.id === "prime-agent-basic")?.available, false);
      checkpoint("healthy-subscriptions-committed-while-prime-pending");
      await upgrade.stopForShutdown();
      assert.equal(primeAborted, true);
    } else {
      await upgrade.evaluation;
      assert.deepEqual(await product.harnessReadinessUpdatesDue(), []);
      assert.deepEqual(checks, phase === "recover" ? ["prime.agent"] : []);
      assert.deepEqual(publications, phase === "recover" ? ["prime-agent-basic"] : []);
      assert.deepEqual(preparations, phase === "recover" ? [requirements["prime.agent"].recipeId] : []);
      checkpoint(phase === "recover" ? "new-process-resumes-only-interrupted-prime" : "fresh-process-restores-readiness-without-rechecking");
    }
    if (phase !== "upgrade") await assertUsable(baseline);
    report.saved = await snapshot(baseline.threadId, baseline.familyId);
    assertPreserved(baseline.saved, report.saved);
    assert.equal(fixtureExecutions, 0);
    assert.deepEqual(failures, []);
    report.dueAfter = await product.harnessReadinessUpdatesDue();
    checkpoint("saved-defaults-provider-identities-conversation-artifact-and-view-plan-preserved");
  }
  report.passed = true;
} finally {
  await upgrade?.stopForShutdown();
  await composition?.close();
  const children = [product?.child, runtime.graphProcess].filter(Boolean);
  await product?.close();
  await runtime.close();
  report.nativeExits = children.map(child => ({ pid: child.pid, code: child.exitCode, signal: child.signalCode }));
  assert.ok(report.nativeExits.every(child => child.code !== null || child.signal !== null), "Owned native process remained alive");
  report.checks = checks;
  report.preparations = preparations;
  report.publications = publications;
  report.fixtureExecutions = fixtureExecutions;
  await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`);
}
