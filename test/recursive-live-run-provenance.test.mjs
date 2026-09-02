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
  it("binds workspace, executable, and bundle bytes into one execution identity and fails drift closed", () => {
    const path = repository();
    const provenance = workspaceProvenance(path);

    expect(provenance.commit, "a clean workspace pins its exact commit").toMatch(/^[0-9a-f]{40}$/u);
    expect(provenance.clean, "a fresh fixture repository is clean").toBe(true);
    expect(provenance.workspaceDigest, "workspace digest shape").toMatch(/^sha256:[0-9a-f]{64}$/u);

    writeFileSync(join(path, "tracked.txt"), "second\n");
    writeFileSync(join(path, "private-name.txt"), "untracked bytes\n");
    const dirty = workspaceProvenance(path);
    expect(dirty.clean, "tracked edits dirty the workspace").toBe(false);
    expect(dirty.workspaceDigest, "the digest moves with the workspace bytes").not.toBe(provenance.workspaceDigest);
    expect(JSON.stringify(dirty), "untracked file names stay private").not.toContain("private-name");

    writeFileSync(join(path, "tracked.txt"), Buffer.from([0x80]));
    const rawDigest = workspaceProvenance(path).workspaceDigest;
    writeFileSync(join(path, "tracked.txt"), Buffer.from([0x81]));
    expect(workspaceProvenance(path).workspaceDigest, "diffs hash raw bytes, not lossy UTF-8 text").not.toBe(rawDigest);

    const executable = join(path, "fixture-bin");
    writeFileSync(executable, "binary bytes");
    expect(executableProvenance(executable, "fixture 1.0"), "executable bytes and version").toMatchObject({
      bytes: 12,
      version: "fixture 1.0",
      sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });

    const bundle = join(path, "dist");
    mkdirSync(bundle);
    writeFileSync(join(bundle, "b.js"), "b");
    writeFileSync(join(bundle, "a.js"), "a");
    const inputs = {
      repositoryRoot: path,
      executables: { fixture: { path: executable, version: "fixture 1.0" } },
      bundles: { rootDist: bundle },
    };
    const identity = executionIdentity(inputs);
    expect(directoryProvenance(bundle), "generated-directory byte census").toMatchObject({ files: 2, bytes: 2 });

    const record = liveRunProvenance({
      harnessConfigurationDigest: "sha256:harness",
      temporalFeatureSchemaVersion: 1,
      identity,
      now: new Date("2026-08-30T12:00:00.000Z"),
      runId: "run-fixture",
    });
    expect(record, "the immutable comparison header").toMatchObject({
      schemaVersion: 1,
      runId: "run-fixture",
      createdAt: "2026-08-30T12:00:00.000Z",
      harnessConfigurationDigest: "sha256:harness",
      temporalFeatureSchemaVersion: 1,
      executables: { fixture: { version: "fixture 1.0" } },
      bundles: { rootDist: { files: 2 } },
    });

    expect(() => assertExecutionIdentity(identity, executionIdentity(inputs), "before-enabled"),
      "stable bytes keep the execution identity").not.toThrow();
    writeFileSync(join(bundle, "a.js"), "changed");
    expect(() => assertExecutionIdentity(identity, executionIdentity(inputs), "after-enabled"),
      "generated-byte drift fails closed and names the checkpoint")
      .toThrow("Live-run execution identity changed at after-enabled");
  }, 20_000);

  it("publishes only public profile selection, bounded timeouts, and atomic Check 1 verdicts", () => {
    const subscriptionProfile = {
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
    };
    const digest = publicProfileDigest(subscriptionProfile);
    expect(digest, "profile digest shape").toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(digest, "homes, keys, and trailing slashes never enter the digest").toBe(publicProfileDigest({
      ...subscriptionProfile,
      endpoint: "https://api.example.test/v1",
      codexHome: "/different/private/home",
      apiKey: "different-secret",
    }));

    const apiProfile = {
      name: "api", harness: "codex-basic", implementation: "codex.basic",
      providerId: "codex", adapterId: "openai-api", contract: "secret@1", modelId: "gpt",
    };
    const gateway = publicProfileDigest({ ...apiProfile, endpoint: "https://gateway.example.test/v1/" });
    expect(gateway, "endpoint normalization").toBe(
      publicProfileDigest({ ...apiProfile, endpoint: "https://gateway.example.test/v1" }),
    );
    expect(gateway, "a different endpoint changes the digest").not.toBe(
      publicProfileDigest({ ...apiProfile, endpoint: "https://other.example.test/v1" }),
    );
    expect(gateway, "the endpoint never appears in the digest").not.toContain("gateway.example.test");
    expect(() => publicProfileDigest({ ...apiProfile, endpoint: "https://user:secret@example.test/v1" }),
      "endpoints carry no credentials").toThrow(/without credentials/);

    expect(liveRunTimeoutMs("900000"), "an explicit paid-arm timeout parses").toBe(900_000);
    const invalidTimeouts = ["0", "-1", "1.5", "nope", String(MAX_LIVE_RUN_TIMEOUT_MS + 1)];
    expect(invalidTimeouts, "timeout guard inventory").toHaveLength(5);
    for (const invalid of invalidTimeouts) {
      expect(() => liveRunTimeoutMs(invalid), `timeout ${invalid} is rejected before execution`).toThrow(/--timeout-ms/);
    }

    const directory = mkdtempSync(join(tmpdir(), "recursive-live-receipt-"));
    directories.push(directory);
    const receipt = join(directory, "run.json");
    writeJsonAtomic(receipt, { status: "check1-passed", verificationLevel: "check1" });
    expect(JSON.parse(readFileSync(receipt, "utf8")), "one complete receipt").toEqual({
      status: CHECK1_STATUS.passed,
      verificationLevel: CHECK1_VERIFICATION_LEVEL,
    });
    expect(statSync(receipt).mode & 0o777, "the receipt is owner-only").toBe(0o600);
    expect(readdirSync(directory), "no temporary litter").toEqual(["run.json"]);

    expect(CHECK1_VERIFICATION_LEVEL, "the top-level verdict stays Check 1").toBe("check1");
    expect(CHECK1_STATUS, "every verdict names Check 1 rather than a merge-gate pass").toEqual({
      running: "check1-running",
      passed: "check1-passed",
      failed: "check1-failed",
    });
  }, 20_000);
});
