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
const spoofed = { RELAYER_DESKTOP_TARGET: "macos-arm64" };

const sharedHarnessNames = [
  "fixture-task-system.yaml",
  "fixture-graph-memory.yaml",
  "codex-basic.yaml",
  "codex-basic-graph-search.yaml",
  "codex-basic-high.yaml",
  "codex-eval-complete-disabled.yaml",
  "codex-eval-complete-enabled.yaml",
  "codex-eval-lantern-search-disabled-recursion-disabled.yaml",
  "codex-eval-lantern-search-query-v1-recursion-disabled.yaml",
  "codex-eval-lantern-search-disabled-recursion-enabled.yaml",
  "codex-eval-lantern-search-query-v1-recursion-enabled.yaml",
  "codex-layered-navigation-luna.yaml",
  "codex-multi-agent-layered-navigation.yaml",
  "claude-basic.yaml",
  "claude-basic-graph-search.yaml",
  "codex-layered-personal-presentation-v0.yaml",
  "codex-layered-personal-presentation-v1.yaml",
];

describe("Eval harness configuration availability", () => {
  it("resolves the runtime target from real packaged identity, never from the environment", () => {
    const cases = [
      [
        "packaged darwin/x64 ignores a spoofed macos-arm64 target",
        { isPackaged: true, environment: spoofed, platform: "darwin", architecture: "x64" },
        "macos-x64",
      ],
      [
        "packaged win32/x64 ignores a spoofed macos-arm64 target",
        { isPackaged: true, environment: spoofed, platform: "win32", architecture: "x64" },
        "windows-x64",
      ],
      [
        "packaged darwin/arm64 ignores a spoofed windows-x64 target",
        { isPackaged: true, environment: { RELAYER_DESKTOP_TARGET: "windows-x64" }, platform: "darwin", architecture: "arm64" },
        "macos-arm64",
      ],
      [
        "unpackaged win32 development host reports the spoofed macos-arm64 target",
        { isPackaged: false, environment: spoofed, platform: "win32", architecture: "x64" },
        "macos-arm64",
      ],
      [
        "unpackaged linux/x64 is a development-only Eval host",
        { isPackaged: false, environment: {}, platform: "linux", architecture: "x64" },
        "linux-x64",
      ],
      [
        "unpackaged darwin development host may declare linux-x64",
        { isPackaged: false, environment: { RELAYER_DESKTOP_TARGET: "linux-x64" }, platform: "darwin", architecture: "arm64" },
        "linux-x64",
      ],
    ];
    expect(cases, "runtime target corpus").toHaveLength(6);
    for (const [label, input, key] of cases) {
      expect(evalRuntimeTarget(input).key, label).toBe(key);
    }
    expect(evalRuntimeTarget({
      isPackaged: false,
      environment: {},
      platform: "linux",
      architecture: "x64",
    }), "linux development target keeps its platform identity").toMatchObject({ key: "linux-x64", platform: "linux", architecture: "x64" });
    expect(() => evalRuntimeTarget({
      isPackaged: true,
      environment: { RELAYER_DESKTOP_TARGET: "linux-x64" },
      platform: "linux",
      architecture: "x64",
    }), "packaged Eval never supports linux").toThrow("Unsupported Relayer Desktop target: linux-x64.");
  });

  it("gates harness availability by packaging, target, and development package presence", async () => {
    const packageAvailable = vi.fn(() => true);
    expect(names(evalHarnessConfigurationPaths({
      harnessDirectory: "/tmp/harnesses",
      isPackaged: false,
      packageAvailable,
      targetKey: "macos-arm64",
    })), "development hosts include Prime configurations when the package is available").toEqual([
      ...sharedHarnessNames,
      "prime-agent-basic.yaml",
      "prime-agent-basic-graph-search.yaml",
      "prime-agent-deep.yaml",
      "prime-agent-layered-navigation-luna.yaml",
    ]);
    expect(packageAvailable, "availability probes the Prime development package").toHaveBeenCalledWith("@earendil-works/pi-coding-agent");

    expect(names(evalHarnessConfigurationPaths({
      harnessDirectory: "/tmp/harnesses",
      isPackaged: false,
      packageAvailable: () => false,
      targetKey: "macos-arm64",
    })), "development hosts hide Prime configurations without the package").toEqual(sharedHarnessNames);

    const packagedPackageAvailable = vi.fn(() => true);
    expect(names(evalHarnessConfigurationPaths({
      harnessDirectory: "/tmp/harnesses",
      isPackaged: true,
      packageAvailable: packagedPackageAvailable,
      targetKey: "macos-arm64",
    })), "packaged Eval never exposes development-only Prime configurations").toEqual(sharedHarnessNames);
    expect(packagedPackageAvailable, "packaged Eval never probes the development package").not.toHaveBeenCalled();

    for (const targetKey of ["macos-x64", "windows-x64", "linux-x64"]) {
      const available = names(evalHarnessConfigurationPaths({
        harnessDirectory: "/tmp/harnesses",
        isPackaged: false,
        packageAvailable: () => true,
        targetKey,
      }));
      expect(available, `${targetKey} keeps baseline harnesses`).toEqual(expect.arrayContaining([
        "fixture-task-system.yaml",
        "codex-basic.yaml",
        "claude-basic.yaml",
        "prime-agent-basic.yaml",
      ]));
      expect(available, `${targetKey} omits Apple-Silicon graph-search experiments`).not.toEqual(expect.arrayContaining([
        "fixture-graph-memory.yaml",
        "codex-basic-graph-search.yaml",
        "claude-basic-graph-search.yaml",
        "prime-agent-basic-graph-search.yaml",
        "codex-eval-lantern-search-disabled-recursion-disabled.yaml",
        "codex-eval-lantern-search-query-v1-recursion-disabled.yaml",
        "codex-eval-lantern-search-disabled-recursion-enabled.yaml",
        "codex-eval-lantern-search-query-v1-recursion-enabled.yaml",
      ]));
    }

    const evalMain = await readFile(new URL("../desktop/eval-main/index.mjs", import.meta.url), "utf8");
    expect(evalMain, "unpackaged exports record the package.json product version")
      .toContain("const desktopVersion = app.isPackaged ? app.getVersion() : (metadata.version || app.getVersion());");
    expect(evalMain, "exports carry the recorded version").toContain("desktopVersion,");
    expect(evalMain, "exports never hard-code app.getVersion()").not.toContain("desktopVersion: app.getVersion()");

    const evalPackaging = await readFile(new URL("../desktop/packaging/eval-electron-builder.mjs", import.meta.url), "utf8");
    const productPackaging = await readFile(new URL("../desktop/packaging/electron-builder.mjs", import.meta.url), "utf8");
    const codexBasic = await loadHarnessConfigurations([
      resolve(repositoryRoot, "harnesses/codex-basic.yaml"),
    ]);
    expect(DEFAULT_DESKTOP_HARNESS_CONFIGURATION, "product default harness").toBe("codex-basic");
    expect(codexBasic.get("codex-basic")?.settings, "codex-basic stays product-facing").toMatchObject({
      promptProfile: "layered-navigation-multi-agent-v1",
    });
    expect(codexBasic.get("codex-basic")?.modelRules?.allow.map(({ adapterId }) => adapterId),
      "codex-basic keeps its provider allow list").toEqual([
      "codex-subscription",
      "openai-api",
      "openrouter",
      "vercel-ai-router",
    ]);
    for (const fragment of [
      '{ from: resolve(repositoryRoot, "harnesses"), to: "harnesses", filter: ["*.yaml"] }',
      '"main/managed-runtimes/**/*"',
      '"main/credentials/**/*"',
      '"main/models/**/*"',
      '"renderer/src/model-picker-model.js"',
      '"shared/codex-runtime-environment.mjs"',
      '"shared/managed-runtime-requirements.mjs"',
      '"shared/target.mjs"',
    ]) {
      expect(evalPackaging, `Eval packaging ships ${fragment}`).toContain(fragment);
    }
    expect(productPackaging, "product packaging ships codex-basic").toContain('{ from: resolve(repositoryRoot, "harnesses/codex-basic.yaml"), to: "harnesses/codex-basic.yaml" }');
    expect(productPackaging, "product packaging ships claude-basic").toContain('{ from: resolve(repositoryRoot, "harnesses/claude-basic.yaml"), to: "harnesses/claude-basic.yaml" }');
    for (const internalHarness of [
      "codex-basic-high.yaml",
      "codex-multi-agent-layered-navigation.yaml",
      "codex-layered-navigation-luna.yaml",
      "codex-layered-personal-presentation-v0.yaml",
      "codex-layered-personal-presentation-v1.yaml",
    ]) {
      expect(productPackaging, `product packaging keeps ${internalHarness} internal`).not.toContain(internalHarness);
    }
  });

  it("keeps comparison cells identical except for their declared factors", async () => {
    const catalog = await loadHarnessConfigurations(evalHarnessConfigurationPaths({
      harnessDirectory: resolve(repositoryRoot, "harnesses"),
      isPackaged: true,
      targetKey: "macos-arm64",
    }));
    expect([...catalog.keys()], "generic Eval catalog resolves the multi-agent configuration").toContain("codex-layered-navigation-luna");
    expect(catalog.get("claude-basic"), "claude-basic resolves").toMatchObject({
      name: "claude-basic",
      implementation: "claude.basic",
    });
    expect(catalog.get("codex-multi-agent-layered-navigation"), "multi-agent settings resolve").toMatchObject({
      name: "codex-multi-agent-layered-navigation",
      implementation: "codex.basic",
      settings: { promptProfile: "layered-navigation-multi-agent-v1" },
    });

    const fullCatalog = await loadHarnessConfigurations(evalHarnessConfigurationPaths({
      harnessDirectory: resolve(repositoryRoot, "harnesses"),
      isPackaged: false,
      packageAvailable: () => true,
      targetKey: "macos-arm64",
    }));
    const treatmentPairs = [
      ["codex-basic", "codex-basic-graph-search"],
      ["claude-basic", "claude-basic-graph-search"],
      ["prime-agent-basic", "prime-agent-basic-graph-search"],
    ];
    expect(treatmentPairs, "treatment pair inventory").toHaveLength(3);
    for (const [controlName, treatmentName] of treatmentPairs) {
      const control = structuredClone(fullCatalog.get(controlName));
      const treatment = structuredClone(fullCatalog.get(treatmentName));
      expect(control?.graphCapabilityProfile, `${controlName} disables search`).toEqual({ search: "disabled" });
      expect(treatment?.graphCapabilityProfile, `${treatmentName} grants query-v1`).toEqual({ search: "query-v1" });
      if (control) {
        control.name = "comparison";
        control.revision = 1;
        control.graphCapabilityProfile = { search: "comparison" };
      }
      if (treatment) {
        treatment.name = "comparison";
        treatment.revision = 1;
        treatment.graphCapabilityProfile = { search: "comparison" };
      }
      expect(treatment, `${treatmentName} matches ${controlName} except identity and query authority`).toEqual(control);
    }

    const quartetCatalog = await loadHarnessConfigurations(evalHarnessConfigurationPaths({
      harnessDirectory: resolve(repositoryRoot, "harnesses"),
      isPackaged: false,
      packageAvailable: () => false,
      targetKey: "macos-arm64",
    }));
    expect(quartetCatalog.get("codex-eval-lantern-search-query-v1-recursion-enabled"),
      "Apple-Silicon quartet cells load with their declared factors").toMatchObject({
      implementation: "codex.basic",
      complete: { agentAuthored: true },
      graphCapabilityProfile: { search: "query-v1" },
      settings: {
        personalPresentationVersion: "personal-presentation-v2",
        promptProfile: "layered-navigation-multi-agent-v1",
      },
    });
    expect(quartetCatalog.has("claude-eval-complete-graph-search"), "no non-runnable combined Claude cell").toBe(false);
    expect(quartetCatalog.has("prime-agent-eval-complete-graph-search"), "no non-runnable combined Prime cell").toBe(false);

    const presentationCatalog = await loadHarnessConfigurations([
      resolve(repositoryRoot, "harnesses/codex-layered-personal-presentation-v0.yaml"),
      resolve(repositoryRoot, "harnesses/codex-layered-personal-presentation-v1.yaml"),
    ]);
    const presentationControl = structuredClone(presentationCatalog.get("codex-layered-personal-presentation-v0"));
    const presentationTreatment = structuredClone(presentationCatalog.get("codex-layered-personal-presentation-v1"));
    expect(presentationControl?.settings.personalPresentationVersion, "v0 pins its version").toBe("personal-presentation-v0");
    expect(presentationTreatment?.settings.personalPresentationVersion, "v1 pins its version").toBe("personal-presentation-v1");
    delete presentationControl?.settings.personalPresentationVersion;
    delete presentationTreatment?.settings.personalPresentationVersion;
    if (presentationControl) presentationControl.name = "comparison";
    if (presentationTreatment) presentationTreatment.name = "comparison";
    expect(presentationTreatment, "presentation matrix differs only by name and pinned version").toEqual(presentationControl);

    const completeCatalog = await loadHarnessConfigurations([
      resolve(repositoryRoot, "harnesses/codex-eval-complete-disabled.yaml"),
      resolve(repositoryRoot, "harnesses/codex-eval-complete-enabled.yaml"),
    ]);
    const completeControl = structuredClone(completeCatalog.get("codex-eval-complete-disabled"));
    const completeTreatment = structuredClone(completeCatalog.get("codex-eval-complete-enabled"));
    expect(completeControl?.complete, "off cell withholds Complete authority").toEqual({ agentAuthored: false });
    expect(completeTreatment?.complete, "on cell grants Complete authority").toEqual({ agentAuthored: true });
    expect(completeControl?.settings.personalPresentationVersion, "off cell pins v1 presentation").toBe("personal-presentation-v1");
    expect(completeTreatment?.settings.personalPresentationVersion, "on cell pins v2 presentation").toBe("personal-presentation-v2");
    if (completeControl) {
      completeControl.name = "comparison";
      completeControl.complete = { agentAuthored: true };
      completeControl.settings.personalPresentationVersion = "personal-presentation-v2";
    }
    if (completeTreatment) completeTreatment.name = "comparison";
    expect(completeTreatment, "visible-work comparison differs only by name, personalization, and Complete").toEqual(completeControl);
  });
});
