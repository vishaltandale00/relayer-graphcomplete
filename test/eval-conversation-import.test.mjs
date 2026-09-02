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
const publishedReceipt = {
  ...receipt,
  header: { conversation: { title: receipt.title }, producer: receipt.producer },
  turns: receipt.turns,
};
const directories = [];

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

const runDirectory = (root) => join(root, `runs/import-${receipt.importId}`);
const stagedSource = (root) => join(runDirectory(root), "conversation.jsonl");

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Eval conversation import publication", () => {
  it("streams, stages, and persists the exact source before backend publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-eval-import-"));
    directories.push(root);
    const stateFile = join(root, "state.json");
    const sourceFile = stagedSource(root);
    const bundleFile = join(runDirectory(root), "bundle.json");
    const calls = installBackend({
      beforePublish: async () => {
        expect(new Uint8Array(await readFile(sourceFile)), "exact source is staged before publication").toEqual(source);
        expect(JSON.parse(await readFile(bundleFile, "utf8")).testRunId, "immutable bundle is staged before publication")
          .toBe(`import-${receipt.importId}`);
      },
    });
    const run = await service(stateFile).importConversation(await inputFile(root));
    expect(calls.map((call) => call.method), "publication posts then publishes").toEqual(["POST", "PUT"]);
    expect(calls[0].body, "import streams instead of buffering").not.toBeInstanceOf(Uint8Array);
    expect(new Uint8Array(calls[0].streamedBytes), "streamed bytes match the source").toEqual(source);
    expect(new Uint8Array(await readFile(join(root, run.sourceRef))), "persisted source is exact").toEqual(source);
    const bundle = JSON.parse(await readFile(join(root, run.bundleRef), "utf8"));
    expect(bundle.testRunId, "bundle names the import run").toBe(run.id);
    expect(bundle.run.sourceRef, "bundle points at the persisted source").toBe(run.sourceRef);
    expect(JSON.parse(await readFile(stateFile, "utf8")).runs[0].importId, "state records the backend import identity")
      .toBe(receipt.importId);

    const largeRoot = await mkdtemp(join(tmpdir(), "relayer-eval-streaming-"));
    directories.push(largeRoot);
    const large = Buffer.alloc(2 * 1024 * 1024 + 17, 120);
    const largeCalls = installBackend();
    await service(join(largeRoot, "state.json")).importConversation(await inputFile(largeRoot, large));
    expect(largeCalls[0].streamedBytes.byteLength, "files above 2 MiB stream completely").toBe(large.byteLength);
    expect(largeCalls[0].body, "large imports never buffer the whole file").not.toBeInstanceOf(Uint8Array);

    const nearLimitSource = await inputFile(root, Buffer.alloc(64 * 1024, 1));
    await expect(stageBoundedSource(nearLimitSource, join(root, "near-limit.jsonl"), 64 * 1024),
      "staging accepts exactly the byte limit").resolves.toBe(64 * 1024);
    await writeFile(nearLimitSource, Buffer.alloc(64 * 1024 + 1, 1));
    await expect(stageBoundedSource(nearLimitSource, join(root, "over-limit.jsonl"), 64 * 1024),
      "staging enforces the byte limit").rejects.toThrow("exceeds");

    const selected = await inputFile(root, Buffer.from("original"));
    const staged = join(root, "staged.jsonl");
    await stageBoundedSource(selected, staged, 32, {
      afterOpen: async () => {
        await rename(selected, join(root, "original-moved.jsonl"));
        await writeFile(selected, "replacement-that-is-too-large-for-the-limit");
      },
    });
    expect(await readFile(staged, "utf8"), "staging reads from the opened handle even if the path is replaced")
      .toBe("original");
  });

  it("compensates staged local and backend state through every publication failure path", async () => {
    const cases = [
      {
        label: "source persistence conflict compensates the staged backend",
        prepare: async (root) => {
          await mkdir(runDirectory(root), { recursive: true });
          await writeFile(stagedSource(root), "conflict");
        },
        backend: () => ({}),
        expected: { throws: /./, methods: ["POST", "DELETE"] },
      },
      {
        label: "bundle persistence conflict compensates the staged backend",
        prepare: async (root) => {
          await mkdir(runDirectory(root), { recursive: true });
          await writeFile(join(runDirectory(root), "bundle.json"), "not a bundle");
        },
        backend: () => ({}),
        expected: { throws: /./, methods: ["POST", "DELETE"] },
      },
      {
        label: "publication refusal compensates both staged stores",
        backend: () => ({ publishStatus: 500 }),
        expected: { throws: /publish failed/, methods: ["POST", "PUT", "DELETE"], sourceRemoved: true },
      },
      {
        label: "PUT connection loss before publication cleans the staged import",
        backend: () => ({ rejectPublish: true }),
        expected: { throws: /connection lost/, methods: ["POST", "PUT", "GET", "DELETE"], sourceRemoved: true },
      },
      {
        label: "PUT response lost after publication reconciles through GET",
        backend: () => ({ rejectPublish: true, published: [publishedReceipt] }),
        expected: { importId: receipt.importId, methods: ["POST", "PUT", "GET"], sourcePreserved: true },
      },
      {
        label: "GET-then-DELETE race preserves the exact source",
        backend: () => ({
          rejectPublish: true,
          deleteStatus: 409,
          publishedAfterDeleteFailure: [publishedReceipt],
        }),
        expected: { importId: receipt.importId, methods: ["POST", "PUT", "GET", "DELETE", "GET"], sourcePreserved: true },
      },
      {
        label: "local state publication failure reconciles on reopen",
        prepare: async (root) => {
          await mkdir(join(root, "state-directory"));
        },
        stateFile: (root) => join(root, "state-directory"),
        backend: () => ({}),
        expected: { throws: /./, methods: ["POST", "PUT"] },
        recover: async (root) => {
          installBackend({ published: [publishedReceipt] });
          const recovered = await service(join(root, "recovered-state.json")).open();
          const recoveredRun = recovered.listRuns()[0];
          return {
            recoveredImportId: recoveredRun.importId,
            recoveredSource: await readFile(join(root, recoveredRun.sourceRef)),
            recoveredBundleRunId: JSON.parse(await readFile(join(root, recoveredRun.bundleRef), "utf8")).testRunId,
            recoveredRunId: recoveredRun.id,
          };
        },
        expectedRecovery: {
          recoveredImportId: receipt.importId,
          recoveredSourceMatches: true,
          recoveredBundleMatchesRun: true,
        },
      },
      {
        label: "ambiguous PUT restart reconciles without leaving a local orphan",
        backend: () => ({ rejectPublish: true, rejectGet: true }),
        expected: {
          throws: /reconciliation connection lost/,
          methods: ["POST", "PUT", "GET"],
          pendingImport: true,
        },
        recover: async (root) => {
          installBackend({ published: [] });
          await service(join(root, "recovered-state.json")).open();
          return {
            pendingImportRemoved: await readFile(join(runDirectory(root), "pending-import.json"))
              .then(() => false)
              .catch(() => true),
          };
        },
        expectedRecovery: { pendingImportRemoved: true },
      },
    ];
    expect(cases, "publication failure corpus").toHaveLength(8);

    for (const testCase of cases) {
      const root = await mkdtemp(join(tmpdir(), "relayer-eval-import-failure-"));
      directories.push(root);
      await testCase.prepare?.(root);
      const calls = installBackend(testCase.backend());
      const stateFile = testCase.stateFile ? testCase.stateFile(root) : join(root, "state.json");
      let run = null;
      let error = null;
      try {
        run = await service(stateFile).importConversation(await inputFile(root));
      } catch (thrown) {
        error = thrown;
      }
      if (testCase.expected.throws) {
        expect(error, `${testCase.label} rejects`).toBeTruthy();
        expect(error?.message, `${testCase.label} error`).toMatch(testCase.expected.throws);
      } else {
        expect(error, `${testCase.label} succeeds`).toBeNull();
        expect(run?.importId, `${testCase.label} import identity`).toBe(testCase.expected.importId);
      }
      expect(calls.map((call) => call.method), `${testCase.label} backend sequence`).toEqual(testCase.expected.methods);
      if (testCase.expected.sourceRemoved) {
        await expect(readFile(stagedSource(root)), `${testCase.label} removes staged source`).rejects.toThrow();
      }
      if (testCase.expected.sourcePreserved) {
        expect(await readFile(join(root, run.sourceRef)), `${testCase.label} preserves the exact source`)
          .toEqual(Buffer.from(source));
      }
      if (testCase.expected.pendingImport) {
        await expect(readFile(join(runDirectory(root), "pending-import.json")), `${testCase.label} records pending import`)
          .resolves.toBeTruthy();
      }
      if (testCase.recover) {
        const recovery = await testCase.recover(root);
        if (testCase.expectedRecovery.recoveredImportId !== undefined) {
          expect(recovery.recoveredImportId, `${testCase.label} recovery import identity`)
            .toBe(testCase.expectedRecovery.recoveredImportId);
          expect(Buffer.compare(recovery.recoveredSource, Buffer.from(source)), `${testCase.label} recovery source is exact`)
            .toBe(0);
          expect(recovery.recoveredBundleRunId === recovery.recoveredRunId, `${testCase.label} recovery bundle names its run`)
            .toBe(true);
        }
        if (testCase.expectedRecovery.pendingImportRemoved !== undefined) {
          expect(recovery.pendingImportRemoved, `${testCase.label} removes the pending import marker`)
            .toBe(testCase.expectedRecovery.pendingImportRemoved);
        }
      }
    }
  });
});
