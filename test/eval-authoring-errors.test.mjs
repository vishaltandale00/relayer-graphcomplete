import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { authoringErrorsFromOperations, authoringErrorsFromTraceDirectory, unavailableAuthoringErrors } from "../desktop/eval-main/authoring-errors.mjs";
import { projectExecutionDossier } from "../desktop/eval-renderer/run-model.js";

const folders = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const operation = (sequence, path, status, extra = {}) => ({ schemaVersion: 1, sequence, interactionNodeId: 17, method: "POST", path, status, ...extra });

it("counts failures at their origin, distinguishes retries, and keeps incomplete totals unknown", () => {
  const failed = operation(1, "/api/graph/nodes", 422, { errorCodes: ["invalid_icon", "invalid_title"] });
  const diagnostic = operation(3, "/api/graph/authoring-errors", 202, { authoringError: { id: "failure-1", phase: "compiler", codes: ["unsafe_css"] } });
  const metric = authoringErrorsFromOperations([
    failed, failed, operation(2, "/api/graph/nodes", 422), diagnostic, diagnostic,
    operation(4, "/api/graph/authoring-errors", 202, { authoringError: { id: "failure-2", phase: "compiler", codes: ["unsafe_css"] } }),
    operation(5, "/api/graph/nodes/17/output", 404, { method: "GET" }),
    operation(6, "/api/graph/nodes", 503), operation(7, "/api/graph/nodes", 429),
    operation(8, "/api/graph/nodes", 401), operation(9, "/api/graph/submit", 200),
  ]);
  expect(metric).toMatchObject({ total: null, observed: 4, coverage: "partial", byCause: { server_rejection: 2, compiler: 2 } });
  expect(authoringErrorsFromOperations([])).toMatchObject({ total: null, observed: 0, coverage: "partial" });
  expect(authoringErrorsFromOperations([], { complete: false }).reasons).toContain("ledger_truncated");
  expect(unavailableAuthoringErrors().observed).toBeNull();
});

it("validates persisted evidence, rejects tampering and foreign turns, and projects legacy unknowns", async () => {
  const folder = await mkdtemp(join(tmpdir(), "eval-authoring-errors-")); folders.push(folder);
  const bytes = Buffer.from(JSON.stringify(operation(1, "/api/graph/submit", 422)) + "\n");
  await writeFile(join(folder, "graph-operations.jsonl"), bytes);
  const descriptor = { graphOperations: { format: "relayer-graph-operations-v1", ref: "graph-operations.jsonl", status: "complete", truncated: false,
    byteLength: bytes.byteLength, eventCount: 1, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` } };
  const metric = await authoringErrorsFromTraceDirectory(folder, descriptor, 17);
  expect(metric.observed).toBe(1);
  await expect(authoringErrorsFromTraceDirectory(folder, descriptor, 18)).rejects.toThrow("invalid receipt");
  const dossier = projectExecutionDossier({}, { turns: [{ interactionId: 1, authoringErrors: metric }, { interactionId: 2 }] });
  expect(dossier.authoringErrors).toMatchObject([{ interactionId: 1, observed: 1, total: null }, { interactionId: 2, observed: null, coverage: "unavailable" }]);
  await writeFile(join(folder, "graph-operations.jsonl"), "tampered");
  await expect(authoringErrorsFromTraceDirectory(folder, descriptor, 17)).rejects.toThrow("digest");
  expect(await authoringErrorsFromTraceDirectory(folder, {}, 17)).toMatchObject({ observed: null, coverage: "unavailable" });
});


it("diagnostic transport failure preserves the original client error", async () => {
  const { RelayerGraphClient } = await import("../packages/graph-client/src/index.ts");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("diagnostic transport unavailable"); }));
  const client = new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 17, authoringErrors: true });
  await expect(client.createEdge(1)).rejects.toThrow("createEdge requires two node references");
  expect(fetch).toHaveBeenCalledOnce();
});
