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
  it("models ratings, timestamps, anchors, navigation identity, and draft reset on one contract", () => {
    expect(ANNOTATION_RATINGS, "sparse four-value rating contract").toEqual([
      { value: 1, label: "Bad" },
      { value: 2, label: "Needs work" },
      { value: 3, label: "Good" },
      { value: 4, label: "Great" },
    ]);
    expect(annotationRatingLabel(null), "no label for an unset rating").toBe(null);
    expect(annotationRatingLabel(3), "rating label lookup").toBe("Good");

    expect(annotationTimestamp("1787620000000")?.toISOString(), "durable millisecond timestamp").toBe("2026-08-25T01:06:40.000Z");
    expect(annotationTimestamp("2026-08-24T22:26:40.000Z")?.toISOString(), "ISO timestamp passthrough").toBe("2026-08-24T22:26:40.000Z");
    expect(annotationTimestamp("not-a-timestamp"), "invalid timestamp without renderer failure").toBe(null);

    const node = { kind: "node", interactionId: "turn-1", layerId: "layer-1", nodeId: "node-1" };
    expect(sameAnnotationAnchor(node, { ...node }), "identical node anchors match").toBe(true);
    expect(sameAnnotationAnchor(node, { ...node, layerId: "layer-2" }), "different layer breaks the anchor").toBe(false);
    const action = {
      kind: "action",
      interactionId: "turn-1",
      presentationLayerId: "layer-2",
      sourceLayerId: "layer-1",
      nodeId: "node-1",
      actionId: "action-1",
    };
    expect(sameAnnotationAnchor(action, { ...action }), "identical action anchors match").toBe(true);
    expect(sameAnnotationAnchor(action, { ...action, sourceLayerId: "layer-2" }), "different source layer breaks the anchor").toBe(false);
    const annotations = [
      { id: "active", anchor: node, revisions: [{ state: "active", comment: "Useful" }] },
      { id: "retracted", anchor: node, revisions: [{ state: "active" }, { state: "retracted" }] },
    ];
    expect(activeAnnotations(annotations).map(({ id }) => id), "retracted annotations excluded").toEqual(["active"]);
    expect(annotationsForAnchor(annotations, node).map(({ id }) => id), "anchor-scoped lookup excludes retracted").toEqual(["active"]);

    const anchor = { kind: "node", interactionId: "turn-1", layerId: "layer-2", nodeId: "node-3" };
    expect(annotationNavigationContext({
      currentInteractionId: "turn-1",
      layerPath: [{ layerId: "layer-1" }, { layerId: "layer-2", actionId: "action-1" }],
    }, anchor), "stable navigation identity instead of layout coordinates").toEqual({
      turnId: "turn-1",
      layerPath: [
        { layerId: "layer-1", viaActionId: null },
        { layerId: "layer-2", viaActionId: "action-1" },
      ],
      selectedSubject: anchor,
    });

    expect(annotationSubjectContextChanged("thread-1", node, "thread-1", { ...node }), "same thread and subject keeps drafts").toBe(false);
    expect(annotationSubjectContextChanged("thread-1", node, "thread-2", { ...node }), "thread change resets drafts").toBe(true);
    expect(annotationSubjectContextChanged(
      "thread-1",
      node,
      "thread-1",
      { ...node, nodeId: "node-2" },
    ), "semantic subject change resets drafts").toBe(true);
  });

  it("renders one compact slider and wires annotation seams without unset or text Add controls", async () => {
    const markup = productWorkspaceMarkup();
    expect(markup.match(/type="range"/g), "exactly one slider control").toHaveLength(1);
    expect(markup, "no Unset control").not.toContain("Unset");
    expect(markup, "no text Add control").not.toContain(">Add<");
    expect(markup, "annotation submit affordance").toContain('class="annotation-submit"');
    expect(markup, "arrow submit glyph").toContain(">↑</button>");

    const graphAdapter = await readFile(new URL("../desktop/renderer/src/graph.js", import.meta.url), "utf8");
    const workspace = await readFile(new URL("../desktop/renderer/src/product-workspace/workspace.js", import.meta.url), "utf8");
    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(graphAdapter, "capability-gated annotation API").toContain("appState.capabilities?.annotations === true");
    expect(graphAdapter, "annotation API not keyed off the raw review query param").not.toContain('query.get("review") === "1"\n    ? createAnnotationApi');
    expect(workspace, "unresolved navigation item guard").toContain("if (!item.current)");
    expect(workspace, "layer navigation call").toContain("await onNavigateLayer(item.layerId");
    expect(workspace.match(/const \{ reveal \} = openInspector/g), "inspector reveal call sites").toHaveLength(2);
    expect(workspace, "origin-based inspector reveal").toContain("const { reveal } = openInspector({ origin });");
    expect(workspace, "origin captured from the event target").toContain("origin: event.currentTarget");
    expect(workspace, "inspector focus restoration hook").toContain("inspectorFocusRestorationTarget(");
    expect(styles, "node layer passes pointer events through").toContain("#nodeLayer{pointer-events:none}");
    expect(styles, "graph nodes absolutely positioned").toContain(".graph-node{position:absolute");
    expect(styles, "nodes re-enable pointer events").toContain("pointer-events:auto");
  });
});
