import { describe, expect, it } from "vitest";

import {
  CASE_TYPE_BY_INTERACTION_VARIANT,
  EVAL_INTERACTION_CASE_TYPE_LABELS,
  EVAL_INTERACTION_CASE_TYPES,
  INTERACTION_VARIANT_BY_CASE_TYPE,
  INTERACTION_VARIANTS,
  decorateEvalCaseCatalogEntry,
  interactionCaseType,
  interactionVariantForCaseType,
  isInTurnSteered,
  isSteeredMultiTurn,
  requireSingleOpeningPrompt,
} from "../src/project-cases/interaction-variants.js";

describe("eval interaction case types", () => {
  it("defines single-turn and in-turn-steered as the two catalog types", () => {
    expect(EVAL_INTERACTION_CASE_TYPES).toEqual(["single-turn", "in-turn-steered"]);
    expect(INTERACTION_VARIANTS).toEqual(["single-turn", "multi-turn"]);
    expect(CASE_TYPE_BY_INTERACTION_VARIANT).toEqual({
      "single-turn": "single-turn",
      "multi-turn": "in-turn-steered",
    });
    expect(INTERACTION_VARIANT_BY_CASE_TYPE).toEqual({
      "single-turn": "single-turn",
      "in-turn-steered": "multi-turn",
    });
    expect(EVAL_INTERACTION_CASE_TYPE_LABELS["in-turn-steered"]).toBe("In-turn steered");
    expect(interactionVariantForCaseType("in-turn-steered")).toBe("multi-turn");
    expect(interactionCaseType({ interactionVariant: "multi-turn" })).toBe("in-turn-steered");
    expect(interactionCaseType({ caseType: "in-turn-steered" })).toBe("in-turn-steered");
    expect(isInTurnSteered({ interactionVariant: "multi-turn" })).toBe(true);
    expect(isSteeredMultiTurn({ caseType: "in-turn-steered" })).toBe(true);
    expect(isInTurnSteered({ interactionVariant: "single-turn" })).toBe(false);
    expect(interactionCaseType({})).toBeUndefined();
  });

  it("decorates catalog entries with the product type and label", () => {
    expect(decorateEvalCaseCatalogEntry({
      id: "autonomous.h3.sanitize-status-code.multi-turn",
      interactionVariant: "multi-turn",
    })).toMatchObject({
      caseType: "in-turn-steered",
      caseTypeLabel: "In-turn steered",
    });
    expect(decorateEvalCaseCatalogEntry({ id: "empty-project.task-system.single-turn" }))
      .toEqual({ id: "empty-project.task-system.single-turn" });
    expect(requireSingleOpeningPrompt(["Fix it."], "in-turn-steered")).toBe("Fix it.");
    expect(() => requireSingleOpeningPrompt(["one", "two"], "in-turn-steered"))
      .toThrow(/exactly one opening prompt/);
  });
});
