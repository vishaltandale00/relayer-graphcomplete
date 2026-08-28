import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewSession } from "../desktop/eval-main/review-session.mjs";
import { setControlActivationCompletion } from "../desktop/renderer/src/control-activation.js";
import {
  accessibleControlName,
  createReviewPresentationAdapter,
  isAccessibleControl,
  isVisibleElement,
  visibleCaptureRegions,
} from "../desktop/renderer/src/review-tools.js";

const directories = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function reviewState(overrides = {}) {
  return {
    executionId: "execution-1",
    threadId: "thread-1",
    turnId: "turn-1",
    layerId: "layer-1",
    selectedNodeId: null,
    activatedActionId: null,
    navigationPath: [{ layerId: "layer-1", viaActionId: null }],
    viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
    controls: [],
    ...overrides,
  };
}

function fakeElectron(commands) {
  const ipc = new EventEmitter();
  const captures = [];
  const webContents = {
    isDestroyed: () => false,
    getURL: () => "http://127.0.0.1:43123/?threadId=thread-1&review=1",
    send: (_channel, request) => {
      queueMicrotask(async () => {
        try {
          const result = await commands[request.command](request.payload);
          ipc.emit(request.responseChannel, { sender: webContents }, { result });
        } catch (error) {
          ipc.emit(request.responseChannel, { sender: webContents }, { error: error.message });
        }
      });
    },
    capturePage: async (clip) => {
      captures.push(clip);
      return {
        toPNG: () => Buffer.from(`png:${JSON.stringify(clip)}:${captures.length}`),
        getSize: () => ({ width: clip.width * 2, height: clip.height * 2 }),
      };
    },
  };
  return { ipc, webContents, captures };
}

