import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";

const CRATES_IO_SOURCE = "registry+https://github.com/rust-lang/crates.io-index";

function lockPackage(lockText, name) {
  for (const block of lockText.split(/^\[\[package\]\]\s*$/mu).slice(1)) {
    const fields = Object.fromEntries(
      [...block.matchAll(/^(name|version|source|checksum) = "([^"]*)"$/gmu)]
        .map((match) => [match[1], match[2]]),
    );
    if (fields.name === name) return fields;
  }
  throw new Error(`Cargo.lock does not contain the ${name} package`);
}

export function digestCargoResolvedLbugTree(root) {
  const digest = createHash("sha256");
  function visit(directory) {
    const entries = readdirSync(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const normalized = relative(root, path).replaceAll("\\", "/");
      const info = lstatSync(path);
      // Cargo adds this registry bookkeeping marker after unpacking. It is
      // not in the published crate archive or the source-preparation input.
      if (directory === root && entry.name === ".cargo-ok") {
        if (!info.isFile()) {
          throw new Error("Cargo registry .cargo-ok marker is not a regular file");
        }
        continue;
      }
      if (info.isDirectory()) {
        digest.update(`D\0${normalized}\0`);
        visit(path);
      } else if (info.isSymbolicLink()) {
        digest.update(`L\0${normalized}\0${readlinkSync(path)}\0`);
      } else if (info.isFile()) {
        const bytes = readFileSync(path);
        digest.update(`F\0${normalized}\0${bytes.length}\0`);
        digest.update(bytes);
      } else {
        throw new Error(`unsupported Cargo-resolved lbug source entry: ${normalized}`);
      }
    }
  }
  visit(root);
  return digest.digest("hex");
}

export function assertResolvedLbugNativeSource({ packageMetadata, cargoLockText, contract }) {
  if (!packageMetadata) throw new Error("Cargo metadata does not contain the lbug package");
  const expected = contract.rustBinding;
  const packageRoot = dirname(packageMetadata.manifest_path ?? "");
  if (
    packageMetadata.name !== expected.crate ||
    packageMetadata.version !== expected.version ||
    packageMetadata.source !== CRATES_IO_SOURCE ||
    basename(packageMetadata.manifest_path ?? "") !== "Cargo.toml"
  ) {
    throw new Error(
      "Cargo-resolved lbug package identity changed; re-review the native source contract",
    );
  }

  const locked = lockPackage(cargoLockText, expected.crate);
  if (
    locked.version !== expected.version ||
    locked.source !== CRATES_IO_SOURCE ||
    locked.checksum !== expected.sha256
  ) {
    throw new Error("Cargo.lock lbug pin/checksum changed; re-review the native source contract");
  }

  const sourceTreeSha256 = digestCargoResolvedLbugTree(packageRoot);
  if (sourceTreeSha256 !== expected.nativeSourceTreeSha256) {
    throw new Error("Cargo-resolved lbug source tree changed; re-review the native source contract");
  }
  return { packageRoot, sourceTreeSha256, checksum: locked.checksum };
}
