import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewSession } from "../desktop/eval-main/review-session.mjs";
import { captureGroundingTargets } from "../desktop/eval-main/simulated-user-judge.mjs";
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
    threadRevision: "thread:thread-1:revision:1",
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

async function reviewDirectory(prefix = "relayer-review-session-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

describe("ReviewSession", () => {
  it("requires server-enforced read-only authority and reconciles revision, input-draft, and operator state", async () => {
    const electron = fakeElectron({ snapshot: async () => reviewState() });
    expect(() => new ReviewSession({
      executionId: "execution-1",
      readOnly: false,
      webContents: electron.webContents,
      artifactDirectory: "/unused",
      ipc: electron.ipc,
    }), "read-only authority is server-enforced").toThrow("server-enforced read-only authority");

    electron.webContents.getURL = () => "https://example.com/?review=1";
    const remoteSession = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: electron.webContents,
      artifactDirectory: "/unused",
      ipc: electron.ipc,
    });
    await expect(remoteSession.open(), "review workspaces must be local production URLs")
      .rejects.toThrow("local production review workspace");

    const localElectron = fakeElectron({ snapshot: async () => reviewState() });
    let inputDraftRevision = 3;
    const draftSession = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: localElectron.webContents,
      artifactDirectory: "/unused",
      ipc: localElectron.ipc,
      loadInputDraftRevision: vi.fn(async () => inputDraftRevision),
    });
    expect((await draftSession.open()).threadRevision, "open folds the live input-draft revision")
      .toBe("thread:thread-1:revision:1:server-input-draft:3");
    inputDraftRevision = 4;
    expect((await draftSession.state()).threadRevision, "every later state refolds the live draft revision")
      .toBe("thread:thread-1:revision:1:server-input-draft:4");

    const importedElectron = fakeElectron({ snapshot: async () => reviewState() });
    const importedSession = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: importedElectron.webContents,
      artifactDirectory: "/unused",
      ipc: importedElectron.ipc,
      loadInputDraftRevision: vi.fn(async () => null),
    });
    expect((await importedSession.open()).threadRevision, "imported threads use a stable no-draft revision")
      .toBe("thread:thread-1:revision:1:server-input-draft:none");
    expect((await importedSession.state()).threadRevision, "the no-draft revision stays stable")
      .toBe("thread:thread-1:revision:1:server-input-draft:none");

    const updateInputOperatorState = vi.fn(async ({ committed }) => reviewState({
      controls: [{
        elementRef: "send-interaction",
        kind: "input-operator-send",
        disabled: !committed,
      }],
    }));
    const operatorElectron = fakeElectron({
      snapshot: async () => reviewState(),
      updateInputOperatorState,
    });
    const operatorSession = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: operatorElectron.webContents,
      artifactDirectory: "/unused",
      ipc: operatorElectron.ipc,
    });
    await operatorSession.open();

    await expect(operatorSession.setInputOperatorCommitted(true), "committed input enables operator Send")
      .resolves.toMatchObject({
        controls: [{ elementRef: "send-interaction", disabled: false }],
      });
    await expect(operatorSession.setInputOperatorCommitted(false), "uncommitted input disables operator Send")
      .resolves.toMatchObject({
        controls: [{ elementRef: "send-interaction", disabled: true }],
      });
    expect(updateInputOperatorState, "the renderer receives each commissioned state").toHaveBeenNthCalledWith(1, { committed: true });
    expect(updateInputOperatorState, "the renderer receives each commissioned state").toHaveBeenNthCalledWith(2, { committed: false });

    updateInputOperatorState.mockResolvedValueOnce(reviewState({
      controls: [{ elementRef: "send-interaction", kind: "input-operator-send", disabled: true }],
    }));
    await expect(operatorSession.setInputOperatorCommitted(true),
      "operator Send requires the renderer to confirm the committed state")
      .rejects.toThrow("did not reflect the commissioned input state");
  });

  it("captures viewport and full-element tiles with immutable digests and restores contested captures", async () => {
    // Stable capture: viewport and multi-tile element captures persist digests and files.
    const directory = await reviewDirectory();
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
    expect(viewportResult.ok, "viewport capture succeeds").toBe(true);
    expect(viewport, "viewport metadata carries the immutable review state").toMatchObject({
      executionId: "execution-1",
      threadId: "thread-1",
      threadRevision: "thread:thread-1:revision:1",
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
    expect(viewport.contentDigest, "viewport content digest").toMatch(/^sha256:[a-f0-9]{64}$/);

    const full = (await session.screenshot({
      target: { kind: "element", elementRef: "node-detail" },
      mode: "full",
      label: "Complete node detail",
    })).screenshot;
    expect(full.tileCount, "full element capture tiles every row").toBe(3);
    expect(full.tiles.map((tile) => tile.index), "tiles stay ordered").toEqual([0, 1, 2]);
    expect(full.tiles.every((tile) => /^sha256:[a-f0-9]{64}$/.test(tile.contentDigest)), "every tile carries a content digest").toBe(true);
    expect(restoredCapture, "capture restores the presentation").toBe(true);
    expect(electron.captures, "one capture per tile").toHaveLength(4);
    expect(await readdir(join(directory, full.screenshotId)), "artifact directory holds metadata and tiles").toEqual([
      "metadata.json",
      `${full.screenshotId}-001.png`,
      `${full.screenshotId}-002.png`,
      `${full.screenshotId}-003.png`,
    ]);
    expect(JSON.parse(await readFile(join(directory, full.screenshotId, "metadata.json"), "utf8")),
      "metadata matches the captured digest").toMatchObject({ contentDigest: full.contentDigest, tileCount: 3 });

    // Drifted capture: presentation changes mid-plan, the session restores and allows a retry.
    const driftDirectory = await reviewDirectory();
    let driftState = reviewState({ selectedNodeId: "node-1" });
    let captureActive = false;
    let capturePlans = 0;
    let restorations = 0;
    const driftElectron = fakeElectron({
      snapshot: async () => driftState,
      capturePlan: async ({ target, mode }) => {
        if (captureActive) throw new Error("A review capture is already active.");
        captureActive = true;
        capturePlans += 1;
        if (capturePlans === 1) driftState = reviewState({ selectedNodeId: "node-2" });
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
    const driftSession = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: driftElectron.webContents,
      artifactDirectory: driftDirectory,
      ipc: driftElectron.ipc,
    });
    await driftSession.open();

    await expect(driftSession.screenshot({
      target: { kind: "element", elementRef: "node-detail" },
      label: "unstable selection",
    }), "presentation drift during planning rejects the capture")
      .rejects.toThrow("changed presentation while preparing the screenshot");
    expect(captureActive, "drifted capture releases its lock").toBe(false);
    expect(restorations, "drifted capture restores once").toBe(1);
    expect(driftElectron.captures, "drifted capture takes no tiles").toHaveLength(0);

    await expect(driftSession.screenshot({
      target: { kind: "element", elementRef: "node-detail" },
      label: "stable retry",
    }), "the retry captures the settled presentation").resolves.toMatchObject({ ok: true, screenshot: { selectedNodeId: "node-2" } });
    expect(captureActive, "retry releases its lock").toBe(false);
    expect(restorations, "retry restores again").toBe(2);
    expect(driftElectron.captures, "retry captures its tile").toHaveLength(1);

    // Contested capture: an overlapping request must not restore the winner's presentation.
    const contestDirectory = await reviewDirectory();
    let contestActive = false;
    let contestRestorations = 0;
    let releaseFirstPlan;
    let markFirstPlanActive;
    const firstPlanActive = new Promise((resolve) => { markFirstPlanActive = resolve; });
    const firstPlanRelease = new Promise((resolve) => { releaseFirstPlan = resolve; });
    const plan = {
      target: { kind: "element", elementRef: "node-detail" },
      mode: "visible",
      clip: { x: 20, y: 40, width: 300, height: 200 },
      tiles: [{ index: 0, row: 0, column: 0, scrollX: 0, scrollY: 0 }],
    };
    const contestElectron = fakeElectron({
      snapshot: async () => reviewState({ selectedNodeId: "node-2" }),
      capturePlan: async () => {
        if (contestActive) throw new Error("A review capture is already active.");
        contestActive = true;
        markFirstPlanActive();
        await firstPlanRelease;
        return plan;
      },
      prepareCaptureTile: async ({ index }) => ({ index, clip: plan.clip }),
      restoreCapture: async () => {
        contestActive = false;
        contestRestorations += 1;
      },
    });
    const contestSession = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: contestElectron.webContents,
      artifactDirectory: contestDirectory,
      ipc: contestElectron.ipc,
    });
    await contestSession.open();

    const first = contestSession.screenshot({
      target: { kind: "element", elementRef: "node-detail" },
      label: "winning capture",
    });
    await firstPlanActive;
    await expect(contestSession.screenshot({
      target: { kind: "element", elementRef: "node-detail" },
      label: "overlapping capture",
    }), "overlapping capture requests are rejected").rejects.toThrow("A review capture is already active");
    expect(contestActive, "the winner keeps its capture lock").toBe(true);
    expect(contestRestorations, "the loser never restores the winner's presentation").toBe(0);

    releaseFirstPlan();
    await expect(first, "the winning capture completes").resolves.toMatchObject({ ok: true });
    expect(contestActive, "the winner releases its lock when done").toBe(false);
    expect(contestRestorations, "the winner restores exactly once").toBe(1);
    expect(contestElectron.captures, "only the winner captures").toHaveLength(1);
  });

  it("activates current controls, delegates signed history deltas, and grounds multi-layer capture targets", async () => {
    // Control activation and history delegation.
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
    await expect(session.interact({ elementRef: "missing-control", activate: true }),
      "unknown controls are rejected").rejects.toThrow("Unknown or invisible");
    await session.interact({ elementRef: "node-node-7", activate: true });
    await session.interact({ elementRef: "action-action-4", activate: true });

    expect((await session.history({ delta: -2 })).state.selectedNodeId, "negative deltas rewind the workspace").toBeNull();
    expect((await session.history({ delta: 2 })).state, "positive deltas replay the workspace").toMatchObject({
      layerId: "layer-2",
      activatedActionId: "action-4",
      navigationPath: [
        { layerId: "layer-1", viaActionId: null },
        { layerId: "layer-2", viaActionId: "action-4" },
      ],
    });
    await expect(session.history({ delta: 0 }), "zero deltas are invalid").rejects.toThrow("non-zero signed integer");
    await expect(session.history({ delta: 1 }), "out-of-range deltas surface the workspace error").rejects.toThrow("outside the workspace history");
    expect(historyDeltas, "every signed delta reaches the workspace exactly once").toEqual([-2, 2, 1]);
    expect(session.trace().map((entry) => entry.type), "the session trace records each command").toEqual([
      "session-opened",
      "interact",
      "interact",
      "history",
      "history",
    ]);

    // Resolved invokes that change interaction are Eval navigation.
    let invokeState = reviewState({
      controls: [{
        elementRef: "action-action-4",
        name: "Open completed result",
        role: "button",
        disabled: false,
        kind: "navigate-action",
        actionId: "action-4",
      }],
    });
    const invokeElectron = fakeElectron({
      snapshot: async () => invokeState,
      activate: async () => {
        invokeState = reviewState({
          threadId: "thread-2",
          turnId: "turn-2",
          layerId: "layer-1",
          activatedActionId: "action-4",
        });
        return invokeState;
      },
    });
    const invokeSession = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: invokeElectron.webContents,
      artifactDirectory: "/unused",
      ipc: invokeElectron.ipc,
      commandTimeoutMs: 100,
    });
    await invokeSession.open();
    await expect(invokeSession.interact({
      elementRef: "action-action-4",
      activate: true,
    }), "a resolved invoke changing interaction at the same layer is navigation").resolves.toMatchObject({
      ok: true,
      state: { turnId: "turn-2", layerId: "layer-1" },
    });
    expect(invokeSession.trace().at(-1).state.threadId, "the trace records the navigated thread").toBe("thread-2");

    // History results must match the committed visible state.
    const committedState = reviewState();
    const staleElectron = fakeElectron({
      snapshot: async () => committedState,
      history: async () => reviewState({
        layerId: "layer-2",
        navigationPath: [{ layerId: "layer-2", viaActionId: null }],
      }),
    });
    const staleSession = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: staleElectron.webContents,
      artifactDirectory: "/unused",
      ipc: staleElectron.ipc,
      commandTimeoutMs: 100,
    });
    await staleSession.open();
    await expect(staleSession.history({ delta: -1 }),
      "history commands must return the committed visible state")
      .rejects.toThrow("did not restore the requested review history state");
    expect(staleSession.trace().map((entry) => entry.type), "rejected history leaves no trace entry").toEqual(["session-opened"]);

    // Layerless durable turns are navigable directly and through history.
    let layerlessState = reviewState({
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
    const layerlessElectron = fakeElectron({
      snapshot: async () => layerlessState,
      activate: async () => { layerlessState = layerless(); return layerlessState; },
      history: async () => { layerlessState = layerless(); return layerlessState; },
    });
    const layerlessSession = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: layerlessElectron.webContents,
      artifactDirectory: "/unused",
      ipc: layerlessElectron.ipc,
      commandTimeoutMs: 100,
    });
    await layerlessSession.open();
    await expect(layerlessSession.interact({
      elementRef: "turn-running",
      activate: true,
    }), "direct navigation to a durable layerless turn").resolves.toMatchObject({ state: { turnId: "turn-running", layerId: null } });
    layerlessState = reviewState();
    await expect(layerlessSession.history({ delta: -1 }), "history navigation to a durable layerless turn")
      .resolves.toMatchObject({
        state: { turnId: "turn-running", layerId: null, navigationPath: [] },
      });

    // Grounding captures the root-child-grandchild fixture efficiently.
    const groundingDirectory = await reviewDirectory("relayer-grounding-review-");
    const stack = [];
    const groundingHistoryDeltas = [];
    const nodeControl = (nodeId) => ({
      elementRef: `node-${nodeId}`,
      name: `Node ${nodeId}`,
      role: "button",
      disabled: false,
      kind: "node",
      actionId: null,
    });
    const actionControl = (actionId) => ({
      elementRef: `action-${actionId}`,
      name: `Action ${actionId}`,
      role: "button",
      disabled: false,
      kind: "navigate-action",
      actionId,
    });
    let groundingState = reviewState({ controls: [nodeControl("2")] });
    const select = (nodeId) => {
      const actionId = groundingState.layerId === "layer-1" && nodeId === "2" ? "11"
        : groundingState.layerId === "layer-2" && nodeId === "3" ? "21"
          : null;
      groundingState = { ...groundingState, selectedNodeId: nodeId, controls: actionId ? [actionControl(actionId)] : [] };
    };
    const navigate = (actionId) => {
      stack.push(structuredClone(groundingState));
      const child = actionId === "11"
        ? { layerId: "layer-2", nodeId: "3" }
        : { layerId: "layer-3", nodeId: "4" };
      groundingState = reviewState({
        layerId: child.layerId,
        selectedNodeId: null,
        activatedActionId: actionId,
        navigationPath: [
          ...groundingState.navigationPath,
          { layerId: child.layerId, viaActionId: actionId },
        ],
        controls: [nodeControl(child.nodeId)],
      });
    };
    const groundingElectron = fakeElectron({
      snapshot: async () => groundingState,
      activate: async ({ elementRef }) => {
        if (elementRef.startsWith("node-")) select(elementRef.slice(5));
        else navigate(elementRef.slice(7));
        return groundingState;
      },
      history: async ({ delta }) => {
        groundingHistoryDeltas.push(delta);
        for (let count = 0; count < -delta; count += 1) groundingState = stack.pop();
        return groundingState;
      },
      capturePlan: async () => ({
        clip: { x: 0, y: 0, width: 320, height: 200 },
        tiles: [{ index: 0, row: 0, column: 0, scrollX: 0, scrollY: 0 }],
      }),
      prepareCaptureTile: async ({ index }) => ({
        index,
        clip: { x: 0, y: 0, width: 320, height: 200 },
      }),
      restoreCapture: async () => groundingState,
    });
    const groundingSession = new ReviewSession({
      executionId: "execution-1",
      readOnly: true,
      webContents: groundingElectron.webContents,
      artifactDirectory: groundingDirectory,
      ipc: groundingElectron.ipc,
      commandTimeoutMs: 100,
    });
    await groundingSession.open();

    const captures = await captureGroundingTargets(groundingSession, [
      { layerId: "layer-1", nodeIds: ["2"], path: [] },
      {
        layerId: "layer-2",
        nodeIds: ["3"],
        path: [{ sourceNodeId: "2", actionId: "11" }],
      },
      {
        layerId: "layer-3",
        nodeIds: ["4"],
        path: [
          { sourceNodeId: "2", actionId: "11" },
          { sourceNodeId: "3", actionId: "21" },
        ],
      },
    ]);

    expect(captures, "every grounding target is captured").toHaveLength(3);
    expect(groundingHistoryDeltas, "rewinds are batched without over-rewinding").toEqual([-1, -2]);
    expect(groundingSession.trace().filter((entry) => entry.elementRef === "node-2"),
      "selections are never reactivated").toHaveLength(1);
    expect((await groundingSession.state()).navigationPath, "grounding returns to the root layer").toEqual([
      { layerId: "layer-1", viaActionId: null },
    ]);
  });
});

