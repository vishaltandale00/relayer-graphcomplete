import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadHarnessConfiguration } from "../packages/harness-host/src/configuration.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const cells = Object.freeze([
  ["codex-eval-lantern-search-disabled-recursion-disabled", "disabled", false],
  ["codex-eval-lantern-search-query-v1-recursion-disabled", "query-v1", false],
  ["codex-eval-lantern-search-disabled-recursion-enabled", "disabled", true],
  ["codex-eval-lantern-search-query-v1-recursion-enabled", "query-v1", true],
]);

function controlledConfiguration(configuration) {
  const controlled = structuredClone(configuration);
  delete controlled.name;
  delete controlled.graphCapabilityProfile;
  delete controlled.complete;
  return controlled;
}

describe("Lantern graph-search × agent-authored recursion configurations", () => {
  it("defines a normalized Codex 2x2 whose cells vary only by the declared factors", async () => {
    const configurations = await Promise.all(cells.map(async ([name, search, agentAuthored]) => {
      const configuration = await loadHarnessConfiguration(
        resolve(repositoryRoot, "harnesses", `${name}.yaml`),
      );
      expect(configuration.name).toBe(name);
      expect(configuration.graphCapabilityProfile).toEqual({ search });
      expect(configuration.complete).toEqual({ agentAuthored });
      return configuration;
    }));

    expect(configurations.map(({ graphCapabilityProfile, complete }) => ({
      search: graphCapabilityProfile.search,
      agentAuthored: complete.agentAuthored,
    }))).toEqual([
      { search: "disabled", agentAuthored: false },
      { search: "query-v1", agentAuthored: false },
      { search: "disabled", agentAuthored: true },
      { search: "query-v1", agentAuthored: true },
    ]);

    const [control, ...otherCells] = configurations.map(controlledConfiguration);
    expect(otherCells).toEqual([control, control, control]);
    expect(control).toMatchObject({
      implementation: "codex.basic",
      modelRules: {
        allow: [{ adapterId: "codex-subscription", modelIdRegex: ".*" }],
        deny: [],
      },
      executionAccessContracts: ["managed-runtime@1", "secret@1"],
      settings: {
        modelReasoningEffort: "medium",
        personalPresentationVersion: "personal-presentation-v2",
        promptProfile: "layered-navigation-multi-agent-v1",
        skipGitRepoCheck: true,
      },
    });
  });
});
