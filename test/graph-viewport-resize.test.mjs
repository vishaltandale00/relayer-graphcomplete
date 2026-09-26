import { describe, expect, it, vi } from "vitest";
import { graphCameraForView, observeAutomaticGraphFitOnResize } from "../desktop/renderer/src/product-workspace/workspace.js";

class ResizeObserverFixture {
  constructor(callback) { this.callback = callback; }
  observe = vi.fn();
  disconnect = vi.fn();
  notify() { this.callback([]); }
}

describe("graph viewport resize", () => {
  it("refits automatic cameras when the sidebar changes canvas width and preserves a manually adjusted camera", () => {
    let size = { width: 500, height: 420 };
    let cameraRevision = 0;
    const observer = new ResizeObserverFixture(() => {});
    const refit = vi.fn();
    const cleanup = observeAutomaticGraphFitOnResize({
      graphStage: { getBoundingClientRect: () => size },
      graphWindow: { ResizeObserver: class extends ResizeObserverFixture {
        constructor(callback) { super(callback); Object.assign(observer, this); }
      } },
      getCameraRevision: () => cameraRevision,
      getGraphNodes: () => [{ id: 1 }],
      hasActiveGesture: () => false,
      refit,
    });

    observer.notify();
    size = { width: 270, height: 420 };
    observer.notify();
    expect(refit).toHaveBeenCalledOnce();

    cameraRevision = 1;
    size = { width: 500, height: 420 };
    observer.notify();
    expect(refit).toHaveBeenCalledOnce();
    cleanup();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it("does not refit during a graph pointer gesture", () => {
    let size = { width: 500, height: 420 };
    const observer = new ResizeObserverFixture(() => {});
    const refit = vi.fn();
    observeAutomaticGraphFitOnResize({
      graphStage: { getBoundingClientRect: () => size },
      graphWindow: { ResizeObserver: class extends ResizeObserverFixture {
        constructor(callback) { super(callback); Object.assign(observer, this); }
      } },
      getCameraRevision: () => 0,
      getGraphNodes: () => [{ id: 1 }],
      hasActiveGesture: () => true,
      refit,
    });
    observer.notify();
    size = { width: 270, height: 420 };
    observer.notify();
    expect(refit).not.toHaveBeenCalled();
  });
  it("resets automatic fit on a fresh view, refits automatic cached views to current bounds, and preserves manual cached cameras", () => {
    const nodes = [
      { x: 0, y: 0, width: 80, height: 50 },
      { x: 320, y: 240, width: 80, height: 50 },
    ];
    const narrow = { width: 280, height: 420 };
    const wide = { width: 520, height: 420 };
    const fresh = graphCameraForView({
      cachedView: null,
      cachedLayoutMatches: false,
      enteringView: true,
      nodes,
      bounds: narrow,
      currentCamera: { x: 8, y: 9, zoom: 2 },
      currentCameraRevision: 4,
    });
    expect(fresh.cameraRevision).toBe(0);
    expect(fresh.camera).toEqual(expect.objectContaining({ zoom: expect.any(Number) }));

    const automaticCache = { camera: fresh.camera, cameraRevision: 0 };
    const restoredAutomatic = graphCameraForView({
      cachedView: automaticCache,
      cachedLayoutMatches: true,
      enteringView: true,
      nodes,
      bounds: wide,
      currentCamera: fresh.camera,
      currentCameraRevision: 0,
    });
    expect(restoredAutomatic.camera).not.toEqual(fresh.camera);
    expect(restoredAutomatic.cameraRevision).toBe(0);

    const manualCamera = { x: 124, y: 88, zoom: 1.7 };
    const restoredManual = graphCameraForView({
      cachedView: { camera: manualCamera, cameraRevision: 3 },
      cachedLayoutMatches: true,
      enteringView: true,
      nodes,
      bounds: wide,
      currentCamera: fresh.camera,
      currentCameraRevision: 0,
    });
    expect(restoredManual).toEqual({ camera: manualCamera, cameraRevision: 3 });
  });

});
