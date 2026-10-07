// PRD 11.11: Codex, Claude and Prime guidance explains artifact layers.
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
    for (const kind of ["website", "pdf", "video", "image", "markdown", "url"]) expect(guidance).toContain(`"${kind}"`);
    expect(guidance).toContain("relative to the thread folder and must stay inside it");
    expect(guidance).toContain("never put an artifact node in a graph layer");
    expect(guidance).toContain("resubmit the node after any later edit");
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
  });
});
