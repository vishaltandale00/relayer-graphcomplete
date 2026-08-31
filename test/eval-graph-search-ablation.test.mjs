import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EvalService } from "../desktop/eval-main/eval-service.mjs";
import { evalHarnessConfigurationPaths } from "../desktop/eval-main/configuration-paths.mjs";
import {
  bindAblationControls,
  createRunFromControls,
  selectionForAblation,
  selectionFromControls,
} from "../desktop/eval-renderer/configuration-model.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const directories = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Desktop Eval graph-search ablation", () => {
  it("catalogs one query-v1 treatment beside the search-disabled baseline for every available provider", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-search-ablation-"));
    directories.push(dataDirectory);
    const service = await new EvalService({
      stateFile: join(dataDirectory, "runs.json"),
      productSession: { url: "http://127.0.0.1:1", controlToken: "unused" },
      configurationPaths: evalHarnessConfigurationPaths({
        harnessDirectory: join(repositoryRoot, "harnesses"),
        isPackaged: false,
        packageAvailable: () => true,
        targetKey: "macos-arm64",
      }),
      targetKey: "macos-arm64",
    }).open();

    const catalog = service.catalog();
    expect(catalog.ablations).toEqual([{
      id: "graph-search-query-v1",
      name: "Graph search · query-v1",
      description: expect.stringContaining("same graph-memory case"),
      testCaseIds: ["graph-memory.prior-accepted-reference"],
      harnessPairs: [
        { provider: "Codex", control: "codex-basic", treatment: "codex-basic-graph-search" },
        { provider: "Claude", control: "claude-basic", treatment: "claude-basic-graph-search" },
        { provider: "Prime Agent", control: "prime-agent-basic", treatment: "prime-agent-basic-graph-search" },
      ],
    }]);
    expect(catalog.harnessConfigurations.find(({ name }) => name === "codex-basic-graph-search")).toMatchObject({
      implementation: "codex.basic",
      graphCapabilityProfile: { search: "query-v1" },
    });
  });

  it("rejects a crafted query-v1 run when an unsupported target loads the treatment directly", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-search-platform-gate-"));
    directories.push(dataDirectory);
    const service = await new EvalService({
      stateFile: join(dataDirectory, "runs.json"),
      productSession: { url: "http://127.0.0.1:1", controlToken: "unused" },
      configurationPaths: [
        join(repositoryRoot, "harnesses", "codex-basic.yaml"),
        join(repositoryRoot, "harnesses", "codex-basic-graph-search.yaml"),
      ],
      platform: "win32",
      targetKey: "windows-x64",
    }).open();

    await expect(service.createRun({
      testCaseIds: ["graph-memory.prior-accepted-reference"],
      harnessConfigurationNames: ["codex-basic", "codex-basic-graph-search"],
      judgeConfigurationName: "deterministic-graph-contract",
    })).rejects.toThrow("qualified only for macOS Apple Silicon");
    expect(service.listRuns()).toEqual([]);
  });

  it("turns the preset into the exact case by all control and treatment arms", () => {
    const selection = selectionForAblation({
      cases: [{ id: "graph-memory.prior-accepted-reference" }],
      judges: [{ id: "deterministic-graph-contract" }],
      ablations: [{
        id: "graph-search-query-v1",
        testCaseIds: ["graph-memory.prior-accepted-reference"],
        harnessPairs: [
          { provider: "Codex", control: "codex-basic", treatment: "codex-basic-graph-search" },
          { provider: "Claude", control: "claude-basic", treatment: "claude-basic-graph-search" },
        ],
      }],
    }, "graph-search-query-v1");

    expect(selection).toEqual({
      testCaseIds: ["graph-memory.prior-accepted-reference"],
      harnessConfigurationNames: [
        "codex-basic",
        "codex-basic-graph-search",
        "claude-basic",
        "claude-basic-graph-search",
      ],
      judgeConfigurationName: "deterministic-graph-contract",
    });
  });

  it("clicks the rendered preset and passes the exact selection to createRun", async () => {
    const catalog = {
      cases: [{ id: "graph-memory.prior-accepted-reference" }, { id: "unrelated-case" }],
      judges: [{ id: "deterministic-graph-contract" }, { id: "simulated-user" }],
      ablations: [{
        id: "graph-search-query-v1",
        testCaseIds: ["graph-memory.prior-accepted-reference"],
        harnessPairs: [
          { provider: "Codex", control: "codex-basic", treatment: "codex-basic-graph-search" },
          { provider: "Claude", control: "claude-basic", treatment: "claude-basic-graph-search" },
          { provider: "Prime Agent", control: "prime-agent-basic", treatment: "prime-agent-basic-graph-search" },
        ],
      }],
    };
    const preset = { dataset: { ablation: "graph-search-query-v1" }, onclick: null };
    const controls = {
      cases: inputs("graph-memory.prior-accepted-reference", "unrelated-case"),
      harnesses: inputs(
        "fixture-task-system",
        "codex-basic",
        "codex-basic-graph-search",
        "claude-basic",
        "claude-basic-graph-search",
        "prime-agent-basic",
        "prime-agent-basic-graph-search",
      ),
      judge: inputs("deterministic-graph-contract", "simulated-user"),
    };
    const root = controlRoot(preset, controls);
    let applied;
    const createRun = vi.fn(async (selection) => ({ id: "run-1", selection }));

    bindAblationControls(root, catalog, (selection) => { applied = selection; });
    preset.onclick();
    const created = await createRunFromControls(root, { createRun });

    expect(applied).toEqual(selectionFromControls(root));
    const expectedSelection = {
      testCaseIds: ["graph-memory.prior-accepted-reference"],
      harnessConfigurationNames: [
        "codex-basic",
        "codex-basic-graph-search",
        "claude-basic",
        "claude-basic-graph-search",
        "prime-agent-basic",
        "prime-agent-basic-graph-search",
      ],
      judgeConfigurationName: "deterministic-graph-contract",
    };
    expect(createRun).toHaveBeenCalledExactlyOnceWith(expectedSelection);
    expect(created).toEqual({ id: "run-1", selection: expectedSelection });
  });
});

function inputs(...values) {
  return values.map((value) => ({ value, checked: value === "unrelated-case" || value === "fixture-task-system" || value === "simulated-user" }));
}

function controlRoot(preset, controls) {
  return {
    querySelectorAll(selector) {
      if (selector === "[data-ablation]") return [preset];
      const match = selector.match(/^input\[name="(cases|harnesses|judge)"\](?::checked)?$/);
      if (!match) return [];
      const candidates = controls[match[1]];
      return selector.endsWith(":checked") ? candidates.filter(({ checked }) => checked) : candidates;
    },
  };
}
