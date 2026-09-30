import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ResolvedPersonalPresentation } from "@relayer/graph-client";
import { renderPersonalPresentationGuidance, personalPresentationTraceValues } from "../src/implementations/personal-presentation-guidance.js";

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

  it("renders the published V3 visual preference neutrally without mutating it or rewriting custom text", () => {
    const source = readFileSync(new URL("../../../crates/relayer-app-server/src/runtime.rs", import.meta.url), "utf8");
    const encoded = source.match(/title: "Authored visual Node Details",\s*detail: ("(?:[^"\\]|\\.)*")/)?.[1];
    expect(encoded).toBeDefined();
    const detail = JSON.parse(encoded!);
    const node = { id: 93, kind: "presentation-preference", icon: "layout-template", title: "Authored visual Node Details", detail, state: "accepted" as const };
    const pinned = presentation([node]);
    const before = structuredClone(pinned);
    const rendered = renderPersonalPresentationGuidance(pinned);
    expect(rendered).toContain("every node you create");
    expect(rendered).toContain("exact source layer");
    expect(rendered).toContain("Mount every action");
    expect(rendered).not.toMatch(/detailAuthoring|checkpointNodeDetail|detailCapability|html`/);
    expect(pinned).toEqual(before);
    const custom = presentation([{ ...node, detail: detail + " Custom preference." }]);
    expect(renderPersonalPresentationGuidance(custom)).toContain(detail + " Custom preference.");
    const trace = personalPresentationTraceValues({ personalPresentation: pinned } as Parameters<typeof personalPresentationTraceValues>[0]);
    expect(trace?.exactBlock).toBe(rendered);
    expect(trace?.legacyBlocks).toEqual([`Personal graph presentation preferences:\n\n${node.title}: ${detail}`]);
    expect(trace?.fragments).toContain(detail);
    expect(trace?.fragments).toContain(rendered.split("\n\n")[1]);
  });

  it("renders V4 explanatory guidance verbatim without changing earlier preferences", () => {
    const source = readFileSync(new URL("../../../crates/relayer-app-server/src/runtime.rs", import.meta.url), "utf8");
    const encoded = source.match(/title: "Explanatory presentation",\s*detail: ("(?:[^"\\]|\\.)*")/)?.[1];
    expect(encoded).toBeDefined();
    const detail = JSON.parse(encoded!);
    const pinned = presentation([{ id: 93, kind: "presentation-preference", icon: "palette", title: "Explanatory presentation", detail, state: "accepted" }]);
    expect(renderPersonalPresentationGuidance(pinned)).toBe(`Personal graph presentation preferences:\n\nExplanatory presentation: ${detail}`);
    expect(personalPresentationTraceValues({ personalPresentation: pinned } as Parameters<typeof personalPresentationTraceValues>[0])?.legacyBlocks).toEqual([]);
  });

  it("renders V5 topological guidance without rewriting V4", () => {
    const source = readFileSync(new URL("../../../crates/relayer-app-server/src/runtime.rs", import.meta.url), "utf8");
    const encodedDetails = [...source.matchAll(/title: "Explanatory presentation",\s*detail: ("(?:[^"\\]|\\.)*")/g)]
      .map((match) => JSON.parse(match[1]!));
    expect(encodedDetails).toHaveLength(2);
    const [v4Detail, v5Detail] = encodedDetails;
    expect(v4Detail).not.toContain("graph topology itself");
    expect(v5Detail).toContain("graph topology itself");
    expect(v5Detail).toContain("distinct nodes and meaningful edges");
    expect(v5Detail).toContain("A flat one-node presentation is appropriate only when");
    expect(v5Detail).toContain("Do not split prose into decorative nodes or boxes");
    expect(v5Detail).toContain("a chart, map, or diagram may remain inside one Node Detail");
    const pinned = presentation([{ id: 93, kind: "presentation-preference", icon: "palette", title: "Explanatory presentation", detail: v5Detail, state: "accepted" }]);
    expect(renderPersonalPresentationGuidance(pinned)).toBe(`Personal graph presentation preferences:\n\nExplanatory presentation: ${v5Detail}`);
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
