import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { bindComposerKeydown } from "../desktop/renderer/src/product-workspace/workspace.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const services = [];
const directories = [];

afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("first-message composer integration", () => {
  it.each(["personal-presentation-v1", "personal-presentation-v3"])("promotes new Codex threads while preserving reopened %s follow-up and invoke pins", async (previousVersion) => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-codex-presentation-"));
    directories.push(dataDirectory);
    const configurationPath = join(dataDirectory, "codex-basic.yaml");
    const shipped = await readFile(join(repositoryRoot, "harnesses/codex-basic.yaml"), "utf8");
    // Exercise both the original implicit default and the immediately preceding visual default.
    await writeFile(configurationPath, shipped.replace(/^  personalPresentationVersion:.*\n/m, previousVersion === "personal-presentation-v1" ? "" : `  personalPresentationVersion: ${previousVersion}\n`));
    const observed = [];
    const start = async () => {
      const runtime = new GraphCompleteRuntimeService({
        userDataDirectory: dataDirectory,
        graphServerBinary: join(repositoryRoot, "target/debug/relayer-graph-server"),
        configurationPaths: [configurationPath],
        candidateTrace: {
          directory: join(dataDirectory, "traces"),
          policy: { mode: "required", requiredFeatures: {}, includeNativeArtifacts: false, maxBytesPerTurn: 100_000, maxEventsPerTurn: 200 },
        },
        // Only replace paid provider execution; keep configuration selection, graph
        // attachment, acceptance, and durable Product storage on production paths.
        additionalImplementations: {
          "codex.basic": (context) => {
            const fixture = taskSystemFixtureFactory(context);
            const complete = fixture.complete.bind(fixture);
            fixture.complete = async (run) => {
              observed.push({ graphNodeId: run.inputGraph.id, presentation: structuredClone(run.personalPresentation) });
              await complete(run);
            };
            return fixture;
          },
        },
        acquireProviderExecution: async (providerId) => ({
          definition: { id: providerId, adapterId: "codex-subscription", accessContract: "managed-runtime@1" },
          descriptor: { adapterId: "codex-subscription", accessContract: "managed-runtime@1", implementationVersion: "1" },
          runtime: { async executionAccess() { return { kind: "managed-runtime", environment: {} }; } },
          async release() {},
        }),
      });
      services.push(runtime);
      const product = new RelayerAppServerService({
        userDataDirectory: dataDirectory,
        binaryPath: join(repositoryRoot, "target/debug/relayer-app-server"),
        webDirectory: join(repositoryRoot, "desktop/renderer"),
        permissionCatalogPath: join(repositoryRoot, "permissions/desktop.json"),
        runtimeSession: await runtime.start(),
        defaultHarnessConfiguration: "codex-basic",
      });
      services.push(product);
      const session = await product.start();
      await product.seedProviderCatalog(fixtureCatalogSnapshot());
      return { product, runtime, session };
    };
    const before = await start();
    const family = await productRequest(before.session, "/api/model-families", {
      method: "POST",
      body: JSON.stringify({ name: "Fixture models", enabled: true, members: [{ providerId: "codex", modelId: "fixture-model" }] }),
    });
    const modelSelection = { familyId: family.id, providerId: "codex", modelId: "fixture-model" };
    const createThread = (session) => productRequest(session, "/api/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Presentation selection", initialMessage: "Show the task system.", modelSelection }),
    });
    const oldThread = await createThread(before.session);
    const oldAccepted = await waitForAcceptedThread(before.session, oldThread.id);
    const oldPresentation = observed[0].presentation;
    expect(oldPresentation).toBeDefined();
    await before.product.close();
    await before.runtime.close();
    services.splice(services.indexOf(before.product), 1);
    services.splice(services.indexOf(before.runtime), 1);

    await writeFile(configurationPath, shipped);
    const after = await start();
    const failureEvidence = async (interaction) => {
      const target = join(dataDirectory, `failed-trace-${interaction.id}`);
      const trace = await after.runtime.exportCandidateTrace(interaction.id, target).catch((error) => ({ exportError: String(error) }));
      const receipts = await readFile(join(target, "graph-operations.jsonl"), "utf8").catch(() => "");
      return { trace, graphOperations: receipts };
    };
    const reopened = await productRequest(after.session, `/api/threads/${oldThread.id}`);
    expect(reopened.interactions[0]).toEqual(oldAccepted.interactions[0]);
    const followUp = await productRequest(after.session, `/api/threads/${oldThread.id}/interactions`, {
      method: "POST", body: JSON.stringify({ text: "Explain the next task.", modelSelection }),
    });
    const continued = await waitForAcceptedInteractions(after.session, oldThread.id, 2, failureEvidence);
    const followUpResult = continued.interactions.find(({ id }) => id === followUp.id);
    expect(followUpResult).toBeDefined();
    const source = oldAccepted.interactions[0];
    const invoke = source.completionOutput.rootLayer.actions.find(({ kind }) => kind === "invoke");
    const invoked = await productRequest(after.session, `/api/threads/${oldThread.id}/interactions/${source.id}/actions/${invoke.id}/invoke`, { method: "POST" });
    const invokedThread = await waitForAcceptedInteractions(after.session, oldThread.id, 3, failureEvidence);
    const child = invokedThread.interactions.find(({ id }) => id === invoked.invocation.resultInteractionId);
    expect(child).toBeDefined();
    for (const interaction of [followUpResult, child]) {
      const presentation = observed.find(({ graphNodeId }) => graphNodeId === interaction.graphNodeId)?.presentation;
      expect(presentation?.attachment).toMatchObject({
        versionInteractionNodeId: oldPresentation.attachment.versionInteractionNodeId,
        rootLayerId: oldPresentation.attachment.rootLayerId,
      });
      const trace = await after.runtime.exportCandidateTrace(interaction.id, join(dataDirectory, `trace-${interaction.id}`));
      expect(trace.personalPresentationVersionId).toBe(oldPresentation.attachment.versionInteractionNodeId);
      expect(trace.personalPresentationVersionKey).toBe(previousVersion);
    }
    const refreshedSource = invokedThread.interactions.find(({ id }) => id === source.id).completionOutput;
    const originalActionIds = new Set(source.completionOutput.rootLayer.actions.map(({ id }) => id));
    expect({ ...refreshedSource, rootLayer: { ...refreshedSource.rootLayer,
      actions: refreshedSource.rootLayer.actions.filter(({ id }) => originalActionIds.has(id)),
    } }).toEqual(source.completionOutput);
    expect(refreshedSource.rootLayer.actions.filter(({ id }) => !originalActionIds.has(id))).toEqual([
      expect.objectContaining({ kind: "navigate", relation: "reference", sourceNodeId: invoke.sourceNodeId,
        targetLayerId: child.completionOutput.rootLayer.layer.id, state: "accepted" }),
    ]);
    expect(invokedThread.actionInvocations).toContainEqual(expect.objectContaining({
      durable: true, reusable: false, sourceInteractionId: source.id, actionId: invoke.id,
      resultInteractionId: child.id, resultCompletionStatus: "accepted",
    }));
    expect(child.completionOutput.rootLayer.layer.id).not.toBe(source.completionOutput.rootLayer.layer.id);
    const newThread = await createThread(after.session);
    const newAccepted = await waitForAcceptedThread(after.session, newThread.id);
    const newPresentation = observed.find(({ graphNodeId }) => graphNodeId === newAccepted.interactions[0].graphNodeId).presentation;
    expect(newPresentation.attachment.versionInteractionNodeId).not.toBe(oldPresentation.attachment.versionInteractionNodeId);
    const titles = (presentation) => presentation.graph.layers.flatMap(({ nodes }) => nodes.map(({ title }) => title));
    expect(titles(oldPresentation)).not.toContain("Explanatory presentation");
    expect(titles(newPresentation)).toContain("Authored visual Node Details");
    expect(titles(newPresentation)).toContain("Explanatory presentation");
    const newTrace = await after.runtime.exportCandidateTrace(newAccepted.interactions[0].id, join(dataDirectory, "new-trace"));
    expect(newTrace.personalPresentationVersionKey).toBe("personal-presentation-v4");
  }, 20_000);

  it("submits on Enter and accepts a graph through the zero-inference fixture harness", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-first-message-test-"));
    directories.push(dataDirectory);
    const configurationPath = join(dataDirectory, "fixture-task-system.yaml");
    const fixtureConfiguration = await readFile(
      join(repositoryRoot, "harnesses", "fixture-task-system.yaml"),
      "utf8",
    );
    await writeFile(configurationPath, fixtureConfiguration);
    const alternateConfigurationPath = join(repositoryRoot, "harnesses", "codex-basic-high.yaml");
    let providerLeaseAcquisitions = 0;
    let providerLeaseReleases = 0;
    const runtime = new GraphCompleteRuntimeService({
      userDataDirectory: dataDirectory,
      graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
      configurationPaths: [configurationPath, alternateConfigurationPath],
      additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory },
      acquireProviderExecution: async (providerId) => {
        providerLeaseAcquisitions += 1;
        return {
          definition: {
            id: providerId,
            adapterId: "codex-subscription",
            accessContract: "managed-runtime@1",
          },
          descriptor: {
            adapterId: "codex-subscription",
            accessContract: "managed-runtime@1",
            implementationVersion: "1",
          },
          runtime: {
            async executionAccess() {
              return { kind: "managed-runtime", environment: {} };
            },
          },
          async release() {
            providerLeaseReleases += 1;
          },
        };
      },
    });
    services.push(runtime);
    const runtimeSession = await runtime.start();
    const product = new RelayerAppServerService({
      userDataDirectory: dataDirectory,
      binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
      webDirectory: join(repositoryRoot, "desktop", "renderer"),
      permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
      runtimeSession,
      defaultHarnessConfiguration: "fixture-task-system",
    });
    services.push(product);
    const productSession = await product.start();
    await product.seedProviderCatalog(fixtureCatalogSnapshot());
    const fixtureFamily = await productRequest(productSession, "/api/model-families", {
      method: "POST",
      body: JSON.stringify({
        name: "Fixture models",
        enabled: true,
        members: [{ providerId: "codex", modelId: "fixture-model" }],
      }),
    });
    const modelSettings = await productRequest(productSession, "/api/model-settings");
    expect(modelSettings.harnesses.map(({ id }) => id)).toEqual([
      "codex-basic",
      "codex-basic-high",
      "fixture-task-system",
    ]);
    expect(modelSettings.families).toEqual([
      expect.objectContaining({
        kind: "system",
        name: "Codex defaults",
        managedPolicy: expect.objectContaining({ providerId: "codex", policyId: "codex-default-family" }),
      }),
      expect.objectContaining({ id: fixtureFamily.id, kind: "custom", name: "Fixture models" }),
    ]);
    expect(modelSettings.harnesses.find(({ id }) => id === "codex-basic").available).toBe(false);
    expect(modelSettings.harnesses.filter(({ available }) => available).map(({ id }) => id)).toEqual([
      "codex-basic-high",
      "fixture-task-system",
    ]);
    expect(modelSettings.harnesses.find(({ id }) => id === "fixture-task-system").modelCompatibility).toEqual([
      { providerId: "codex" },
    ]);
    const modelSelection = {
      familyId: fixtureFamily.id,
      providerId: "codex",
      modelId: "fixture-model",
    };

    const createdThreads = [];
    let sendCompletion;
    const send = {
      click: vi.fn(() => {
        sendCompletion = productRequest(productSession, "/api/threads", {
          method: "POST",
          body: JSON.stringify({
            title: "Zero-inference Enter test",
            initialMessage: "Show the deterministic task system.",
            harnessId: "fixture-task-system",
            modelSelection,
          }),
        }).then((response) => createdThreads.push(response.id));
        return sendCompletion;
      }),
    };
    const prompt = {};
    bindComposerKeydown(prompt, () => void send.click());

    const shiftedEnter = { key: "Enter", shiftKey: true, preventDefault: vi.fn() };
    prompt.onkeydown(shiftedEnter);
    expect(shiftedEnter.preventDefault).not.toHaveBeenCalled();
    expect(send.click).not.toHaveBeenCalled();

    const plainEnter = { key: "Enter", preventDefault: vi.fn() };
    prompt.onkeydown(plainEnter);
    expect(plainEnter.preventDefault).toHaveBeenCalledOnce();
    expect(send.click).toHaveBeenCalledOnce();

    await sendCompletion;
    expect(createdThreads).toHaveLength(1);
    const detail = await waitForAcceptedThread(productSession, createdThreads[0]);
    expect(detail.interactions).toHaveLength(1);
    expect(detail.interactions[0].completionStatus).toBe("accepted");
    expect(detail.interactions[0].completionOutput.rootLayer.nodes.map((node) => node.title)).toEqual([
      "Incoming queue",
      "Two-worker pool",
      "Results store",
    ]);
    expect(providerLeaseAcquisitions).toBe(1);
    expect(providerLeaseReleases).toBe(1);
    const source = detail.interactions[0];
    const invoke = source.completionOutput.rootLayer.actions.find((action) => action.kind === "invoke");
    expect(invoke).toMatchObject({
      targetLayerId: null,
      label: "Plan the next improvement",
      interactionText: "Propose the most useful next improvement to this task system.",
    });

    const invocationPath = `/api/threads/${createdThreads[0]}/interactions/${source.id}/actions/${invoke.id}/invoke`;
    const callHeaders = { "Idempotency-Key": "first-message-invoke" };
    const invoked = await productRequest(productSession, invocationPath, { method: "POST", headers: callHeaders });
    expect(invoked).toMatchObject({
      invocation: {
        sourceInteractionId: source.id,
        actionId: invoke.id,
      },
      interaction: {
        completionStatus: "running",
      },
    });

    const completed = await waitForAcceptedInteractions(productSession, createdThreads[0], 2);
    const result = completed.interactions.find((interaction) => interaction.id === invoked.invocation.resultInteractionId);
    expect(result).toMatchObject({
      text: "Propose the most useful next improvement to this task system.",
      completionStatus: "accepted",
    });
    expect(result.completionOutput.rootLayer.nodes.map((node) => node.title)).toEqual([
      "Incoming queue",
      "Two-worker pool",
      "Results store",
    ]);
    const refreshedInvoke = completed.interactions[0].completionOutput.rootLayer.actions
      .find((action) => action.id === invoke.id);
    expect(refreshedInvoke).toEqual(invoke);
    expect(completed.actionInvocations).toContainEqual(expect.objectContaining({
      durable: true, reusable: false, invocationKey: "first-message-invoke", sourceInteractionId: source.id,
      actionId: invoke.id, resultInteractionId: result.id, resultCompletionStatus: "accepted",
    }));

    const replay = await productRequest(productSession, invocationPath, { method: "POST", headers: callHeaders });
    expect(replay.invocation.resultInteractionId).toBe(result.id);
    expect((await productRequest(productSession, `/api/threads/${createdThreads[0]}`)).interactions).toHaveLength(2);
  }, 15_000);
});

