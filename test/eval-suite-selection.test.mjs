import { describe, expect, it } from "vitest";

import { applyAblationToControls, selectionFromControls } from "../desktop/eval-renderer/configuration-model.js";

function rootWith(groups) {
  return {
    querySelector(selector) { return selector === "#judgeSetupRevision" ? groups.judgeSetupRevision?.[0] ?? null : null; },
    querySelectorAll(selector) {
      const name = /name="([^"]+)"/.exec(selector)?.[1];
      const checkedOnly = selector.includes(":checked");
      return (groups[name] || []).filter((input) => !checkedOnly || input.checked);
    },
  };
}

describe("Eval suite selection", () => {
  it("sends a suite identity without caller-controlled member overrides", () => {
    const root = rootWith({
      suites: [{ value: "fixture-suite-v1", checked: true }],
      cases: [{ value: "case-a", checked: true }, { value: "case-b", checked: true }],
      harnesses: [{ value: "codex-basic", checked: true }],
      judge: [{ value: "simulated-user", checked: true }],
      judgeSetupRevision: [{ value: "setup-selected-immutable" }],
    });

    expect(selectionFromControls(root)).toEqual({
      suiteId: "fixture-suite-v1",
      testCaseIds: [],
      harnessConfigurationNames: ["codex-basic"],
      judgeConfigurationName: "simulated-user",
      judgeSetupRevisionId: "setup-selected-immutable",
    });
  });

  it("clears a suite when applying an ordinary ablation preset", () => {
    const suiteInput = { value: "fixture-suite-v1", checked: true };
    const root = rootWith({
      suites: [suiteInput],
      cases: [{ value: "case-a", checked: false }],
      harnesses: [{ value: "control", checked: false }, { value: "treatment", checked: false }],
      judge: [{ value: "deterministic-graph-contract", checked: false }],
    });
    const catalog = {
      ablations: [{
        id: "ablation-a",
        testCaseIds: ["case-a"],
        harnessPairs: [{ control: "control", treatment: "treatment" }],
      }],
      judges: [{ id: "deterministic-graph-contract" }],
    };

    applyAblationToControls(root, catalog, "ablation-a");

    expect(suiteInput.checked).toBe(false);
    expect(selectionFromControls(root)).toMatchObject({
      suiteId: null,
      testCaseIds: ["case-a"],
    });
  });
});
