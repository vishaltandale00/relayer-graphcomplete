import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = async (name) => JSON.parse(await readFile(path.join(root, "fixtures/graph-query-v1", name), "utf8"));
const coverage = JSON.parse(await readFile(path.join(root, "docs/evidence/issue-261-ladybug-contract-probe/coverage.json"), "utf8"));
const source = await readFile(path.join(root, "docs/evidence/issue-261-ladybug-contract-probe/src/main.rs"), "utf8");
const lock = await readFile(path.join(root, "docs/evidence/issue-261-ladybug-contract-probe/Cargo.lock"), "utf8");
const output = await readFile(path.join(root, "docs/evidence/issue-261-ladybug-contract-probe/captured-output.txt"), "utf8");
const receipt = JSON.parse(await readFile(path.join(root, "docs/evidence/issue-261-ladybug-contract-probe/receipt.json"), "utf8"));

assert.equal(receipt.issue, 261);
assert.equal(receipt.engine, "lbug");
assert.equal(receipt.version, "0.19.1");
const evidenceRoot = path.join(root, "docs/evidence/issue-261-ladybug-contract-probe");
for (const [relativePath, expected] of Object.entries(receipt.sha256)) {
  const bytes = await readFile(path.join(evidenceRoot, relativePath));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, `${relativePath} changed after evidence capture`);
}
const positiveFixtureBytes = await readFile(path.join(root, "fixtures/graph-query-v1/positive.json"));
assert.equal(
  createHash("sha256").update(positiveFixtureBytes).digest("hex"),
  receipt.frozenPositiveFixtureSha256,
  "positive.json changed after exact-envelope evidence capture",
);

assert.equal(coverage.issue, 261);
assert.equal(coverage.engine, "lbug");
assert.equal(coverage.version, "0.19.1");
assert.deepEqual(coverage.extensions, []);
assert.match(lock, /name = "lbug"\nversion = "0\.19\.1"/);

const positive = await fixture("positive.json");
assert.deepEqual(coverage.requiredPositiveCases, positive.cases.map(({ id }) => id));
for (const { id } of positive.cases) {
  assert.match(source, new RegExp(`\\("${id}",`), `${id} lacks an executable lowering`);
  assert.match(output, new RegExp(`^CASE=${id} STATUS=passed$`, "m"), `${id} lacks captured passing evidence`);
}

const negative = await fixture("negative.json");
for (const { id, expectedError } of negative.cases) {
  assert.ok(coverage.negativeDispositionByPhase[expectedError.phase], `${id} has no phase disposition`);
}
const values = await fixture("values.json");
assert.ok(coverage.valueCaseDisposition);
assert.equal(values.cases.length + values.normalizationErrors.length, 15);
const limits = await fixture("limits.json");
assert.ok(coverage.limitCaseDisposition);
assert.equal(limits.cases.length, 8);
assert.equal(limits.budgetContract.id, "all-budget-dimensions");

assert.deepEqual(coverage.requiredProofs, [
  "parsed-read-only", "all-tagged-values-lossless", "transaction-rollback-reopen",
  "extensions-empty", "zero-one-two-hop-only", "allowed-shape-cancellation-falsifier",
  "canonical-negative-zero", "reject-nonfinite-floats", "reject-int128-overflow",
  "derived-cap-plus-one-truncation",
]);
assert.match(source, /prepared\.is_read_only\(\)/);
assert.match(source, /fn prove_values\(/);
assert.match(source, /fn prove_rollback_and_reopen\(/);
assert.match(source, /EXTENSIONS=\[\]/);
assert.match(source, /fn prove_cancellation_falsifier\(/);
assert.match(source, /b\.title = \$title/);
assert.match(source, /conn\.execute\(&mut timed, params\(\)\)/);
assert.match(source, /normalized_rows\.len\(\) > row_cap/);
assert.match(source, /fn prove_normalization_falsifiers\(/);
for (const line of [
  "EXACT_ENVELOPES=passed", "VALUES=passed", "NORMALIZATION_FALSIFIERS=passed",
  "PARSED_READ_ONLY_GATE=passed", "WALL_TIME_FALSIFIER=passed",
  "CANCELLATION_FALSIFIER=passed", "TRANSACTION_ROLLBACK_REOPEN=passed",
  "EXTENSIONS=[]", "LBUG_STORAGE_VERSION=43",
]) assert.ok(output.split("\n").includes(line), `captured output lacks ${line}`);
assert.doesNotMatch(source, /INSTALL\s|LOAD EXTENSION/i);
console.log(`Ladybug contract probe receipt covers ${positive.cases.length} positive, ${negative.cases.length} negative, ${values.cases.length + values.normalizationErrors.length} value, and ${limits.cases.length + 1} limit/budget cases.`);