function fixtureCatalogSnapshot() {
  return {
    providerId: "codex",
    label: "Codex",
    connected: true,
    models: [{
      id: "fixture-model",
      label: "Fixture model",
      order: 0,
      visible: true,
      available: true,
      providerDefault: true,
      metadata: {},
    }],
    systemFamily: { key: "codex", name: "Codex", modelIds: ["fixture-model"] },
  };
}

async function waitForAcceptedThread(session, threadId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const detail = await productRequest(session, `/api/threads/${threadId}`);
    if (detail.interactions[0]?.completionStatus === "accepted") return detail;
    if (detail.interactions[0]?.completionStatus === "failed") {
      throw new Error(`The zero-inference first-message thread failed: ${JSON.stringify(detail.interactions[0])}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("The zero-inference first-message thread did not complete in time.");
}

async function waitForAcceptedInteractions(session, threadId, count, failureEvidence = async () => null) {
  const deadline = Date.now() + 10_000;
  let latest;
  while (Date.now() < deadline) {
    const detail = await productRequest(session, `/api/threads/${threadId}`);
    latest = detail;
    const failed = detail.interactions.find((interaction) => interaction.completionStatus === "failed"
      || (interaction.latestAttempt?.finishedAt && interaction.latestAttempt.outcome !== "accepted"));
    if (failed) throw new Error(`The zero-inference interaction failed: ${JSON.stringify({ interaction: failed, evidence: await failureEvidence(failed) })}`);
    if (detail.interactions.length === count && detail.interactions.every((interaction) => interaction.completionStatus === "accepted")) {
      return detail;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`The zero-inference interaction did not complete in time: ${JSON.stringify(latest?.interactions.map(({ completionOutput, ...rest }) => rest))}`);
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
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}
