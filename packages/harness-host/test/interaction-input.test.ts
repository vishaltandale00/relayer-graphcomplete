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
  it("keeps legacy text-only rendering byte-compatible", () => {
    expect(renderInteractionInput({ interaction, contexts: [] })).toBe(`{
  "message": "Question",
  "contexts": []
}`);
  });

  it("renders structured submitted input without authority metadata", () => {
    const rendered = renderInteractionInput({
      interaction: { ...interaction, title: "", detail: "" },
      contexts: [],
      submittedInputs: [{
        action: {
          control: "single_select",
          prompt: "Choose evidence",
          options: [{ key: "logs", label: "Logs" }],
        },
        value: { selected: [{ key: "logs", label: "Logs" }] },
      }],
    });

    expect(JSON.parse(rendered).submittedInputs).toEqual([{
      action: {
        control: "single_select",
        prompt: "Choose evidence",
        options: [{ key: "logs", label: "Logs" }],
      },
      value: { selected: [{ key: "logs", label: "Logs" }] },
    }]);
    expect(rendered).not.toContain("actionId");
    expect(rendered).not.toContain("attemptKey");
  });
});
