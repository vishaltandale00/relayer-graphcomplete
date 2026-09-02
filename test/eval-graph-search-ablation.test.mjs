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
  it("flows the query-v1 preset from catalog through rendered controls into a platform-gated createRun", async () => {
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
    expect(catalog.ablations, "one query-v1 treatment beside the search-disabled baseline per provider").toEqual([{
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
    expect(catalog.harnessConfigurations.find(({ name }) => name === "codex-basic-graph-search"),
      "treatment configuration keeps baseline identity with query authority").toMatchObject({
      implementation: "codex.basic",
      graphCapabilityProfile: { search: "query-v1" },
    });

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
    expect(selection, "preset becomes the exact case by every control and treatment arm").toEqual({
      testCaseIds: ["graph-memory.prior-accepted-reference"],
      harnessConfigurationNames: [
        "codex-basic",
        "codex-basic-graph-search",
        "claude-basic",
        "claude-basic-graph-search",
      ],
      judgeConfigurationName: "deterministic-graph-contract",
    });

    const presetCatalog = {
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
    const createRun = vi.fn(async (runSelection) => ({ id: "run-1", selection: runSelection }));

    bindAblationControls(root, presetCatalog, (presetSelection) => { applied = presetSelection; });
    preset.onclick();
    const created = await createRunFromControls(root, { createRun });

    expect(applied, "clicking the preset applies exactly the rendered controls").toEqual(selectionFromControls(root));
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
    expect(createRun, "createRun receives the exact preset selection").toHaveBeenCalledExactlyOnceWith(expectedSelection);
    expect(created, "created run echoes the selection").toEqual({ id: "run-1", selection: expectedSelection });

    const gatedDirectory = await mkdtemp(join(tmpdir(), "relayer-eval-search-platform-gate-"));
    directories.push(gatedDirectory);
    const gatedService = await new EvalService({
      stateFile: join(gatedDirectory, "runs.json"),
      productSession: { url: "http://127.0.0.1:1", controlToken: "unused" },
      configurationPaths: [
        join(repositoryRoot, "harnesses", "codex-basic.yaml"),
        join(repositoryRoot, "harnesses", "codex-basic-graph-search.yaml"),
      ],
      platform: "win32",
      targetKey: "windows-x64",
    }).open();
    await expect(gatedService.createRun({
      testCaseIds: ["graph-memory.prior-accepted-reference"],
      harnessConfigurationNames: ["codex-basic", "codex-basic-graph-search"],
      judgeConfigurationName: "deterministic-graph-contract",
    }), "unsupported targets cannot run the crafted treatment").rejects.toThrow("qualified only for macOS Apple Silicon");
    expect(gatedService.listRuns(), "gated runs are never persisted").toEqual([]);
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
