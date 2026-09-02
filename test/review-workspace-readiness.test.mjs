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
  it("completes the readiness handshake only for the exact signal the preload emits after adapter registration", async () => {
    vi.useFakeTimers();
    const ipc = new EventEmitter();
    const readyUrl = "http://127.0.0.1:43123/?threadId=7&interactionId=41&review=1&reviewSession=token-1";
    const webContents = Object.assign(new EventEmitter(), {
      getURL: () => readyUrl,
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
    expect(
      await Promise.race([ready.then(() => "ready"), Promise.resolve("waiting")]),
      "signals beyond the legacy five-second window and from foreign senders or wrong turns stay waiting",
    ).toBe("waiting");

    ipc.emit(REVIEW_WORKSPACE_READY_CHANNEL, { sender: webContents }, {
      executionId: "execution-1",
      threadId: "7",
      turnId: "41",
      navigationToken: "token-1",
    });

    await expect(ready, "exact readiness signal resolves").resolves.toEqual({
      executionId: "execution-1",
      threadId: "7",
      turnId: "41",
      navigationToken: "token-1",
    });
    expect(window.loadURL, "ready workspace reloads the review URL").toHaveBeenCalledWith(webContents.getURL());
    expect(ipc.listenerCount(REVIEW_WORKSPACE_READY_CHANNEL), "ready listener is removed").toBe(0);

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
              expect(name, "preload exposes the review bridge").toBe("relayerEvalReview");
              reviewApi = value;
            },
          },
          ipcRenderer,
        };
      },
      process: { argv: ["--relayer-eval-execution=execution-1"] },
      location: { href: readyUrl },
      URL,
    });

    expect(sent, "no readiness is emitted before the presentation adapter exists").toEqual([]);
    reviewApi.registerPresentationAdapter({
      snapshot: () => ({ threadId: "7", turnId: "41" }),
      capturePlan: () => {},
      prepareCaptureTile: () => {},
      restoreCapture: () => {},
      activate: () => {},
      history: () => {},
    });

    expect(sent, "adapter registration emits the exact readiness signal").toEqual([[
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
