import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  NODE_REDIS_UPSTREAM_COMMIT,
  NODE_REDIS_UPSTREAM_TREE,
  gradeNodeRedisWorkspace,
  materializeNodeRedisProjectFixture,
  nodeRedisCommandQueueRaceCase,
} from "../packages/eval-runner/dist/index.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const regressionFixture = join(repositoryRoot, "eval-cases/node-redis-command-queue-race/admission/candidate-regression.fixture.cjs");
const noopRegressionFixture = join(repositoryRoot, "eval-cases/node-redis-command-queue-race/admission/noop-regression.fixture.cjs");
const portfolio = Object.freeze([
  { id: "untouched-source-baseline", role: "red-baseline", patch: null, expectedFailures: ["candidate-regression-passes", "failed-command-rejected-once", "queue-clean-before-reconnect", "reconnect-reply-order", "offline-queue-replayed-in-order", "reconnect-queue-drained", "single-failure-callbacks-settle", "repeated-failures-rejected-independently", "repeated-reconnects-start-clean", "ordered-replies-after-recovery", "no-command-reply-misassociation", "callbacks-settle-without-hang", "focused-source-and-tests"] },
  { id: "upstream-proposal", role: "green-solution", patch: "eval-cases/node-redis-command-queue-race/solution/reference.patch", expectedFailures: [] },
  { id: "queue-admission", role: "green-solution", patch: "eval-cases/node-redis-command-queue-race/admission/alternative-queue-admission.patch", expectedFailures: [] },
  { id: "clear-on-ready", role: "adversarial-mutant", patch: "eval-cases/node-redis-command-queue-race/admission/mutant-clear-on-ready.patch", expectedFailures: ["candidate-regression-passes", "failed-command-rejected-once", "queue-clean-before-reconnect", "single-failure-callbacks-settle", "repeated-failures-rejected-independently", "repeated-reconnects-start-clean"] },
  { id: "first-error-only", role: "adversarial-mutant", patch: "eval-cases/node-redis-command-queue-race/admission/mutant-first-error-only.patch", expectedFailures: ["repeated-failures-rejected-independently", "repeated-reconnects-start-clean", "ordered-replies-after-recovery", "no-command-reply-misassociation", "callbacks-settle-without-hang"] },
  { id: "no-reconnect", role: "adversarial-mutant", patch: "eval-cases/node-redis-command-queue-race/admission/mutant-no-reconnect.patch", expectedFailures: ["candidate-regression-passes", "fault-injection-observed", "queue-clean-before-reconnect", "reconnect-reply-order", "offline-queue-replayed-in-order", "single-failure-callbacks-settle", "repeated-faults-observed", "fault-command-matrix-observed", "repeated-failures-rejected-independently", "repeated-reconnects-start-clean", "ordered-replies-after-recovery", "no-command-reply-misassociation", "callbacks-settle-without-hang"] },
  { id: "noop-regression", role: "adversarial-delivery-mutant", patch: "eval-cases/node-redis-command-queue-race/solution/reference.patch", regression: noopRegressionFixture, expectedFailures: ["candidate-regression-passes"] },
  { id: "forged-observations", role: "adversarial-authority-mutant", patch: "eval-cases/node-redis-command-queue-race/admission/mutant-forged-observations.patch", expectedFailures: ["candidate-regression-passes", "failed-command-rejected-once", "queue-clean-before-reconnect", "reconnect-reply-order", "offline-queue-replayed-in-order", "reconnect-queue-drained", "single-failure-callbacks-settle", "repeated-failures-rejected-independently", "repeated-reconnects-start-clean", "ordered-replies-after-recovery", "no-command-reply-misassociation", "callbacks-settle-without-hang"] },
]);

const root = await mkdtemp(join(tmpdir(), "relayer-node-redis-admission-"));
try {
  const baseline = join(root, "baseline");
  await materializeNodeRedisProjectFixture({
    cacheDirectory: process.env.RELAYER_NODE_REDIS_CACHE || join(root, "source-cache"),
    workspaceDirectory: baseline,
  });
  const results = [];
  for (const entry of portfolio) {
    const workspace = join(root, entry.id);
    await cp(baseline, workspace, { recursive: true });
    if (entry.patch) await execFileAsync("git", ["apply", join(repositoryRoot, entry.patch)], { cwd: workspace });
    await cp(entry.regression || regressionFixture, join(workspace, "test/command-queue-race.test.js"));
    await execFileAsync("git", ["add", "--all"], { cwd: workspace });
    await execFileAsync("git", [
      "-c", "user.name=Relayer Admission",
      "-c", "user.email=admission@invalid.example",
      "commit", "--quiet", "-m", `Admission member: ${entry.id}`,
    ], { cwd: workspace });

    const checks = await gradeNodeRedisWorkspace({ workspaceDirectory: workspace });
    const failedChecks = checks.filter(({ passed }) => !passed).map(({ name }) => name);
    const expectedFailures = entry.expectedFailures.map((name) => `workspace:node-redis:${name}`);
    if (JSON.stringify(failedChecks) !== JSON.stringify(expectedFailures)) {
      throw new Error(`Admission member ${entry.id} failure matrix drifted: expected ${expectedFailures.join(", ") || "green"}; received ${failedChecks.join(", ") || "green"}.`);
    }
    const green = failedChecks.length === 0;
    results.push({
      id: entry.id,
      role: entry.role,
      patchDigest: entry.patch ? sha256(await readFile(join(repositoryRoot, entry.patch))) : null,
      green,
      failedChecks,
      checks,
    });
  }
  const output = {
    schemaVersion: 1,
    caseId: nodeRedisCommandQueueRaceCase.snapshot.id,
    caseSnapshotDigest: nodeRedisCommandQueueRaceCase.snapshotDigest,
    verifierDigest: nodeRedisCommandQueueRaceCase.snapshot.artifacts.verifier.contentDigest,
    upstreamCommit: NODE_REDIS_UPSTREAM_COMMIT,
    upstreamTree: NODE_REDIS_UPSTREAM_TREE,
    environment: { platform: process.platform, architecture: process.arch, node: process.versions.node, npm: "10.9.8" },
    productionGraderExercised: true,
    results,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
