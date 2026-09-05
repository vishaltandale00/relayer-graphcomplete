import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadHarnessConfigurations } from "../packages/harness-host/src/configuration.ts";
import {
  evalHarnessConfigurationPaths,
  evalRuntimeTarget,
} from "../desktop/eval-main/configuration-paths.mjs";
import { DEFAULT_DESKTOP_HARNESS_CONFIGURATION } from "../desktop/main/services/desktop-harness-configuration.mjs";

const names = (paths) => paths.map((path) => basename(path));
const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));

describe("Eval harness configuration availability", () => {
  it("uses actual packaged runtime identity instead of an environment-spoofed graph-search target", () => {
    const spoofed = { RELAYER_DESKTOP_TARGET: "macos-arm64" };
    expect(evalRuntimeTarget({
      isPackaged: true,
      environment: spoofed,
      platform: "darwin",
      architecture: "x64",
    }).key).toBe("macos-x64");
    expect(evalRuntimeTarget({
      isPackaged: true,
      environment: spoofed,
      platform: "win32",
      architecture: "x64",
    }).key).toBe("windows-x64");
    expect(evalRuntimeTarget({
      isPackaged: true,
      environment: { RELAYER_DESKTOP_TARGET: "windows-x64" },
      platform: "darwin",
      architecture: "arm64",
    }).key).toBe("macos-arm64");
    expect(evalRuntimeTarget({
      isPackaged: false,
      environment: spoofed,
      platform: "win32",
      architecture: "x64",
    }).key).toBe("macos-arm64");
  });

  it("resolves linux-x64 as a development-only unpackaged Eval host", () => {
    expect(evalRuntimeTarget({
      isPackaged: false,
      environment: {},
      platform: "linux",
      architecture: "x64",
    })).toMatchObject({ key: "linux-x64", platform: "linux", architecture: "x64" });
    expect(evalRuntimeTarget({
      isPackaged: false,
      environment: { RELAYER_DESKTOP_TARGET: "linux-x64" },
      platform: "darwin",
      architecture: "arm64",
    }).key).toBe("linux-x64");
    expect(() => evalRuntimeTarget({
      isPackaged: true,
      environment: { RELAYER_DESKTOP_TARGET: "linux-x64" },
      platform: "linux",
      architecture: "x64",
    })).toThrow("Unsupported Relayer Desktop target: linux-x64.");
  });

  it("records the package.json product version on unpackaged Eval exports", async () => {
    const evalMain = await readFile(new URL("../desktop/eval-main/index.mjs", import.meta.url), "utf8");
    expect(evalMain).toContain("const desktopVersion = app.isPackaged ? app.getVersion() : (metadata.version || app.getVersion());");
    expect(evalMain).toContain("desktopVersion,");
    expect(evalMain).not.toContain("desktopVersion: app.getVersion()");
  });

  it("includes Prime configurations when the development package is available", () => {
    const packageAvailable = vi.fn(() => true);

    expect(names(evalHarnessConfigurationPaths({
      harnessDirectory: "/tmp/harnesses",
      isPackaged: false,
      packageAvailable,
      targetKey: "macos-arm64",
    }))).toEqual([
      "fixture-task-system.yaml",
      "fixture-graph-memory.yaml",
      "codex-basic.yaml",
      "codex-basic-high.yaml",
      "codex-eval-visual-node-details-control.yaml",
      "codex-eval-visual-node-details-treatment.yaml",
      "codex-eval-lantern-search-disabled-recursion-disabled.yaml",
      "codex-eval-lantern-search-query-v1-recursion-disabled.yaml",
      "codex-eval-lantern-search-disabled-recursion-enabled.yaml",
      "codex-eval-lantern-search-query-v1-recursion-enabled.yaml",
      "codex-layered-navigation-luna.yaml",
      "codex-multi-agent-layered-navigation.yaml",
      "claude-basic.yaml",
      "codex-layered-personal-presentation-v0.yaml",
      "codex-layered-personal-presentation-v1.yaml",
      "codex-layered-personal-presentation-v2.yaml",
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
      targetKey: "macos-arm64",
    }))).toEqual([
      "fixture-task-system.yaml",
      "fixture-graph-memory.yaml",
      "codex-basic.yaml",
      "codex-basic-high.yaml",
      "codex-eval-visual-node-details-control.yaml",
      "codex-eval-visual-node-details-treatment.yaml",
      "codex-eval-lantern-search-disabled-recursion-disabled.yaml",
      "codex-eval-lantern-search-query-v1-recursion-disabled.yaml",
      "codex-eval-lantern-search-disabled-recursion-enabled.yaml",
      "codex-eval-lantern-search-query-v1-recursion-enabled.yaml",
      "codex-layered-navigation-luna.yaml",
      "codex-multi-agent-layered-navigation.yaml",
      "claude-basic.yaml",
      "codex-layered-personal-presentation-v0.yaml",
      "codex-layered-personal-presentation-v1.yaml",
      "codex-layered-personal-presentation-v2.yaml",
    ]);
  });

  it("never exposes development-only Prime configurations in packaged Eval", () => {
    const packageAvailable = vi.fn(() => true);

    expect(names(evalHarnessConfigurationPaths({
      harnessDirectory: "/tmp/harnesses",
      isPackaged: true,
      packageAvailable,
      targetKey: "macos-arm64",
    }))).toEqual([
      "fixture-task-system.yaml",
      "fixture-graph-memory.yaml",
      "codex-basic.yaml",
      "codex-basic-high.yaml",
      "codex-eval-visual-node-details-control.yaml",
      "codex-eval-visual-node-details-treatment.yaml",
      "codex-eval-lantern-search-disabled-recursion-disabled.yaml",
      "codex-eval-lantern-search-query-v1-recursion-disabled.yaml",
      "codex-eval-lantern-search-disabled-recursion-enabled.yaml",
      "codex-eval-lantern-search-query-v1-recursion-enabled.yaml",
      "codex-layered-navigation-luna.yaml",
      "codex-multi-agent-layered-navigation.yaml",
      "claude-basic.yaml",
      "codex-layered-personal-presentation-v0.yaml",
      "codex-layered-personal-presentation-v1.yaml",
      "codex-layered-personal-presentation-v2.yaml",
    ]);
    expect(packageAvailable).not.toHaveBeenCalled();
  });

  it("keeps baseline harnesses but omits graph-search experiments off Apple Silicon", () => {
    for (const targetKey of ["macos-x64", "windows-x64", "linux-x64"]) {
      const available = names(evalHarnessConfigurationPaths({
        harnessDirectory: "/tmp/harnesses",
        isPackaged: false,
        packageAvailable: () => true,
        targetKey,
      }));
      expect(available).toEqual(expect.arrayContaining([
        "fixture-task-system.yaml",
        "codex-basic.yaml",
        "claude-basic.yaml",
        "prime-agent-basic.yaml",
      ]));
      expect(available).not.toEqual(expect.arrayContaining([
        "fixture-graph-memory.yaml",
              "codex-eval-lantern-search-disabled-recursion-disabled.yaml",
        "codex-eval-lantern-search-query-v1-recursion-disabled.yaml",
        "codex-eval-lantern-search-disabled-recursion-enabled.yaml",
        "codex-eval-lantern-search-query-v1-recursion-enabled.yaml",
      ]));
    }
  });

  it("resolves the multi-agent configuration through the generic Eval catalog path", async () => {
    const catalog = await loadHarnessConfigurations(evalHarnessConfigurationPaths({
      harnessDirectory: resolve(repositoryRoot, "harnesses"),
      isPackaged: true,
      targetKey: "macos-arm64",
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

  it("loads the Apple-Silicon-only Codex quartet without exposing non-runnable combined provider cells", async () => {
    const catalog = await loadHarnessConfigurations(evalHarnessConfigurationPaths({
      harnessDirectory: resolve(repositoryRoot, "harnesses"),
      isPackaged: false,
      packageAvailable: () => false,
      targetKey: "macos-arm64",
    }));

    expect(catalog.get("codex-eval-lantern-search-query-v1-recursion-enabled")).toMatchObject({
      implementation: "codex.basic",
      complete: { agentAuthored: true },
      graphCapabilityProfile: { search: "query-v1" },
      settings: {
        personalPresentationVersion: "personal-presentation-v2",
        promptProfile: "layered-navigation-multi-agent-v1",
      },
    });
    expect(catalog.has("claude-eval-complete-graph-search")).toBe(false);
    expect(catalog.has("prime-agent-eval-complete-graph-search")).toBe(false);
  });

  it("keeps the layered Codex harness product-facing and the high variant internal", async () => {
    const evalPackaging = await readFile(new URL("../desktop/packaging/eval-electron-builder.mjs", import.meta.url), "utf8");
    const productPackaging = await readFile(new URL("../desktop/packaging/electron-builder.mjs", import.meta.url), "utf8");
    const codexBasic = await loadHarnessConfigurations([
      resolve(repositoryRoot, "harnesses/codex-basic.yaml"),
    ]);

    expect(DEFAULT_DESKTOP_HARNESS_CONFIGURATION).toBe("codex-basic");
    expect(codexBasic.get("codex-basic")?.settings).toMatchObject({
      promptProfile: "layered-navigation-multi-agent-v1",
    });
    expect(codexBasic.get("codex-basic")?.modelRules?.allow.map(({ adapterId }) => adapterId)).toEqual([
      "codex-subscription",
      "openai-api",
      "openrouter",
      "vercel-ai-router",
    ]);
    expect(evalPackaging).toContain('{ from: resolve(repositoryRoot, "harnesses"), to: "harnesses", filter: ["*.yaml"] }');
    expect(evalPackaging).toContain('"main/managed-runtimes/**/*"');
    expect(evalPackaging).toContain('"main/credentials/**/*"');
    expect(evalPackaging).toContain('"main/models/**/*"');
    expect(evalPackaging).toContain('"renderer/src/model-picker-model.js"');
    expect(evalPackaging).toContain('"shared/codex-runtime-environment.mjs"');
    expect(evalPackaging).toContain('"shared/managed-runtime-requirements.mjs"');
    expect(evalPackaging).toContain('"shared/target.mjs"');
    expect(productPackaging).toContain('{ from: resolve(repositoryRoot, "harnesses/codex-basic.yaml"), to: "harnesses/codex-basic.yaml" }');
    expect(productPackaging).toContain('{ from: resolve(repositoryRoot, "harnesses/claude-basic.yaml"), to: "harnesses/claude-basic.yaml" }');
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

  it("keeps the visual-detail comparison identical except for name and presentation version", async () => {
    const catalog = await loadHarnessConfigurations([
      resolve(repositoryRoot, "harnesses/codex-eval-visual-node-details-control.yaml"),
      resolve(repositoryRoot, "harnesses/codex-eval-visual-node-details-treatment.yaml"),
    ]);
    const control = structuredClone(catalog.get("codex-eval-visual-node-details-control"));
    const treatment = structuredClone(catalog.get("codex-eval-visual-node-details-treatment"));
    expect(control?.complete).toEqual({ agentAuthored: true });
    expect(treatment?.complete).toEqual({ agentAuthored: true });
    expect(control?.settings.personalPresentationVersion).toBe("personal-presentation-v2");
    expect(treatment?.settings.personalPresentationVersion).toBe("personal-presentation-v3");
    if (control) {
      control.name = "comparison";
      control.settings.personalPresentationVersion = "personal-presentation-v3";
    }
    if (treatment) treatment.name = "comparison";
    expect(treatment).toEqual(control);
  });
});
