import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ANNOTATION_RATINGS,
  activeAnnotations,
  annotationNavigationContext,
  annotationRatingLabel,
  annotationTimestamp,
  annotationsForAnchor,
  sameAnnotationAnchor,
} from "../desktop/renderer/src/product-workspace/annotations.js";
import { productWorkspaceMarkup } from "../desktop/renderer/src/product-workspace/view.js";

describe("Eval ProductWorkspace annotations", () => {
  it("keeps the sparse four-value rating contract", () => {
    expect(ANNOTATION_RATINGS).toEqual([
      { value: 1, label: "Bad" },
      { value: 2, label: "Needs work" },
      { value: 3, label: "Good" },
      { value: 4, label: "Great" },
    ]);
    expect(annotationRatingLabel(null)).toBe(null);
    expect(annotationRatingLabel(3)).toBe("Good");
  });

  it("formats durable millisecond timestamps without invalid-date renderer failures", () => {
    expect(annotationTimestamp("1787620000000")?.toISOString()).toBe("2026-08-25T01:06:40.000Z");
    expect(annotationTimestamp("2026-08-24T22:26:40.000Z")?.toISOString()).toBe("2026-08-24T22:26:40.000Z");
    expect(annotationTimestamp("not-a-timestamp")).toBe(null);
  });

  it("matches exact semantic anchors and excludes retracted annotations", () => {
    const node = { kind: "node", interactionId: "turn-1", layerId: "layer-1", nodeId: "node-1" };
    expect(sameAnnotationAnchor(node, { ...node })).toBe(true);
    expect(sameAnnotationAnchor(node, { ...node, layerId: "layer-2" })).toBe(false);
    const action = {
      kind: "action",
      interactionId: "turn-1",
      presentationLayerId: "layer-2",
      sourceLayerId: "layer-1",
      nodeId: "node-1",
      actionId: "action-1",
    };
    expect(sameAnnotationAnchor(action, { ...action })).toBe(true);
    expect(sameAnnotationAnchor(action, { ...action, sourceLayerId: "layer-2" })).toBe(false);
    const annotations = [
      { id: "active", anchor: node, revisions: [{ state: "active", comment: "Useful" }] },
      { id: "retracted", anchor: node, revisions: [{ state: "active" }, { state: "retracted" }] },
    ];
    expect(activeAnnotations(annotations).map(({ id }) => id)).toEqual(["active"]);
    expect(annotationsForAnchor(annotations, node).map(({ id }) => id)).toEqual(["active"]);
  });

  it("captures stable navigation identity rather than layout coordinates", () => {
    const anchor = { kind: "node", interactionId: "turn-1", layerId: "layer-2", nodeId: "node-3" };
    expect(annotationNavigationContext({
      currentInteractionId: "turn-1",
      layerPath: [{ layerId: "layer-1" }, { layerId: "layer-2", actionId: "action-1" }],
    }, anchor)).toEqual({
      turnId: "turn-1",
      layerPath: [
        { layerId: "layer-1", viaActionId: null },
        { layerId: "layer-2", viaActionId: "action-1" },
      ],
      selectedSubject: anchor,
    });
  });

  it("renders one compact slider and no unset or text Add controls", async () => {
    const markup = productWorkspaceMarkup();
    expect(markup.match(/type="range"/g)).toHaveLength(1);
    expect(markup).not.toContain("Unset");
    expect(markup).not.toContain(">Add<");
    expect(markup).toContain('class="annotation-submit"');
    expect(markup).toContain(">↑</button>");

    const graphAdapter = await readFile(new URL("../desktop/renderer/src/graph.js", import.meta.url), "utf8");
    expect(graphAdapter).toContain("appState.capabilities?.annotations === true");
    expect(graphAdapter).not.toContain('query.get("review") === "1"\n    ? createAnnotationApi');
  });
});
