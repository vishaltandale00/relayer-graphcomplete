import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("packaged Prime family evidence contract", () => {
  it("drives the exact packaged product with the active OpenAI adapter and no fixture harness", async () => {
    const source = await readFile(resolve(root, "scripts/capture-packaged-prime-family-evidence.mjs"), "utf8");
    expect(source).toContain('listPackage(asar)');
    expect(source).toContain('main/providers/implementations/openai-api.mjs');
    expect(source).toContain('node_modules/@relayer/harness-host/dist/implementations/prime-agent.js');
    expect(source).toContain('providerAdapter: "openai-api"');
    expect(source).toContain('fixtureHarnessOrAdapterInjected: false');
    expect(source).toContain('releaseConfigurationOverrideEnabled: false');
    expect(source).not.toContain("additionalImplementations");
    expect(source).not.toContain("taskSystemFixtureFactory");
    expect(source).not.toContain("allowHarnessOverride");
  });

  it("covers explicit family composition, roots, recursion, restart, and revocation", async () => {
    const source = await readFile(resolve(root, "scripts/capture-packaged-prime-family-evidence.mjs"), "utf8");
    for (const token of [
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
    ]) expect(source).toContain(token);
  });

  it("aggregates the three-model, multi-provider, same-adapter, and Ask/Auto/Full matrix", async () => {
    const source = await readFile(resolve(root, "scripts/prime-evidence/contract-matrix.mjs"), "utf8");
    expect(source).toContain("orderedThreeModelRoster: true");
    expect(source).toContain('twoProviderAdapters: ["openai-api", "anthropic-api"]');
    expect(source).toContain("isolatedDefinitionsSharingAdapter: 2");
    expect(source).toContain("allCredentialsResolvedBeforePrimePrompt: true");
    expect(source).toContain("admits the complete ordered family, deduplicates access by provider definition, and aliases orchestrator access");
    expect(source).toContain("rolls back already-acquired family access when a later provider cannot be acquired");
    expect(source).toContain("askBoundaryAndApproval: true");
    expect(source).toContain("autoAllowsOnlyAttestedIpynb: true");
    expect(source).toContain("fullOmitsBoundedScopes: true");
		expect(source).toContain("PRIME_SOURCE_TEST_PATHS");
		expect(source).toContain("71-authority-cleanup-races.test.ts");
		expect(source).toContain("71-bounded-kernel.test.ts");
		expect(source).toContain("Prime source mismatch");
  });

  it("exposes one explicit package command", async () => {
    const metadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    expect(metadata.scripts["evidence:prime-family:packaged"])
      .toBe("node scripts/capture-packaged-prime-family-evidence.mjs");
  });

  it("loads the contract matrix module instead of only reading its text", async () => {
    // The text-token checks above cannot catch a syntax or import failure;
    // the module itself is dependency-free, so CI can load the real seam.
    const matrix = await import("../scripts/prime-evidence/contract-matrix.mjs");
    expect(matrix.PRIME_CONTRACT_TEST_NAMES.length).toBeGreaterThan(0);
    expect(matrix.HOST_CONTRACT_TEST_NAMES.length).toBeGreaterThan(0);
    expect(matrix.PRIME_SOURCE_TEST_PATHS.length).toBeGreaterThan(0);
    expect(typeof matrix.verifyPrimeContractMatrix).toBe("function");
  });
});
