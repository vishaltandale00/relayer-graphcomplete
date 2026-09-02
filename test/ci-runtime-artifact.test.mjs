import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  createRuntimeArtifact,
  verifyRuntimeArtifact,
} from "../scripts/ci/runtime-artifact.mjs";

describe("Rust runtime workflow artifact", () => {
  test("installs only exact-match binaries after rejecting every mismatched identity, digest, and inventory boundary", () => {
    const repository = mkdtempSync(join(tmpdir(), "relayer-runtime-source-"));
    const artifactDirectory = mkdtempSync(
      join(tmpdir(), "relayer-runtime-artifact-"),
    );
    const installDirectory = mkdtempSync(
      join(tmpdir(), "relayer-runtime-install-"),
    );
    try {
      const targetDirectory = join(repository, "target", "debug");
      mkdirSync(targetDirectory, { recursive: true });
      writeFileSync(join(repository, "Cargo.lock"), "version = 4\n");
      writeFileSync(
        join(targetDirectory, "relayer-app-server"),
        "trusted-app-bytes",
      );
      writeFileSync(
        join(targetDirectory, "relayer-graph-server"),
        "trusted-graph-bytes",
      );

      const options = {
        repository,
        targetDirectory,
        artifactDirectory,
        installDirectory,
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        platform: "Linux-X64",
        rustcRelease: "1.94.0",
        cargoProfile: "debug-line-tables-only",
        packages: ["relayer-app-server", "relayer-graph-server"],
      };
      const original = createRuntimeArtifact(options);
      const manifestPath = join(artifactDirectory, "manifest.json");
      const writeManifest = (manifest) =>
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const expectRejected = (label, message, attempt) => {
        expect(attempt, `${label}: verification must throw`).toThrow(message);
        expect(
          readdirSync(installDirectory),
          `${label}: nothing is installed after rejection`,
        ).toEqual([]);
      };

      // Every manifest identity field is a reject boundary.
      const identityCases = [
        ["version", 2, "version: artifact identity mismatch"],
        [
          "sourceCommit",
          "89abcdef0123456789abcdef0123456789abcdef",
          "sourceCommit: artifact identity mismatch",
        ],
        ["platform", "Linux-ARM64", "platform: artifact identity mismatch"],
        ["rustcRelease", "1.95.0", "rustcRelease: artifact identity mismatch"],
        [
          "cargoLockSha256",
          "0".repeat(64),
          "cargoLockSha256: artifact identity mismatch",
        ],
        ["cargoProfile", "release", "cargoProfile: artifact identity mismatch"],
        ["featureSet", "all", "featureSet: artifact identity mismatch"],
      ];
      expect(identityCases).toHaveLength(7);
      for (const [field, value, message] of identityCases) {
        writeManifest({ ...original, [field]: value });
        expectRejected(`tampered manifest ${field}`, message, () =>
          verifyRuntimeArtifact(options));
      }
      writeManifest(original);

      // The caller-supplied identity is checked too, not just the manifest.
      expectRejected(
        "mismatched cargoProfile in the verify request",
        "cargoProfile: artifact identity mismatch",
        () => verifyRuntimeArtifact({ ...options, cargoProfile: "debug" }),
      );

      // Modified binary bytes are rejected by digest before installation.
      const graphBinary = join(artifactDirectory, "bin", "relayer-graph-server");
      writeFileSync(graphBinary, "modified-bytes");
      expectRejected(
        "modified binary bytes",
        "relayer-graph-server: artifact digest mismatch",
        () => verifyRuntimeArtifact(options),
      );
      writeFileSync(graphBinary, "trusted-graph-bytes");

      // Binary names cannot escape the install directory.
      writeManifest({
        ...original,
        binaries: [{ ...original.binaries[0], name: "../escape" }],
      });
      expectRejected(
        "path-traversal binary name",
        "../escape: invalid binary name",
        () => verifyRuntimeArtifact(options),
      );
      writeManifest(original);

      // Unexpected files in the artifact inventory are rejected.
      writeFileSync(join(artifactDirectory, "bin", "unexpected"), "bytes");
      expectRejected(
        "unexpected binary in the artifact inventory",
        "artifact binary inventory mismatch",
        () => verifyRuntimeArtifact(options),
      );
      rmSync(join(artifactDirectory, "bin", "unexpected"));

      // An untampered artifact verifies and installs the exact bytes.
      verifyRuntimeArtifact(options);
      expect(
        readFileSync(join(installDirectory, "relayer-app-server"), "utf8"),
        "the app-server binary installs byte-for-byte",
      ).toBe("trusted-app-bytes");
      expect(
        readFileSync(join(installDirectory, "relayer-graph-server"), "utf8"),
        "the graph-server binary installs byte-for-byte",
      ).toBe("trusted-graph-bytes");
    } finally {
      rmSync(repository, { recursive: true, force: true });
      rmSync(artifactDirectory, { recursive: true, force: true });
      rmSync(installDirectory, { recursive: true, force: true });
    }
  });
});
