import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EvalService, stageBoundedSource } from "../desktop/eval-main/eval-service.mjs";

const source = new TextEncoder().encode('{"recordType":"header"}\n{"recordType":"turn"}\n');
const receipt = {
  importId: "portable-1",
  sourceSha256: "sha256:abc",
  threadId: 41,
  title: "Imported debugging run",
  producer: { desktopVersion: "1", buildCommit: "abc", platform: "darwin", architecture: "arm64" },
  turns: [{ sourceTurnId: "turn-1", interactionId: 51, graphNodeId: 61, completionStatus: "accepted" }],
};

function response(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installBackend({
  published = [],
  beforePublish = async () => {},
  publishStatus = 200,
  rejectPublish = false,
  rejectGet = false,
  deleteStatus = 200,
  publishedAfterDeleteFailure = null,
} = {}) {
  const calls = [];
  let currentPublished = published;
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const method = options.method || "GET";
    const call = { method, url: String(url), body: options.body, streamedBytes: null };
    calls.push(call);
    if (method === "POST") {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      call.streamedBytes = Buffer.concat(chunks);
      return response(200, receipt);
    }
    if (method === "PUT") {
      await beforePublish();
      if (rejectPublish) throw new Error("publication connection lost");
      return response(publishStatus, publishStatus === 200 ? { published: true } : { error: "publish failed" });
    }
    if (method === "DELETE") {
      if (deleteStatus !== 200) {
        if (publishedAfterDeleteFailure) currentPublished = publishedAfterDeleteFailure;
        return response(deleteStatus, { error: "cleanup failed" });
      }
      return response(200, { removed: true });
    }
    if (method === "GET") {
      if (rejectGet) throw new Error("reconciliation connection lost");
      return response(200, { imports: currentPublished });
    }
    return response(405, { error: "unexpected request" });
  }));
  return calls;
}

async function inputFile(root, bytes = source) {
  const path = join(root, "input.jsonl");
  await writeFile(path, bytes);
  return path;
}