describe("ReviewSession", () => {
  it("requires server-enforced read-only authority on a local production review URL", async () => {
    const electron = fakeElectron({ snapshot: async () => reviewState() });
    expect(() => new ReviewSession({
      executionId: "execution-1",
      readOnly: false,
      webContents: electron.webContents,
      artifactDirectory: "/unused",
      ipc: electron.ipc,
    })).toThrow("server-enforced read-only authority");

    electron.webContents.getURL = () => "https://example.com/?review=1";
    const session = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: electron.webContents,
      artifactDirectory: "/unused",
      ipc: electron.ipc,
    });
    await expect(session.open()).rejects.toThrow("local production review workspace");
  });

  it("captures viewport and full-element tiles with immutable state and content digests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-review-session-"));
    directories.push(directory);
    const state = reviewState({
      selectedNodeId: "node-7",
      activatedActionId: "action-4",
      navigationPath: [
        { layerId: "layer-1", viaActionId: null },
        { layerId: "layer-1", viaActionId: "action-4" },
      ],
    });
    let restoredCapture = false;
    const electron = fakeElectron({
      snapshot: async () => state,
      capturePlan: async ({ target, mode }) => target.kind === "viewport"
        ? {
          target,
          mode,
          clip: { x: 0, y: 0, width: 1200, height: 800 },
          tiles: [{ index: 0, row: 0, column: 0, scrollX: 0, scrollY: 0 }],
        }
        : {
          target,
          mode,
          clip: { x: 900, y: 80, width: 300, height: 360 },
          tiles: [0, 1, 2].map((index) => ({
            index,
            row: index,
            column: 0,
            scrollX: 0,
            scrollY: index * 360,
          })),
        },
      prepareCaptureTile: async ({ index }) => ({
        index,
        clip: { x: 900, y: 80, width: 300, height: 360 },
      }),
      restoreCapture: async () => { restoredCapture = true; },
    });
    const session = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: electron.webContents,
      artifactDirectory: directory,
      ipc: electron.ipc,
    });
    await session.open();

    const viewportResult = await session.screenshot({
      target: { kind: "viewport" },
      mode: "visible",
      label: "Initial layer",
    });
    const viewport = viewportResult.screenshot;
    expect(viewportResult.ok).toBe(true);
    expect(viewport).toMatchObject({
      executionId: "execution-1",
      threadId: "thread-1",
      turnId: "turn-1",
      layerId: "layer-1",
      selectedNodeId: "node-7",
      activatedActionId: "action-4",
      navigationPath: [
        { layerId: "layer-1", viaActionId: null },
        { layerId: "layer-1", viaActionId: "action-4" },
      ],
      captureTarget: { kind: "viewport" },
      tileCount: 1,
    });
    expect(viewport.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const full = (await session.screenshot({
      target: { kind: "element", elementRef: "node-detail" },
      mode: "full",
      label: "Complete node detail",
    })).screenshot;
    expect(full.tileCount).toBe(3);
    expect(full.tiles.map((tile) => tile.index)).toEqual([0, 1, 2]);
    expect(full.tiles.every((tile) => /^sha256:[a-f0-9]{64}$/.test(tile.contentDigest))).toBe(true);
    expect(restoredCapture).toBe(true);
    expect(electron.captures).toHaveLength(4);
    expect(await readdir(join(directory, full.screenshotId))).toEqual([
      "metadata.json",
      `${full.screenshotId}-001.png`,
      `${full.screenshotId}-002.png`,
      `${full.screenshotId}-003.png`,
    ]);
    expect(JSON.parse(await readFile(join(directory, full.screenshotId, "metadata.json"), "utf8")))
      .toMatchObject({ contentDigest: full.contentDigest, tileCount: 3 });
  });

  it("restores an element capture when presentation changes and permits a retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-review-session-"));
    directories.push(directory);
    let state = reviewState({ selectedNodeId: "node-1" });
    let captureActive = false;
    let capturePlans = 0;
    let restorations = 0;
    const electron = fakeElectron({
      snapshot: async () => state,
      capturePlan: async ({ target, mode }) => {
        if (captureActive) throw new Error("A review capture is already active.");
        captureActive = true;
        capturePlans += 1;
        if (capturePlans === 1) state = reviewState({ selectedNodeId: "node-2" });
        return {
          target,
          mode,
          clip: { x: 20, y: 40, width: 300, height: 200 },
          tiles: [{ index: 0, row: 0, column: 0, scrollX: 0, scrollY: 0 }],
        };
      },
      prepareCaptureTile: async ({ index }) => ({
        index,
        clip: { x: 20, y: 40, width: 300, height: 200 },
      }),
      restoreCapture: async () => {
        captureActive = false;
        restorations += 1;
      },
    });
    const session = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: electron.webContents,
      artifactDirectory: directory,
      ipc: electron.ipc,
    });
    await session.open();

    await expect(session.screenshot({
      target: { kind: "element", elementRef: "node-detail" },
      label: "unstable selection",
    })).rejects.toThrow("changed presentation while preparing the screenshot");
    expect(captureActive).toBe(false);
    expect(restorations).toBe(1);
    expect(electron.captures).toHaveLength(0);

    await expect(session.screenshot({
      target: { kind: "element", elementRef: "node-detail" },
      label: "stable retry",
    })).resolves.toMatchObject({ ok: true, screenshot: { selectedNodeId: "node-2" } });
    expect(captureActive).toBe(false);
    expect(restorations).toBe(2);
    expect(electron.captures).toHaveLength(1);
  });

  it("activates only current controls and delegates arbitrary signed history deltas to the workspace", async () => {
    let state = reviewState({
      controls: [{
        elementRef: "node-node-7",
        name: "Open Queue",
        role: "button",
        disabled: false,
        kind: "node",
        actionId: null,
      }],
    });
    const historyDeltas = [];
    const electron = fakeElectron({
      snapshot: async () => state,
      activate: async ({ elementRef }) => {
        if (elementRef === "node-node-7") {
          state = reviewState({
            selectedNodeId: "node-7",
            controls: [{
              elementRef: "action-action-4",
              name: "See queue behavior",
              role: "button",
              disabled: false,
              kind: "navigate-action",
              actionId: "action-4",
            }],
          });
        } else {
          state = reviewState({
            layerId: "layer-2",
            activatedActionId: "action-4",
            navigationPath: [
              { layerId: "layer-1", viaActionId: null },
              { layerId: "layer-2", viaActionId: "action-4" },
            ],
          });
        }
        return state;
      },
      history: async ({ delta }) => {
        historyDeltas.push(delta);
        if (delta === -2) {
          state = reviewState();
        } else if (delta === 2) {
          state = reviewState({
            layerId: "layer-2",
            activatedActionId: "action-4",
            navigationPath: [
              { layerId: "layer-1", viaActionId: null },
              { layerId: "layer-2", viaActionId: "action-4" },
            ],
          });
        } else {
          throw new Error(`History delta ${delta} is outside the workspace history.`);
        }
        return state;
      },
    });
    const session = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: electron.webContents,
      artifactDirectory: "/unused",
      ipc: electron.ipc,
      commandTimeoutMs: 100,
    });
    await session.open();
    await expect(session.interact({ elementRef: "missing-control", activate: true })).rejects.toThrow("Unknown or invisible");
    await session.interact({ elementRef: "node-node-7", activate: true });
    await session.interact({ elementRef: "action-action-4", activate: true });

    expect((await session.history({ delta: -2 })).state.selectedNodeId).toBeNull();
    expect((await session.history({ delta: 2 })).state).toMatchObject({
      layerId: "layer-2",
      activatedActionId: "action-4",
      navigationPath: [
        { layerId: "layer-1", viaActionId: null },
        { layerId: "layer-2", viaActionId: "action-4" },
      ],
    });
    await expect(session.history({ delta: 0 })).rejects.toThrow("non-zero signed integer");
    await expect(session.history({ delta: 1 })).rejects.toThrow("outside the workspace history");
    expect(historyDeltas).toEqual([-2, 2, 1]);
    expect(session.trace().map((entry) => entry.type)).toEqual([
      "session-opened",
      "interact",
      "interact",
      "history",
      "history",
    ]);
  });

  it("treats a resolved invoke as Eval navigation when it changes interaction at the same layer id", async () => {
    let state = reviewState({
      controls: [{
        elementRef: "action-action-4",
        name: "Open completed result",
        role: "button",
        disabled: false,
        kind: "navigate-action",
        actionId: "action-4",
      }],
    });
    const electron = fakeElectron({
      snapshot: async () => state,
      activate: async () => {
        state = reviewState({
          threadId: "thread-2",
          turnId: "turn-2",
          layerId: "layer-1",
          activatedActionId: "action-4",
        });
        return state;
      },
    });
    const session = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: electron.webContents,
      artifactDirectory: "/unused",
      ipc: electron.ipc,
      commandTimeoutMs: 100,
    });
    await session.open();

    await expect(session.interact({
      elementRef: "action-action-4",
      activate: true,
    })).resolves.toMatchObject({
      ok: true,
      state: { turnId: "turn-2", layerId: "layer-1" },
    });
    expect(session.trace().at(-1).state.threadId).toBe("thread-2");
  });

  it("rejects a history command whose returned state is not the committed visible state", async () => {
    const state = reviewState();
    const electron = fakeElectron({
      snapshot: async () => state,
      history: async () => reviewState({
        layerId: "layer-2",
        navigationPath: [{ layerId: "layer-2", viaActionId: null }],
      }),
    });
    const session = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: electron.webContents,
      artifactDirectory: "/unused",
      ipc: electron.ipc,
      commandTimeoutMs: 100,
    });
    await session.open();

    await expect(session.history({ delta: -1 })).rejects.toThrow(
      "did not restore the requested review history state",
    );
    expect(session.trace().map((entry) => entry.type)).toEqual(["session-opened"]);
  });

  it("accepts direct and history navigation to durable turns without an accepted layer", async () => {
    let state = reviewState({
      controls: [{
        elementRef: "turn-running",
        name: "Turn 2",
        role: "button",
        disabled: false,
        kind: "turn",
        actionId: null,
      }],
    });
    const layerless = () => reviewState({
      turnId: "turn-running",
      layerId: null,
      navigationPath: [],
      selectedNodeId: null,
      controls: [],
    });
    const electron = fakeElectron({
      snapshot: async () => state,
      activate: async () => { state = layerless(); return state; },
      history: async () => { state = layerless(); return state; },
    });
    const session = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: electron.webContents,
      artifactDirectory: "/unused",
      ipc: electron.ipc,
      commandTimeoutMs: 100,
    });
    await session.open();

    await expect(session.interact({
      elementRef: "turn-running",
      activate: true,
    })).resolves.toMatchObject({ state: { turnId: "turn-running", layerId: null } });
    state = reviewState();
    await expect(session.history({ delta: -1 })).resolves.toMatchObject({
      state: { turnId: "turn-running", layerId: null, navigationPath: [] },
    });
  });
});

