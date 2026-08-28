import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
assert.deepEqual(receipt.pinnedSourceCandidate, {
  openssl: {
    version: "3.5.8",
    series: "3.5-LTS",
    source: "openssl-3.5.8.tar.gz",
    sha256: "a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2",
    license: "Apache-2.0",
    endOfLife: "2030-04-08",
  },
  observedTarget: "aarch64-apple-darwin",
  inferredTargets: ["x86_64-apple-darwin"],
  bindingHookSha256: "d91ee35aecd6423dfcc43a982facab19597b7b0428e4b5b17cdb379bd7be36e2",
  sourceProbeLockSha256: "0b91deadfebe9ea44b26fd0f6e7ea814806f5ada772cad62412d914f9c495b24",
  macos13_0: {
    opensslStaticBuild: "passed",
    ladybugSourceBuild: "failed",
    failure: "std-format-requires-macos-13.3",
  },
  macos13_3: {
    ladybugSourceBuild: "passed-with-narrow-binding-hook",
    binarySha256: "aea4e12adceea09977a9c4bd913f48beae2f68d0f4be16e1863330c29f693b39",
    imports: ["/usr/lib/libc++.1.dylib", "/usr/lib/libSystem.B.dylib"],
  },
});
const bindingHook = await readFile(resolve(
  root,
  "docs/evidence/issue-261-ladybug-probe/static-openssl-build-hook.patch",
));
assert.equal(
  createHash("sha256").update(bindingHook).digest("hex"),
  receipt.pinnedSourceCandidate.bindingHookSha256,
);
const sourceProbeLock = await readFile(resolve(
  root,
  "docs/evidence/issue-261-ladybug-probe/source-build-probe/Cargo.lock",
));
assert.equal(
  createHash("sha256").update(sourceProbeLock).digest("hex"),
  receipt.pinnedSourceCandidate.sourceProbeLockSha256,
);

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

const macOnlyFindingIds = new Set([
  "macos-minimum-version-mismatch",
  "source-build-macos-13.0-incompatible",
]);
for (const finding of receipt.blockingFindings.filter(({ id }) => !macOnlyFindingIds.has(id))) {
  assert.deepEqual(finding.targets, requiredTargets);
}
assert.deepEqual(
  receipt.blockingFindings.map(({ candidate, id }) => [id, candidate]),
  [
    ["external-openssl-runtime", "upstream-release-artifacts"],
    ["incomplete-native-license-receipts", "upstream-release-artifacts-and-source-candidate"],
    ["macos-minimum-version-mismatch", "upstream-release-artifacts"],
    ["source-build-macos-13.0-incompatible", "pinned-source"],
  ],
);
assert.deepEqual(
  receipt.blockingFindings.find(({ id }) => id === "macos-minimum-version-mismatch").targets,
  requiredTargets.slice(0, 2),
);
assert.deepEqual(
  receipt.blockingFindings.find(({ id }) => id === "source-build-macos-13.0-incompatible").targets,
  requiredTargets.slice(0, 2),
);
assert.deepEqual(
  receipt.blockingFindings.map(({ id }) => id).sort(),
  [
    "external-openssl-runtime",
    "incomplete-native-license-receipts",
    "macos-minimum-version-mismatch",
    "source-build-macos-13.0-incompatible",
  ],
);

console.log("Ladybug v0.19.1 qualification receipt lint passed: upstream artifacts NO-GO");
