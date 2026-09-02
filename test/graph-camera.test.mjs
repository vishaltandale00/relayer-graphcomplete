import { describe, expect, it } from "vitest";
import { productWorkspaceMarkup } from "../desktop/renderer/src/product-workspace/view.js";
import {
  GRAPH_MAX_ZOOM,
  GRAPH_MIN_ZOOM,
  captureGraphViewState,
  clampGraphZoom,
  fitGraphCamera,
  graphCameraViewKey,
  graphEdgeSegment,
  graphEdgeStrokeWidth,
  graphNodeLayoutBounds,
  graphScreenPoint,
  graphWorldPoint,
  inspectorFocusRestorationTarget,
  inspectorFitRequestIsCurrent,
  recenterGraphCamera,
  shouldActivateGraphNodeAfterPointerGesture,
  shouldFitInspectorDock,
  shouldFitInspectorOpen,
  shouldRevealStackedInspector,
  zoomGraphCameraAt,
} from "../desktop/renderer/src/product-workspace/workspace.js";

describe("product workspace graph camera", () => {
  it("fits and reveals inspectors only for user-initiated changes, never for restored or presented state", () => {
    const openCases = [
      [false, true, 761], [false, true, 760], [true, true, 1200], [true, false, 1200], [false, false, 1200],
    ];
    for (const [opened, permanentRail, viewportWidth] of openCases) {
      expect(
        shouldFitInspectorOpen(opened, permanentRail, viewportWidth),
        `no refit when node details opens (opened=${opened}, permanentRail=${permanentRail}, width=${viewportWidth})`,
      ).toBe(false);
    }

    const dockCases = [
      [true, false, true], [true, false, false], [false, false, true], [false, true, true],
    ];
    for (const [responsiveOpen, wasResponsive, docked] of dockCases) {
      expect(
        shouldFitInspectorDock(responsiveOpen, wasResponsive, docked),
        `no refit when responsive node details changes presentation (${responsiveOpen}, ${wasResponsive}, ${docked})`,
      ).toBe(false);
    }

    expect(shouldRevealStackedInspector(1100, true), "user-opened inspector revealed in stacked layout").toBe(true);
    expect(shouldRevealStackedInspector(760, true), "user-opened inspector revealed at the stacked breakpoint").toBe(true);
    expect(shouldRevealStackedInspector(1101, true), "no stacked reveal outside stacked widths").toBe(false);
    expect(shouldRevealStackedInspector(960, false), "restored state is never scrolled into view").toBe(false);

    const available = new Set(["origin", "graph", "badge"]);
    const choose = () => inspectorFocusRestorationTarget(
      "origin",
      "graph",
      ["badge", "settings"],
      (candidate) => available.has(candidate),
    );
    expect(choose(), "focus returns to the visible origin first").toBe("origin");
    available.delete("origin");
    expect(choose(), "graph fallback when the origin is gone").toBe("graph");
    available.delete("graph");
    expect(choose(), "first visible dock badge fallback").toBe("badge");
    available.clear();
    expect(choose(), "no candidate leaves focus unset").toBe(null);

    expect(shouldActivateGraphNodeAfterPointerGesture(false), "plain click activates the node").toBe(true);
    expect(shouldActivateGraphNodeAfterPointerGesture(true), "click generated after a drag does not activate").toBe(false);

    const request = { graphViewKey: "thread:turn:layer", cameraRevision: 4 };
    const current = {
      cameraRevision: 4,
      graphViewKey: "thread:turn:layer",
      inspectorOpen: true,
      viewportWidth: 1200,
    };
    expect(inspectorFitRequestIsCurrent(request, current), "unchanged camera and view keep the fit queued").toBe(true);
    expect(inspectorFitRequestIsCurrent(request, { ...current, cameraRevision: 5 }), "camera movement invalidates the fit").toBe(false);
    expect(inspectorFitRequestIsCurrent(request, { ...current, graphViewKey: "other" }), "view change invalidates the fit").toBe(false);
    expect(inspectorFitRequestIsCurrent(request, { ...current, inspectorOpen: false }), "closing the inspector invalidates the fit").toBe(false);
    expect(inspectorFitRequestIsCurrent(request, { ...current, viewportWidth: 760 }), "narrow layout invalidates the fit").toBe(false);
  });

  it("round-trips, zooms, fits, and captures the graph camera around a fixed world plane", () => {
    expect(graphEdgeStrokeWidth(0.4), "edge thickness scales down with zoom").toBeCloseTo(0.6);
    expect(graphEdgeStrokeWidth(2), "edge thickness scales up with zoom").toBe(3);

    const camera = { x: -35, y: 24, zoom: 0.5 };
    const screen = graphScreenPoint({ x: 120, y: 80 }, camera);
    expect(screen, "world to screen projection").toEqual({ x: 25, y: 64 });
    expect(graphWorldPoint(screen, camera), "screen back to world round trip").toEqual({ x: 120, y: 80 });

    const anchor = { x: 260, y: 180 };
    const anchoredCamera = { x: 20, y: -30, zoom: 0.8 };
    const worldAnchor = graphWorldPoint(anchor, anchoredCamera);
    const zoomed = zoomGraphCameraAt(anchoredCamera, 1.6, anchor);
    expect(zoomed.zoom, "zoom reaches the requested level").toBe(1.6);
    expect(graphScreenPoint(worldAnchor, zoomed), "pointer anchor stays fixed while zooming").toEqual(anchor);
    expect(zoomGraphCameraAt(anchoredCamera, 10, anchor).zoom, "zoom clamped at the maximum").toBe(GRAPH_MAX_ZOOM);
    expect(zoomGraphCameraAt(anchoredCamera, 0.01, anchor).zoom, "zoom clamped at the minimum").toBe(GRAPH_MIN_ZOOM);
    expect(clampGraphZoom(1.25), "in-range zoom passes through").toBe(1.25);

    const edgeCamera = { x: 10, y: 20, zoom: 0.5 };
    expect(graphEdgeSegment(
      graphScreenPoint({ x: 0, y: 0 }, edgeCamera),
      graphScreenPoint({ x: 200, y: 0 }, edgeCamera),
      24 * edgeCamera.zoom,
    ), "edge endpoints scaled to the rendered icon boundary").toEqual({ x1: 22, y1: 20, x2: 98, y2: 20 });

    const nodes = [{ x: 0, y: 0 }, { x: 400, y: 200 }];
    const bounds = { width: 600, height: 400 };
    const fitted = fitGraphCamera(nodes, bounds, 40);
    expect(fitted.zoom, "fit zoom above the minimum").toBeGreaterThanOrEqual(GRAPH_MIN_ZOOM);
    expect(fitted.zoom, "fit zoom below the maximum").toBeLessThanOrEqual(GRAPH_MAX_ZOOM);
    expect(graphScreenPoint({ x: 200, y: 122 }, fitted), "content centered in the viewport").toEqual({ x: 300, y: 200 });
    expect(graphScreenPoint({ x: -82, y: -28 }, fitted).x, "left content inset respected").toBeGreaterThanOrEqual(40);
    expect(graphScreenPoint({ x: 482, y: 272 }, fitted).x, "right content inset respected").toBeLessThanOrEqual(560);

    const recentered = recenterGraphCamera(nodes, bounds, 1.4);
    expect(recentered.zoom, "recenter keeps the requested zoom").toBe(1.4);
    expect(graphScreenPoint({ x: 200, y: 122 }, recentered), "recenter recenters without changing zoom").toEqual({ x: 300, y: 200 });

    const layoutBounds = graphNodeLayoutBounds(164, 260);
    expect(layoutBounds, "wrapped AI-authored title height included in node bounds").toEqual({ halfWidth: 82, top: 28, bottom: 237 });
    const tallCamera = fitGraphCamera([{ x: 0, y: 0, layoutBounds }], bounds, 40);
    expect(graphScreenPoint({ x: 0, y: -layoutBounds.top }, tallCamera).y, "title top stays inside the inset").toBeGreaterThanOrEqual(40);
    expect(graphScreenPoint({ x: 0, y: layoutBounds.bottom }, tallCamera).y, "wrapped title bottom stays inside the inset").toBeLessThanOrEqual(360);

    const thread = { id: "thread-1" };
    const viewState = {
      currentInteractionId: "turn-1",
      interactions: [{ id: "turn-1", threadId: "thread-1" }],
      visibleLayer: { layer: { id: "layer-1" } },
      nodes: [],
    };
    expect(graphCameraViewKey(viewState, thread, [{ id: "node-1" }]), "view key from thread, turn, and layer").toBe("thread-1:turn-1:layer-1");
    expect(graphCameraViewKey({
      ...viewState,
      currentInteractionId: "turn-2",
      interactions: [...viewState.interactions, { id: "turn-2", threadId: "thread-1" }],
    }, thread, [{ id: "node-1" }]), "turn change changes the view key").toBe("thread-1:turn-2:layer-1");
    expect(graphCameraViewKey({
      ...viewState,
      visibleLayer: { layer: { id: "layer-2" } },
    }, thread, [{ id: "node-1" }]), "layer change changes the view key").toBe("thread-1:turn-1:layer-2");

    const settledNodes = [{ id: 1, x: 120, y: 90, pinned: true }];
    const settledCamera = { x: 30, y: -20, zoom: 1.25 };
    const captured = captureGraphViewState(settledNodes, settledCamera, "turn-1", 4);
    settledNodes[0].x = 999;
    settledCamera.zoom = 0.4;
    expect(captured, "capture snapshots positions and camera against later mutation").toEqual({
      camera: { x: 30, y: -20, zoom: 1.25 },
      cameraRevision: 4,
      nodes: [{ id: 1, x: 120, y: 90, pinned: true }],
      settled: true,
      signature: "turn-1",
    });
  });

  it("renders visible zoom, fit, and recenter controls", () => {
    const markup = productWorkspaceMarkup();
    for (const id of ["zoomOutGraph", "zoomInGraph", "fitGraph", "recenterGraph", "graphZoomLevel"]) {
      expect(markup, `camera control ${id} rendered`).toContain(`id="${id}"`);
    }
  });
});
