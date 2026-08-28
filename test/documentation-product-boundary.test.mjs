import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readRepositoryFile = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("product documentation boundary", () => {
  it("defines Relayer as harness and provider agnostic without promising arbitrary adapters", async () => {
    const [readme, packageManifest, architecture, prd, walkthrough, layeredDecision, decision, supersededDecision] = await Promise.all([
      readRepositoryFile("README.md"),
      readRepositoryFile("package.json"),
      readRepositoryFile("docs/architecture.md"),
      readRepositoryFile("docs/prd/index.html"),
      readRepositoryFile("docs/prd/assets/product-walkthrough.html"),
      readRepositoryFile("docs/decisions/0005-layered-navigation-contract.md"),
      readRepositoryFile("docs/decisions/0006-harness-provider-agnostic-product-boundary.md"),
      readRepositoryFile("docs/decisions/0001-prime-agent-runtime-boundary.md"),
    ]);

    expect(readme).toContain("a harness- and provider-agnostic product contract");
    expect(readme).not.toContain("system built on [Prime Agent]");
    expect(JSON.parse(packageManifest).description).toContain("harness- and provider-agnostic product contract");
    expect(architecture).toContain("A thread-selected harness owns model execution behind a provider-agnostic product contract.");
    expect(architecture).toContain("For an ordinary message, a model-related failure returns the same interaction to an editable unsent state");
    expect(architecture).toContain("For an input-assisted Send, failure or stop instead restores its snapshotted attachments");
    expect(architecture).toContain("retry requires a new explicit Send and a new root interaction");
    expect(architecture).toContain("durable graph writes remain authoritative");
    expect(architecture).not.toContain("Prime Agent is the execution runtime.");
    expect(prd).toContain("Relayer has a harness- and provider-agnostic product contract.");
    expect(prd).toContain("Application-state baseline:</strong> Commit <code>38286cb</code>");
    expect(walkthrough).toContain("Product workspace");
    expect(walkthrough).toContain("Judge review");
    expect(walkthrough).toContain("Candidate trace");
    expect(walkthrough).not.toContain("See in App");
    expect(walkthrough).not.toContain("Continue with this configuration");
    expect(layeredDecision).toContain("Each selected harness owns any provider-native recursive execution it uses");
    expect(decision).toContain("It does not create a generic agent protocol or make arbitrary providers and harnesses work without explicit adapters");
    expect(decision).toContain("Each harness owns any provider-native delegation it uses");
    expect(supersededDecision).toContain("Status: superseded by [ADR 0006]");
  });
});
