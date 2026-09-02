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
  resolveGraphCapabilityProfile,
  sameHarnessExecutionConfiguration,
} from "../src/configuration.js";
import type { HarnessConfiguration, HarnessModelRules } from "../src/types.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const permissionBindings = { ask: {}, auto: {}, full: {} };
const baseConfiguration = {
  schemaVersion: 1,
  name: "contract",
  implementation: "test",
  implementationVersion: 1,
  permissionBindings,
  settings: {},
};
const subsetConfiguration = {
  ...baseConfiguration,
  name: "subset",
  implementation: "codex.basic",
  executionAccessContracts: ["managed-runtime@1"],
  modelCompatibility: [{
    providerId: "codex",
    modelIds: ["model-a", "model-b"],
    preferredModelId: "model-b",
  }],
};
const codingRules: HarnessModelRules = {
  allow: [
    { adapterId: "anthropic-api", modelIdRegex: "^claude-sonnet-" },
    { adapterId: "openai-api", modelIdExact: "gpt-5.2" },
  ],
  deny: [{ adapterId: "openai-api", modelIdRegex: "-preview$" }],
};

describe("harness configuration", () => {
  it("normalizes graph authority, Complete authority, and family policy into stable digests", () => {
    const omitted = parseHarnessConfiguration(baseConfiguration);
    const disabled = parseHarnessConfiguration({
      ...baseConfiguration,
      graphCapabilityProfile: { search: "disabled" },
    });
    const enabled = parseHarnessConfiguration({
      ...baseConfiguration,
      graphCapabilityProfile: { search: "query-v1" },
    });

    expect(resolveGraphCapabilityProfile(omitted), "omitted graph profile means search disabled").toEqual({ search: "disabled" });
    expect(resolveGraphCapabilityProfile(disabled), "explicit disabled profile").toEqual({ search: "disabled" });
    expect(resolveGraphCapabilityProfile(enabled), "versioned query-v1 profile").toEqual({ search: "query-v1" });
    expect(digestHarnessConfiguration(omitted), "omitted and disabled profiles share one digest").toBe(digestHarnessConfiguration(disabled));
    expect(digestHarnessConfiguration(enabled), "query-v1 changes the digest").not.toBe(digestHarnessConfiguration(disabled));
    expect(sameHarnessExecutionConfiguration(omitted, disabled), "omitted and disabled execute the same").toBe(true);
    expect(sameHarnessExecutionConfiguration(disabled, enabled), "enabling search changes execution").toBe(false);
    expect(sameHarnessExecutionConfiguration(enabled, disabled), "execution equivalence is symmetric").toBe(false);

    const completeDisabled = parseHarnessConfiguration({ ...baseConfiguration, name: "complete-disabled" });
    const completeEnabled = parseHarnessConfiguration({
      ...baseConfiguration,
      name: "complete-enabled",
      complete: { agentAuthored: true },
    });
    expect(completeDisabled.complete, "agent-authored Complete is opt-in").toBeUndefined();
    expect(completeEnabled.complete, "explicit Complete authority parses").toEqual({ agentAuthored: true });
    expect(sameHarnessExecutionConfiguration(completeDisabled, { ...completeEnabled, name: completeDisabled.name }),
      "Complete authority changes execution identity").toBe(false);
    expect(digestHarnessConfiguration(completeDisabled), "Complete authority changes the digest").not.toBe(
      digestHarnessConfiguration({ ...completeEnabled, name: completeDisabled.name }),
    );

    const familyV1 = parseHarnessConfiguration({
      ...baseConfiguration,
      name: "managed",
      implementation: "test",
      executionAccessContracts: ["managed-runtime@1"],
      modelDefaults: { familyPolicy: { id: "codex-default-family", version: 1 } },
      modelRules: { allow: [], deny: [] },
    });
    expect(familyV1.modelDefaults, "managed family policy parses").toEqual({ familyPolicy: { id: "codex-default-family", version: 1 } });
    const familyV2 = parseHarnessConfiguration({
      ...familyV1,
      revision: 2,
      modelRules: { allow: [], deny: [{ adapterId: "codex-subscription", modelIdExact: "retired" }] },
      modelDefaults: { familyPolicy: { id: "codex-default-family", version: 2 } },
    });
    expect(sameHarnessExecutionConfiguration(familyV1, familyV2), "catalog-rule changes adopt lazily").toBe(true);
    expect(digestHarnessConfiguration(familyV1), "catalog-rule changes still alter the snapshot digest").not.toBe(digestHarnessConfiguration(familyV2));

    const left = parseHarnessConfiguration({
      ...baseConfiguration,
      name: "prime-production",
      implementation: "prime.agent",
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
    expect(digestHarnessConfiguration(left), "digest shape").toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(digestHarnessConfiguration(reordered), "key order never changes the digest").toBe(digestHarnessConfiguration(left));
    expect(digestHarnessConfiguration(changed), "settings changes alter the digest").not.toBe(digestHarnessConfiguration(left));

    expect(parseHarnessConfiguration({
      ...baseConfiguration,
      name: "prime-production",
      implementation: "prime.agent",
      implementationVersion: 7,
      settings: { root: { model: "luna" }, reviewers: [{ model: "sol", effort: "high" }] },
    }).settings, "implementation-specific settings stay opaque").toEqual({ root: { model: "luna" }, reviewers: [{ model: "sol", effort: "high" }] });
  });

  it("rejects the invalid harness configuration corpus", () => {
    const cases: ReadonlyArray<readonly [string, unknown, string]> = [
      ["unversioned graph search profile", { ...baseConfiguration, graphCapabilityProfile: { search: "query-v2" } }, "graphCapabilityProfile.search"],
      ["unknown graph profile field", { ...baseConfiguration, graphCapabilityProfile: { search: "query-v1", target: "project" } }, "Unknown graphCapabilityProfile field"],
      ["preferred model outside the subset", { ...subsetConfiguration, modelCompatibility: [{ providerId: "codex", modelIds: ["model-a"], preferredModelId: "model-b" }] }, "preferredModelId must be allowed"],
      ["model id with leading whitespace", { ...subsetConfiguration, modelCompatibility: [{ providerId: "codex", modelIds: [" model"] }] }, "modelIds must be a non-empty model ID array"],
      ["model id with trailing newline", { ...subsetConfiguration, modelCompatibility: [{ providerId: "codex", modelIds: ["model\n"] }] }, "modelIds must be a non-empty model ID array"],
      ["model id with a lone surrogate", { ...subsetConfiguration, modelCompatibility: [{ providerId: "codex", modelIds: ["model\uD800"] }] }, "modelIds must be a non-empty model ID array"],
      ["model id over 200 ascii characters", { ...subsetConfiguration, modelCompatibility: [{ providerId: "codex", modelIds: ["m".repeat(201)] }] }, "modelIds must be a non-empty model ID array"],
      ["model id over 200 unicode characters", { ...subsetConfiguration, modelCompatibility: [{ providerId: "codex", modelIds: ["🧠".repeat(201)] }] }, "modelIds must be a non-empty model ID array"],
      ["invalid model id regex", { ...baseConfiguration, modelRules: { allow: [{ adapterId: "openai-api", modelIdRegex: "[" }], deny: [] } }, "modelIdRegex is invalid"],
      ["both exact and regex rule matchers", { ...baseConfiguration, modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt", modelIdRegex: "gpt" }], deny: [] } }, "exactly one"],
      ["unversioned execution access contract", { ...baseConfiguration, executionAccessContracts: ["secret"] }, "versioned identifier"],
      ["model rules without execution access contracts", { ...baseConfiguration, modelRules: { allow: [{ adapterId: "openai-api", modelIdExact: "gpt" }], deny: [] } }, "require executionAccessContracts"],
      ["lookahead regex that cannot run everywhere", { ...baseConfiguration, executionAccessContracts: ["secret@1"], modelRules: { allow: [{ adapterId: "openai-api", modelIdRegex: "(?=gpt)" }], deny: [] } }, "cross-runtime subset"],
      ["legacy model compatibility without explicit access", { ...baseConfiguration, name: "ambient-legacy", modelCompatibility: [{ providerId: "codex" }] }, "require executionAccessContracts"],
      ["Complete authority set to a bare true", { ...baseConfiguration, complete: true }, "Harness complete must contain only a boolean agentAuthored field"],
      ["Complete authority set to an empty object", { ...baseConfiguration, complete: {} }, "Harness complete must contain only a boolean agentAuthored field"],
      ["Complete authority with a non-boolean flag", { ...baseConfiguration, complete: { agentAuthored: "yes" } }, "Harness complete must contain only a boolean agentAuthored field"],
      ["Complete authority with an unknown field", { ...baseConfiguration, complete: { agentAuthored: true, depth: 2 } }, "Harness complete must contain only a boolean agentAuthored field"],
    ];
    expect(cases, "invalid configuration inventory").toHaveLength(18);
    for (const [label, configuration, message] of cases) {
      expect.soft(() => parseHarnessConfiguration(configuration), label).toThrow(message);
    }
  });

  it("applies model compatibility and adapter rule semantics", () => {
    const parsed = parseHarnessConfiguration(subsetConfiguration);
    expect(parsed.modelCompatibility, "subset compatibility round-trips").toEqual([{
      providerId: "codex",
      modelIds: ["model-a", "model-b"],
      preferredModelId: "model-b",
    }]);

    const acceptedModelIds: ReadonlyArray<readonly [string, readonly string[], string | undefined]> = [
      ["quoted vendor model ids stay byte-exact", ['vendor/model:latest"quoted'], 'vendor/model:latest"quoted'],
      ["200 unicode characters fit the stable id limit", ["🧠".repeat(200)], undefined],
      ["byte-order marks are preserved verbatim", ["\uFEFFmodel\uFEFF"], undefined],
    ];
    for (const [label, modelIds, preferredModelId] of acceptedModelIds) {
      expect(parseHarnessConfiguration({
        ...parsed,
        modelCompatibility: [{ providerId: "codex", modelIds, ...(preferredModelId === undefined ? {} : { preferredModelId }) }],
      }).modelCompatibility, label).toEqual([{ providerId: "codex", modelIds, ...(preferredModelId === undefined ? {} : { preferredModelId }) }]);
    }

    const coding = parseHarnessConfiguration({
      ...baseConfiguration,
      name: "coding",
      implementation: "codex.basic",
      executionAccessContracts: ["secret@1"],
      modelRules: codingRules,
    });
    const admissionCases: ReadonlyArray<readonly [string, HarnessModelRules, { adapterId?: string; modelId: string }, boolean]> = [
      ["regex allow matches the adapter prefix", coding.modelRules!, { adapterId: "anthropic-api", modelId: "claude-sonnet-4" }, true],
      ["regex allow rejects a different family", coding.modelRules!, { adapterId: "anthropic-api", modelId: "claude-haiku-4" }, false],
      ["exact allow matches its pinned model", coding.modelRules!, { adapterId: "openai-api", modelId: "gpt-5.2" }, true],
      ["deny wins over a matching allow", { allow: [{ adapterId: "openai-api", modelIdRegex: "^gpt-" }], deny: [{ adapterId: "openai-api", modelIdExact: "gpt-preview" }] }, { adapterId: "openai-api", modelId: "gpt-preview" }, false],
      ["empty rules admit every model", { allow: [], deny: [] }, { adapterId: "future", modelId: "model" }, true],
      ["adapter-less selections never match adapter rules", coding.modelRules!, { modelId: "gpt-5.2" }, false],
    ];
    expect(admissionCases, "adapter rule admission inventory").toHaveLength(6);
    for (const [label, rules, selection, allowed] of admissionCases) {
      expect.soft(harnessAllowsModel(rules, selection), label).toBe(allowed);
    }
  });

  it("loads and validates the checked-in harness catalog", async () => {
    const harnessDirectory = join(repositoryRoot, "harnesses");
    const paths = (await readdir(harnessDirectory))
      .filter((name) => name.endsWith(".yaml"))
      .sort()
      .map((name) => join(harnessDirectory, name));
    await expect(Promise.all(paths.map(loadHarnessConfiguration)), "every checked-in harness parses").resolves.toHaveLength(paths.length);

    for (const name of ["codex-basic", "claude-basic", "prime-agent-basic", "prime-agent-deep"]) {
      const configuration = await loadHarnessConfiguration(join(repositoryRoot, `harnesses/${name}.yaml`));
      expect(configuration.graphCapabilityProfile, `${name} ships search-disabled`).toEqual({ search: "disabled" });
      expect(resolveGraphCapabilityProfile(configuration), `${name} resolves search-disabled`).toEqual({ search: "disabled" });
    }

    const codexBasics: ReadonlyArray<readonly [string, string, number, string | undefined]> = [
      ["codex-basic", "medium", 6, "layered-navigation-multi-agent-v1"],
      ["codex-basic-high", "high", 4, undefined],
    ];
    for (const [name, modelReasoningEffort, revision, promptProfile] of codexBasics) {
      await expect(loadHarnessConfiguration(join(repositoryRoot, `harnesses/${name}.yaml`)), `${name} snapshot`).resolves.toEqual({
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
        ...(name === "codex-basic" ? { graphCapabilityProfile: { search: "disabled" } } : {}),
        settings: {
          modelReasoningEffort,
          ...(promptProfile === undefined ? {} : { promptProfile }),
          skipGitRepoCheck: true,
        },
      });
    }

    const claude = await loadHarnessConfiguration(join(repositoryRoot, "harnesses/claude-basic.yaml"));
    expect(claude.modelDefaults, "claude family policy").toEqual({
      familyPolicy: { id: "claude-default-family", version: 1 },
    });
    for (const modelId of ["sonnet", "opus", "fable"]) {
      expect(harnessAllowsModel(claude.modelRules, { adapterId: "claude-subscription", modelId }),
        `claude subscription alias ${modelId}`).toBe(true);
    }
    expect(harnessAllowsModel(claude.modelRules, { adapterId: "claude-subscription", modelId: "claude-sonnet-4" }),
      "versioned ids are not subscription aliases").toBe(false);
    expect(harnessAllowsModel(claude.modelRules, { adapterId: "anthropic-api", modelId: "claude-sonnet-4" }),
      "versioned ids stay valid through the API adapter").toBe(true);

    const primeCatalog = await loadHarnessConfigurations([
      join(repositoryRoot, "harnesses/prime-agent-basic.yaml"),
      join(repositoryRoot, "harnesses/prime-agent-deep.yaml"),
    ]);
    expect([...primeCatalog.keys()], "prime agent catalog names").toEqual(["prime-agent-basic", "prime-agent-deep"]);
    expect([...primeCatalog.values()].map(({ implementation }) => implementation), "one implementation, two configurations").toEqual(["prime.agent", "prime.agent"]);
    expect(primeCatalog.get("prime-agent-basic")?.settings, "prime configurations differ by settings").not.toEqual(primeCatalog.get("prime-agent-deep")?.settings);
    for (const selected of primeCatalog.values()) {
      expect(selected.permissionBindings, `${selected.name} permission bindings`).toEqual({
        ask: { boundary: "workspace-write@1", reviewer: "user", networkAccessEnabled: true },
        auto: { boundary: "workspace-write@1", reviewer: "automatic", networkAccessEnabled: true },
        full: {},
      });
      expect(selected.modelRules?.allow.map(({ adapterId }) => adapterId), `${selected.name} adapter allow order`).toEqual([
        "openai-api",
        "anthropic-api",
        "openrouter",
        "vercel-ai-router",
      ]);
      expect(selected.executionAccessContracts, `${selected.name} access contracts`).toEqual(["secret@1"]);
      expect(selected.settings, `${selected.name} never pins a model in settings`).not.toHaveProperty("model");
    }

    const lunaCatalog = await loadHarnessConfigurations([
      join(repositoryRoot, "harnesses/codex-basic.yaml"),
      join(repositoryRoot, "harnesses/codex-layered-navigation-luna.yaml"),
      join(repositoryRoot, "harnesses/prime-agent-layered-navigation-luna.yaml"),
    ]);
    expect([...lunaCatalog.keys()], "luna opt-in keeps legacy names").toEqual([
      "codex-basic",
      "codex-layered-navigation-luna",
      "prime-agent-layered-navigation-luna",
    ]);
    expect(lunaCatalog.get("codex-layered-navigation-luna")?.settings, "codex luna settings").toMatchObject({
      model: "gpt-5.6-luna",
      modelReasoningEffort: "medium",
      promptProfile: "layered-navigation-v1",
    });
    expect(lunaCatalog.get("prime-agent-layered-navigation-luna")?.settings, "prime luna settings").toMatchObject({
      thinkingLevel: "medium",
      promptProfile: "layered-navigation-v1",
    });
    expect(lunaCatalog.get("prime-agent-layered-navigation-luna")?.settings, "prime luna never pins a model").not.toHaveProperty("model");
    expect(lunaCatalog.get("prime-agent-layered-navigation-luna")?.permissionBindings, "prime luna permission bindings").toEqual({
      ask: { boundary: "workspace-write@1", reviewer: "user", networkAccessEnabled: true },
      auto: { boundary: "workspace-write@1", reviewer: "automatic", networkAccessEnabled: true },
      full: {},
    });
    expect(lunaCatalog.get("prime-agent-layered-navigation-luna")?.modelRules?.allow.map(({ adapterId }) => adapterId), "prime luna adapter allow order").toEqual([
      "openai-api",
      "anthropic-api",
      "openrouter",
      "vercel-ai-router",
    ]);
    expect(lunaCatalog.get("prime-agent-layered-navigation-luna")?.executionAccessContracts, "prime luna access contracts").toEqual(["secret@1"]);

    const multiAgent = await loadHarnessConfiguration(join(repositoryRoot, "harnesses/codex-multi-agent-layered-navigation.yaml"));
    expect(multiAgent, "model-neutral multi-agent snapshot").toEqual({
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
    expect(multiAgent.settings, "multi-agent never pins a model").not.toHaveProperty("model");
    expect(multiAgent.modelCompatibility?.[0], "multi-agent has no preferred model").not.toHaveProperty("preferredModelId");
  }, 15_000);

  it("catalogs many names per implementation and rejects duplicates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-harness-config-"));
    try {
      const fast = join(directory, "fast.yaml");
      const deep = join(directory, "deep.yaml");
      await writeFile(fast, "schemaVersion: 1\nname: codex-fast\nimplementation: codex.basic\nimplementationVersion: 1\npermissionBindings:\n  auto: {}\nsettings:\n  modelReasoningEffort: low\n", "utf8");
      await writeFile(deep, "schemaVersion: 1\nname: codex-deep\nimplementation: codex.basic\nimplementationVersion: 1\npermissionBindings:\n  auto: {}\nsettings:\n  modelReasoningEffort: high\n", "utf8");

      const catalog = await loadHarnessConfigurations([fast, deep]);
      expect([...catalog.keys()], "distinct names load in order").toEqual(["codex-fast", "codex-deep"]);
      expect([...catalog.values()].map(({ implementation }) => implementation), "both names select one implementation").toEqual(["codex.basic", "codex.basic"]);

      const duplicateSource = "schemaVersion: 1\nname: duplicate\nimplementation: test\nimplementationVersion: 1\npermissionBindings:\n  auto: {}\nsettings: {}\n";
      const first = join(directory, "first.yaml");
      const second = join(directory, "second.yaml");
      await writeFile(first, duplicateSource, "utf8");
      await writeFile(second, duplicateSource, "utf8");
      await expect(loadHarnessConfigurations([first, second]), "duplicate names fail closed").rejects.toThrow("Duplicate harness configuration name: duplicate");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
