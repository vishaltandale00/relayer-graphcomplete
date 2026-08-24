import { describe, expect, it, vi } from "vitest";
import { productWorkspaceMarkup } from "../desktop/renderer/src/product-workspace/view.js";
import { createGraphSimulationController } from "../desktop/renderer/src/product-workspace/graph-simulation.js";
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
  inspectorFitRequestIsCurrent,
  recenterGraphCamera,
  shouldActivateGraphNodeAfterPointerGesture,
  shouldAutoFitSettledGraph,
  shouldFitInspectorDock,
  shouldFitInspectorOpen,
  zoomGraphCameraAt,
} from "../desktop/renderer/src/product-workspace/workspace.js";

describe("product workspace graph camera", () => {
  it("requests an inspector fit only for a desktop closed-to-open transition", () => {
    expect(shouldFitInspectorOpen(false, true, 761)).toBe(true);
    expect(shouldFitInspectorOpen(false, true, 760)).toBe(false);
    expect(shouldFitInspectorOpen(true, true, 1200)).toBe(false);
    expect(shouldFitInspectorOpen(true, false, 1200)).toBe(false);
    expect(shouldFitInspectorOpen(false, false, 1200)).toBe(false);
  });

  it("requests a fit when an open overlay inspector becomes docked", () => {
    expect(shouldFitInspectorDock(true, false, true)).toBe(true);
    expect(shouldFitInspectorDock(true, false, false)).toBe(false);
    expect(shouldFitInspectorDock(false, false, true)).toBe(false);
    expect(shouldFitInspectorDock(false, true, true)).toBe(false);
  });

  it("does not activate a graph node from the click generated after dragging it", () => {
    expect(shouldActivateGraphNodeAfterPointerGesture(false)).toBe(true);
    expect(shouldActivateGraphNodeAfterPointerGesture(true)).toBe(false);
  });

  it("invalidates queued inspector fits after camera, view, close, or narrow-layout changes", () => {
    const request = { graphViewKey: "thread:turn:layer", cameraRevision: 4 };
    const current = {
      cameraRevision: 4,
      graphViewKey: "thread:turn:layer",
      inspectorOpen: true,
      viewportWidth: 1200,
    };
    expect(inspectorFitRequestIsCurrent(request, current)).toBe(true);
    expect(inspectorFitRequestIsCurrent(request, { ...current, cameraRevision: 5 })).toBe(false);
    expect(inspectorFitRequestIsCurrent(request, { ...current, graphViewKey: "other" })).toBe(false);
    expect(inspectorFitRequestIsCurrent(request, { ...current, inspectorOpen: false })).toBe(false);
    expect(inspectorFitRequestIsCurrent(request, { ...current, viewportWidth: 760 })).toBe(false);
  });

  it("invalidates a previous view's queued physics frame before it can mutate a restored view", () => {
    const queuedFrames = new Map();
    let nextFrame = 0;
    const requestFrame = vi.fn((callback) => {
      const frame = ++nextFrame;
      queuedFrames.set(frame, callback);
      return frame;
    });
    const cancelFrame = vi.fn((frame) => queuedFrames.delete(frame));
    const controller = createGraphSimulationController({ requestFrame, cancelFrame });
    const step = vi.fn(() => true);

    controller.start(step);
    const staleFrame = requestFrame.mock.results[0].value;
    const staleCallback = queuedFrames.get(staleFrame);
    controller.cancel();
    staleCallback();

    expect(step).toHaveBeenCalledTimes(1);
    expect(cancelFrame).toHaveBeenCalledWith(staleFrame);
    expect(queuedFrames.has(staleFrame)).toBe(false);
  });

  it("scales edge thickness with the camera zoom", () => {
    expect(graphEdgeStrokeWidth(0.4)).toBeCloseTo(0.6);
    expect(graphEdgeStrokeWidth(2)).toBe(3);
  });

  it("round-trips between graph world and screen coordinates at any zoom", () => {
    const camera = { x: -35, y: 24, zoom: 0.5 };
    const screen = graphScreenPoint({ x: 120, y: 80 }, camera);

    expect(screen).toEqual({ x: 25, y: 64 });
    expect(graphWorldPoint(screen, camera)).toEqual({ x: 120, y: 80 });
  });

  it("keeps the graph point under the pointer fixed while zooming", () => {
    const anchor = { x: 260, y: 180 };
    const camera = { x: 20, y: -30, zoom: 0.8 };
    const worldAnchor = graphWorldPoint(anchor, camera);
    const zoomed = zoomGraphCameraAt(camera, 1.6, anchor);

    expect(zoomed.zoom).toBe(1.6);
    expect(graphScreenPoint(worldAnchor, zoomed)).toEqual(anchor);
    expect(zoomGraphCameraAt(camera, 10, anchor).zoom).toBe(GRAPH_MAX_ZOOM);
    expect(zoomGraphCameraAt(camera, 0.01, anchor).zoom).toBe(GRAPH_MIN_ZOOM);
    expect(clampGraphZoom(1.25)).toBe(1.25);
  });

  it("fits a settled new view only when the user has not changed its camera", () => {
    expect(shouldAutoFitSettledGraph("turn:layer", "turn:layer", 3, 3)).toBe(true);
    expect(shouldAutoFitSettledGraph("turn:layer", "turn:layer", 3, 4)).toBe(false);
    expect(shouldAutoFitSettledGraph("turn:layer", "other:layer", 3, 3)).toBe(false);
  });

  it("scales edge endpoints to the rendered icon boundary", () => {
    const camera = { x: 10, y: 20, zoom: 0.5 };
    const segment = graphEdgeSegment(
      graphScreenPoint({ x: 0, y: 0 }, camera),
      graphScreenPoint({ x: 200, y: 0 }, camera),
      24 * camera.zoom,
    );

    expect(segment).toEqual({ x1: 22, y1: 20, x2: 98, y2: 20 });
  });

  it("fits graph content inside the viewport and recenters without changing zoom", () => {
    const nodes = [{ x: 0, y: 0 }, { x: 400, y: 200 }];
    const bounds = { width: 600, height: 400 };
    const camera = fitGraphCamera(nodes, bounds, 40);

    expect(camera.zoom).toBeGreaterThanOrEqual(GRAPH_MIN_ZOOM);
    expect(camera.zoom).toBeLessThanOrEqual(GRAPH_MAX_ZOOM);
    expect(graphScreenPoint({ x: 200, y: 122 }, camera)).toEqual({ x: 300, y: 200 });
    expect(graphScreenPoint({ x: -82, y: -28 }, camera).x).toBeGreaterThanOrEqual(40);
    expect(graphScreenPoint({ x: 482, y: 272 }, camera).x).toBeLessThanOrEqual(560);

    const recentered = recenterGraphCamera(nodes, bounds, 1.4);
    expect(recentered.zoom).toBe(1.4);
    expect(graphScreenPoint({ x: 200, y: 122 }, recentered)).toEqual({ x: 300, y: 200 });
  });

  it("includes the rendered height of wrapped AI-authored node titles when fitting", () => {
    const layoutBounds = graphNodeLayoutBounds(164, 260);
    const nodes = [{ x: 0, y: 0, layoutBounds }];
    const bounds = { width: 600, height: 400 };
    const camera = fitGraphCamera(nodes, bounds, 40);

    expect(layoutBounds).toEqual({ halfWidth: 82, top: 28, bottom: 237 });
    expect(graphScreenPoint({ x: 0, y: -layoutBounds.top }, camera).y).toBeGreaterThanOrEqual(40);
    expect(graphScreenPoint({ x: 0, y: layoutBounds.bottom }, camera).y).toBeLessThanOrEqual(360);
  });

  it("uses turn and layer identity to decide when a graph needs its initial fit", () => {
    const thread = { id: "thread-1" };
    const state = {
      currentInteractionId: "turn-1",
      interactions: [{ id: "turn-1", threadId: "thread-1" }],
      visibleLayer: { layer: { id: "layer-1" } },
      nodes: [],
    };

    expect(graphCameraViewKey(state, thread, [{ id: "node-1" }])).toBe("thread-1:turn-1:layer-1");
    expect(graphCameraViewKey({
      ...state,
      currentInteractionId: "turn-2",
      interactions: [...state.interactions, { id: "turn-2", threadId: "thread-1" }],
    }, thread, [{ id: "node-1" }])).toBe("thread-1:turn-2:layer-1");
    expect(graphCameraViewKey({
      ...state,
      visibleLayer: { layer: { id: "layer-2" } },
    }, thread, [{ id: "node-1" }])).toBe("thread-1:turn-1:layer-2");
  });

  it("captures settled node positions and camera for turn navigation round trips", () => {
    const nodes = [{ id: 1, x: 120, y: 90, vx: 0, vy: 0, pinned: true }];
    const camera = { x: 30, y: -20, zoom: 1.25 };
    const captured = captureGraphViewState(nodes, camera, "turn-1", true, 4);

    nodes[0].x = 999;
    camera.zoom = 0.4;
    expect(captured).toEqual({
      camera: { x: 30, y: -20, zoom: 1.25 },
      cameraRevision: 4,
      nodes: [{ id: 1, x: 120, y: 90, vx: 0, vy: 0, pinned: true }],
      settled: true,
      signature: "turn-1",
    });
  });

  it("renders visible zoom, fit, and recenter controls", () => {
    const markup = productWorkspaceMarkup();
    expect(markup).toContain('id="zoomOutGraph"');
    expect(markup).toContain('id="zoomInGraph"');
    expect(markup).toContain('id="fitGraph"');
    expect(markup).toContain('id="recenterGraph"');
    expect(markup).toContain('id="graphZoomLevel"');
  });
});
