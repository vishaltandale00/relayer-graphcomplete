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
    ]);
    expect(packageAvailable).not.toHaveBeenCalled();
  });

  it("resolves the multi-agent configuration through the generic Eval catalog path", async () => {
    const catalog = await loadHarnessConfigurations(evalHarnessConfigurationPaths({
      harnessDirectory: resolve(repositoryRoot, "harnesses"),
      isPackaged: true,
    }));

    expect([...catalog.keys()]).toContain("codex-layered-navigation-luna");
    expect(catalog.get("codex-multi-agent-layered-navigation")).toMatchObject({
      name: "codex-multi-agent-layered-navigation",
      implementation: "codex.basic",
      settings: { promptProfile: "layered-navigation-multi-agent-v1" },
    });
  });

  it("packages the configuration for Eval without promoting it to the product", async () => {
    const evalPackaging = await readFile(new URL("../desktop/packaging/eval-electron-builder.mjs", import.meta.url), "utf8");
    const productPackaging = await readFile(new URL("../desktop/packaging/electron-builder.mjs", import.meta.url), "utf8");

    expect(DEFAULT_DESKTOP_HARNESS_CONFIGURATION).toBe("codex-basic");
    expect(evalPackaging).toContain('{ from: resolve(repositoryRoot, "harnesses"), to: "harnesses", filter: ["*.yaml"] }');
    expect(productPackaging).toContain('{ from: resolve(repositoryRoot, "harnesses/codex-basic.yaml"), to: "harnesses/codex-basic.yaml" }');
    expect(productPackaging).toContain('{ from: resolve(repositoryRoot, "harnesses/codex-basic-high.yaml"), to: "harnesses/codex-basic-high.yaml" }');
    expect(productPackaging).not.toContain("codex-multi-agent-layered-navigation.yaml");
    expect(productPackaging).not.toContain("codex-layered-navigation-luna.yaml");
  });
});
