import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { digestLadybugSourceTree, sha256File } from "./prepare-ladybug-source.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const defaultInventoryPath = resolve(repositoryRoot, "vendor/ladybug/native-inventory.json");
const sha256Pattern = /^[0-9a-f]{64}$/u;

// `vendor/ladybug/native-inventory.json` and `vendor/ladybug/source-build-manifest.json`
// pin the same digest of the same lbug source tree. Share one walker so the two
// receipts cannot disagree about identical, unmodified source.
const sha256Tree = digestLadybugSourceTree;

function resolveRepositoryPath(path, label) {
  assert.equal(isAbsolute(path), false, `${label} must be repository-relative`);
  const resolved = resolve(repositoryRoot, path);
  assert.ok(resolved.startsWith(`${repositoryRoot}${sep}`), `${label} escapes repository`);
  return resolved;
}

export async function verifyLadybugNativeReceipts({
  inventoryPath = defaultInventoryPath,
  sourceRoot,
  opensslSourceRoot,
  requireReleaseReady = false,
} = {}) {
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.componentSet, "ladybug-native-v0.18.0");
  assert.deepEqual(inventory.extensions, []);
  assert.deepEqual(inventory.binding, {
    crate: "lbug",
    version: "0.18.0",
    crateSha256: "f52ee74966e323212747aa22fa8c01f73f1cbbb996187c3b08cbf96ff9f67562",
    sourceBasisCommit: "ea283cd1bf5473cd5c233944e3b281eb0d758a45",
    sourceTreeSha256: "58ab1da5ce17d2ca6ae0a6d835b2384c6fd8c8627703bf93e77685419f7142ba",
    spdx: "MIT",
    licensePath: "vendor/ladybug/notices/ladybug-binding-LICENSE",
    noticeProvenance: "https://raw.githubusercontent.com/LadybugDB/ladybug-rust/7afc780e33fb42c8f9b2f0c4ab6833bf2f86c76f/LICENSE at SHA-256 1c495c9546d0de02e83c9d50d5f7eb21f0085bc8f77a0ee333081a123a9c8d0c (git blob 9bb12b2468f7629dd9a6ce15d4d972ad014ff40d)",
    receiptStatus: "upstream-license-vendored",
  });
  assert.deepEqual(inventory.core, {
    version: "0.18.0",
    commit: "0cda4fffcebb4a52cc24198462901ad28e2d5b66",
    sourceTreeSha256: "c90c2bd925e72dcc6c9e51c17b1a150589e719c949d364ded4a98389f0aabe62",
    spdx: "MIT",
    licensePath: "vendor/ladybug/notices/ladybug-core-LICENSE",
  });
  assert.deepEqual(inventory.openssl, {
    version: "3.5.8",
    sourceSha256: "a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2",
    spdx: "Apache-2.0",
    licensePath: "vendor/ladybug/notices/openssl-LICENSE.txt",
    noticePath: "vendor/ladybug/notices/openssl-NOTICE.md",
    sourceLicensePath: "LICENSE.txt",
    sourceLicenseSha256: "7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a",
    sourceVerificationPrecondition: "verified OpenSSL 3.5.8 source archive with the pinned sourceSha256",
    linkage: "static",
  });

  const components = new Map();
  for (const component of inventory.nativeComponents) {
    assert.ok(!components.has(component.name), `duplicate native component: ${component.name}`);
    components.set(component.name, component);
    assert.match(component.sourceTreeSha256, sha256Pattern, `${component.name} source digest`);
    assert.ok(["compiled", "configured-not-linked", "source-tooling"].includes(component.disposition));
    if (component.disposition === "compiled") {
      assert.ok(component.spdx, `${component.name} has no SPDX expression`);
      assert.ok(component.licensePath, `${component.name} has no license notice`);
      if (!component.licenseSource) {
        assert.ok(component.noticeProvenance, `${component.name} has no notice provenance`);
      }
    }
  }
  assert.deepEqual(
    [...components.keys()].sort(),
    [...inventory.expectedNativeSubtrees].sort(),
    "every native subtree must have exactly one inventory entry",
  );
  assert.equal(new Set(inventory.expectedNativeSubtrees).size, inventory.expectedNativeSubtrees.length);

  const licensePaths = new Set([
    inventory.binding.licensePath,
    inventory.core.licensePath,
    inventory.openssl.licensePath,
    inventory.openssl.noticePath,
    ...inventory.nativeComponents.filter(({ licensePath }) => licensePath).map(({ licensePath }) => licensePath),
  ]);
  assert.deepEqual(
    [...licensePaths].sort(),
    Object.keys(inventory.noticeSha256).sort(),
    "every license notice path must have exactly one digest entry",
  );
  for (const licensePath of licensePaths) {
    const path = resolveRepositoryPath(licensePath, "licensePath");
    assert.ok((await stat(path)).isFile(), `license notice is not a file: ${licensePath}`);
    assert.ok((await readFile(path)).length > 0, `license notice is empty: ${licensePath}`);
    assert.equal(await sha256File(path), inventory.noticeSha256[licensePath], `license notice changed: ${licensePath}`);
  }

  // An unlisted file under `vendor/ladybug/notices/` would ship without a digest
  // or provenance, so the directory must contain exactly the inventoried notices.
  const noticesRoot = resolveRepositoryPath("vendor/ladybug/notices", "notices root");
  const expectedNotices = Object.keys(inventory.noticeSha256)
    .map((path) => path.slice("vendor/ladybug/notices/".length))
    .sort();
  assert.deepEqual(
    await collectNoticeFiles(noticesRoot),
    expectedNotices,
    "notices directory must contain exactly the inventoried files",
  );

  assert.deepEqual(inventory.systemRuntimes, [
    { name: "Apple libc++ and libSystem", targets: ["aarch64-apple-darwin", "x86_64-apple-darwin"], shipped: false, classification: "operating-system-runtime" },
    { name: "Microsoft Visual C++ Runtime", targets: ["x86_64-pc-windows-msvc"], shipped: false, classification: "system-runtime-prerequisite" },
  ]);
  const knownReleaseBlockers = ["lbug-binding-missing-upstream-license-file"];
  assert.ok(
    Array.isArray(inventory.releaseBlockers)
      && inventory.releaseBlockers.every((blocker) => knownReleaseBlockers.includes(blocker)),
    `native inventory declares an unrecognized release blocker: ${JSON.stringify(inventory.releaseBlockers)}`,
  );
  if (requireReleaseReady) {
    assert.deepEqual(inventory.releaseBlockers, [], "native receipt is not release-ready");
  }

  if (sourceRoot) {
    const crateRoot = resolve(sourceRoot);
    const thirdPartyRoot = join(crateRoot, "lbug-src", "third_party");
    const actualSubtrees = (await readdir(thirdPartyRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(actualSubtrees, [...inventory.expectedNativeSubtrees].sort(), "unlisted native subtree");
    assert.equal(await sha256Tree(join(crateRoot, "src")), inventory.binding.sourceTreeSha256, "binding source tree changed");
    assert.equal(await sha256Tree(join(crateRoot, "lbug-src")), inventory.core.sourceTreeSha256, "embedded core tree changed");
    for (const component of inventory.nativeComponents) {
      assert.equal(
        await sha256Tree(join(thirdPartyRoot, component.name)),
        component.sourceTreeSha256,
        `${component.name} source tree changed`,
      );
      if (component.licenseSource) {
        const expectedNotice = await renderSourceNotice(thirdPartyRoot, component);
        assert.deepEqual(
          await readFile(resolveRepositoryPath(component.licensePath, "licensePath")),
          expectedNotice,
          `${component.name} notice differs from exact embedded license bytes`,
        );
      }
    }
  }
  if (opensslSourceRoot) {
    const sourceLicense = resolve(opensslSourceRoot, inventory.openssl.sourceLicensePath);
    assert.equal(await sha256File(sourceLicense), inventory.openssl.sourceLicenseSha256, "OpenSSL source license changed");
    assert.deepEqual(
      await readFile(sourceLicense),
      await readFile(resolveRepositoryPath(inventory.openssl.licensePath, "licensePath")),
      "OpenSSL notice differs from exact 3.5.8 source license",
    );
  }
  return inventory;
}

async function collectNoticeFiles(root, directory = root, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectNoticeFiles(root, path, output);
    else if (entry.isFile()) output.push(relative(root, path).replaceAll("\\", "/"));
    else throw new Error(`unsupported notice entry: ${relative(root, path)}`);
  }
  return output.sort();
}

