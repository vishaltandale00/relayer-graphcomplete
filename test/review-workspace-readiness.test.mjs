import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REVIEW_WORKSPACE_READY_CHANNEL,
  loadReadyReviewWorkspace,
} from "../desktop/eval-main/review-workspace-readiness.mjs";

afterEach(() => {
  vi.useRealTimers();
});

describe("automated review workspace readiness", () => {
  it("waits for the exact navigation readiness signal beyond the legacy five-second window", async () => {
    vi.useFakeTimers();
    const ipc = new EventEmitter();
    const webContents = Object.assign(new EventEmitter(), {
      getURL: () => "http://127.0.0.1:43123/?threadId=7&interactionId=41&review=1&reviewSession=token-1",
    });
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      webContents,
      loadURL: vi.fn(async () => {}),
    });

    const ready = loadReadyReviewWorkspace({
      window,
      ipc,
      url: webContents.getURL(),
      expected: {
        executionId: "execution-1",
        threadId: "7",
        turnId: "41",
        navigationToken: "token-1",
      },
      timeoutMs: 30_000,
    });

    await vi.advanceTimersByTimeAsync(6_000);
    ipc.emit(REVIEW_WORKSPACE_READY_CHANNEL, { sender: {} }, {
      executionId: "execution-1",
      threadId: "7",
      turnId: "41",
      navigationToken: "token-1",
    });
    ipc.emit(REVIEW_WORKSPACE_READY_CHANNEL, { sender: webContents }, {
      executionId: "execution-1",
      threadId: "7",
      turnId: "wrong-turn",
      navigationToken: "token-1",
    });
    await Promise.resolve();
    expect(await Promise.race([ready.then(() => "ready"), Promise.resolve("waiting")])).toBe("waiting");

    ipc.emit(REVIEW_WORKSPACE_READY_CHANNEL, { sender: webContents }, {
      executionId: "execution-1",
      threadId: "7",
      turnId: "41",
      navigationToken: "token-1",
    });

    await expect(ready).resolves.toEqual({
      executionId: "execution-1",
      threadId: "7",
      turnId: "41",
      navigationToken: "token-1",
    });
    expect(window.loadURL).toHaveBeenCalledWith(webContents.getURL());
    expect(ipc.listenerCount(REVIEW_WORKSPACE_READY_CHANNEL)).toBe(0);
  });

  it("emits exact navigation readiness only after the presentation adapter is registered", async () => {
    const source = await readFile(new URL("../desktop/preload/eval-review.cjs", import.meta.url), "utf8");
    const sent = [];
    let reviewApi;
    const ipcRenderer = {
      on: vi.fn(),
      invoke: vi.fn(),
      send: (...arguments_) => sent.push(arguments_),
    };
    vm.runInNewContext(source, {
      require: (specifier) => {
        if (specifier !== "electron") throw new Error(`Unexpected preload dependency: ${specifier}`);
        return {
          contextBridge: {
            exposeInMainWorld: (name, value) => {
              expect(name).toBe("relayerEvalReview");
              reviewApi = value;
            },
          },
          ipcRenderer,
        };
      },
      process: { argv: ["--relayer-eval-execution=execution-1"] },
      location: {
        href: "http://127.0.0.1:43123/?threadId=7&interactionId=41&review=1&reviewSession=token-1",
      },
      URL,
    });

    reviewApi.registerPresentationAdapter({
      snapshot: () => ({ threadId: "7", turnId: "41" }),
      capturePlan: () => {},
      prepareCaptureTile: () => {},
      restoreCapture: () => {},
      activate: () => {},
      history: () => {},
    });

    expect(sent).toEqual([[
      REVIEW_WORKSPACE_READY_CHANNEL,
      {
        executionId: "execution-1",
        threadId: "7",
        turnId: "41",
        navigationToken: "token-1",
      },
    ]]);
  });
});
