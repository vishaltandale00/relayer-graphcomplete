import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  capturedStateMeetsReadableHold,
  capturedStateRun,
  classifyDesktopCaptureText,
  sha256File,
} from "../scripts/lib/desktop-capture-evidence.mjs";
import {
  assertTrackedWorkspaceUnchanged,
  captureTrackedWorkspaceSnapshot,
  validateTerminalFrameCoverage,
  validateVisibleBoundaryHold,
} from "../scripts/lib/interaction-context-capture-proof.mjs";

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

describe("retained capture file receipts", () => {
  it("hashes the retained frame after it replaces the earlier screenshot bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-capture-receipt-"));
    try {
      const screenshotFile = join(directory, "saved-thread.png");
      await writeFile(screenshotFile, Buffer.from("pre-recording image"));
      await writeFile(screenshotFile, Buffer.from("retained first-frame image"));

      await expect(sha256File(screenshotFile)).resolves.toBe(
        "dadfc27ecf36ecc4ecbf9350ccb094d8ed2c20fee24e3f1a74777ab002f63701",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("interaction-context recording proof", () => {
  it("requires painted screen text at both captured endpoints of the requested visible hold", () => {
    const startFrame = {
      frameNumber: 10,
      elapsedMs: 1000,
      recognizedText: "Two-worker pool Drafts will be omitted",
    };
    const endFrame = {
      frameNumber: 26,
      elapsedMs: 2800,
      maximumCaptureGapMs: 140,
      recognizedText: "Two-worker pool Drafts will be omitted",
    };

    expect(validateVisibleBoundaryHold({
      startFrame,
      endFrame,
      expectedText: ["Two-worker pool", "Drafts will be omitted"],
      minimumHoldMs: 1800,
      maximumCaptureGapMs: 500,
    })).toBe(1800);
    expect(() => validateVisibleBoundaryHold({
      startFrame,
      endFrame: { ...endFrame, recognizedText: "Two-worker pool" },
      expectedText: ["Two-worker pool", "Drafts will be omitted"],
      minimumHoldMs: 1800,
      maximumCaptureGapMs: 500,
    })).toThrow(/did not match at both ends/);
    expect(() => validateVisibleBoundaryHold({
      startFrame,
      endFrame: { ...endFrame, elapsedMs: 2799 },
      expectedText: ["Two-worker pool", "Drafts will be omitted"],
      minimumHoldMs: 1800,
      maximumCaptureGapMs: 500,
    })).toThrow(/shorter than 1800ms/);
    expect(() => validateVisibleBoundaryHold({
      startFrame,
      endFrame: { ...endFrame, maximumCaptureGapMs: 501 },
      expectedText: ["Two-worker pool", "Drafts will be omitted"],
      minimumHoldMs: 1800,
      maximumCaptureGapMs: 500,
    })).toThrow(/capture gap/);
  });

  it("rejects a stale omission-warning frame as the post-override screen", () => {
    const warningFrame = {
      frameNumber: 10,
      elapsedMs: 1000,
      recognizedText: "Turn 3 of 3 DRAFTS WILL BE OMITTED Use the confirmed queue note for this follow-up.",
    };
    const warningHoldEnd = {
      ...warningFrame,
      frameNumber: 27,
      elapsedMs: 2800,
      maximumCaptureGapMs: 180,
    };
    expect(() => validateVisibleBoundaryHold({
      startFrame: warningFrame,
      endFrame: warningHoldEnd,
      expectedText: ["Turn 4 of 4", "Use the confirmed queue note for this follow-up."],
      expectedAbsentText: ["Drafts will be omitted"],
      minimumHoldMs: 1400,
      maximumCaptureGapMs: 500,
    })).toThrow(/missingStart.*Turn 4 of 4.*unexpectedStart.*Drafts will be omitted/);

    const postOverrideFrame = {
      ...warningFrame,
      recognizedText: "Turn 4 of 4 Use the confirmed queue note for this follow-up.",
    };
    expect(validateVisibleBoundaryHold({
      startFrame: postOverrideFrame,
      endFrame: {
        ...postOverrideFrame,
        frameNumber: 27,
        elapsedMs: 2800,
        maximumCaptureGapMs: 180,
      },
      expectedText: ["Turn 4 of 4", "Use the confirmed queue note for this follow-up."],
      expectedAbsentText: ["Drafts will be omitted"],
      minimumHoldMs: 1400,
      maximumCaptureGapMs: 500,
    })).toBe(1800);
  });

  it("rejects title-only stale frames when the boundary requires Node Details or a closed editor", () => {
    const titleOnlyStaleFrame = {
      frameNumber: 3,
      elapsedMs: 0,
      recognizedText: "Incoming queue Two-worker pool",
    };
    const titleOnlyStaleEnd = {
      ...titleOnlyStaleFrame,
      frameNumber: 20,
      elapsedMs: 1500,
      maximumCaptureGapMs: 100,
    };

    expect(() => validateVisibleBoundaryHold({
      startFrame: titleOnlyStaleFrame,
      endFrame: titleOnlyStaleEnd,
      expectedText: ["NODE DETAILS", "Incoming queue"],
      minimumHoldMs: 1400,
      maximumCaptureGapMs: 500,
    })).toThrow(/missingStart.*NODE DETAILS/);

    const staleEditorFrame = {
      ...titleOnlyStaleFrame,
      recognizedText: "NODE DETAILS Two-worker pool Add an annotation Keep both workers available for queued tasks.",
    };
    const staleEditorEnd = {
      ...staleEditorFrame,
      frameNumber: 20,
      elapsedMs: 1500,
      maximumCaptureGapMs: 100,
    };
    expect(() => validateVisibleBoundaryHold({
      startFrame: staleEditorFrame,
      endFrame: staleEditorEnd,
      expectedText: ["Two-worker pool"],
      expectedAbsentText: ["Add an annotation", "Keep both workers available for queued tasks."],
      minimumHoldMs: 1400,
      maximumCaptureGapMs: 500,
    })).toThrow(/unexpectedStart/);

    expect(validateVisibleBoundaryHold({
      startFrame: {
        ...titleOnlyStaleFrame,
        recognizedText: "Incoming queue Two-worker pool Scroll or pinch to zoom",
      },
      endFrame: {
        ...titleOnlyStaleEnd,
        recognizedText: "Incoming queue Two-worker pool Scroll or pinch to zoom",
      },
      expectedText: ["Incoming queue"],
      expectedAbsentText: ["NODE DETAILS", "Add an annotation"],
      minimumHoldMs: 1400,
      maximumCaptureGapMs: 500,
    })).toBe(1500);
  });

  it("rejects a container that clips its encoded terminal frame despite matching earlier timestamps", () => {
    const capturedPresentationMs = [0, 100, 200];
    const encodedPresentationMs = [0, 100, 200, 400, 600];
    expect(validateTerminalFrameCoverage({
      capturedPresentationMs,
      encodedPresentationMs,
      containerDurationMs: 601,
      terminalFrameHoldMs: 200,
    })).toMatchObject({ terminalFramePresentationMs: 600, requiredContainerDurationMs: 601 });
    expect(() => validateTerminalFrameCoverage({
      capturedPresentationMs,
      encodedPresentationMs,
      containerDurationMs: 600,
      terminalFrameHoldMs: 200,
    })).toThrow(/container ends before its terminal frame/);
    expect(() => validateTerminalFrameCoverage({
      capturedPresentationMs,
      encodedPresentationMs: [0, 100, 200, 390, 600],
      containerDurationMs: 601,
      terminalFrameHoldMs: 200,
    })).toThrow(/Repeated terminal frames/);
  });
});

describe("post-capture production workspace guard", () => {
  it("accepts changes to declared capture outputs and rejects another tracked production file edit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "interaction-workspace-snapshot-"));
    const excludedOutput = "docs/prd/assets/evidence/interaction-context/manifest.json";
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: directory });
      await writeFile(join(directory, "scripts-renderer.js"), "export const version = 1;\n");
      await mkdir(join(directory, "docs/prd/assets/evidence/interaction-context"), { recursive: true });
      await writeFile(join(directory, excludedOutput), "{\"version\":1}\n");
      execFileSync("git", ["add", "scripts-renderer.js", excludedOutput], { cwd: directory });

      const before = await captureTrackedWorkspaceSnapshot(directory, [excludedOutput]);
      await writeFile(join(directory, excludedOutput), "{\"version\":2}\n");
      const captureOnlyChange = await captureTrackedWorkspaceSnapshot(directory, [excludedOutput]);
      expect(() => assertTrackedWorkspaceUnchanged(before, captureOnlyChange)).not.toThrow();

      await writeFile(join(directory, "scripts-renderer.js"), "export const version = 2;\n");
      const productionEdit = await captureTrackedWorkspaceSnapshot(directory, [excludedOutput]);
      expect(() => assertTrackedWorkspaceUnchanged(before, productionEdit))
        .toThrow(/Tracked production workspace changed during capture/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a newly created untracked production file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "interaction-workspace-untracked-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: directory });
      await writeFile(join(directory, "tracked.js"), "export const stable = true;\n");
      execFileSync("git", ["add", "tracked.js"], { cwd: directory });
      const before = await captureTrackedWorkspaceSnapshot(directory);
      await writeFile(join(directory, "new-production-file.js"), "export const changed = true;\n");
      const after = await captureTrackedWorkspaceSnapshot(directory);
      expect(() => assertTrackedWorkspaceUnchanged(before, after))
        .toThrow(/Tracked production workspace changed during capture/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
