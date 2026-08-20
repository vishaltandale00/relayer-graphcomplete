import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { taskSystemFixtureFactory } from "@relayer/eval-runner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startModelCatalogRefreshServer } from "../desktop/main/models/model-catalog-refresh-server.mjs";
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
  it("submits on Enter and accepts a graph through the zero-inference fixture harness", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-first-message-test-"));
    directories.push(dataDirectory);
    const configurationPath = join(repositoryRoot, "harnesses", "fixture-task-system.yaml");
    const alternateConfigurationPath = join(repositoryRoot, "harnesses", "codex-basic-high.yaml");
    const runtime = new GraphCompleteRuntimeService({
      userDataDirectory: dataDirectory,
      graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
      configurationPaths: [configurationPath, alternateConfigurationPath],
      additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory },
    });
    services.push(runtime);
    const runtimeSession = await runtime.start();
    let product;
    const modelCatalogRefreshServer = await startModelCatalogRefreshServer({
      refresh: () => product.publishProviderCatalog(fixtureCatalogSnapshot()),
    });
    services.push(modelCatalogRefreshServer);
    product = new RelayerAppServerService({
      userDataDirectory: dataDirectory,
      binaryPath: join(repositoryRoot, "target", "debug", "relayer-app-server"),
      webDirectory: join(repositoryRoot, "desktop", "renderer"),
      permissionCatalogPath: join(repositoryRoot, "permissions", "desktop.json"),
      runtimeSession,
      providerCatalogRefreshSession: modelCatalogRefreshServer.session,
      defaultHarnessConfiguration: "fixture-task-system",
    });
    services.push(product);
    const productSession = await product.start();
    await product.publishProviderCatalog(fixtureCatalogSnapshot());
    const modelSettings = await productRequest(productSession, "/api/model-settings");
    expect(modelSettings.harnesses.map(({ id }) => id)).toEqual([
      "codex-basic",
      "codex-basic-high",
      "fixture-task-system",
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
      familyId: modelSettings.families[0].id,
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
