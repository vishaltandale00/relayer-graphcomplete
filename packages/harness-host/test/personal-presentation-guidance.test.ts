import { describe, expect, it } from "vitest";
import type { ResolvedPersonalPresentation } from "@relayer/graph-client";
import { renderPersonalPresentationGuidance } from "../src/implementations/personal-presentation-guidance.js";

function presentation(nodes: ResolvedPersonalPresentation["graph"]["layers"][number]["nodes"]): ResolvedPersonalPresentation {
  return {
    attachment: { interactionNodeId: 10, versionInteractionNodeId: 90, rootLayerId: 91 },
    graph: {
      nodeId: 90,
      rootLayerId: 91,
      rootAction: { id: 92, sourceNodeId: 90, kind: "navigate", relation: "expand", label: "Personal presentation", variant: "pill", targetLayerId: 91, state: "accepted" },
      layers: [{
        layer: { id: 91, nodes: nodes.map((node) => node.id), edges: [], state: "accepted" },
        nodes,
        edges: [],
        actions: [],
      }],
    },
  };
}

describe("personal presentation guidance", () => {
  it("renders neutral V0 without changing baseline prompt content", () => {
    const neutral = presentation([{
      id: 93,
      kind: "personal-presentation-manifest",
      icon: "settings",
      title: "Neutral personal presentation",
      detail: "This control version adds no personal presentation guidance.",
      state: "accepted",
    }]);

    expect(renderPersonalPresentationGuidance(neutral)).toBe("");
  });

  it("renders accepted preference nodes in canonical layer and node order", () => {
    const guidance = renderPersonalPresentationGuidance(presentation([
      {
        id: 93,
        kind: "presentation-preference",
        icon: "compass",
        title: "Decision-useful center",
        detail: "The user prefers central layers that are immediately decision-useful. Foreground the conclusion or current status, the reasoning that materially affects it, and the most important tradeoffs or limitations.",
        state: "accepted",
      },
      {
        id: 94,
        kind: "presentation-preference",
        icon: "layers",
        title: "Adaptive progressive disclosure",
        detail: "Reveal additional information according to its value to understanding. Keep information central when it is necessary to understand the response without navigating. Use graph actions when supporting evidence, implementation detail, or secondary context would materially improve understanding or help the user proceed. Do not add branches that merely repeat or decorate the central explanation.",
        state: "accepted",
      },
      {
        id: 95,
        kind: "presentation-preference",
        icon: "workflow",
        title: "Visible working state",
        detail: "For work that will not finish immediately, prefer establishing a useful current early and advancing it often enough for the user to follow and steer the work. Exercise judgment so updates remain useful rather than noisy. Then return an integrated final response. Use separate semantic work scopes when available and useful, but preserve visible progress even when all work remains inside one completion. Do not expose private scratch reasoning or create decorative progress updates.",
        state: "accepted",
      },
    ]));

    expect(guidance).toBe(`Personal graph presentation preferences:

Decision-useful center: The user prefers central layers that are immediately decision-useful. Foreground the conclusion or current status, the reasoning that materially affects it, and the most important tradeoffs or limitations.

Adaptive progressive disclosure: Reveal additional information according to its value to understanding. Keep information central when it is necessary to understand the response without navigating. Use graph actions when supporting evidence, implementation detail, or secondary context would materially improve understanding or help the user proceed. Do not add branches that merely repeat or decorate the central explanation.

Visible working state: For work that will not finish immediately, prefer establishing a useful current early and advancing it often enough for the user to follow and steer the work. Exercise judgment so updates remain useful rather than noisy. Then return an integrated final response. Use separate semantic work scopes when available and useful, but preserve visible progress even when all work remains inside one completion. Do not expose private scratch reasoning or create decorative progress updates.`);
  });

  it("fails closed when the attachment and resolved graph disagree", () => {
    const valid = presentation([]);
    const invalid = {
      ...valid,
      attachment: { ...valid.attachment, rootLayerId: 999 },
    };

    expect(() => renderPersonalPresentationGuidance(invalid)).toThrow("root layer");
  });

  it("canonicalizes whitespace without adding harness-owned graph validity rules", () => {
    const padded = presentation([{
      id: 93,
      kind: "presentation-preference",
      icon: "compass",
      title: " Summary ",
      detail: " Show a summary. ",
      state: "accepted",
    }]);

    expect(renderPersonalPresentationGuidance(padded)).toContain("Summary: Show a summary.");
  });
});
