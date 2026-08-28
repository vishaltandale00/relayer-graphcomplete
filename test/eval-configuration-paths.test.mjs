import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadHarnessConfigurations } from "../packages/harness-host/src/configuration.ts";
import { evalHarnessConfigurationPaths } from "../desktop/eval-main/configuration-paths.mjs";
import { DEFAULT_DESKTOP_HARNESS_CONFIGURATION } from "../desktop/main/services/desktop-harness-configuration.mjs";

const names = (paths) => paths.map((path) => basename(path));
const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));

describe("Eval harness configuration availability", () => {
  it("includes Prime configurations when the development package is available", () => {
    const packageAvailable = vi.fn(() => true);

    expect(names(evalHarnessConfigurationPaths({
      harnessDirectory: "/tmp/harnesses",
      isPackaged: false,
      packageAvailable,
    }))).toEqual([
      "fixture-task-system.yaml",
      "codex-basic.yaml",
      "codex-basic-high.yaml",
      "codex-layered-navigation-luna.yaml",
      "codex-multi-agent-layered-navigation.yaml",
      "claude-basic.yaml",
      "codex-layered-personal-presentation-v0.yaml",
      "codex-layered-personal-presentation-v1.yaml",
      "prime-agent-basic.yaml",
      "prime-agent-deep.yaml",
      "prime-agent-layered-navigation-luna.yaml",
    ]);
    expect(packageAvailable).toHaveBeenCalledWith("@earendil-works/pi-coding-agent");
  });

  it("hides Prime configurations when the development package is unavailable", () => {
    expect(names(evalHarnessConfigurationPaths({
      harnessDirectory: "/tmp/harnesses",
      isPackaged: false,
      packageAvailable: () => false,
    }))).toEqual([
      "fixture-task-system.yaml",
      "codex-basic.yaml",
      "codex-basic-high.yaml",
      "codex-layered-navigation-luna.yaml",
      "codex-multi-agent-layered-navigation.yaml",
      "claude-basic.yaml",
      "codex-layered-personal-presentation-v0.yaml",
      "codex-layered-personal-presentation-v1.yaml",
    ]);
  });

  it("never exposes development-only Prime configurations in packaged Eval", () => {
    const packageAvailable = vi.fn(() => true);

    expect(names(evalHarnessConfigurationPaths({
      harnessDirectory: "/tmp/harnesses",
      isPackaged: true,
      packageAvailable,
    }))).toEqual([
      "fixture-task-system.yaml",
      "codex-basic.yaml",
      "codex-basic-high.yaml",
      "codex-layered-navigation-luna.yaml",
      "codex-multi-agent-layered-navigation.yaml",
      "claude-basic.yaml",
      "codex-layered-personal-presentation-v0.yaml",
      "codex-layered-personal-presentation-v1.yaml",
    ]);
    expect(packageAvailable).not.toHaveBeenCalled();
  });

  it("resolves the multi-agent configuration through the generic Eval catalog path", async () => {
    const catalog = await loadHarnessConfigurations(evalHarnessConfigurationPaths({
      harnessDirectory: resolve(repositoryRoot, "harnesses"),
      isPackaged: true,
    }));

    expect([...catalog.keys()]).toContain("codex-layered-navigation-luna");
    expect(catalog.get("claude-basic")).toMatchObject({
      name: "claude-basic",
      implementation: "claude.basic",
    });
    expect(catalog.get("codex-multi-agent-layered-navigation")).toMatchObject({
      name: "codex-multi-agent-layered-navigation",
      implementation: "codex.basic",
      settings: { promptProfile: "layered-navigation-multi-agent-v1" },
    });
  });

  it("keeps the layered Codex harness product-facing and the high variant internal", async () => {
    const evalPackaging = await readFile(new URL("../desktop/packaging/eval-electron-builder.mjs", import.meta.url), "utf8");
    const productPackaging = await readFile(new URL("../desktop/packaging/electron-builder.mjs", import.meta.url), "utf8");
    const codexProduct = await loadHarnessConfigurations([
      resolve(repositoryRoot, "harnesses/codex.yaml"),
    ]);

    expect(DEFAULT_DESKTOP_HARNESS_CONFIGURATION).toBe("codex");
    expect(codexProduct.get("codex")?.settings).toMatchObject({
      promptProfile: "layered-navigation-multi-agent-v1",
    });
    expect(evalPackaging).toContain('{ from: resolve(repositoryRoot, "harnesses"), to: "harnesses", filter: ["*.yaml"] }');
    expect(evalPackaging).toContain('"main/managed-runtimes/**/*"');
    expect(evalPackaging).toContain('"main/credentials/**/*"');
    expect(evalPackaging).toContain('"main/models/**/*"');
    expect(evalPackaging).toContain('"renderer/src/model-picker-model.js"');
    expect(evalPackaging).toContain('"shared/codex-runtime-environment.mjs"');
    expect(evalPackaging).toContain('"shared/managed-runtime-requirements.mjs"');
    expect(evalPackaging).toContain('"shared/target.mjs"');
    expect(productPackaging).toContain('{ from: resolve(repositoryRoot, "harnesses/codex.yaml"), to: "harnesses/codex.yaml" }');
    expect(productPackaging).toContain('{ from: resolve(repositoryRoot, "harnesses/claude.yaml"), to: "harnesses/claude.yaml" }');
    expect(productPackaging).toContain('{ from: resolve(repositoryRoot, "harnesses/prime-agent.yaml"), to: "harnesses/prime-agent.yaml" }');
    expect(productPackaging).not.toContain("prime-agent-deep.yaml");
    expect(productPackaging).not.toContain("codex-basic-high.yaml");
    expect(productPackaging).not.toContain("codex-multi-agent-layered-navigation.yaml");
    expect(productPackaging).not.toContain("codex-layered-navigation-luna.yaml");
    expect(productPackaging).not.toContain("codex-layered-personal-presentation-v0.yaml");
    expect(productPackaging).not.toContain("codex-layered-personal-presentation-v1.yaml");
  });

  it("keeps the personal presentation matrix identical except for name and pinned version", async () => {
    const catalog = await loadHarnessConfigurations([
      resolve(repositoryRoot, "harnesses/codex-layered-personal-presentation-v0.yaml"),
      resolve(repositoryRoot, "harnesses/codex-layered-personal-presentation-v1.yaml"),
    ]);
    const control = structuredClone(catalog.get("codex-layered-personal-presentation-v0"));
    const treatment = structuredClone(catalog.get("codex-layered-personal-presentation-v1"));
    expect(control?.settings.personalPresentationVersion).toBe("personal-presentation-v0");
    expect(treatment?.settings.personalPresentationVersion).toBe("personal-presentation-v1");
    delete control?.settings.personalPresentationVersion;
    delete treatment?.settings.personalPresentationVersion;
    if (control) control.name = "comparison";
    if (treatment) treatment.name = "comparison";
    expect(treatment).toEqual(control);
  });
});
