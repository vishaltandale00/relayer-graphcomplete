import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadHarnessConfiguration } from "../packages/harness-host/src/configuration.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const cells = Object.freeze([
  ["codex-eval-lantern-search-query-v1-recursion-disabled", false],
  ["codex-eval-lantern-search-query-v1-recursion-enabled", true],
]);

function controlledConfiguration(configuration) {
  const controlled = structuredClone(configuration);
  delete controlled.name;
  delete controlled.complete;
  return controlled;
}

describe("Lantern agent-authored recursion configurations", () => {
  it("defines a normalized, search-enabled Codex pair whose cells vary only by recursion", async () => {
    const configurations = await Promise.all(cells.map(async ([name, agentAuthored]) => {
      const configuration = await loadHarnessConfiguration(
        resolve(repositoryRoot, "harnesses", `${name}.yaml`),
      );
      expect(configuration.name).toBe(name);
      expect(configuration.graphCapabilityProfile).toEqual({ search: "query-v1" });
      expect(configuration.complete).toEqual({ agentAuthored });
      return configuration;
    }));

    const [control, treatment] = configurations.map(controlledConfiguration);
    expect(treatment).toEqual(control);
    expect(control).toMatchObject({
      implementation: "codex.basic",
      graphCapabilityProfile: { search: "query-v1" },
      modelRules: {
        allow: [{ adapterId: "codex-subscription", modelIdRegex: ".*" }],
        deny: [],
      },
      executionAccessContracts: ["managed-runtime@1", "secret@1"],
      settings: {
        modelReasoningEffort: "medium",
        personalPresentationVersion: "personal-presentation-v2",
        promptProfile: "layered-navigation-multi-agent-v1",
        rootSessionMode: "fresh",
        skipGitRepoCheck: true,
      },
    });
  });
});
