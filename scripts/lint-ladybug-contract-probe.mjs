import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");
const fixture = async (name) => JSON.parse(await read(`fixtures/graph-query-v1/${name}`));

// The issue #261 gate is frozen evidence: the exact captured output, the coverage
// disposition, and the resolved dependency closure that produced them. The probe
// crate that produced it was promoted into relayer-graph-server (#299), so the
// executable assertions below read the promoted client and its tests instead.
const evidenceRoot = "docs/evidence/issue-261-ladybug-contract-probe";
const coverage = JSON.parse(await read(`${evidenceRoot}/coverage.json`));
const lock = await read(`${evidenceRoot}/Cargo.lock`);
const output = await read(`${evidenceRoot}/captured-output.txt`);
const receipt = JSON.parse(await read(`${evidenceRoot}/receipt.json`));

const client = (
  await Promise.all(
    [
      "crates/relayer-graph-server/src/search_index.rs",
      "crates/relayer-graph-server/src/search_index/schema.rs",
      "crates/relayer-graph-server/src/search_index/store.rs",
      "crates/relayer-graph-server/src/search_index/value.rs",
    ].map(read),
  )
).join("\n");
const clientTests = await read("crates/relayer-graph-server/tests/ladybug_search_index.rs");

assert.equal(receipt.issue, 261);
assert.equal(receipt.engine, "lbug");
assert.equal(receipt.version, "0.18.0");
assert.equal(receipt.promotedTo, "crates/relayer-graph-server/src/search_index/");
for (const [relativePath, expected] of Object.entries(receipt.sha256)) {
  const bytes = await readFile(path.join(root, evidenceRoot, relativePath));
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
assert.equal(coverage.version, "0.18.0");
assert.deepEqual(coverage.extensions, []);
assert.match(lock, /name = "lbug"\nversion = "0\.18\.0"/);
// The promoted client must stay on the same exact pin the gate certified.
assert.match(
  await read("crates/relayer-graph-server/Cargo.toml"),
  /lbug = \{ version = "=0\.18\.0"/,
  "the promoted client drifted off the qualified lbug pin",
);

const positive = await fixture("positive.json");
assert.deepEqual(coverage.requiredPositiveCases, positive.cases.map(({ id }) => id));
for (const { id } of positive.cases) {
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

// The lowerings the probe proved are product code now, so assert they are still
// there rather than that a frozen binary once contained them.
assert.match(client, /prepared\.is_read_only\(\)/, "the parsed read-only gate is gone");
for (const lowering of [
  /fn normalize_value\(/, /fn normalize_node\(/, /fn normalize_relationship\(/, /fn list_descriptor\(/,
]) assert.match(client, lowering, `the promoted client lost ${lowering}`);
assert.match(
  client,
  /if !value\.is_finite\(\)[\s\S]*?invalid\("engine returned a nonfinite float"\)/,
  "nonfinite floats are no longer rejected",
);
assert.match(client, /if value == 0\.0 \{ 0\.0 \} else \{ value \}/, "negative zero is no longer canonicalised");
assert.match(
  client,
  /i64::try_from\(\*value\)[\s\S]*?NormalizeFailureKind::IntegerOverflow/,
  "int128 overflow is no longer rejected",
);
assert.doesNotMatch(client, /INSTALL\s|LOAD EXTENSION/i, "the client loads an engine extension");

// And that the proofs the probe ran once now run on every build.
for (const proof of [
  /fn every_v1_value_type_round_trips_losslessly\(/,
  /fn a_rolled_back_write_leaves_the_store_untouched\(/,
  /fn a_committed_closure_survives_closing_and_reopening_the_store\(/,
  /fn the_read_path_refuses_a_query_the_engine_does_not_parse_read_only\(/,
]) assert.match(clientTests, proof, `the promoted client lost the ${proof} proof`);

for (const line of [
  "EXACT_ENVELOPES=passed", "VALUES=passed", "NORMALIZATION_FALSIFIERS=passed",
  "PARSED_READ_ONLY_GATE=passed", "WALL_TIME_FALSIFIER=passed",
  "CANCELLATION_FALSIFIER=passed", "TRANSACTION_ROLLBACK_REOPEN=passed",
  "EXTENSIONS=[]", "LBUG_STORAGE_VERSION=42",
]) assert.ok(output.split("\n").includes(line), `captured output lacks ${line}`);

console.log(`Ladybug contract probe receipt covers ${positive.cases.length} positive, ${negative.cases.length} negative, ${values.cases.length + values.normalizationErrors.length} value, and ${limits.cases.length + 1} limit/budget cases.`);
