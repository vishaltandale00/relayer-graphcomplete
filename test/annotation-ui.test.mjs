import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ANNOTATION_RATINGS,
  activeAnnotations,
  annotationNavigationContext,
  annotationRatingLabel,
  annotationSubjectContextChanged,
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

  it("resets annotation drafts when either the thread or semantic subject changes", () => {
    const node = { kind: "node", interactionId: "turn-1", layerId: "layer-1", nodeId: "node-1" };
    expect(annotationSubjectContextChanged("thread-1", node, "thread-1", { ...node })).toBe(false);
    expect(annotationSubjectContextChanged("thread-1", node, "thread-2", { ...node })).toBe(true);
    expect(annotationSubjectContextChanged(
      "thread-1",
      node,
      "thread-1",
      { ...node, nodeId: "node-2" },
    )).toBe(true);
  });

  it("renders one compact slider and no unset or text Add controls", async () => {
    const markup = productWorkspaceMarkup();
    expect(markup.match(/type="range"/g)).toHaveLength(1);
    expect(markup).not.toContain("Unset");
    expect(markup).not.toContain(">Add<");
    expect(markup).toContain('class="annotation-submit"');
    expect(markup).toContain(">↑</button>");

    const graphAdapter = await readFile(new URL("../desktop/renderer/src/graph.js", import.meta.url), "utf8");
    const workspace = await readFile(new URL("../desktop/renderer/src/product-workspace/workspace.js", import.meta.url), "utf8");
    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(graphAdapter).toContain("appState.capabilities?.annotations === true");
    expect(graphAdapter).not.toContain('query.get("review") === "1"\n    ? createAnnotationApi');
    expect(workspace).toContain("if (!item.current)");
    expect(workspace).toContain("await onNavigateLayer(item.layerId");
    expect(workspace.match(/const \{ reveal \} = openInspector/g)).toHaveLength(2);
    expect(workspace).toContain("const { reveal } = openInspector({ origin });");
    expect(workspace).toContain("origin: event.currentTarget");
    expect(workspace).toContain("inspectorFocusRestorationTarget(");
    expect(styles).toContain("#nodeLayer{pointer-events:none}");
    expect(styles).toContain(".graph-node{position:absolute");
    expect(styles).toContain("pointer-events:auto");
    expect(styles).toContain(".inspector{position:relative}");
    expect(styles).toContain(".annotation-panel{position:absolute;inset:max(58%,calc(100% - 250px)) 12px 12px");
    expect(styles).toContain("overflow:auto");
    expect(styles).toContain("box-shadow:0 18px 48px rgba(0,0,0,.52)");
  });
});
