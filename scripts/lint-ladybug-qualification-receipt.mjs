import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const receipt = JSON.parse(await readFile(
  resolve(root, "fixtures/ladybug-v0.19.1-qualification.json"),
  "utf8",
));

assert.equal(receipt.issue, 261);
assert.equal(receipt.decision, "upstream-artifacts-no-go");
assert.equal(receipt.qualificationStatus, "complete-decision");
assert.deepEqual(receipt.core, {
  version: "0.19.1",
  tag: "v0.19.1",
  commit: "554c1e71158564c37a30c541a92bfc9eddc96430",
});
assert.equal(receipt.rustBinding.crate, "lbug");
assert.equal(receipt.rustBinding.version, "0.19.1");
assert.equal(
  receipt.rustBinding.sourceBasisCommit,
  "2e89afb712e6e26f2465f486b153e4aea1176130",
);
assert.equal(receipt.rustBinding.vcsDirty, true);
assert.equal(
  receipt.rustBinding.crateSha256,
  "a7a032d5968ac2260545e8c5cf05a123559de2c6ba2bd0dde11c0ed958dfa172",
);
assert.deepEqual(receipt.extensions, []);

const requiredTargets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
];
const expectedArtifacts = new Map([
  ["aarch64-apple-darwin/static/liblbug-static-osx-arm64.tar.gz", "9d8bf7fd2a2b715e419db1f087f57777fd9413e214abdf32fa60ca3a9e51d883"],
  ["x86_64-apple-darwin/static/liblbug-static-osx-x86_64.tar.gz", "8ae8597da0295b14a06ee89cb632ab44c5f0e834be9576689d706eea16159f79"],
  ["x86_64-pc-windows-msvc/static/liblbug-static-windows-x86_64.zip", "bc05aea71c008067a05fea027fc7113ae8f23e6e6d020394014e915ed0bbfc76"],
  ["aarch64-apple-darwin/shared/liblbug-osx-arm64.tar.gz", "276ce32705fb01f3bf27dcffa053dd181f5bc96628760e961bece46cf85b770e"],
  ["x86_64-apple-darwin/shared/liblbug-osx-x86_64.tar.gz", "0f941f9f983f0184a177e938f0816d3aaa71266fe6d87fef2c5023cebe03c20a"],
  ["x86_64-pc-windows-msvc/shared/liblbug-windows-x86_64.zip", "865e2c8765064be76d41e4d786dfb0cd3ad0c258ddaf7b522fa3da7159ecd3ef"],
]);
assert.equal(receipt.releaseArtifacts.length, expectedArtifacts.size);
const seenArtifacts = new Set();
for (const artifact of receipt.releaseArtifacts) {
  const key = `${artifact.target}/${artifact.kind}/${artifact.name}`;
  assert.ok(!seenArtifacts.has(key), `duplicate artifact receipt: ${key}`);
  seenArtifacts.add(key);
  assert.equal(artifact.sha256, expectedArtifacts.get(key), `unexpected artifact receipt: ${key}`);
}
for (const target of requiredTargets) {
  for (const kind of ["static", "shared"]) {
    const artifact = receipt.releaseArtifacts.find(
      (candidate) => candidate.target === target && candidate.kind === kind,
    );
    assert.ok(artifact, `missing ${kind} artifact receipt for ${target}`);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);
  }
}

for (const finding of receipt.blockingFindings.filter(({ id }) => id !== "macos-minimum-version-mismatch")) {
  assert.deepEqual(finding.targets, requiredTargets);
}
assert.deepEqual(
  receipt.blockingFindings.find(({ id }) => id === "macos-minimum-version-mismatch").targets,
  requiredTargets.slice(0, 2),
);
assert.deepEqual(
  receipt.blockingFindings.map(({ id }) => id).sort(),
  [
    "external-openssl-runtime",
    "incomplete-native-license-receipts",
    "macos-minimum-version-mismatch",
  ],
);

console.log("Ladybug v0.19.1 qualification receipt lint passed: upstream artifacts NO-GO");
