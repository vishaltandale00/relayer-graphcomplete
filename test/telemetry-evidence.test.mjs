import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runDeterministicTelemetryPortfolio,
  runTelemetryEvidence,
} from "../scripts/run-telemetry-evidence.mjs";

describe("deterministic telemetry evidence portfolio", () => {
  it("proves the local-gateway artifact and gates the production portfolio on its exact test command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "telemetry-evidence-test-"));
    const outputPath = join(directory, "evidence.json");
    try {
      const result = await runTelemetryEvidence({ outputPath });
      const artifactText = await readFile(outputPath, "utf8");
      const artifact = JSON.parse(artifactText);

      expect(result.outputPath, "artifact path").toBe(outputPath);
      expect(artifact, "artifact matches the returned summary").toEqual(result.artifact);
      expect(artifact.verdict, "local gateway verdict").toBe("local-gateway-privacy-pass-release-indeterminate");
      expect(artifact.execution, "declared execution boundary").toEqual({
        inference: false,
        liveAuth0: false,
        liveSentry: false,
        network: "loopback-only",
      });
      expect(artifact.checkpoints.positive, "positive component contracts").toHaveLength(5);
      expect(artifact.checkpoints.privacy, "privacy checkpoints").toHaveLength(165);
      expect(artifact.checkpoints.privacy.every((item) => item.rejected), "every privacy checkpoint rejected").toBe(true);
      expect(artifact.checkpoints.adapterPrivacy, "adapter privacy checkpoints").toHaveLength(99);
      expect(
        artifact.checkpoints.adapterPrivacy.every((item) => item.crossed === false),
        "no adapter privacy boundary crossed",
      ).toBe(true);
      expect(artifact.checkpoints.outbound.requestCount, "loopback request count").toBe(5);
      expect(artifact.checkpoints.outbound.forbiddenQueuePersistence, "no forbidden queue persistence").toBe(false);
      expect(artifact.checkpoints.releaseSymbols, "release symbols not run outside release context").toMatchObject({
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
      expect(artifact.checkpoints.productionAdapters, "production adapters deferred").toEqual({
        status: "not-run",
        context: "invoke-npm-run-evidence-telemetry-for-production-portfolio",
      });
      expect(artifact.checkpoints.releaseSymbols.inspected, "release symbol signals inspected").toHaveLength(4);
      expect(artifactText, "privacy sentinel never written").not.toContain("privacy-sentinel");

      const invocations = [];
      const portfolio = await runDeterministicTelemetryPortfolio({
        execute: async (command, args) => invocations.push([command, args]),
      });

      expect(invocations, "production portfolio command count").toHaveLength(2);
      expect(invocations[0], "shared Rust panic seam command").toEqual([
        "cargo",
        ["test", "-p", "relayer-telemetry-capability", "--test", "panic_capability"],
      ]);
      expect(invocations[1][1], "renderer error reporting test command").toContain("test/desktop-renderer-error-reporting.test.mjs");
      expect(invocations[1][1], "release artifacts test command").toContain("test/desktop-telemetry-release-artifacts.test.mjs");
      expect(portfolio, "deterministic production portfolio result").toMatchObject({
        status: "pass",
        fidelity: "deterministic-adapters-and-shared-rust-seam",
        limitations: ["spawned-production-rust-panic-not-run"],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
