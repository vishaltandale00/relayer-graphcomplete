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
  test("installs only binaries bound to the exact source and toolchain inputs", () => {
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
        join(targetDirectory, "relayer-graph-server"),
        "graph-server-bytes",
      );
      writeFileSync(
        join(targetDirectory, "relayer-app-server"),
        "app-server-bytes",
      );

      const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
      createRuntimeArtifact({
        repository,
        targetDirectory,
        artifactDirectory,
        sourceCommit,
        platform: "Linux-X64",
        rustcRelease: "1.94.0",
        cargoProfile: "debug-line-tables-only",
        packages: ["relayer-app-server", "relayer-graph-server"],
      });
      verifyRuntimeArtifact({
        repository,
        artifactDirectory,
        installDirectory,
        sourceCommit,
        platform: "Linux-X64",
        rustcRelease: "1.94.0",
        cargoProfile: "debug-line-tables-only",
      });

      expect(
        readFileSync(join(installDirectory, "relayer-app-server"), "utf8"),
      ).toBe("app-server-bytes");
      expect(
        readFileSync(join(installDirectory, "relayer-graph-server"), "utf8"),
      ).toBe("graph-server-bytes");
    } finally {
      rmSync(repository, { recursive: true, force: true });
      rmSync(artifactDirectory, { recursive: true, force: true });
      rmSync(installDirectory, { recursive: true, force: true });
    }
  });

  test("rejects modified binary bytes instead of installing them", () => {
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
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        platform: "Linux-X64",
        rustcRelease: "1.94.0",
        cargoProfile: "debug-line-tables-only",
        packages: ["relayer-app-server", "relayer-graph-server"],
      };
      createRuntimeArtifact(options);
      expect(() =>
        verifyRuntimeArtifact({
          ...options,
          cargoProfile: "debug",
          installDirectory,
        }),
      ).toThrow("cargoProfile: artifact identity mismatch");
      expect(readdirSync(installDirectory)).toEqual([]);

      writeFileSync(
        join(artifactDirectory, "bin", "relayer-graph-server"),
        "modified-bytes",
      );

      expect(() =>
        verifyRuntimeArtifact({
          ...options,
          installDirectory,
        }),
      ).toThrow("relayer-graph-server: artifact digest mismatch");
      expect(readdirSync(installDirectory)).toEqual([]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
      rmSync(artifactDirectory, { recursive: true, force: true });
      rmSync(installDirectory, { recursive: true, force: true });
    }
  });

  test("rejects every mismatched identity and inventory boundary before installation", () => {
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
      const options = {
        repository,
        targetDirectory,
        artifactDirectory,
        installDirectory,
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        platform: "Linux-X64",
        rustcRelease: "1.94.0",
        cargoProfile: "debug-line-tables-only",
        packages: ["relayer-app-server"],
      };
      const original = createRuntimeArtifact(options);
      const manifestPath = join(artifactDirectory, "manifest.json");
      const cases = [
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
      for (const [field, value, message] of cases) {
        writeFileSync(
          manifestPath,
          `${JSON.stringify({ ...original, [field]: value }, null, 2)}\n`,
        );
        expect(() => verifyRuntimeArtifact(options)).toThrow(message);
        expect(readdirSync(installDirectory)).toEqual([]);
      }

      writeFileSync(
        manifestPath,
        `${JSON.stringify(
          {
            ...original,
            binaries: [{ ...original.binaries[0], name: "../escape" }],
          },
          null,
          2,
        )}\n`,
      );
      expect(() => verifyRuntimeArtifact(options)).toThrow(
        "../escape: invalid binary name",
      );
      expect(readdirSync(installDirectory)).toEqual([]);

      writeFileSync(manifestPath, `${JSON.stringify(original, null, 2)}\n`);
      writeFileSync(join(artifactDirectory, "bin", "unexpected"), "bytes");
      expect(() => verifyRuntimeArtifact(options)).toThrow(
        "artifact binary inventory mismatch",
      );
      expect(readdirSync(installDirectory)).toEqual([]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
      rmSync(artifactDirectory, { recursive: true, force: true });
      rmSync(installDirectory, { recursive: true, force: true });
    }
  });
});
