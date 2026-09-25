import { describe, expect, it } from "vitest";

import {
  capturedStateMeetsReadableHold,
  capturedStateRun,
  classifyDesktopCaptureText,
} from "../scripts/lib/desktop-capture-evidence.mjs";

describe("desktop capture content acceptance", () => {
  it("recognizes the saved-thread follow-up and empty New Thread from captured text", () => {
    expect(classifyDesktopCaptureText(
      "Keep this unsent follow-up with the saved thread.",
    )).toBe("saved-thread");
    expect(classifyDesktopCaptureText(
      "What are we working on? Ask Relayer to investigate, design, or build something...",
    )).toBe("empty-new-thread");
    expect(classifyDesktopCaptureText(
      "Keep this unsent follow-up with the saved thread. What are we working on?",
    )).toBe("unknown");
  });

  it("measures the visible interval from the first and last captured state frames", () => {
    const frames = [
      { capturedAtMs: 55, state: "saved-thread" },
      { capturedAtMs: 720, state: "saved-thread" },
      { capturedAtMs: 1455, state: "saved-thread" },
    ];
    expect(capturedStateRun(frames, "saved-thread")).toMatchObject({
      firstAtMs: 55,
      lastAtMs: 1455,
      durationMs: 1400,
    });
    expect(capturedStateMeetsReadableHold(frames, "saved-thread", 1400))
      .toMatchObject({ durationMs: 1400 });
  });

  it("rejects elapsed recording time when the first captured frame arrived late", () => {
    const frames = [
      { capturedAtMs: 80, state: "saved-thread" },
      { capturedAtMs: 1390, state: "saved-thread" },
    ];
    const clickAtMs = 1400;
    expect(clickAtMs).toBeGreaterThanOrEqual(1400);
    expect(capturedStateMeetsReadableHold(frames, "saved-thread", 1400)).toBeNull();
  });

  it("starts a state's interval at the first frame that actually contains it", () => {
    const frames = [
      { capturedAtMs: 1000, state: "saved-thread" },
      { capturedAtMs: 1280, state: "saved-thread" },
      { capturedAtMs: 1540, state: "empty-new-thread" },
      { capturedAtMs: 1780, state: "empty-new-thread" },
    ];
    const domReportedVisibleAtMs = 1200;
    const newThreadRun = capturedStateRun(frames, "empty-new-thread", { afterIndex: 1 });
    expect(newThreadRun).toMatchObject({ firstAtMs: 1540, lastAtMs: 1780, durationMs: 240 });
    expect(domReportedVisibleAtMs).not.toBe(newThreadRun.firstAtMs);
    expect(capturedStateMeetsReadableHold(
      frames,
      "empty-new-thread",
      1400,
      { afterIndex: 1 },
    )).toBeNull();
  });

  it("breaks a visible interval when a captured frame does not prove that state", () => {
    const frames = [
      { capturedAtMs: 0, state: "empty-new-thread" },
      { capturedAtMs: 850, state: "unknown" },
      { capturedAtMs: 1700, state: "empty-new-thread" },
    ];
    expect(capturedStateMeetsReadableHold(frames, "empty-new-thread", 1400))
      .toBeNull();
  });

  it("selects bounded state runs without borrowing a later repeat of the same screen", () => {
    const frames = [
      { capturedAtMs: 0, state: "saved-thread" },
      { capturedAtMs: 1400, state: "saved-thread" },
      { capturedAtMs: 1500, state: "empty-new-thread" },
      { capturedAtMs: 2900, state: "empty-new-thread" },
      { capturedAtMs: 3000, state: "saved-thread" },
      { capturedAtMs: 4400, state: "saved-thread" },
    ];
    expect(capturedStateRun(frames, "saved-thread", { beforeIndex: 1 }))
      .toMatchObject({ firstAtMs: 0, lastAtMs: 1400, durationMs: 1400 });
    expect(capturedStateRun(frames, "empty-new-thread", { afterIndex: 1, beforeIndex: 3 }))
      .toMatchObject({ firstAtMs: 1500, lastAtMs: 2900, durationMs: 1400 });
    expect(capturedStateRun(frames, "saved-thread", { afterIndex: 3 }))
      .toMatchObject({ firstAtMs: 3000, lastAtMs: 4400, durationMs: 1400 });
  });
});
