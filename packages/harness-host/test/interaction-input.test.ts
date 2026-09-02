import { describe, expect, it } from "vitest";
import { renderInteractionInput } from "../src/interaction-input.js";

const interaction = {
  id: 1,
  kind: "user-interaction",
  icon: "user",
  title: "Question",
  detail: "Question",
  state: "accepted" as const,
};

describe("normalized harness interaction input", () => {
  it("renders the interaction input contract for legacy text and structured submissions", () => {
    const submittedInputs = [{
      action: {
        control: "single_select" as const,
        prompt: "Choose evidence",
        options: [{ key: "logs", label: "Logs" }],
      },
      value: { selected: [{ key: "logs", label: "Logs" }] },
    }];
    const cases = [
      ["legacy text-only rendering stays byte-compatible", () => {
        expect(renderInteractionInput({ interaction, contexts: [] })).toBe(`{
  "message": "Question",
  "contexts": []
}`);
      }],
      ["structured submitted input renders without authority metadata", () => {
        const rendered = renderInteractionInput({
          interaction: { ...interaction, title: "", detail: "" },
          contexts: [],
          submittedInputs,
        });
        expect(JSON.parse(rendered).submittedInputs).toEqual(submittedInputs);
        for (const forbidden of ["actionId", "attemptKey"]) {
          expect(rendered, `no ${forbidden} authority metadata`).not.toContain(forbidden);
        }
      }],
    ] as const;
    expect(cases, "rendering contract inventory").toHaveLength(2);
    for (const [label, check] of cases) {
      expect.soft(() => check(), label).not.toThrow();
    }
  });
});
