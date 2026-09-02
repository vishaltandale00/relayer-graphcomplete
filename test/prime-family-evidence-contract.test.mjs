import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("packaged Prime family evidence contract", () => {
  it("pins the packaged capture script, contract matrix, package command, and loadable matrix module", async () => {
    const capture = await readFile(resolve(root, "scripts/capture-packaged-prime-family-evidence.mjs"), "utf8");
    const captureTokens = [
      "exact packaged product drive", 'listPackage(asar)',
      "active OpenAI adapter", 'main/providers/implementations/openai-api.mjs',
      "packaged prime harness", 'node_modules/@relayer/harness-host/dist/implementations/prime-agent.js',
      "adapter pin", 'providerAdapter: "openai-api"',
      "no fixture harness injection", 'fixtureHarnessOrAdapterInjected: false',
      "no release configuration override", 'releaseConfigurationOverrideEnabled: false',
    ];
    for (const [label, token] of captureTokens) {
      expect.soft(capture, `capture script keeps ${label}`).toContain(token);
    }
    for (const forbidden of ["additionalImplementations", "taskSystemFixtureFactory", "allowHarnessOverride"]) {
      expect.soft(capture, `capture script never references ${forbidden}`).not.toContain(forbidden);
    }
    for (const scenario of [
      "01-clean-profile-incompatible-default",
      "02-explicit-prime-choice",
      "03-family-members-selected",
      "04-explicit-root-selection",
      "05-root-child-accepted-graph",
      "06-follow-up-new-root-same-session",
      "07-restart-resume",
      "08-ask-boundary",
      "09-denial-receipt-and-new-boundary",
      "10-revoked-draft-blocked",
      "sameSession",
      "Decoded first, middle, and last playback frames must be visibly distinct.",
    ]) {
      expect.soft(capture, `capture script covers ${scenario}`).toContain(scenario);
    }

    const matrixSource = await readFile(resolve(root, "scripts/prime-evidence/contract-matrix.mjs"), "utf8");
    for (const [label, token] of [
      ["ordered three-model roster", "orderedThreeModelRoster: true"],
      ["two provider adapters", 'twoProviderAdapters: ["openai-api", "anthropic-api"]'],
      ["isolated definitions sharing one adapter", "isolatedDefinitionsSharingAdapter: 2"],
      ["credentials resolved before the Prime prompt", "allCredentialsResolvedBeforePrimePrompt: true"],
      ["family admission and orchestrator alias", "admits the complete ordered family, deduplicates access by provider definition, and aliases orchestrator access"],
      ["family access rollback", "rolls back already-acquired family access when a later provider cannot be acquired"],
      ["Ask boundary with approval", "askBoundaryAndApproval: true"],
      ["Auto allows only attested ipynb", "autoAllowsOnlyAttestedIpynb: true"],
      ["Full omits bounded scopes", "fullOmitsBoundedScopes: true"],
      ["Prime source test paths", "PRIME_SOURCE_TEST_PATHS"],
      ["authority cleanup race coverage", "71-authority-cleanup-races.test.ts"],
      ["bounded kernel coverage", "71-bounded-kernel.test.ts"],
      ["Prime source mismatch diagnostic", "Prime source mismatch"],
    ]) {
      expect.soft(matrixSource, `contract matrix aggregates ${label}`).toContain(token);
    }

    const metadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    expect(metadata.scripts["evidence:prime-family:packaged"], "one explicit packaged evidence command")
      .toBe("node scripts/capture-packaged-prime-family-evidence.mjs");

    // Text-token checks cannot catch a syntax or import failure; the module is
    // dependency-free, so load the real seam.
    const matrix = await import("../scripts/prime-evidence/contract-matrix.mjs");
    expect(matrix.PRIME_CONTRACT_TEST_NAMES.length, "Prime contract test inventory").toBeGreaterThan(0);
    expect(matrix.HOST_CONTRACT_TEST_NAMES.length, "host contract test inventory").toBeGreaterThan(0);
    expect(matrix.PRIME_SOURCE_TEST_PATHS.length, "Prime source test path inventory").toBeGreaterThan(0);
    expect(typeof matrix.verifyPrimeContractMatrix, "matrix verification entry point").toBe("function");
  });
});
