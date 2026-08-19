import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReviewSession } from "../desktop/eval-main/review-session.mjs";
import {
  accessibleControlName,
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

  it("activates only current controls and moves through local history with a signed delta", async () => {
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
      restore: async (expected) => { state = structuredClone(expected); return state; },
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
    await expect(session.history({ delta: 1 })).rejects.toThrow("outside the review session history");
    expect(session.trace().map((entry) => entry.type)).toEqual([
      "session-opened",
      "interact",
      "interact",
      "history",
      "history",
    ]);
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