describe("review presentation capture synchronization", () => {
  const presentation = (selectedNodeId = null) => ({
    threadId: "thread-1",
    turnId: "turn-1",
    layerId: "layer-1",
    selectedNodeId,
    navigationPath: [{ layerId: "layer-1", viaActionId: null }],
  });

  it("waits for two renderer frames before planning a capture", async () => {
    let frames = 0;
    const adapter = createReviewPresentationAdapter({
      executionId: "execution-1",
      getPresentationState: () => presentation("node-2"),
      navigateHistory: async () => {},
      root: { querySelectorAll: () => [] },
      windowObject: {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 2,
        requestAnimationFrame: (callback) => { frames += 1; callback(); },
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    });

    await expect(adapter.capturePlan({
      target: { kind: "viewport" },
      mode: "visible",
    })).resolves.toMatchObject({ clip: { width: 1200, height: 800 } });
    expect(frames).toBe(2);
  });

  it("does not complete node activation before the selected presentation changes", async () => {
    let current = presentation();
    let frames = 0;
    const attributes = new Map([["aria-label", "Open Worker 2"], ["role", "button"]]);
    const button = {
      dataset: { reviewRef: "node-2", reviewKind: "node", node: "node-2" },
      isConnected: true,
      hidden: false,
      disabled: false,
      textContent: "Worker 2",
      matches: () => true,
      getAttribute: (key) => attributes.get(key) ?? null,
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 100, bottom: 40, width: 90, height: 30 }),
      click: () => {},
    };
    const adapter = createReviewPresentationAdapter({
      executionId: "execution-1",
      getPresentationState: () => current,
      navigateHistory: async () => {},
      root: { querySelectorAll: () => [button] },
      windowObject: {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 2,
        requestAnimationFrame: (callback) => {
          frames += 1;
          if (frames === 3) current = presentation("node-2");
          callback();
        },
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    });

    await expect(adapter.activate({ elementRef: "node-2", operation: "activate" }))
      .resolves.toMatchObject({ selectedNodeId: "node-2" });
    expect(frames).toBe(3);
  });
});

