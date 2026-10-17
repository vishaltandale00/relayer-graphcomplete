import { describe, expect, it } from "vitest";
import { renderInteractionInput, renderThreadHistory } from "../src/interaction-input.js";

const interaction = {
  id: 1,
  kind: "user-interaction",
  icon: "user",
  title: "Question",
  detail: "Question",
  state: "accepted" as const,
};

describe("normalized harness interaction input", () => {
  it("keeps graph continuation input independent of attachment body size and carries exact input once", () => {
    const completionContract = {
      schemaVersion: 1 as const, interactionNodeId: 1,
      input: { text: "Question", context: [{ nodeId: 20, annotations: ["Keep this correction"] }], answers: [], invocationReferences: [] },
      authorities: [{ kind: "navigate.add" as const, nodeId: 20 }],
      returnRequirements: [{ kind: "navigate.response" as const, nodeId: 20 }], digest: "sha256:v1:fixture",
    };
    const render = (detail: string) => renderInteractionInput({ interaction, completionContract,
      contexts: [{ type: "interaction.context", targetNode: { ...interaction, id: 20, detail, title: detail }, annotations: ["Keep this correction"] }],
      artifactNoteScreenshots: [{ targetNodeId: 20, annotationIndex: 0, digestSha256: "a".repeat(64), path: "/verified/note.png" }],
    }, "graph-v1");
    expect(render("tiny")).toBe(render("unrelated prior content".repeat(100_000)));
    const input = JSON.parse(render("tiny"));
    expect(input.completionContract).toEqual(completionContract);
    expect(input.artifactNoteScreenshots[0].path).toBe("/verified/note.png");
    expect(input.message).toBeUndefined();
    expect(input.contexts).toBeUndefined();
  });

  it("teaches bounded historical reads in both languages even without graph search", () => {
    const context = {
      origin: { kind: "root" }, contextMode: "graph-v1",
      threadHistory: Array.from({ length: 50 }, (_, index) => ({ interactionNodeId: index + 1 })),
      graphHistory: { entries: Array.from({ length: 8 }, (_, index) => ({
        interactionNodeId: 100 + index, lifecycle: "active" as const, currentLayerId: null, returnedLayerId: null,
        parentNodeId: null, sourceCompletionId: null,
      })), nextBeforeNodeId: 100 },
    } as const;
    for (const language of ["javascript", "python"] as const) {
      // This renderer uses only the continuation fields, not provider-specific execution state.
      const rendered = renderThreadHistory(context, language);
      expect(rendered).toContain("Do not eagerly read every turn");
      expect(rendered).toContain("Discovery works even when graph search is disabled");
      expect(rendered).toContain(language === "javascript" ? "getHistoricalInput" : "get_historical_input");
      expect(rendered).toContain("never authority");
      expect(rendered).toContain('"interactionNodeId": 1');
      expect(rendered).toContain('"interactionNodeId": 50');
      expect(rendered).toContain('"interactionNodeId": 100');
      expect(rendered).toContain('"interactionNodeId": 107');
    }
  });
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
