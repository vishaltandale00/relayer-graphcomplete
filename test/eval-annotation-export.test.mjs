import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    const service = new EvalService({
      stateFile,
      productSession: {},
      configurationPaths: [],
      annotationSnapshotLoader: async (threadIds) => threadIds.map((threadId) => ({
        schemaVersion: 1,
        kind: "relayer_eval_annotation_snapshot",
        threadId,
        annotationsSha256: `snapshot-${revisions.length}`,
        annotations: [{ id: 9, threadId, revisions: structuredClone(revisions) }],
      })),
    });
    service.runs = [{
      id: "run-1",
      bundleRef: "runs/run-1/bundle.json",
      executions: [{
        id: "execution-1",
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
    expect(secondBundle.annotationSnapshots[0].annotations[0].revisions).toHaveLength(2);
  });

  it("fails closed when snapshot coverage does not exactly match execution threads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-annotation-export-"));
    temporaryDirectories.push(directory);
    const service = new EvalService({
      stateFile: join(directory, "test-runs.json"),
      productSession: {},
      configurationPaths: [],
      annotationSnapshotLoader: async () => [{ threadId: 999 }],
    });
    service.runs = [{
      id: "run-1",
      bundleRef: null,
      executions: [{ id: "execution-1", threadIds: [41], turns: [] }],
    }];
    await expect(service.exportAnnotatedExecution("execution-1"))
      .rejects.toThrow("unexpected or duplicate thread");
  });
});
