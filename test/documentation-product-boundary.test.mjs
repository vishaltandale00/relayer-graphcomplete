import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readRepositoryFile = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("product documentation boundary", () => {
  it("defines Relayer as harness and provider agnostic without promising arbitrary adapters", async () => {
    const [readme, architecture, prd, decision, supersededDecision] = await Promise.all([
      readRepositoryFile("README.md"),
      readRepositoryFile("docs/architecture.md"),
      readRepositoryFile("docs/prd/index.html"),
      readRepositoryFile("docs/decisions/0006-harness-provider-agnostic-product-boundary.md"),
      readRepositoryFile("docs/decisions/0001-prime-agent-runtime-boundary.md"),
    ]);

    expect(readme).toContain("a harness- and provider-agnostic product contract");
    expect(readme).not.toContain("system built on [Prime Agent]");
    expect(architecture).toContain("A thread-selected harness owns model execution behind a provider-agnostic product contract.");
    expect(architecture).not.toContain("Prime Agent is the execution runtime.");
    expect(prd).toContain("Relayer has a harness- and provider-agnostic product contract.");
    expect(decision).toContain("It does not create a generic agent protocol or make arbitrary providers and harnesses work without explicit adapters");
    expect(supersededDecision).toContain("Status: superseded by [ADR 0006]");
  });
});