describe("review presentation adapter", () => {
  const presentation = (selectedNodeId = null) => ({
    threadId: "thread-1",
    turnId: "turn-1",
    layerId: "layer-1",
    selectedNodeId,
    navigationPath: [{ layerId: "layer-1", viaActionId: null }],
  });

  it("synchronizes capture, activation, and history to committed presentation state", async () => {
    // Capture planning waits for two renderer frames.
    let frames = 0;
    const frameAdapter = createReviewPresentationAdapter({
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
    await expect(frameAdapter.capturePlan({
      target: { kind: "viewport" },
      mode: "visible",
    }), "viewport planning settles after renderer frames").resolves.toMatchObject({ clip: { width: 1200, height: 800 } });
    expect(frames, "planning waits for exactly two frames").toBe(2);

    // Node activation waits for the selected presentation to change.
    let activationCurrent = presentation();
    let activationFrames = 0;
    const activationAttributes = new Map([["aria-label", "Open Worker 2"], ["role", "button"]]);
    const activationButton = {
      dataset: { reviewRef: "node-2", reviewKind: "node", node: "node-2" },
      isConnected: true,
      hidden: false,
      disabled: false,
      textContent: "Worker 2",
      matches: () => true,
      getAttribute: (key) => activationAttributes.get(key) ?? null,
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 100, bottom: 40, width: 90, height: 30 }),
      click: () => {},
    };
    const activationAdapter = createReviewPresentationAdapter({
      executionId: "execution-1",
      getPresentationState: () => activationCurrent,
      navigateHistory: async () => {},
      root: { querySelectorAll: () => [activationButton] },
      windowObject: {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 2,
        requestAnimationFrame: (callback) => {
          activationFrames += 1;
          if (activationFrames === 3) activationCurrent = presentation("node-2");
          callback();
        },
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    });
    await expect(activationAdapter.activate({ elementRef: "node-2", operation: "activate" }),
      "node activation completes only once the selection changes").resolves.toMatchObject({ selectedNodeId: "node-2" });
    expect(activationFrames, "activation waits for the changed presentation").toBe(3);

    // Off-screen input actions are revealed before full capture planning.
    let revealed = false;
    const scrollIntoView = vi.fn(() => { revealed = true; });
    const inputAction = {
      dataset: { reviewCapture: "input-action-41-10-13", reviewActionId: "13" },
      isConnected: true,
      hidden: false,
      clientWidth: 320,
      clientHeight: 120,
      scrollWidth: 320,
      scrollHeight: 120,
      scrollLeft: 0,
      scrollTop: 0,
      matches: () => false,
      getAttribute: (key) => key === "aria-label" ? "Input action: Deployment region" : null,
      getBoundingClientRect: () => revealed
        ? { x: 20, y: 420, left: 20, top: 420, right: 340, bottom: 540, width: 320, height: 120 }
        : { x: 20, y: 720, left: 20, top: 720, right: 340, bottom: 840, width: 320, height: 120 },
      scrollIntoView,
    };
    const revealAdapter = createReviewPresentationAdapter({
      executionId: "execution-1",
      getPresentationState: () => presentation("node-2"),
      navigateHistory: async () => {},
      root: {
        querySelectorAll: (selector) => selector === "[data-review-capture]" ? [inputAction] : [],
      },
      windowObject: {
        innerWidth: 1200,
        innerHeight: 600,
        devicePixelRatio: 2,
        requestAnimationFrame: (callback) => callback(),
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    });
    await expect(revealAdapter.capturePlan({
      target: { kind: "element", elementRef: "input-action-41-10-13" },
      mode: "full",
    }), "revealed input actions plan from their on-screen position").resolves.toMatchObject({
      clip: { x: 20, y: 420, width: 320, height: 120 },
      tiles: [{ index: 0, row: 0, column: 0, scrollX: 0, scrollY: 0 }],
    });
    expect(scrollIntoView, "off-screen actions are revealed exactly once").toHaveBeenCalledOnce();
    await revealAdapter.restoreCapture();

    // Scrolling inspector content tiles so full captures reach lower content.
    const outerInspector = {
      dataset: {},
      scrollTop: 0,
      clientWidth: 360,
      clientHeight: 500,
      scrollWidth: 360,
      scrollHeight: 500,
    };
    const inspectorContent = {
      dataset: { reviewCapture: "node-detail" },
      isConnected: true,
      hidden: false,
      scrollLeft: 0,
      scrollTop: 0,
      clientWidth: 320,
      clientHeight: 200,
      scrollWidth: 320,
      scrollHeight: 600,
      matches: () => false,
      getAttribute: (key) => key === "aria-label" ? "Selected node detail content" : null,
      getBoundingClientRect: () => ({ x: 860, y: 100, left: 860, top: 100, right: 1180, bottom: 300, width: 320, height: 200 }),
    };
    const tileAdapter = createReviewPresentationAdapter({
      executionId: "execution-1",
      getPresentationState: () => presentation("node-2"),
      navigateHistory: async () => {},
      root: {
        querySelectorAll: (selector) => selector === "[data-review-capture]" ? [inspectorContent] : [],
      },
      windowObject: {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 2,
        requestAnimationFrame: (callback) => callback(),
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    });
    const tilePlan = await tileAdapter.capturePlan({
      target: { kind: "element", elementRef: "node-detail" },
      mode: "full",
    });
    expect(tilePlan.tiles.map(({ scrollY }) => scrollY), "tiles cover the scrolling content").toEqual([0, 200, 400]);
    await tileAdapter.prepareCaptureTile(tilePlan.tiles[2]);
    expect(inspectorContent.scrollTop, "tile preparation scrolls the inner content").toBe(400);
    expect(outerInspector.scrollTop, "the outer inspector never scrolls").toBe(0);
    await tileAdapter.restoreCapture();
    expect(inspectorContent.scrollTop, "restoration resets the scroll position").toBe(0);

    // History navigation snapshots the committed presentation.
    let historyPresentation = {
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
      expect(delta, "workspace receives the signed delta").toBe(-3);
      historyPresentation = {
        threadId: "thread-1",
        turnId: "turn-1",
        layerId: "layer-1",
        selectedNodeId: "node-1",
        navigationPath: [{ layerId: "layer-1", viaActionId: null }],
      };
      return historyPresentation;
    });
    const historyAdapter = createReviewPresentationAdapter({
      executionId: "execution-1",
      getPresentationState: () => historyPresentation,
      navigateHistory,
      root: { querySelectorAll: () => [] },
      windowObject: {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 2,
        requestAnimationFrame: (callback) => callback(),
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    });
    await expect(historyAdapter.history({ delta: 0 }), "zero deltas are invalid").rejects.toThrow("non-zero signed integer");
    await expect(historyAdapter.history({ delta: -3 }), "history snapshots the committed presentation")
      .resolves.toMatchObject({
        executionId: "execution-1",
        threadId: "thread-1",
        turnId: "turn-1",
        layerId: "layer-1",
        selectedNodeId: "node-1",
        navigationPath: [{ layerId: "layer-1", viaActionId: null }],
      });
    expect(navigateHistory, "the workspace navigates exactly once").toHaveBeenCalledOnce();

    // Visible history buttons complete through their async restoration.
    let buttonPresentation = {
      threadId: "thread-2",
      turnId: "turn-2",
      layerId: "layer-2",
      selectedNodeId: null,
      navigationPath: [{ layerId: "layer-2", viaActionId: null }],
    };
    const buttonAttributes = new Map([
      ["aria-label", "Back to Thread 1"],
      ["role", "button"],
    ]);
    const historyButton = {
      dataset: { reviewRef: "history-back", reviewKind: "history" },
      isConnected: true,
      hidden: false,
      disabled: false,
      textContent: "Back",
      matches: () => true,
      getAttribute: (key) => buttonAttributes.get(key) ?? null,
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 40, bottom: 40, width: 30, height: 30 }),
      click: () => {
        const completion = new Promise((resolve) => setTimeout(() => {
          buttonPresentation = {
            threadId: "thread-1",
            turnId: "turn-1",
            layerId: null,
            selectedNodeId: null,
            navigationPath: [],
          };
          resolve();
        }, 5));
        setControlActivationCompletion(historyButton, completion);
      },
    };
    const buttonAdapter = createReviewPresentationAdapter({
      executionId: "execution-1",
      getPresentationState: () => buttonPresentation,
      navigateHistory: async () => {},
      root: { querySelectorAll: () => [historyButton] },
      windowObject: {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 2,
        requestAnimationFrame: (callback) => setTimeout(callback, 1),
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    });
    await expect(buttonAdapter.activate({
      elementRef: "history-back",
      operation: "activate",
    }), "visible history buttons wait for their async restoration").resolves.toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      layerId: null,
      navigationPath: [],
    });

    // Definitive completion beats the old animation-frame budget.
    let budgetPresentation = {
      threadId: "thread-2",
      turnId: "turn-2",
      layerId: "layer-2",
      selectedNodeId: null,
      navigationPath: [{ layerId: "layer-2", viaActionId: null }],
    };
    let transitionFrames = 0;
    const budgetAttributes = new Map([["aria-label", "Back to Thread 1"], ["role", "button"]]);
    const budgetButton = {
      dataset: { reviewRef: "history-back", reviewKind: "history" },
      isConnected: true,
      hidden: false,
      disabled: false,
      textContent: "Back",
      matches: () => true,
      getAttribute: (key) => budgetAttributes.get(key) ?? null,
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 40, bottom: 40, width: 30, height: 30 }),
      click: () => {
        const completion = new Promise((resolve) => {
          const advance = () => {
            transitionFrames += 1;
            if (transitionFrames <= 140) return queueMicrotask(advance);
            budgetPresentation = {
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
        setControlActivationCompletion(budgetButton, completion);
      },
    };
    const budgetAdapter = createReviewPresentationAdapter({
      executionId: "execution-1",
      getPresentationState: () => budgetPresentation,
      navigateHistory: async () => {},
      root: { querySelectorAll: () => [budgetButton] },
      windowObject: {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 2,
        requestAnimationFrame: (callback) => queueMicrotask(callback),
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    });
    await expect(budgetAdapter.activate({
      elementRef: "history-back",
      operation: "activate",
    }), "definitive completion wins beyond the old frame budget").resolves.toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      layerId: null,
    });
    expect(transitionFrames, "the long transition ran to completion").toBe(141);

    // Thread switches settle on one complete layerless presentation.
    let switchPresentation = {
      threadId: "thread-1",
      turnId: "turn-1",
      layerId: "layer-1",
      selectedNodeId: null,
      navigationPath: [{ layerId: "layer-1", viaActionId: null }],
    };
    const switchAttributes = new Map([
      ["aria-label", "Open Thread 2"],
      ["role", "button"],
    ]);
    const switchButton = {
      dataset: { reviewRef: "thread-2", reviewKind: "thread" },
      isConnected: true,
      hidden: false,
      disabled: false,
      textContent: "Thread 2",
      matches: () => true,
      getAttribute: (key) => switchAttributes.get(key) ?? null,
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 100, bottom: 40, width: 90, height: 30 }),
      click: () => {
        switchPresentation = {
          threadId: "thread-2",
          turnId: null,
          layerId: "layer-1",
          selectedNodeId: null,
          navigationPath: [{ layerId: "layer-1", viaActionId: null }],
        };
        setTimeout(() => {
          switchPresentation = {
            threadId: "thread-2",
            turnId: "turn-running",
            layerId: null,
            selectedNodeId: null,
            navigationPath: [],
          };
        }, 5);
      },
    };
    const switchAdapter = createReviewPresentationAdapter({
      executionId: "execution-1",
      getPresentationState: () => switchPresentation,
      navigateHistory: async () => {},
      root: { querySelectorAll: () => [switchButton] },
      windowObject: {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 2,
        requestAnimationFrame: (callback) => setTimeout(callback, 1),
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    });
    await expect(switchAdapter.activate({
      elementRef: "thread-2",
      operation: "activate",
    }), "thread switches wait for one complete layerless presentation").resolves.toMatchObject({
      threadId: "thread-2",
      turnId: "turn-running",
      layerId: null,
      selectedNodeId: null,
      navigationPath: [],
    });

    // Numeric paths canonicalize identically for visible and tool history.
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
    let canonicalPresentation = rootPresentation();
    const canonicalAttributes = new Map([["aria-label", "Forward to child"], ["role", "button"]]);
    const canonicalButton = {
      dataset: { reviewRef: "history-forward", reviewKind: "history" },
      isConnected: true,
      hidden: false,
      disabled: false,
      textContent: "Forward",
      matches: () => true,
      getAttribute: (key) => canonicalAttributes.get(key) ?? null,
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 40, bottom: 40, width: 30, height: 30 }),
      click: () => {
        canonicalPresentation = deepPresentation();
        setControlActivationCompletion(canonicalButton, Promise.resolve());
      },
    };
    const canonicalAdapter = createReviewPresentationAdapter({
      executionId: "execution-1",
      getPresentationState: () => canonicalPresentation,
      navigateHistory: async () => {
        canonicalPresentation = deepPresentation();
        return canonicalPresentation;
      },
      root: { querySelectorAll: () => [canonicalButton] },
      windowObject: {
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 2,
        requestAnimationFrame: (callback) => callback(),
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    });
    const visible = await canonicalAdapter.activate({
      elementRef: "history-forward",
      operation: "activate",
    });
    canonicalPresentation = rootPresentation();
    canonicalAdapter.snapshot();
    const tool = await canonicalAdapter.history({ delta: 1 });
    expect(visible.navigationPath, "visible history canonicalizes numeric paths").toEqual([
      { layerId: "100", viaActionId: null },
      { layerId: "101", viaActionId: "501" },
    ]);
    expect(visible.activatedActionId, "visible history records the via-action").toBe("501");
    expect(tool.activatedActionId, "tool history records the via-action").toBe("501");
    expect(tool.navigationPath, "visible and tool history metadata stay identical").toEqual(visible.navigationPath);

    // Visibility predicates and capture regions.
    const element = ({ connected = true, hidden = false, name = "Open node", disabled = false } = {}) => {
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
    };
    const predicateWindow = {
      innerWidth: 800,
      innerHeight: 600,
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    };
    expect(isVisibleElement(element(), predicateWindow), "on-screen elements are visible").toBe(true);
    expect(accessibleControlName(element()), "accessible names come from aria-label").toBe("Open node");
    expect(isAccessibleControl(element(), predicateWindow), "named visible elements are controls").toBe(true);
    expect(isAccessibleControl(element({ name: "" }), predicateWindow), "unnamed elements are not controls").toBe(false);
    expect(isVisibleElement(element({ hidden: true }), predicateWindow), "hidden elements are not visible").toBe(false);

    const region = element({ name: "Selected node detail" });
    region.dataset = { reviewCapture: "node-detail" };
    region.matches = () => false;
    region.getAttribute = (key) => key === "aria-label" ? "Selected node detail" : key === "role" ? "region" : null;
    const regionRoot = { querySelectorAll: () => [region] };
    expect(visibleCaptureRegions(regionRoot, predicateWindow), "capture regions expose their refs").toEqual([{
      elementRef: "node-detail",
      name: "Selected node detail",
      role: "region",
      disabled: false,
      kind: "capture-region",
      actionId: null,
    }]);
    expect(isAccessibleControl(region, predicateWindow), "capture regions are never controls").toBe(false);
  });
});
