import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { digestHarnessConfiguration, loadHarnessConfiguration, loadHarnessConfigurations, parseHarnessConfiguration } from "../src/configuration.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

describe("harness configuration", () => {
  it("loads the production codex.basic configuration", async () => {
    await expect(loadHarnessConfiguration(join(repositoryRoot, "harnesses/codex-basic.yaml"))).resolves.toEqual({
      schemaVersion: 1,
      name: "codex-basic",
      implementation: "codex.basic",
      implementationVersion: 1,
      settings: {
        modelReasoningEffort: "medium",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        networkAccessEnabled: true,
        skipGitRepoCheck: true,
      },
    });
  });

  it("keeps implementation-specific configuration opaque to the host", () => {
    expect(parseHarnessConfiguration({
      schemaVersion: 1,
      name: "prime-production",
      implementation: "prime-agent",
      implementationVersion: 7,
      settings: { root: { model: "luna" }, reviewers: [{ model: "sol", effort: "high" }] },
    }).settings).toEqual({ root: { model: "luna" }, reviewers: [{ model: "sol", effort: "high" }] });
  });

  it("creates a stable digest from the exact configuration snapshot", () => {
    const left = parseHarnessConfiguration({
      schemaVersion: 1,
      name: "prime-production",
      implementation: "prime-agent",
      implementationVersion: 1,
      settings: { reviewers: [{ effort: "high", model: "sol" }], root: { model: "luna" } },
    });
    const reordered = parseHarnessConfiguration({
      settings: { root: { model: "luna" }, reviewers: [{ model: "sol", effort: "high" }] },
      implementationVersion: 1,
      implementation: "prime-agent",
      name: "prime-production",
      schemaVersion: 1,
    });
    const changed = { ...left, settings: { ...left.settings, root: { model: "terra" } } };

    expect(digestHarnessConfiguration(left)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(digestHarnessConfiguration(reordered)).toBe(digestHarnessConfiguration(left));
    expect(digestHarnessConfiguration(changed)).not.toBe(digestHarnessConfiguration(left));
  });

  it("allows many named configurations to select the same implementation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-config-"));
    const fast = join(directory, "fast.yaml");
    const deep = join(directory, "deep.yaml");
    try {
      await writeFile(fast, "schemaVersion: 1\nname: codex-fast\nimplementation: codex.basic\nimplementationVersion: 1\nsettings:\n  modelReasoningEffort: low\n", "utf8");
      await writeFile(deep, "schemaVersion: 1\nname: codex-deep\nimplementation: codex.basic\nimplementationVersion: 1\nsettings:\n  modelReasoningEffort: high\n", "utf8");

      const catalog = await loadHarnessConfigurations([fast, deep]);

      expect([...catalog.keys()]).toEqual(["codex-fast", "codex-deep"]);
      expect([...catalog.values()].map(({ implementation }) => implementation)).toEqual(["codex.basic", "codex.basic"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects duplicate configuration names in a catalog", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-config-"));
    const first = join(directory, "first.yaml");
    const second = join(directory, "second.yaml");
    const source = "schemaVersion: 1\nname: duplicate\nimplementation: test\nimplementationVersion: 1\nsettings: {}\n";
    try {
      await writeFile(first, source, "utf8");
      await writeFile(second, source, "utf8");
      await expect(loadHarnessConfigurations([first, second])).rejects.toThrow("Duplicate harness configuration name: duplicate");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
