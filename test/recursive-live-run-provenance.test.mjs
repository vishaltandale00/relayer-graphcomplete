import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CHECK1_STATUS,
  CHECK1_VERIFICATION_LEVEL,
  MAX_LIVE_RUN_TIMEOUT_MS,
  assertExecutionIdentity,
  directoryProvenance,
  executionIdentity,
  executableProvenance,
  liveRunProvenance,
  liveRunTimeoutMs,
  publicProfileDigest,
  writeJsonAtomic,
  workspaceProvenance,
} from "../scripts/recursive-live-run-provenance.mjs";

const directories = [];

function repository() {
  const path = mkdtempSync(join(tmpdir(), "recursive-live-provenance-"));
  directories.push(path);
  execFileSync("git", ["init", "-q"], { cwd: path });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: path });
  writeFileSync(join(path, "tracked.txt"), "first\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: path });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: path });
  return path;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("recursive live-run provenance", () => {
  it("binds a clean workspace to its exact commit", () => {
    const path = repository();
    const provenance = workspaceProvenance(path);

    expect(provenance.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(provenance.clean).toBe(true);
    expect(provenance.workspaceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("changes the private workspace digest for tracked and untracked bytes", () => {
    const path = repository();
    const clean = workspaceProvenance(path);
    writeFileSync(join(path, "tracked.txt"), "second\n");
    writeFileSync(join(path, "private-name.txt"), "untracked bytes\n");
    const dirty = workspaceProvenance(path);

    expect(dirty.clean).toBe(false);
    expect(dirty.workspaceDigest).not.toBe(clean.workspaceDigest);
    expect(JSON.stringify(dirty)).not.toContain("private-name");
  });

  it("hashes tracked diffs as raw bytes rather than lossy UTF-8 text", () => {
    const path = repository();
    writeFileSync(join(path, "tracked.txt"), Buffer.from([0x80]));
    const first = workspaceProvenance(path).workspaceDigest;
    writeFileSync(join(path, "tracked.txt"), Buffer.from([0x81]));

    expect(workspaceProvenance(path).workspaceDigest).not.toBe(first);
  });

  it("records executable bytes and the immutable comparison header", () => {
    const path = repository();
    const executable = join(path, "fixture-bin");
    writeFileSync(executable, "binary bytes");

    expect(executableProvenance(executable, "fixture 1.0")).toMatchObject({
      bytes: 12,
      version: "fixture 1.0",
      sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    const bundle = join(path, "dist");
    mkdirSync(bundle);
    writeFileSync(join(bundle, "index.js"), "generated bundle");
    const identity = executionIdentity({
      repositoryRoot: path,
      executables: { fixture: { path: executable, version: "fixture 1.0" } },
      bundles: { rootDist: bundle },
    });
    const provenance = liveRunProvenance({
      harnessConfigurationDigest: "sha256:harness",
      temporalFeatureSchemaVersion: 1,
      identity,
      now: new Date("2026-08-30T12:00:00.000Z"),
      runId: "run-fixture",
    });

    expect(provenance).toMatchObject({
      schemaVersion: 1,
      runId: "run-fixture",
      createdAt: "2026-08-30T12:00:00.000Z",
      harnessConfigurationDigest: "sha256:harness",
      temporalFeatureSchemaVersion: 1,
      executables: { fixture: { version: "fixture 1.0" } },
      bundles: { rootDist: { files: 1 } },
    });
  });

  it("digests only public run-profile selection", () => {
    const digest = publicProfileDigest({
      name: "subscription",
      harness: "codex-basic",
      implementation: "codex.basic",
      providerId: "codex",
      adapterId: "codex-subscription",
      contract: "managed-runtime@1",
      modelId: "gpt-5.6-sol",
      endpoint: "https://api.example.test/v1/",
      codexHome: "/private/home",
      apiKey: "secret",
    });

    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(digest).toBe(publicProfileDigest({
      name: "subscription",
      harness: "codex-basic",
      implementation: "codex.basic",
      providerId: "codex",
      adapterId: "codex-subscription",
      contract: "managed-runtime@1",
      modelId: "gpt-5.6-sol",
      endpoint: "https://api.example.test/v1",
      codexHome: "/different/private/home",
      apiKey: "different-secret",
    }));
  });

  it("binds a normalized public endpoint without exposing it", () => {
    const profile = {
      name: "api", harness: "codex-basic", implementation: "codex.basic",
      providerId: "codex", adapterId: "openai-api", contract: "secret@1", modelId: "gpt",
    };
    const first = publicProfileDigest({ ...profile, endpoint: "https://gateway.example.test/v1/" });
    const normalized = publicProfileDigest({ ...profile, endpoint: "https://gateway.example.test/v1" });
    const other = publicProfileDigest({ ...profile, endpoint: "https://other.example.test/v1" });

    expect(first).toBe(normalized);
    expect(first).not.toBe(other);
    expect(first).not.toContain("gateway.example.test");
    expect(() => publicProfileDigest({ ...profile, endpoint: "https://user:secret@example.test/v1" }))
      .toThrow(/without credentials/);
  });

  it("bounds the paid-arm timeout before execution", () => {
    expect(liveRunTimeoutMs("900000")).toBe(900_000);
    for (const invalid of ["0", "-1", "1.5", "nope", String(MAX_LIVE_RUN_TIMEOUT_MS + 1)]) {
      expect(() => liveRunTimeoutMs(invalid)).toThrow(/--timeout-ms/);
    }
  });

  it("binds stable generated-directory bytes and fails identity drift closed", () => {
    const path = repository();
    const executable = join(path, "fixture-bin");
    const bundle = join(path, "dist");
    writeFileSync(executable, "binary bytes");
    mkdirSync(bundle);
    writeFileSync(join(bundle, "b.js"), "b");
    writeFileSync(join(bundle, "a.js"), "a");
    const inputs = {
      repositoryRoot: path,
      executables: { node: { path: executable, version: "v1" } },
      bundles: { rootDist: bundle },
    };
    const first = executionIdentity(inputs);
    expect(directoryProvenance(bundle)).toMatchObject({ files: 2, bytes: 2 });
    expect(() => assertExecutionIdentity(first, executionIdentity(inputs), "before-enabled")).not.toThrow();

    writeFileSync(join(bundle, "a.js"), "changed");
    expect(() => assertExecutionIdentity(first, executionIdentity(inputs), "after-enabled"))
      .toThrow("Live-run execution identity changed at after-enabled");
  });

  it("atomically publishes one complete private JSON receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "recursive-live-receipt-"));
    directories.push(directory);
    const path = join(directory, "run.json");
    writeJsonAtomic(path, { status: "check1-passed", verificationLevel: "check1" });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      status: CHECK1_STATUS.passed,
      verificationLevel: CHECK1_VERIFICATION_LEVEL,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(["run.json"]);
  });

  it("names every top-level verdict as Check 1 rather than a merge-gate pass", () => {
    expect(CHECK1_VERIFICATION_LEVEL).toBe("check1");
    expect(CHECK1_STATUS).toEqual({
      running: "check1-running",
      passed: "check1-passed",
      failed: "check1-failed",
    });
  });
});
