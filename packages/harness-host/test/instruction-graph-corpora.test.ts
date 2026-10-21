import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadHarnessConfiguration } from "../src/configuration.js";
import { instructionGraphCorpus } from "../src/instruction-graph-corpora.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
it.each([
  ["codex-basic", "codex-instruction-graph-v2", "codex-full-prompt-control", 19],
  ["claude-basic", "claude-instruction-graph-v2", "claude-full-prompt-control", 13],
  ["prime-agent-basic", "prime-agent-instruction-graph-v2", "prime-agent-full-prompt-control", 15],
] as const)("binds %s and its Eval alias to the reviewed provider corpus with a separate full-prompt control", async (name, alias, controlName, revision) => {
  const corpus = instructionGraphCorpus(alias);
  const current = await loadHarnessConfiguration(join(root, `harnesses/${name}.yaml`));
  const treatment = await loadHarnessConfiguration(join(root, `harnesses/${alias}.yaml`));
  const control = await loadHarnessConfiguration(join(root, `harnesses/${controlName}.yaml`));
  expect(current).toMatchObject({ name, revision, settings: { promptProfile: "instruction-graph-v2",
    instructionGraphVersionKey: corpus.versionKey, instructionGraphDigest: corpus.digest } });
  expect(treatment.settings).toEqual(current.settings);
  expect(treatment.implementation).toBe(current.implementation);
  expect(control.implementation).toBe(current.implementation);
  expect(control.permissionBindings).toEqual(current.permissionBindings);
  expect(control.settings.instructionGraphVersionKey).toBeUndefined();
  expect(control.settings.instructionGraphDigest).toBeUndefined();
  expect(control.settings.promptProfile).not.toBe("instruction-graph-v2");
  expect(corpus.retrievalContractVersion).toBe(2);
  expect(instructionGraphCorpus(alias)).toBe(corpus);
});
it("refuses unregistered corpora rather than selecting a fallback", () => {
  expect(() => instructionGraphCorpus("task-authored-instructions")).toThrow("Unknown code-owned instruction corpus");
});
