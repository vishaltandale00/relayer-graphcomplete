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
  it("gates eligibility and coverage before snapshotting, then hashes each changed history into a new point-in-time artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-annotation-export-"));
    temporaryDirectories.push(directory);
    const stateFile = join(directory, "test-runs.json");
    let revisions = [{ revision: 1, comment: "First", rating: null, state: "active" }];
    let snapshotCalls = 0;
    let coverageMismatch = false;
    let capture = 0;
    const service = new EvalService({
      stateFile,
      productSession: {},
      configurationPaths: [],
      annotationSnapshotLoader: async (threadIds) => {
        snapshotCalls += 1;
        if (coverageMismatch) {
          return {
            schemaVersion: 1,
            kind: "relayer_eval_annotation_snapshot_set",
            annotationsSha256: "sha256:history",
            threads: [{ threadId: 999, annotations: [] }],
          };
        }
        return {
          schemaVersion: 1,
          kind: "relayer_eval_annotation_snapshot_set",
          exportedAt: `capture-${capture += 1}`,
          annotationsSha256: `sha256:history-${revisions.length}`,
          threads: threadIds.map((threadId) => ({
            threadId,
            annotations: [{ id: 9, threadId, revisions: structuredClone(revisions) }],
          })),
        };
      },
    });
    service.runs = [{
      id: "run-1",
      bundleRef: "runs/run-1/bundle.json",
      executions: [{
        id: "execution-1",
        status: "running",
        threadIds: [41],
        turns: [{
          threadId: 41,
          interactionId: 51,
          graphNodeId: 61,
          rootLayerId: 71,
          status: "submitted",
        }],
      }],
    }];

    await expect(service.exportAnnotatedExecution("execution-1"), "nonterminal executions are rejected")
      .rejects.toThrow("terminal execution");
    service.runs[0].executions[0].status = "passed";
    service.runs[0].executions[0].turns[0].status = "accepted";
    service.runs[0].bundleRef = null;
    await expect(service.exportAnnotatedExecution("execution-1"), "incomplete executions are rejected")
      .rejects.toThrow("durable source run bundle");
    expect(snapshotCalls, "ineligible exports never reach the snapshot loader").toBe(0);

    service.runs[0].bundleRef = "runs/run-1/bundle.json";
    await writeRunBundle(stateFile, service.runs[0]);
    coverageMismatch = true;
    await expect(service.exportAnnotatedExecution("execution-1"), "snapshot coverage must exactly match execution threads")
      .rejects.toThrow("unexpected or duplicate thread");

    coverageMismatch = false;
    const first = await service.exportAnnotatedExecution("execution-1");
    const firstFile = join(dirname(stateFile), ...first.bundleRef.split("/"));
    const firstBytes = await readFile(firstFile, "utf8");
    const firstBundle = JSON.parse(firstBytes);
    expect(firstBundle, "annotated bundle keeps fixed graph references").toMatchObject({
      kind: "relayer_eval_annotated_execution_bundle",
      sourceRunBundleRef: "runs/run-1/bundle.json",
      fixedGraphReferences: [{ threadId: 41, interactionId: 51, rootLayerId: 71 }],
    });
    expect(firstBundle.integritySha256, "bundle integrity digest").toMatch(/^sha256:[a-f0-9]{64}$/);
    const identicalHistory = await service.exportAnnotatedExecution("execution-1");
    expect(identicalHistory.annotationMaterialSha256, "identical history reuses the same annotation material")
      .toBe(first.annotationMaterialSha256);

    revisions = [...revisions, {
      revision: 2,
      comment: "Later edit",
      rating: 4,
      state: "active",
    }];
    const second = await service.exportAnnotatedExecution("execution-1");
    expect(second.bundleRef, "changed history creates a new artifact").not.toBe(first.bundleRef);
    expect(second.annotationMaterialSha256, "changed history changes the annotation material digest")
      .not.toBe(first.annotationMaterialSha256);
    expect(await readFile(firstFile, "utf8"), "older export is never rewritten").toBe(firstBytes);
    const secondBundle = JSON.parse(await readFile(
      join(dirname(stateFile), ...second.bundleRef.split("/")),
      "utf8",
    ));
    expect(secondBundle.annotationSnapshot.threads[0].annotations[0].revisions, "new artifact carries the edited history")
      .toHaveLength(2);
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
