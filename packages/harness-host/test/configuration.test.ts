import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  digestHarnessConfiguration,
  harnessAllowsModel,
  loadHarnessConfiguration,
  loadHarnessConfigurations,
  parseHarnessConfiguration,
  sameHarnessExecutionConfiguration,
} from "../src/configuration.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const permissionBindings = { ask: {}, auto: {}, full: {} };

describe("harness configuration", () => {
  it("validates every checked-in harness configuration", async () => {
    const harnessDirectory = join(repositoryRoot, "harnesses");
    const paths = (await readdir(harnessDirectory))
      .filter((name) => name.endsWith(".yaml"))
      .sort()
      .map((name) => join(harnessDirectory, name));

    await expect(Promise.all(paths.map(loadHarnessConfiguration))).resolves.toHaveLength(paths.length);
  });

  it.each([
    ["codex-basic", "medium", 3, "layered-navigation-multi-agent-v1"],
    ["codex-basic-high", "high", 2, undefined],
  ])("loads the checked-in %s configuration", async (name, modelReasoningEffort, revision, promptProfile) => {
    await expect(loadHarnessConfiguration(join(repositoryRoot, `harnesses/${name}.yaml`))).resolves.toEqual({
      schemaVersion: 1,
      name,
      implementation: "codex.basic",
      implementationVersion: 1,
      revision,
      permissionBindings: {
        ask: { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user", networkAccessEnabled: true },
        auto: { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review", networkAccessEnabled: true },
        full: { sandboxMode: "danger-full-access", approvalPolicy: "never" },
      },
      modelCompatibility: [{ providerId: "codex" }],
      modelRules: {
        allow: [
          { adapterId: "codex-subscription", modelIdRegex: ".*" },
          { adapterId: "openai-api", modelIdRegex: ".*" },
          { adapterId: "openrouter", modelIdRegex: ".*" },
          { adapterId: "vercel-ai-router", modelIdRegex: ".*" },
        ],
        deny: [],
      },
      executionAccessContracts: ["managed-runtime@1", "secret@1"],
      modelDefaults: { familyPolicy: { id: "codex-default-family", version: 2 } },
      settings: {
        modelReasoningEffort,
        ...(promptProfile === undefined ? {} : { promptProfile }),
        skipGitRepoCheck: true,
      },
    });
  });

  it("admits every production Claude subscription alias through the checked-in harness", async () => {
    const configuration = await loadHarnessConfiguration(join(repositoryRoot, "harnesses/claude-basic.yaml"));
    expect(configuration.modelDefaults).toEqual({
      familyPolicy: { id: "claude-default-family", version: 1 },
    });
    for (const modelId of ["sonnet", "opus", "fable"]) {
      expect(harnessAllowsModel(configuration.modelRules, {
        adapterId: "claude-subscription",
        modelId,
      })).toBe(true);
    }
    expect(harnessAllowsModel(configuration.modelRules, {
      adapterId: "claude-subscription",
      modelId: "claude-sonnet-4",
    })).toBe(false);
    expect(harnessAllowsModel(configuration.modelRules, {
      adapterId: "anthropic-api",
      modelId: "claude-sonnet-4",
    })).toBe(true);
  });

  it("validates provider-neutral all-model and subset compatibility", () => {
    const parsed = parseHarnessConfiguration({
      schemaVersion: 1,
      name: "subset",
      implementation: "codex.basic",
      implementationVersion: 1,
      permissionBindings,
      executionAccessContracts: ["managed-runtime@1"],
      modelCompatibility: [{
        providerId: "codex",
        modelIds: ["model-a", "model-b"],
        preferredModelId: "model-b",
      }],
      settings: {},
    });
    expect(parsed.modelCompatibility).toEqual([{
      providerId: "codex",
      modelIds: ["model-a", "model-b"],
      preferredModelId: "model-b",
    }]);
    expect(() => parseHarnessConfiguration({
      ...parsed,
      modelCompatibility: [{ providerId: "codex", modelIds: ["model-a"], preferredModelId: "model-b" }],
    })).toThrow("preferredModelId must be allowed");

    const stableModelId = 'vendor/model:latest"quoted';
    expect(parseHarnessConfiguration({
      ...parsed,
      modelCompatibility: [{
        providerId: "codex",
        modelIds: [stableModelId],
        preferredModelId: stableModelId,
      }],
    }).modelCompatibility).toEqual([{
      providerId: "codex",
      modelIds: [stableModelId],
      preferredModelId: stableModelId,
    }]);
    const unicodeModelId = "🧠".repeat(200);
    expect(parseHarnessConfiguration({
      ...parsed,
      modelCompatibility: [{ providerId: "codex", modelIds: [unicodeModelId] }],
    }).modelCompatibility).toEqual([{ providerId: "codex", modelIds: [unicodeModelId] }]);
    const byteOrderMarkModelId = "\uFEFFmodel\uFEFF";
    expect(parseHarnessConfiguration({
      ...parsed,
      modelCompatibility: [{ providerId: "codex", modelIds: [byteOrderMarkModelId] }],
    }).modelCompatibility).toEqual([{ providerId: "codex", modelIds: [byteOrderMarkModelId] }]);
    for (const modelId of [" model", "model\n", "model\uD800", "m".repeat(201)]) {
      expect(() => parseHarnessConfiguration({
        ...parsed,
        modelCompatibility: [{ providerId: "codex", modelIds: [modelId] }],
      })).toThrow("modelIds must be a non-empty model ID array");
    }
    expect(() => parseHarnessConfiguration({
      ...parsed,
      modelCompatibility: [{ providerId: "codex", modelIds: ["🧠".repeat(201)] }],
    })).toThrow("modelIds must be a non-empty model ID array");
  });

  it("validates adapter model rules and applies deny-wins semantics", () => {
    const parsed = parseHarnessConfiguration({
      schemaVersion: 1,
      name: "coding",
      implementation: "codex.basic",
      implementationVersion: 1,
      permissionBindings,
      executionAccessContracts: ["secret@1"],
      modelRules: {
        allow: [
          { adapterId: "anthropic-api", modelIdRegex: "^claude-sonnet-" },
          { adapterId: "openai-api", modelIdExact: "gpt-5.2" },
        ],
        deny: [{ adapterId: "openai-api", modelIdRegex: "-preview$" }],
      },
      settings: {},
    });

    expect(harnessAllowsModel(parsed.modelRules, { adapterId: "anthropic-api", modelId: "claude-sonnet-4" })).toBe(true);
    expect(harnessAllowsModel(parsed.modelRules, { adapterId: "anthropic-api", modelId: "claude-haiku-4" })).toBe(false);
    expect(harnessAllowsModel(parsed.modelRules, { adapterId: "openai-api", modelId: "gpt-5.2" })).toBe(true);
    expect(harnessAllowsModel({
      allow: [{ adapterId: "openai-api", modelIdRegex: "^gpt-" }],
      deny: [{ adapterId: "openai-api", modelIdExact: "gpt-preview" }],
    }, { adapterId: "openai-api", modelId: "gpt-preview" })).toBe(false);
    expect(harnessAllowsModel({ allow: [], deny: [] }, { adapterId: "future", modelId: "model" })).toBe(true);
    expect(harnessAllowsModel(parsed.modelRules, { modelId: "gpt-5.2" })).toBe(false);
  });

  it("fails closed on invalid model rules and access contracts", () => {
    const base = {
      schemaVersion: 1,
      name: "invalid",
      implementation: "test",
      implementationVersion: 1,
      permissionBindings,
      settings: {},
    };
    expect(() => parseHarnessConfiguration({
      ...base,
      modelRules: { allow: [{ adapterId: "openai-api", modelIdRegex: "[" }] },
    })).toThrow("modelIdRegex is invalid");
    expect(() => parseHarnessConfiguration({
      ...base,
      modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt", modelIdRegex: "gpt" }] },
    })).toThrow("exactly one");
    expect(() => parseHarnessConfiguration({ ...base, executionAccessContracts: ["secret"] }))
      .toThrow("versioned identifier");
    expect(() => parseHarnessConfiguration({
      ...base,
      modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt" }] },
    })).toThrow("require executionAccessContracts");
    expect(() => parseHarnessConfiguration({
      ...base,
      executionAccessContracts: ["secret@1"],
      modelRules: { allow: [{ adapterId: "openai-api", modelIdRegex: "(?=gpt)" }] },
    })).toThrow("cross-runtime subset");
  });

  it("parses a managed family policy and adopts catalog-rule changes lazily", () => {
    const base = parseHarnessConfiguration({
      schemaVersion: 1,
      name: "managed",
      implementation: "test",
      implementationVersion: 1,
      permissionBindings,
      executionAccessContracts: ["managed-runtime@1"],
      modelDefaults: { familyPolicy: { id: "codex-default-family", version: 1 } },
      modelRules: { allow: [], deny: [] },
      settings: {},
    });
    expect(base.modelDefaults).toEqual({ familyPolicy: { id: "codex-default-family", version: 1 } });
    const changedRules = parseHarnessConfiguration({
      ...base,
      revision: 2,
      modelRules: { allow: [], deny: [{ adapterId: "codex-subscription", modelIdExact: "retired" }] },
      modelDefaults: { familyPolicy: { id: "codex-default-family", version: 2 } },
    });
    expect(sameHarnessExecutionConfiguration(base, changedRules)).toBe(true);
    expect(digestHarnessConfiguration(base)).not.toBe(digestHarnessConfiguration(changedRules));
  });

  it("rejects legacy model compatibility without explicit execution access", () => {
    expect(() => parseHarnessConfiguration({
      schemaVersion: 1,
      name: "ambient-legacy",
      implementation: "test",
      implementationVersion: 1,
      permissionBindings,
      modelCompatibility: [{ providerId: "codex" }],
      settings: {},
    })).toThrow("require executionAccessContracts");
  });

  it("keeps implementation-specific configuration opaque to the host", () => {
    expect(parseHarnessConfiguration({
      schemaVersion: 1,
      name: "prime-production",
      implementation: "prime.agent",
      implementationVersion: 7,
      permissionBindings,
      settings: { root: { model: "luna" }, reviewers: [{ model: "sol", effort: "high" }] },
    }).settings).toEqual({ root: { model: "luna" }, reviewers: [{ model: "sol", effort: "high" }] });
  });

  it("creates a stable digest from the exact configuration snapshot", () => {
    const left = parseHarnessConfiguration({
      schemaVersion: 1,
      name: "prime-production",
      implementation: "prime.agent",
      implementationVersion: 1,
      permissionBindings,
      settings: { reviewers: [{ effort: "high", model: "sol" }], root: { model: "luna" } },
    });
    const reordered = parseHarnessConfiguration({
      settings: { root: { model: "luna" }, reviewers: [{ model: "sol", effort: "high" }] },
      implementationVersion: 1,
      implementation: "prime.agent",
      name: "prime-production",
      permissionBindings,
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
      await writeFile(fast, "schemaVersion: 1\nname: codex-fast\nimplementation: codex.basic\nimplementationVersion: 1\npermissionBindings:\n  auto: {}\nsettings:\n  modelReasoningEffort: low\n", "utf8");
      await writeFile(deep, "schemaVersion: 1\nname: codex-deep\nimplementation: codex.basic\nimplementationVersion: 1\npermissionBindings:\n  auto: {}\nsettings:\n  modelReasoningEffort: high\n", "utf8");

      const catalog = await loadHarnessConfigurations([fast, deep]);

      expect([...catalog.keys()]).toEqual(["codex-fast", "codex-deep"]);
      expect([...catalog.values()].map(({ implementation }) => implementation)).toEqual(["codex.basic", "codex.basic"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads two production configurations for the same Prime Agent harness", async () => {
    const catalog = await loadHarnessConfigurations([
      join(repositoryRoot, "harnesses/prime-agent-basic.yaml"),
      join(repositoryRoot, "harnesses/prime-agent-deep.yaml"),
    ]);

    expect([...catalog.keys()]).toEqual(["prime-agent-basic", "prime-agent-deep"]);
    expect([...catalog.values()].map(({ implementation }) => implementation)).toEqual(["prime.agent", "prime.agent"]);
    expect(catalog.get("prime-agent-basic")?.settings).not.toEqual(catalog.get("prime-agent-deep")?.settings);
    for (const selected of catalog.values()) {
      expect(selected.permissionBindings).toEqual({
        ask: { boundary: "workspace-write@1", reviewer: "user", networkAccessEnabled: true },
        auto: { boundary: "workspace-write@1", reviewer: "automatic", networkAccessEnabled: true },
        full: {},
      });
      expect(selected.modelRules?.allow.map(({ adapterId }) => adapterId)).toEqual([
        "openai-api",
        "anthropic-api",
        "openrouter",
        "vercel-ai-router",
      ]);
      expect(selected.executionAccessContracts).toEqual(["secret@1"]);
      expect(selected.settings).not.toHaveProperty("model");
    }
  });

  it("loads the opt-in Luna layered-navigation configurations without changing legacy names", async () => {
    const catalog = await loadHarnessConfigurations([
      join(repositoryRoot, "harnesses/codex-basic.yaml"),
      join(repositoryRoot, "harnesses/codex-layered-navigation-luna.yaml"),
      join(repositoryRoot, "harnesses/prime-agent-layered-navigation-luna.yaml"),
    ]);

    expect([...catalog.keys()]).toEqual([
      "codex-basic",
      "codex-layered-navigation-luna",
      "prime-agent-layered-navigation-luna",
    ]);
    expect(catalog.get("codex-layered-navigation-luna")?.settings).toMatchObject({
      model: "gpt-5.6-luna",
      modelReasoningEffort: "medium",
      promptProfile: "layered-navigation-v1",
    });
    expect(catalog.get("prime-agent-layered-navigation-luna")?.settings).toMatchObject({
      thinkingLevel: "medium",
      promptProfile: "layered-navigation-v1",
    });
    expect(catalog.get("prime-agent-layered-navigation-luna")?.settings).not.toHaveProperty("model");
    expect(catalog.get("prime-agent-layered-navigation-luna")?.permissionBindings).toEqual({
      ask: { boundary: "workspace-write@1", reviewer: "user", networkAccessEnabled: true },
      auto: { boundary: "workspace-write@1", reviewer: "automatic", networkAccessEnabled: true },
      full: {},
    });
    expect(catalog.get("prime-agent-layered-navigation-luna")?.modelRules?.allow.map(({ adapterId }) => adapterId)).toEqual([
      "openai-api",
      "anthropic-api",
      "openrouter",
      "vercel-ai-router",
    ]);
    expect(catalog.get("prime-agent-layered-navigation-luna")?.executionAccessContracts).toEqual(["secret@1"]);
  });

  it("loads the model-neutral Codex multi-agent layered-navigation configuration", async () => {
    const configuration = await loadHarnessConfiguration(join(repositoryRoot, "harnesses/codex-multi-agent-layered-navigation.yaml"));

    expect(configuration).toEqual({
      schemaVersion: 1,
      name: "codex-multi-agent-layered-navigation",
      implementation: "codex.basic",
      implementationVersion: 1,
      permissionBindings: {
        ask: { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user", networkAccessEnabled: true },
        auto: { sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review", networkAccessEnabled: true },
        full: { sandboxMode: "danger-full-access", approvalPolicy: "never" },
      },
      modelCompatibility: [{ providerId: "codex" }],
      executionAccessContracts: ["managed-runtime@1"],
      settings: {
        modelReasoningEffort: "medium",
        promptProfile: "layered-navigation-multi-agent-v1",
        skipGitRepoCheck: true,
      },
    });
    expect(configuration.settings).not.toHaveProperty("model");
    expect(configuration.modelCompatibility?.[0]).not.toHaveProperty("preferredModelId");
  });

  it("rejects duplicate configuration names in a catalog", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-config-"));
    const first = join(directory, "first.yaml");
    const second = join(directory, "second.yaml");
    const source = "schemaVersion: 1\nname: duplicate\nimplementation: test\nimplementationVersion: 1\npermissionBindings:\n  auto: {}\nsettings: {}\n";
    try {
      await writeFile(first, source, "utf8");
      await writeFile(second, source, "utf8");
      await expect(loadHarnessConfigurations([first, second])).rejects.toThrow("Duplicate harness configuration name: duplicate");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
