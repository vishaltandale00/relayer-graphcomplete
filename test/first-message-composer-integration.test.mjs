import { mkdtemp, rm } from "node:fs/promises";
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
  it("submits on Enter and accepts a graph through the zero-inference fixture harness", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-first-message-test-"));
    directories.push(dataDirectory);
    const configurationPath = join(repositoryRoot, "harnesses", "fixture-task-system.yaml");
    const runtime = new GraphCompleteRuntimeService({
      userDataDirectory: dataDirectory,
      graphServerBinary: join(repositoryRoot, "target", "debug", "relayer-graph-server"),
      configurationPaths: [configurationPath],
      additionalImplementations: { "fixture.task-system": taskSystemFixtureFactory },
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

    const createdThreads = [];
    const send = {
      click: vi.fn(async () => {
        const response = await productRequest(productSession, "/api/threads", {
          method: "POST",
          body: JSON.stringify({
            title: "Zero-inference Enter test",
            initialMessage: "Show the deterministic task system.",
          }),
        });
        createdThreads.push(response.id);
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

    await vi.waitFor(() => expect(createdThreads).toHaveLength(1));
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

async function waitForAcceptedThread(session, threadId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const detail = await productRequest(session, `/api/threads/${threadId}`);
    if (detail.interactions[0]?.completionStatus === "accepted") return detail;
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
