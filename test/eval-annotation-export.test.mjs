import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EvalService } from "../desktop/eval-main/eval-service.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("immutable annotated execution exports", () => {
  it("creates a new hashed point-in-time artifact without rewriting an older export", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-annotation-export-"));
    temporaryDirectories.push(directory);
    const stateFile = join(directory, "test-runs.json");
    let revisions = [{ revision: 1, comment: "First", rating: null, state: "active" }];
    let capture = 0;
    const service = new EvalService({
      stateFile,
      productSession: {},
      configurationPaths: [],
      annotationSnapshotLoader: async (threadIds) => ({
        schemaVersion: 1,
        kind: "relayer_eval_annotation_snapshot_set",
        exportedAt: `capture-${capture += 1}`,
        annotationsSha256: `sha256:history-${revisions.length}`,
        threads: threadIds.map((threadId) => ({
          threadId,
          annotations: [{ id: 9, threadId, revisions: structuredClone(revisions) }],
        })),
      }),
    });
    service.runs = [{
      id: "run-1",
      bundleRef: "runs/run-1/bundle.json",
      executions: [{
        id: "execution-1",
        status: "passed",
        threadIds: [41],
        turns: [{
          threadId: 41,
          interactionId: 51,
          graphNodeId: 61,
          rootLayerId: 71,
          status: "accepted",
        }],
      }],
    }];
    await writeRunBundle(stateFile, service.runs[0]);

    const first = await service.exportAnnotatedExecution("execution-1");
    const firstFile = join(dirname(stateFile), ...first.bundleRef.split("/"));
    const firstBytes = await readFile(firstFile, "utf8");
    const firstBundle = JSON.parse(firstBytes);
    expect(firstBundle).toMatchObject({
      kind: "relayer_eval_annotated_execution_bundle",
      sourceRunBundleRef: "runs/run-1/bundle.json",
      fixedGraphReferences: [{ threadId: 41, interactionId: 51, rootLayerId: 71 }],
    });
    expect(firstBundle.integritySha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    const identicalHistory = await service.exportAnnotatedExecution("execution-1");
    expect(identicalHistory.annotationMaterialSha256).toBe(first.annotationMaterialSha256);

    revisions = [...revisions, {
      revision: 2,
      comment: "Later edit",
      rating: 4,
      state: "active",
    }];
    const second = await service.exportAnnotatedExecution("execution-1");
    expect(second.bundleRef).not.toBe(first.bundleRef);
    expect(second.annotationMaterialSha256).not.toBe(first.annotationMaterialSha256);
    expect(await readFile(firstFile, "utf8")).toBe(firstBytes);
    const secondBundle = JSON.parse(await readFile(
      join(dirname(stateFile), ...second.bundleRef.split("/")),
      "utf8",
    ));
    expect(secondBundle.annotationSnapshot.threads[0].annotations[0].revisions).toHaveLength(2);
  });

  it("fails closed when snapshot coverage does not exactly match execution threads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-annotation-export-"));
    temporaryDirectories.push(directory);
    const service = new EvalService({
      stateFile: join(directory, "test-runs.json"),
      productSession: {},
      configurationPaths: [],
      annotationSnapshotLoader: async () => ({
        schemaVersion: 1,
        kind: "relayer_eval_annotation_snapshot_set",
        annotationsSha256: "sha256:history",
        threads: [{ threadId: 999, annotations: [] }],
      }),
    });
    service.runs = [{
      id: "run-1",
      bundleRef: "runs/run-1/bundle.json",
      executions: [{
        id: "execution-1",
        status: "passed",
        threadIds: [41],
        turns: [{ threadId: 41, interactionId: 51, status: "accepted" }],
      }],
    }];
    await writeRunBundle(service.stateFile, service.runs[0]);
    await expect(service.exportAnnotatedExecution("execution-1"))
      .rejects.toThrow("unexpected or duplicate thread");
  });

  it("rejects nonterminal, incomplete, and non-durable executions before snapshotting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-annotation-export-"));
    temporaryDirectories.push(directory);
    let snapshotCalls = 0;
    const service = new EvalService({
      stateFile: join(directory, "test-runs.json"),
      productSession: {},
      configurationPaths: [],
      annotationSnapshotLoader: async () => {
        snapshotCalls += 1;
        return { threads: [] };
      },
    });
    service.runs = [{
      id: "run-1",
      bundleRef: null,
      executions: [{
        id: "execution-1",
        status: "running",
        threadIds: [41],
        turns: [{ threadId: 41, interactionId: 51, status: "submitted" }],
      }],
    }];
    await expect(service.exportAnnotatedExecution("execution-1"))
      .rejects.toThrow("terminal execution");
    service.runs[0].executions[0].status = "passed";
    service.runs[0].executions[0].turns[0].status = "accepted";
    await expect(service.exportAnnotatedExecution("execution-1"))
      .rejects.toThrow("durable source run bundle");
    expect(snapshotCalls).toBe(0);
  });
});

async function writeRunBundle(stateFile, run) {
  const file = join(dirname(stateFile), ...run.bundleRef.split("/"));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    bundleSchemaVersion: 1,
    kind: "relayer_eval_run_bundle",
    testRunId: run.id,
    run: structuredClone(run),
  }));
}