describe("review presentation history", () => {
  it("waits for workspace navigation and snapshots the committed presentation", async () => {
    let presentation = {
      threadId: "thread-1",
      turnId: "turn-2",
      layerId: "layer-2",
      selectedNodeId: null,
      navigationPath: [
        { layerId: "layer-1", viaActionId: null },
        { layerId: "layer-2", viaActionId: "action-2" },
      ],
    };
    const navigateHistory = vi.fn(async (delta) => {
      expect(delta).toBe(-3);
      presentation = {
        threadId: "thread-1",
        turnId: "turn-1",
        layerId: "layer-1",
        selectedNodeId: "node-1",
        navigationPath: [{ layerId: "layer-1", viaActionId: null }],
      };
      return presentation;
    });
    const root = { querySelectorAll: () => [] };
    const windowObject = {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 2,
      requestAnimationFrame: (callback) => callback(),
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    };
    const adapter = createReviewPresentationAdapter({
      executionId: "execution-1",
      getPresentationState: () => presentation,
      navigateHistory,
      root,
      windowObject,
    });

    await expect(adapter.history({ delta: 0 })).rejects.toThrow("non-zero signed integer");
    await expect(adapter.history({ delta: -3 })).resolves.toMatchObject({
      executionId: "execution-1",
      threadId: "thread-1",
      turnId: "turn-1",
      layerId: "layer-1",
      selectedNodeId: "node-1",
      navigationPath: [{ layerId: "layer-1", viaActionId: null }],
    });
    expect(navigateHistory).toHaveBeenCalledOnce();
  });

  it("waits for a visible history button to finish async restoration", async () => {
    let presentation = {
      threadId: "thread-2",
      turnId: "turn-2",
      layerId: "layer-2",
      selectedNodeId: null,
      navigationPath: [{ layerId: "layer-2", viaActionId: null }],
    };
    const attributes = new Map([
      ["aria-label", "Back to Thread 1"],
      ["role", "button"],
    ]);
    const button = {
      dataset: { reviewRef: "history-back", reviewKind: "history" },
      isConnected: true,
      hidden: false,
      disabled: false,
      textContent: "Back",
      matches: () => true,
      getAttribute: (key) => attributes.get(key) ?? null,
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 40, bottom: 40, width: 30, height: 30 }),
      click: () => {
        const completion = new Promise((resolve) => setTimeout(() => {
          presentation = {
            threadId: "thread-1",
            turnId: "turn-1",
            layerId: null,
            selectedNodeId: null,
            navigationPath: [],
          };
          resolve();
        }, 5));
        setControlActivationCompletion(button, completion);
      },
    };
    const adapter = createReviewPresentationAdapter({
      executionId: "execution-1",
      getPresentationState: () => presentation,
      navigateHistory: async () => {},
      root: { querySelectorAll: () => [button] },
      windowObject: {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 2,
        requestAnimationFrame: (callback) => setTimeout(callback, 1),
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    });

    await expect(adapter.activate({
      elementRef: "history-back",
      operation: "activate",
    })).resolves.toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      layerId: null,
      navigationPath: [],
    });
  });

  it("uses definitive visible-history completion beyond the old animation-frame budget", async () => {
    let presentation = {
      threadId: "thread-2",
      turnId: "turn-2",
      layerId: "layer-2",
      selectedNodeId: null,
      navigationPath: [{ layerId: "layer-2", viaActionId: null }],
    };
    let transitionFrames = 0;
    const attributes = new Map([["aria-label", "Back to Thread 1"], ["role", "button"]]);
    const button = {
      dataset: { reviewRef: "history-back", reviewKind: "history" },
      isConnected: true,
      hidden: false,
      disabled: false,
      textContent: "Back",
      matches: () => true,
      getAttribute: (key) => attributes.get(key) ?? null,
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 40, bottom: 40, width: 30, height: 30 }),
      click: () => {
        const completion = new Promise((resolve) => {
          const advance = () => {
            transitionFrames += 1;
            if (transitionFrames <= 140) return queueMicrotask(advance);
            presentation = {
              threadId: "thread-1",
              turnId: "turn-1",
              layerId: null,
              selectedNodeId: null,
              navigationPath: [],
            };
            resolve();
          };
          queueMicrotask(advance);
        });
        setControlActivationCompletion(button, completion);
      },
    };
    const adapter = createReviewPresentationAdapter({
      executionId: "execution-1",
      getPresentationState: () => presentation,
      navigateHistory: async () => {},
      root: { querySelectorAll: () => [button] },
      windowObject: {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 2,
        requestAnimationFrame: (callback) => queueMicrotask(callback),
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    });

    await expect(adapter.activate({
      elementRef: "history-back",
      operation: "activate",
    })).resolves.toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      layerId: null,
    });
    expect(transitionFrames).toBe(141);
  });

  it("waits for an async thread switch to expose one complete layerless presentation", async () => {
    let presentation = {
      threadId: "thread-1",
      turnId: "turn-1",
      layerId: "layer-1",
      selectedNodeId: null,
      navigationPath: [{ layerId: "layer-1", viaActionId: null }],
    };
    const attributes = new Map([
      ["aria-label", "Open Thread 2"],
      ["role", "button"],
    ]);
    const button = {
      dataset: { reviewRef: "thread-2", reviewKind: "thread" },
      isConnected: true,
      hidden: false,
      disabled: false,
      textContent: "Thread 2",
      matches: () => true,
      getAttribute: (key) => attributes.get(key) ?? null,
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 100, bottom: 40, width: 90, height: 30 }),
      click: () => {
        presentation = {
          threadId: "thread-2",
          turnId: null,
          layerId: "layer-1",
          selectedNodeId: null,
          navigationPath: [{ layerId: "layer-1", viaActionId: null }],
        };
        setTimeout(() => {
          presentation = {
            threadId: "thread-2",
            turnId: "turn-running",
            layerId: null,
            selectedNodeId: null,
            navigationPath: [],
          };
        }, 5);
      },
    };
    const adapter = createReviewPresentationAdapter({
      executionId: "execution-1",
      getPresentationState: () => presentation,
      navigateHistory: async () => {},
      root: { querySelectorAll: () => [button] },
      windowObject: {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 2,
        requestAnimationFrame: (callback) => setTimeout(callback, 1),
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    });

    await expect(adapter.activate({
      elementRef: "thread-2",
      operation: "activate",
    })).resolves.toMatchObject({
      threadId: "thread-2",
      turnId: "turn-running",
      layerId: null,
      selectedNodeId: null,
      navigationPath: [],
    });
  });

  it("canonicalizes numeric paths and keeps visible and tool history action metadata identical", async () => {
    const rootPresentation = () => ({
      threadId: 10,
      turnId: 1,
      layerId: 100,
      selectedNodeId: null,
      navigationPath: [{ layerId: 100, viaActionId: null }],
    });
    const deepPresentation = () => ({
      threadId: 10,
      turnId: 1,
      layerId: 101,
      selectedNodeId: 11,
      navigationPath: [
        { layerId: 100, viaActionId: null },
        { layerId: 101, viaActionId: 501 },
      ],
    });
    let presentation = rootPresentation();
    const attributes = new Map([["aria-label", "Forward to child"], ["role", "button"]]);
    const button = {
      dataset: { reviewRef: "history-forward", reviewKind: "history" },
      isConnected: true,
      hidden: false,
      disabled: false,
      textContent: "Forward",
      matches: () => true,
      getAttribute: (key) => attributes.get(key) ?? null,
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 40, bottom: 40, width: 30, height: 30 }),
      click: () => {
        presentation = deepPresentation();
        setControlActivationCompletion(button, Promise.resolve());
      },
    };
    const adapter = createReviewPresentationAdapter({
      executionId: "execution-1",
      getPresentationState: () => presentation,
      navigateHistory: async () => {
        presentation = deepPresentation();
        return presentation;
      },
      root: { querySelectorAll: () => [button] },
      windowObject: {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 2,
        requestAnimationFrame: (callback) => callback(),
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    });

    const visible = await adapter.activate({
      elementRef: "history-forward",
      operation: "activate",
    });
    presentation = rootPresentation();
    adapter.snapshot();
    const tool = await adapter.history({ delta: 1 });

    expect(visible.navigationPath).toEqual([
      { layerId: "100", viaActionId: null },
      { layerId: "101", viaActionId: "501" },
    ]);
    expect(visible.activatedActionId).toBe("501");
    expect(tool.activatedActionId).toBe("501");
    expect(tool.navigationPath).toEqual(visible.navigationPath);
  });
});