async function renderSourceNotice(thirdPartyRoot, component) {
  const sourcePath = resolve(join(thirdPartyRoot, component.name), component.licenseSource.path);
  assert.ok(
    sourcePath.startsWith(`${join(thirdPartyRoot, component.name)}${sep}`),
    `${component.name} license source escapes its subtree`,
  );
  const source = await readFile(sourcePath);
  if (!component.licenseSource.lineStart) return source;
  const lines = source.toString("utf8").split(/(?<=\n)/u);
  return Buffer.from(lines.slice(component.licenseSource.lineStart - 1, component.licenseSource.lineEnd).join(""));
}

async function generateNotices(inventoryPath, sourceRoot) {
  assert.ok(sourceRoot, "--generate-notices requires --source-root");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const thirdPartyRoot = join(resolve(sourceRoot), "lbug-src", "third_party");
  for (const component of inventory.nativeComponents.filter(({ licenseSource }) => licenseSource)) {
    const output = resolveRepositoryPath(component.licensePath, "licensePath");
    await mkdir(resolve(output, ".."), { recursive: true });
    await writeFile(output, await renderSourceNotice(thirdPartyRoot, component));
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--inventory") options.inventoryPath = resolve(argv[++index]);
    else if (argument === "--source-root") options.sourceRoot = resolve(argv[++index]);
    else if (argument === "--openssl-source-root") options.opensslSourceRoot = resolve(argv[++index]);
    else if (argument === "--release-ready") options.requireReleaseReady = true;
    else if (argument === "--generate-notices") options.generateNotices = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArguments(process.argv.slice(2));
  if (options.generateNotices) await generateNotices(options.inventoryPath ?? defaultInventoryPath, options.sourceRoot);
  const inventory = await verifyLadybugNativeReceipts(options);
  // The blocker phrase must match what this invocation actually verified: plain
  // mode preserves any recognized blocker it found, while --release-ready
  // asserted the list is empty.
  const blockerPhrase = options.requireReleaseReady
    ? "no release blockers declared; blocker gate enforced"
    : inventory.releaseBlockers.length === 0
      ? "no release blockers declared"
      : `release blockers preserved: ${inventory.releaseBlockers.join(", ")}`;
  console.log(`Ladybug native receipt verified: ${inventory.nativeComponents.length} subtrees inventoried; ${blockerPhrase}`);
}