function service(stateFile) {
  return new EvalService({
    stateFile,
    productSession: { origin: "http://127.0.0.1:3210", cookie: { name: "write", value: "secret" } },
    configurationPaths: [],
    conversationImportEnabled: true,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Eval conversation import publication", () => {
  it("persists the exact source and immutable bundle before backend publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-eval-import-"));
    try {
      const stateFile = join(root, "state.json");
      const sourceFile = join(root, `runs/import-${receipt.importId}/conversation.jsonl`);
      const bundleFile = join(root, `runs/import-${receipt.importId}/bundle.json`);
      const calls = installBackend({
        beforePublish: async () => {
          expect(new Uint8Array(await readFile(sourceFile))).toEqual(source);
          expect(JSON.parse(await readFile(bundleFile, "utf8")).testRunId).toBe(`import-${receipt.importId}`);
        },
      });
      const run = await service(stateFile).importConversation(await inputFile(root));
      expect(calls.map((call) => call.method)).toEqual(["POST", "PUT"]);
      expect(calls[0].body).not.toBeInstanceOf(Uint8Array);
      expect(new Uint8Array(calls[0].streamedBytes)).toEqual(source);
      expect(new Uint8Array(await readFile(join(root, run.sourceRef)))).toEqual(source);
      const bundle = JSON.parse(await readFile(join(root, run.bundleRef), "utf8"));
      expect(bundle.testRunId).toBe(run.id);
      expect(bundle.run.sourceRef).toBe(run.sourceRef);
      expect(JSON.parse(await readFile(stateFile, "utf8")).runs[0].importId).toBe(receipt.importId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compensates staged backend state when source or bundle persistence fails", async () => {
    for (const failure of ["source", "bundle"]) {
      const root = await mkdtemp(join(tmpdir(), `relayer-eval-${failure}-`));
      try {
        const runDirectory = join(root, `runs/import-${receipt.importId}`);
        await mkdir(runDirectory, { recursive: true });
        if (failure === "source") {
          await writeFile(join(runDirectory, "conversation.jsonl"), "conflict");
        } else {
          await writeFile(join(runDirectory, "bundle.json"), "not a bundle");
        }
        const calls = installBackend();
        await expect(service(join(root, "state.json")).importConversation(await inputFile(root))).rejects.toThrow();
        expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("reconciles a published import after local state publication fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-eval-state-failure-"));
    try {
      const invalidStateFile = join(root, "state-directory");
      await mkdir(invalidStateFile);
      const calls = installBackend();
      await expect(service(invalidStateFile).importConversation(await inputFile(root))).rejects.toThrow();
      expect(calls.map((call) => call.method)).toEqual(["POST", "PUT"]);

      installBackend({
        published: [{
          ...receipt,
          header: { conversation: { title: receipt.title }, producer: receipt.producer },
          turns: receipt.turns,
        }],
      });
      const recovered = await service(join(root, "recovered-state.json")).open();
      const run = recovered.listRuns()[0];
      expect(run.importId).toBe(receipt.importId);
      expect(await readFile(join(root, run.sourceRef))).toEqual(Buffer.from(source));
      expect(JSON.parse(await readFile(join(root, run.bundleRef), "utf8")).testRunId).toBe(run.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compensates both staged stores when backend publication fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-eval-publish-failure-"));
    try {
      const calls = installBackend({ publishStatus: 500 });
      await expect(service(join(root, "state.json")).importConversation(await inputFile(root))).rejects.toThrow("publish failed");
      expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "DELETE"]);
      await expect(readFile(join(root, `runs/import-${receipt.importId}/conversation.jsonl`))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("streams files above 2 MiB and enforces the byte limit without whole-file buffers", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-eval-streaming-"));
    try {
      const large = Buffer.alloc(2 * 1024 * 1024 + 17, 120);
      const calls = installBackend();
      await service(join(root, "state.json")).importConversation(await inputFile(root, large));
      expect(calls[0].streamedBytes.byteLength).toBe(large.byteLength);
      expect(calls[0].body).not.toBeInstanceOf(Uint8Array);

      const nearLimitSource = await inputFile(root, Buffer.alloc(64 * 1024, 1));
      const staged = join(root, "near-limit.jsonl");
      await expect(stageBoundedSource(nearLimitSource, staged, 64 * 1024)).resolves.toBe(64 * 1024);
      await writeFile(nearLimitSource, Buffer.alloc(64 * 1024 + 1, 1));
      await expect(stageBoundedSource(nearLimitSource, join(root, "over-limit.jsonl"), 64 * 1024)).rejects.toThrow("exceeds");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads from one opened handle even if the selected path is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-eval-toctou-"));
    try {
      const selected = await inputFile(root, Buffer.from("original"));
      const staged = join(root, "staged.jsonl");
      await stageBoundedSource(selected, staged, 32, {
        afterOpen: async () => {
          await rename(selected, join(root, "original-moved.jsonl"));
          await writeFile(selected, "replacement-that-is-too-large-for-the-limit");
        },
      });
      expect(await readFile(staged, "utf8")).toBe("original");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans a staged import when the PUT connection fails before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-eval-put-before-"));
    try {
      const calls = installBackend({ rejectPublish: true });
      await expect(service(join(root, "state.json")).importConversation(await inputFile(root)))
        .rejects.toThrow("connection lost");
      expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "GET", "DELETE"]);
      await expect(readFile(join(root, `runs/import-${receipt.importId}/conversation.jsonl`))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers when the PUT response is lost after publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-eval-put-after-"));
    try {
      const published = [{
        ...receipt,
        header: { conversation: { title: receipt.title }, producer: receipt.producer },
      }];
      const calls = installBackend({ rejectPublish: true, published });
      const run = await service(join(root, "state.json")).importConversation(await inputFile(root));
      expect(run.importId).toBe(receipt.importId);
      expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "GET"]);
      await expect(readFile(join(root, run.sourceRef))).resolves.toEqual(Buffer.from(source));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves exact source when publication wins the GET-then-DELETE race", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-eval-put-race-"));
    try {
      const published = [{
        ...receipt,
        header: { conversation: { title: receipt.title }, producer: receipt.producer },
      }];
      const calls = installBackend({
        rejectPublish: true,
        deleteStatus: 409,
        publishedAfterDeleteFailure: published,
      });
      const run = await service(join(root, "state.json")).importConversation(await inputFile(root));
      expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "GET", "DELETE", "GET"]);
      expect(await readFile(join(root, run.sourceRef))).toEqual(Buffer.from(source));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles an ambiguous PUT after restart without leaving a local orphan", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-eval-put-restart-"));
    try {
      installBackend({ rejectPublish: true, rejectGet: true });
      await expect(service(join(root, "state.json")).importConversation(await inputFile(root)))
        .rejects.toThrow("reconciliation connection lost");
      const runDirectory = join(root, `runs/import-${receipt.importId}`);
      await expect(readFile(join(runDirectory, "pending-import.json"))).resolves.toBeTruthy();

      installBackend({ published: [] });
      await service(join(root, "recovered-state.json")).open();
      await expect(readFile(join(runDirectory, "pending-import.json"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