describe("review presentation visibility", () => {
  function element({ connected = true, hidden = false, name = "Open node", disabled = false } = {}) {
    const attributes = new Map([["aria-label", name]]);
    return {
      isConnected: connected,
      hidden,
      disabled,
      textContent: "",
      matches: () => true,
      getAttribute: (key) => attributes.get(key) ?? null,
      getBoundingClientRect: () => ({ left: 20, top: 20, right: 120, bottom: 60, width: 100, height: 40 }),
    };
  }
  const windowObject = {
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };

  it("requires an on-screen element with an accessible name", () => {
    expect(isVisibleElement(element(), windowObject)).toBe(true);
    expect(accessibleControlName(element())).toBe("Open node");
    expect(isAccessibleControl(element(), windowObject)).toBe(true);
    expect(isAccessibleControl(element({ name: "" }), windowObject)).toBe(false);
    expect(isVisibleElement(element({ hidden: true }), windowObject)).toBe(false);
  });

  it("exposes visible capture-region refs without treating them as controls", () => {
    const region = element({ name: "Selected node detail" });
    region.dataset = { reviewCapture: "node-detail" };
    region.matches = () => false;
    region.getAttribute = (key) => key === "aria-label" ? "Selected node detail" : key === "role" ? "region" : null;
    const root = { querySelectorAll: () => [region] };
    expect(visibleCaptureRegions(root, windowObject)).toEqual([{
      elementRef: "node-detail",
      name: "Selected node detail",
      role: "region",
      disabled: false,
      kind: "capture-region",
      actionId: null,
    }]);
    expect(isAccessibleControl(region, windowObject)).toBe(false);
  });
});
