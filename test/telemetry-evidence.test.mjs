import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runDeterministicTelemetryPortfolio,
  runTelemetryEvidence,
} from "../scripts/run-telemetry-evidence.mjs";

describe("deterministic telemetry evidence portfolio", () => {
  it("proves five component contracts at the local gateway and records native process proof as not run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "telemetry-evidence-test-"));
    const outputPath = join(directory, "evidence.json");
    try {
      const result = await runTelemetryEvidence({ outputPath });
      const artifactText = await readFile(outputPath, "utf8");
      const artifact = JSON.parse(artifactText);

      expect(result.outputPath).toBe(outputPath);
      expect(artifact).toEqual(result.artifact);
      expect(artifact.verdict).toBe("local-gateway-privacy-pass-release-indeterminate");
      expect(artifact.execution).toEqual({
        inference: false,
        liveAuth0: false,
        liveSentry: false,
        network: "loopback-only",
      });
      expect(artifact.checkpoints.positive).toHaveLength(5);
      expect(artifact.checkpoints.privacy).toHaveLength(165);
      expect(artifact.checkpoints.privacy.every((item) => item.rejected)).toBe(true);
      expect(artifact.checkpoints.adapterPrivacy).toHaveLength(99);
      expect(artifact.checkpoints.adapterPrivacy.every((item) => item.crossed === false)).toBe(true);
      expect(artifact.checkpoints.outbound.requestCount).toBe(5);
      expect(artifact.checkpoints.outbound.forbiddenQueuePersistence).toBe(false);
      expect(artifact.checkpoints.releaseSymbols).toMatchObject({
        status: "not-run",
        context: "preview-or-stable-release-candidate-only",
        deterministicFinding: "release-upload-authority-present-but-not-executed",
        signals: {
          sourceMapProduction: true,
          rustSymbolProduction: true,
          sentryUploadCommand: true,
          sentryUploadCredential: true,
        },
        networkUsed: false,
      });
      expect(artifact.checkpoints.productionAdapters).toEqual({
        status: "not-run",
        context: "invoke-npm-run-evidence-telemetry-for-production-portfolio",
      });
      expect(artifact.checkpoints.releaseSymbols.inspected).toHaveLength(4);
      expect(artifactText).not.toContain("privacy-sentinel");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records the deterministic production portfolio only after its exact test command passes", async () => {
    const invocations = [];
    const result = await runDeterministicTelemetryPortfolio({
      execute: async (command, args) => invocations.push([command, args]),
    });

    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toEqual([
      "cargo",
      ["test", "-p", "relayer-telemetry-capability", "--test", "panic_capability"],
    ]);
    expect(invocations[1][1]).toContain("test/desktop-renderer-error-reporting.test.mjs");
    expect(invocations[1][1]).toContain("test/desktop-telemetry-release-artifacts.test.mjs");
    expect(result).toMatchObject({
      status: "pass",
      fidelity: "deterministic-adapters-and-shared-rust-seam",
      limitations: ["spawned-production-rust-panic-not-run"],
    });
  });
});
