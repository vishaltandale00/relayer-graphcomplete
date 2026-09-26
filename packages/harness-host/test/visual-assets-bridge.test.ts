import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileVisualAssetsLibrary } from "@relayer/visual-assets";
import { HarnessHost, startHarnessHost } from "../src/host.js";
import type { HarnessConfiguration } from "../src/types.js";

const directories: string[] = [];
const configuration: HarnessConfiguration = {
  schemaVersion: 1,
  name: "visual-assets-test",
  implementation: "test",
  implementationVersion: 1,
  permissionBindings: { auto: {} },
  settings: {},
};
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#fff"/></svg>';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("visual asset host bridge", () => {
  it("binds completion operations to the active interaction and its server-derived scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-bridge-"));
    directories.push(directory);
    const library = await createFileVisualAssetsLibrary({
      authority: { projects: [{ projectId: 1, threadIds: [1] }, { projectId: 2, threadIds: [2] }], standaloneThreadIds: [] },
      initialAssets: [
        { id: "allowed", registryId: "user", name: "Allowed", fileName: "allowed.svg", mediaType: "image/svg+xml", content: svg, scopes: [{ kind: "project", projectId: 1 }], tagIds: [] },
        { id: "foreign", registryId: "user", name: "Foreign", fileName: "foreign.svg", mediaType: "image/svg+xml", content: svg, scopes: [{ kind: "project", projectId: 2 }], tagIds: [] },
      ],
    }, join(directory, "catalog.json"));
    let releaseAssetMutation!: () => void;
    let assetMutationEntered!: () => void;
    const assetMutationBlocked = new Promise<void>((resolve) => { releaseAssetMutation = resolve; });
    const assetMutationStarted = new Promise<void>((resolve) => { assetMutationEntered = resolve; });
    const durableAdd = library.add.bind(library);
    const guardedLibrary = {
      ...library,
      async add(input: Parameters<typeof library.add>[0], isCurrent?: () => boolean) {
        const read = input.file.read.bind(input.file);
        return durableAdd({
          ...input,
          file: {
            name: input.file.name,
            mediaType: input.file.mediaType,
            ...(input.file.expectedDigest === undefined ? {} : { expectedDigest: input.file.expectedDigest }),
            async read() {
              assetMutationEntered();
              await assetMutationBlocked;
              return read();
            },
          },
        }, isCurrent);
      },
    };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"),
      controlToken: "control",
      visualAssets: { token: "bridge-secret", generation: 7, library: guardedLibrary },
      implementations: { test: () => ({ async complete() { await blocked; }, state: () => ({}) }) },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/output")) return new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
      if (url.endsWith("/personal-presentation")) return new Response(JSON.stringify({ error: { code: "personal_presentation_not_attached" } }), { status: 404, headers: { "content-type": "application/json" } });
      if (url.endsWith("/input")) return new Response(JSON.stringify({ interaction: { id: 9, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" }, contexts: [] }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ node: { id: 9, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await host.initialize();
    await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration, workingDirectory: directory });
    const completing = host.complete(1, 1, { url: "http://127.0.0.1:43123", token: "graph-token", nodeId: 9 });
    await vi.waitFor(async () => {
      await expect(host.visualAssetOperation({
        version: 1,
        generation: 7,
        assetGeneration: 1,
        authority: { kind: "completion", interactionNodeId: 9, scope: { kind: "project", projectId: 1, threadId: 1 } },
        operation: { kind: "resolve", scope: { kind: "project", projectId: 1 }, logicalIds: ["allowed"] },
      })).resolves.toMatchObject({ assets: [{ logicalId: "allowed", availability: "available", mediaType: "image/svg+xml" }] });
    });
    await expect(host.visualAssetOperation({
      version: 1,
      generation: 7,
      assetGeneration: 1,
      authority: { kind: "completion", interactionNodeId: 9, scope: { kind: "project", projectId: 1, threadId: 1 } },
      operation: { kind: "inspect", scope: { kind: "project", projectId: 1 }, assetId: "foreign" },
    })).rejects.toMatchObject({ code: "asset_not_authorized" });
    await expect(host.visualAssetOperation({
      version: 1,
      generation: 7,
      assetGeneration: 1,
      authority: { kind: "completion", interactionNodeId: 9, scope: { kind: "project", projectId: 1, threadId: 2 } },
      operation: { kind: "list-assets", scope: { kind: "project", projectId: 1 } },
    })).rejects.toMatchObject({ code: "completion_inactive" });
    await expect(host.visualAssetOperation({
      version: 1,
      generation: 7,
      assetGeneration: 1,
      authority: { kind: "completion", interactionNodeId: 9, scope: { kind: "project", projectId: 1, threadId: 1 } },
      operation: { kind: "add", scope: { kind: "library" } },
    })).rejects.toMatchObject({ code: "scope_read_only" });
    const racedMutation = host.visualAssetOperation({
      version: 1,
      generation: 7,
      assetGeneration: 1,
      authority: { kind: "completion", interactionNodeId: 9, scope: { kind: "project", projectId: 1, threadId: 1 } },
      operation: {
        kind: "add", scope: { kind: "project", projectId: 1 }, name: "Cancelled", tagIds: [],
        file: { name: "cancelled.svg", mediaType: "image/svg+xml", contentBase64: Buffer.from(svg).toString("base64") },
      },
    });
    await assetMutationStarted;
    let revokeSettled = false;
    const revoking = host.visualAssetOperation({
      version: 1,
      generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "pause", expectedGeneration: 1, barrierId: "barrier-1" },
    }).finally(() => { revokeSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(revokeSettled).toBe(false);
    releaseAssetMutation();
    await expect(racedMutation).rejects.toMatchObject({ code: "completion_inactive" });
    await expect(revoking).resolves.toEqual({ paused: true, assetGeneration: 2 });
    const afterCancellation = await library.listAssets({ scope: { kind: "project", projectId: 1 }, limit: 100 });
    expect(afterCancellation.items.map((asset) => asset.name)).not.toContain("Cancelled");
    await expect(host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "resume", assetGeneration: 2, barrierId: "barrier-1" },
    })).resolves.toEqual({ resumed: true, assetGeneration: 2 });
    await expect(host.visualAssetOperation({ version: 1, generation: 7, assetGeneration: 1,
      authority: { kind: "completion", interactionNodeId: 9, scope: { kind: "project", projectId: 1, threadId: 1 } },
      operation: { kind: "list-assets", scope: { kind: "project", projectId: 1 } },
    })).rejects.toMatchObject({ code: "visual_assets_generation_stale" });
    await expect(host.visualAssetOperation({ version: 1, generation: 7, assetGeneration: 2,
      authority: { kind: "completion", interactionNodeId: 9, scope: { kind: "project", projectId: 1, threadId: 1 } },
      operation: { kind: "list-assets", scope: { kind: "project", projectId: 1 } },
    })).resolves.toMatchObject({ items: [{ id: "allowed" }] });
    await expect(host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "pause", expectedGeneration: 2, barrierId: "lost-pause-ack" },
    })).resolves.toEqual({ paused: true, assetGeneration: 3 });
    await expect(host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "pause", expectedGeneration: 2, barrierId: "explicit-revoke-takeover", revocationTakeover: true },
    })).resolves.toEqual({ paused: true, assetGeneration: 3 });
    await expect(host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "resume", assetGeneration: 3, barrierId: "explicit-revoke-takeover" },
    })).resolves.toEqual({ resumed: true, assetGeneration: 3 });
    await expect(host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "pause", expectedGeneration: 3, barrierId: "finalize-not-delivered" },
    })).resolves.toEqual({ paused: true, assetGeneration: 4 });
    await expect(host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "pause", expectedGeneration: 4, barrierId: "explicit-revoke-after-finalize-loss", revocationTakeover: true },
    })).resolves.toEqual({ paused: true, assetGeneration: 4 });
    await expect(host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "resume", assetGeneration: 4, barrierId: "finalize-not-delivered" },
    })).rejects.toMatchObject({ code: "visual_assets_barrier_stale" });
    await expect(host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "resume", assetGeneration: 4, barrierId: "explicit-revoke-after-finalize-loss" },
    })).resolves.toEqual({ resumed: true, assetGeneration: 4 });
    // Retrying graph execution for this same node must reactivate assets with a
    // fresh generation, never revive requests issued by the earlier capability.
    await host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "pause", expectedGeneration: 4, barrierId: "retry-revoke" },
    });
    await host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "finalize-revoke", assetGeneration: 5, barrierId: "retry-revoke" },
    });
    const activate = (completionEpoch: number) => host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "activate", completionEpoch },
    });
    await expect(activate(10)).resolves.toEqual({ activated: true, assetGeneration: 6 });
    await expect(activate(10)).resolves.toEqual({ activated: true, assetGeneration: 6 });
    await expect(activate(9)).rejects.toMatchObject({ code: "visual_assets_generation_stale" });
    const listWithGeneration = (assetGeneration: number) => host.visualAssetOperation({ version: 1, generation: 7, assetGeneration,
      authority: { kind: "completion", interactionNodeId: 9, scope: { kind: "project", projectId: 1, threadId: 1 } },
      operation: { kind: "list-assets", scope: { kind: "project", projectId: 1 } },
    });
    await expect(listWithGeneration(4)).rejects.toMatchObject({ code: "visual_assets_generation_stale" });
    await expect(listWithGeneration(6)).resolves.toMatchObject({ items: [{ id: "allowed" }] });
    await host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "pause", expectedGeneration: 6, barrierId: "retry-revoke-again" },
    });
    await host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "finalize-revoke", assetGeneration: 7, barrierId: "retry-revoke-again" },
    });
    await expect(activate(10)).rejects.toMatchObject({ code: "visual_assets_generation_stale" });
    await expect(activate(11)).resolves.toEqual({ activated: true, assetGeneration: 8 });
    await expect(listWithGeneration(6)).rejects.toMatchObject({ code: "visual_assets_generation_stale" });
    await expect(listWithGeneration(8)).resolves.toMatchObject({ items: [{ id: "allowed" }] });
    release();
    await completing.catch(() => undefined);
    await expect(host.visualAssetOperation({
      version: 1,
      generation: 7,
      assetGeneration: 8,
      authority: { kind: "completion", interactionNodeId: 9, scope: { kind: "project", projectId: 1, threadId: 1 } },
      operation: { kind: "list-assets", scope: { kind: "project", projectId: 1 } },
    })).rejects.toMatchObject({ code: "completion_inactive" });
    await host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "pause", expectedGeneration: 8, barrierId: "terminal-1" },
    });
    await host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "finalize-revoke", assetGeneration: 9, barrierId: "terminal-1" },
    });
    await expect(host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "pause", expectedGeneration: 9, barrierId: "cleanup-1" },
    })).resolves.toEqual({ paused: true, assetGeneration: 9 });
    await expect(host.visualAssetOperation({ version: 1, generation: 7,
      authority: { kind: "lifecycle", interactionNodeId: 9 },
      operation: { kind: "finalize-revoke", assetGeneration: 9, barrierId: "cleanup-1" },
    })).resolves.toEqual({ revoked: true, assetGeneration: 9 });
    await host.close();
  });

  it("prepares a library-only icon without incidentally associating it to the completion scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-library-icon-"));
    directories.push(directory);
    const digest = createHash("sha256").update(svg).digest("hex");
    const library = await createFileVisualAssetsLibrary({
      authority: { projects: [{ projectId: 1, threadIds: [1] }], standaloneThreadIds: [] },
      initialAssets: [{
        id: "library-icon", registryId: "user", name: "Library icon", fileName: "icon.svg",
        mediaType: "image/svg+xml", content: svg, scopes: [{ kind: "library" }], tagIds: [],
      }],
    }, join(directory, "catalog.json"));
    let release!: () => void;
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"), controlToken: "control",
      visualAssets: { token: "bridge-secret", generation: 13, library },
      implementations: { test: () => ({ async complete() { await new Promise<void>((resolve) => { release = resolve; }); }, state: () => ({}) }) },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/output")) return new Response(JSON.stringify({ error: { code: "completion_not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
      if (url.endsWith("/personal-presentation")) return new Response(JSON.stringify({ error: { code: "personal_presentation_not_attached" } }), { status: 404, headers: { "content-type": "application/json" } });
      if (url.endsWith("/input")) return new Response(JSON.stringify({ interaction: { id: 9, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" }, contexts: [] }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ node: { id: 9, kind: "user-interaction", icon: "user", title: "Question", detail: "Question", state: "accepted" } }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await host.initialize();
    await host.createSession({ threadId: 1, permissionProfileId: "auto", configuration, workingDirectory: directory });
    const completing = host.complete(1, 1, { url: "http://127.0.0.1:43123", token: "graph-token", nodeId: 9 });
    const content = {
      version: 1, components: [], mounts: [],
      assets: [{ id: "library-icon", digestSha256: digest, mediaType: "image/svg+xml", representation: "image" }],
    };
    const package_ = { ...content, integritySha256: createHash("sha256").update(canonicalJson(content)).digest("hex") };
    await vi.waitFor(async () => {
      await expect(host.visualAssetOperation({
        version: 1, generation: 13,
        assetGeneration: 1,
        authority: { kind: "completion", interactionNodeId: 9, scope: { kind: "project", projectId: 1, threadId: 1 } },
        operation: { kind: "prepare-detail", scope: { kind: "project", projectId: 1 }, package: package_ },
      })).resolves.toMatchObject({ detail: { assets: [{ assetId: "library-icon", digestSha256: digest }] } });
    });
    expect((await library.inspect("library-icon")).asset.scopes).toEqual([{ kind: "library" }]);
    release();
    await completing.catch(() => undefined);
    await host.close();
  });

  it("allows only isolated import validation under control authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-control-"));
    directories.push(directory);
    const library = await createFileVisualAssetsLibrary({ authority: { projects: [], standaloneThreadIds: [] } }, join(directory, "catalog.json"));
    const host = new HarnessHost({
      stateFile: join(directory, "sessions.json"), controlToken: "control", implementations: {},
      visualAssets: { token: "bridge-secret", generation: 3, library },
    });
    await host.initialize();
    await expect(host.visualAssetOperation({
      version: 1,
      generation: 3,
      authority: { kind: "control", scope: { kind: "thread", threadId: 4 } },
      operation: { kind: "validate-import", archive: { version: 1, details: [], contents: [] } },
    })).resolves.toEqual({ details: [] });
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'><rect width='1' height='1'/></svg>");
    await expect(host.visualAssetOperation({
      version: 1,
      generation: 3,
      authority: { kind: "control", scope: { kind: "thread", threadId: 4 } },
      operation: { kind: "validate-import-content", content: {
        digestSha256: createHash("sha256").update(svg).digest("hex"),
        mediaType: "image/svg+xml",
        byteLength: svg.length,
        contentBase64: svg.toString("base64"),
      } },
    })).resolves.toEqual({ valid: true });
    await expect(host.visualAssetOperation({
      version: 1,
      generation: 3,
      authority: { kind: "control", scope: { kind: "thread", threadId: 4 } },
      operation: { kind: "list-assets" },
    })).rejects.toMatchObject({ code: "visual_assets_control_operation_invalid" });
    await host.close();
  });

  it("keeps the private route behind its distinct bearer and structured envelope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-visual-route-"));
    directories.push(directory);
    const library = await createFileVisualAssetsLibrary(
      { authority: { projects: [], standaloneThreadIds: [] } },
      join(directory, "catalog.json"),
    );
    const running = await startHarnessHost({
      stateFile: join(directory, "sessions.json"), controlToken: "host-control", implementations: {},
      visualAssets: { token: "private-visual-token", generation: 11, library },
    });
    try {
      const body = JSON.stringify({
        version: 1,
        generation: 11,
        authority: { kind: "control", scope: { kind: "thread", threadId: 8 } },
        operation: { kind: "validate-import", archive: { version: 1, details: [], contents: [] } },
      });
      const unauthorized = await fetch(`${running.url}/visual-assets/operations`, {
        method: "POST", headers: { Authorization: "Bearer host-control", "Content-Type": "application/json" }, body,
      });
      expect(unauthorized.status).toBe(401);
      await expect(unauthorized.json()).resolves.toEqual({
        error: { code: "unauthorized", message: "Visual asset bridge authorization failed" },
      });
      const accepted = await fetch(`${running.url}/visual-assets/operations`, {
        method: "POST", headers: { Authorization: "Bearer private-visual-token", "Content-Type": "application/json" }, body,
      });
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toEqual({ result: { details: [] } });
    } finally {
      await running.close();
    }
  });
});
