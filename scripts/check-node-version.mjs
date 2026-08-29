#!/usr/bin/env node
// Fails the job when the running Node does not match the pinned toolchain.
//
// Workflows declare their Node through `node-version-file: .node-version`, but a
// runner can still hand a job something else: a stale tool cache, a partial
// setup-node failure, or a `nvm use` earlier in the shell. Declaring the version
// is not the same as running it, and only the running version signs a release.
// Uses builtins only so it can run before `npm ci`.

import { readFileSync } from "node:fs";

const versionFile = new URL("../.node-version", import.meta.url);
const expected = readFileSync(versionFile, "utf8").trim();
const actual = process.version.replace(/^v/, "");

if (expected !== actual) {
  console.error(
    `Node toolchain mismatch: .node-version pins ${expected} but this job is running ${actual}.\n` +
      "The declared and running toolchain must be identical; a release signed by an undeclared Node is not reproducible.",
  );
  process.exit(1);
}

console.log(`Node toolchain verified: ${actual} matches .node-version.`);
