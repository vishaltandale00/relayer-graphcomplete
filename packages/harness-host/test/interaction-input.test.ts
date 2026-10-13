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
  it("exposes the full sealed completion contract without projection or private semantics", () => {
    const completionContract = {
      schemaVersion: 1 as const, interactionNodeId: 1,
      input: { text: "Question", context: [], answers: [], invocationReferences: [] },
      authorities: [{ kind: "navigate.add" as const, nodeId: 20 }],
      returnRequirements: [{ kind: "navigate.response" as const, nodeId: 20 }], digest: "sha256:v1:fixture",
    };
    expect(JSON.parse(renderInteractionInput({ interaction, contexts: [], completionContract })).completionContract).toEqual(completionContract);
  });
  it("delivers the exact frozen policy including legacy and disabled snapshots", () => {
    for (const version of ["1", "2"] as const) {
      for (const enabled of [false, true]) {
        const interactionPermissions = { version, enabled, permissions: [{ kind: "navigate.add" as const, nodeId: 20 }] };
        expect(JSON.parse(renderInteractionInput({ interaction, contexts: [], interactionPermissions })).interactionPermissions).toEqual(interactionPermissions);
      }
    }
  });
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
