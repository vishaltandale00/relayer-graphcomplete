// PRD 11.11 and 6.6.6-6.6.7: Codex, Claude and Prime guidance explains artifact layers,
// web apps with their server invoke, and starting state.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARTIFACT_LAYER_GUIDANCE, ARTIFACT_LAYER_GUIDANCE_PYTHON } from "../src/implementations/artifact-layer-guidance.js";

const repositoryRoot = join(import.meta.dirname, "../../..");

describe("artifact layer guidance", () => {
  it.each([
    ["TypeScript", ARTIFACT_LAYER_GUIDANCE, "LayerObject.forArtifact(site", "site.artifact = {"],
    ["Python", ARTIFACT_LAYER_GUIDANCE_PYTHON, "LayerObject.for_artifact(site", "site.artifact = {"],
  ])("teaches the %s client to author and open an artifact layer", (_language, guidance, layer, artifact) => {
    expect(guidance).toContain(layer);
    expect(guidance).toContain(artifact);
    for (const kind of ["website", "pdf", "video", "image", "markdown", "docx", "xlsx", "pptx", "url", "app"]) expect(guidance).toContain(`"${kind}"`);
    expect(guidance).toContain("relative to the thread folder and must stay inside it");
    expect(guidance).toContain("never put an artifact node in a graph layer");
    expect(guidance).toContain("again when your answer is accepted");
    expect(guidance).toContain("approves it once per thread");
    expect(guidance).toContain("Seeds hold test values only");
    // ART-012: spreadsheets keep calculated values; decks with charts get a PDF.
    expect(guidance).toContain("Save spreadsheets with their calculated values");
    expect(guidance).toContain("export a PDF next to any deck with charts");
  });

  it("reaches every product harness prompt and the Python skill", async () => {
    const codex = await readFile(join(repositoryRoot, "packages/harness-host/src/implementations/codex-basic.ts"), "utf8");
    const prime = await readFile(join(repositoryRoot, "packages/harness-host/src/implementations/prime-agent.ts"), "utf8");
    const claude = await readFile(join(repositoryRoot, "packages/harness-host/src/implementations/claude-basic.ts"), "utf8");
    const skill = await readFile(join(repositoryRoot, "python/relayer-graph/SKILL.md"), "utf8");
    expect(codex.match(/\$\{ARTIFACT_LAYER_GUIDANCE\}/gu)).toHaveLength(2);
    expect(prime.match(/\$\{ARTIFACT_LAYER_GUIDANCE_PYTHON\}/gu)).toHaveLength(2);
    expect(claude).toContain("buildLayeredNavigationPrompt");
    expect(skill).toContain("LayerObject.for_artifact(site");
    expect(skill).toContain('"kind": "app"');
    expect(skill.replace(/\s+/gu, " ")).toContain("Save spreadsheets with their calculated values");
  });
});
