import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHarnessHost, type RunningHarnessHost } from "../src/host.js";
import type { DraftPreviewRenderer, HarnessConfiguration, HarnessRunContext } from "../src/types.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PREVIEW_TOKEN = "p".repeat(32);
const configuration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "test-default",
  implementation: "test",
  implementationVersion: 1,
  permissionBindings: { ask: {}, auto: {}, full: {} },
  settings: {},
};
const previewConfiguration: HarnessConfiguration = {
  ...configuration,
  name: "test-preview",
  graphCapabilityProfile: { search: "disabled", preview: "enabled" },
};
const graph = { url: "http://127.0.0.1:43123", token: "token", nodeId: 1 };
const realFetch = globalThis.fetch;
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Fakes the graph server for the host's own reads; host routes use real HTTP. */
function stubGraphServer(host: () => string | undefined, acceptOnInput = true): void {
  let accepted = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const hostUrl = host();
    if (hostUrl !== undefined && url.startsWith(hostUrl)) return realFetch(url, init);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/output")) {
      return accepted
        ? json({ nodeId: 1, rootAction: null, rootLayer: { layer: { id: 3, nodes: [], edges: [], state: "accepted" }, nodes: [], edges: [], actions: [] } })
        : json({ error: { code: "completion_not_found" } }, 404);
    }
    if (url.endsWith("/api/graph/input")) accepted = acceptOnInput;
    return json(url.endsWith("/api/graph/input")
      ? { interaction: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" }, contexts: [] }
      : { node: { id: 1, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } });
  }));
}

async function startHost(
  harnessConfiguration: HarnessConfiguration,
  renderer: DraftPreviewRenderer | undefined,
  complete: (context: HarnessRunContext, running: RunningHarnessHost, signal: AbortSignal | undefined) => Promise<void>,
  acceptOnInput = true,
): Promise<{ running: RunningHarnessHost; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "relayer-draft-preview-"));
  let running: RunningHarnessHost | undefined;
  stubGraphServer(() => running?.url, acceptOnInput);
  running = await startHarnessHost({
    stateFile: join(directory, "sessions.json"),
    controlToken: "control",
    trace: {
      directory: join(directory, "traces"),
      policy: { mode: "required", requiredFeatures: {}, includeNativeArtifacts: false, maxBytesPerTurn: 100_000, maxEventsPerTurn: 100 },
    },
    ...(renderer === undefined ? {} : { draftPreviews: { token: PREVIEW_TOKEN, renderer } }),
    implementations: { test: () => ({ complete: (context, signal) => complete(context, running!, signal), state: () => ({}) }) },
  });
  const started = running;
  cleanup.push(async () => {
    await started.close();
    await rm(directory, { recursive: true, force: true });
  });
  await running.host.createSession({ threadId: 1, permissionProfileId: "auto", configuration: harnessConfiguration, workingDirectory: directory });
  return { running, directory };
}

function renderRequest(url: string, token: string): Promise<Response> {
  return fetch(`${url}/draft-previews/render`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ version: 1, interactionNodeId: 1, fingerprint: "sha256:abc", snapshot: { version: 1, target: { kind: "layer", layerId: 3 } } }),
  });
}

describe("draft preview render bridge", () => {
  it("renders for the graph server inside a transient folder and traces metadata only", async () => {
    const renderer = { render: vi.fn(async () => ({ png: PNG, width: 1176, height: 812 })) };
    let folder: string | undefined;
    let folderExisted = false;
    let programFolder: string | undefined;
    let programFolderExisted = false;
    let unauthorized = 0;
    let rendered: unknown;
    const { running, directory } = await startHost(previewConfiguration, renderer, async (context, host) => {
      folder = context.graph.acquireCapability().previewDirectory;
      folderExisted = folder !== undefined && (await stat(folder)).isDirectory();
      // The host creates the program parent before invoking the harness.
      programFolder = context.graph.acquireCapability().programDirectory;
      programFolderExisted = programFolder !== undefined && await stat(programFolder).then((info) => info.isDirectory(), () => false);
      unauthorized = (await renderRequest(host.url, "wrong")).status;
      rendered = await (await renderRequest(host.url, PREVIEW_TOKEN)).json();
    });

    await running.host.complete(1, 1, graph, undefined, undefined, { productInteractionId: 31 });

    expect(folderExisted).toBe(true);
    expect(unauthorized).toBe(401);
    expect(rendered).toEqual({ result: { pngBase64: Buffer.from(PNG).toString("base64"), width: 1176, height: 812 } });
    // The thread folder rides along so an artifact layer can render its files (PRD 6.6).
    expect(renderer.render).toHaveBeenCalledWith({
      interactionNodeId: 1, fingerprint: "sha256:abc", snapshot: { version: 1, target: { kind: "layer", layerId: 3 } }, workingDirectory: directory,
    });
    await expect(stat(folder!)).rejects.toThrow();
    expect(programFolderExisted).toBe(true);
    expect(programFolder).toContain("relayer-graph-programs-");
    await expect(stat(programFolder!)).rejects.toThrow();
    const exported = join(directory, "exported");
    await running.host.exportCandidateTrace(31, exported, {
      runId: "run", executionId: "execution", interactionId: "31", harnessConfigurationName: "test-preview",
    });
    const events = await readFile(join(exported, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"graph.preview"');
    expect(events).toContain('"outcome":"rendered"');
    expect(events).not.toContain(Buffer.from(PNG).toString("base64"));
  });

  it.each(["success", "failure", "cancel"] as const)("removes saved programs after %s settles", async (outcome) => {
    let programFolder!: string;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const { running } = await startHost(configuration, undefined, async (context, _host, signal) => {
      programFolder = context.graph.acquireCapability().programDirectory!;
      await mkdir(join(programFolder, "programs"), { recursive: true });
      await writeFile(join(programFolder, "programs", "saved.mjs"), "// saved graph program");
      if (outcome === "cancel") {
        if (signal === undefined) throw new Error("cancellation signal missing");
        const waiting = new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        started();
        await waiting;
      }
      started();
      if (outcome === "failure") throw new Error("failed after saving");
    }, outcome === "success");
    const completing = running.host.complete(1, 1, graph);
    if (outcome === "cancel") {
      await ready;
      expect(await readFile(join(programFolder, "programs", "saved.mjs"), "utf8")).toContain("saved graph program");
      expect(running.host.cancel(1, 1)).toBe(true);
    }
    if (outcome === "success") await completing;
    else await expect(completing).rejects.toThrow(outcome === "cancel" ? "cancelled" : "failed after saving");
    await expect(stat(programFolder)).rejects.toThrow();
  });

  it.each([
    ["the configuration declares no preview support", configuration, true],
    ["the host has no renderer", previewConfiguration, false],
  ] as const)("grants no preview folder when %s", async (_case, harnessConfiguration, withRenderer) => {
    let folder: string | undefined = "unset";
    let programFolder: string | undefined;
    const renderer = { render: vi.fn(async () => ({ png: PNG, width: 1, height: 1 })) };
    const { running } = await startHost(harnessConfiguration, withRenderer ? renderer : undefined, async (context) => {
      folder = context.graph.acquireCapability().previewDirectory;
      programFolder = context.graph.acquireCapability().programDirectory;
    });

    await running.host.complete(1, 1, graph, undefined, undefined, { productInteractionId: 32 });

    expect(folder).toBeUndefined();
    // Program edits do not depend on previews; every run gets a path the client may create.
    expect(programFolder).toContain("relayer-graph-programs-");
  });
});
