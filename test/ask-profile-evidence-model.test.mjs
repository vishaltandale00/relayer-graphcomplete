import { describe, expect, it } from "vitest";
import {
  isFreshRecordedPromptFrame,
  validateApprovalPromptHoldEvidence,
} from "../scripts/ask-profile-evidence-model.mjs";

function evidenceFixture() {
  const screenshots = {};
  const holds = [];
  for (let index = 0; index < 7; index += 1) {
    const label = `prompt-${index}-waiting`;
    const requestId = `request-${index}`;
    screenshots[label] = { file: `${label}.png`, approvalRequestId: requestId };
    holds.push({
      label,
      requestId,
      requiredMs: 3_000,
      observedMs: 3_125,
      stableStateSamples: 26,
      videoStartOffsetMs: index * 4_000,
      videoEndOffsetMs: (index * 4_000) + 3_125,
      frameCountAtStart: index * 32,
      frameCountAtEnd: (index * 32) + 25,
    });
  }
  return {
    screenshots,
    holds,
    requiredDurationMs: 3_000,
    minimumFrames: 24,
    encodedDurationMs: 30_000,
    frameIntervalMs: 125,
  };
}

describe("Ask-profile video evidence model", () => {
  it("anchors only to a recorder capture that starts after prompt validation", () => {
    expect(isFreshRecordedPromptFrame({
      frameIndex: 12,
      captureStartedAt: 1_001,
      captureCompletedAt: 1_010,
    }, 1_000), "capture started after validation").toBe(true);
    expect(isFreshRecordedPromptFrame({
      frameIndex: 12,
      captureStartedAt: 999,
      captureCompletedAt: 1_010,
    }, 1_000), "capture started before validation").toBe(false);
  });

  it("accepts seven unique screenshot-correlated stable prompt intervals with adjacent frame windows", () => {
    expect(validateApprovalPromptHoldEvidence(evidenceFixture()), "seven unique intervals").toBe(true);

    const adjacent = evidenceFixture();
    const previous = adjacent.holds[0];
    const next = adjacent.holds[1];
    next.frameCountAtStart = previous.frameCountAtEnd;
    next.frameCountAtEnd = next.frameCountAtStart + 25;
    next.videoStartOffsetMs = previous.videoEndOffsetMs;
    next.videoEndOffsetMs = next.videoStartOffsetMs + 3_125;
    expect(validateApprovalPromptHoldEvidence(adjacent), "exclusive adjacent frame intervals").toBe(true);
  });

  it("rejects the complete tampered prompt-hold corpus", () => {
    const cases = [
      ["a missing hold", (fixture) => fixture.holds.pop()],
      ["a duplicate request", (fixture) => { fixture.holds[1].requestId = fixture.holds[0].requestId; }],
      ["too little wall time", (fixture) => { fixture.holds[0].observedMs = 2_999; }],
      ["too few recorded frames", (fixture) => { fixture.holds[0].frameCountAtEnd = 23; }],
      ["an interval outside the encoded video", (fixture) => { fixture.holds[5].videoEndOffsetMs = 31_000; }],
      ["a non-finite duration", (fixture) => { fixture.holds[0].observedMs = Number.NaN; }],
      ["a non-finite frame counter", (fixture) => { fixture.holds[0].frameCountAtEnd = Number.POSITIVE_INFINITY; }],
      ["an inconsistent video interval", (fixture) => { fixture.holds[0].videoEndOffsetMs += 1; }],
      ["video intervals reused across every distinct prompt", (fixture) => {
        for (const hold of fixture.holds) {
          hold.videoStartOffsetMs = 0;
          hold.videoEndOffsetMs = 3_125;
        }
      }],
      ["a duration-preserving video offset tamper", (fixture) => {
        fixture.holds[1].videoStartOffsetMs += 125;
        fixture.holds[1].videoEndOffsetMs += 125;
      }],
      ["an exact frame interval reused by another prompt", (fixture) => {
        fixture.holds[1].frameCountAtStart = fixture.holds[0].frameCountAtStart;
        fixture.holds[1].frameCountAtEnd = fixture.holds[0].frameCountAtEnd;
      }],
      ["partially overlapping frame intervals", (fixture) => {
        fixture.holds[1].frameCountAtStart = fixture.holds[0].frameCountAtEnd - 1;
        fixture.holds[1].frameCountAtEnd = fixture.holds[1].frameCountAtStart + 25;
      }],
      ["chronologically reordered frame intervals", (fixture) => {
        [fixture.holds[0], fixture.holds[1]] = [fixture.holds[1], fixture.holds[0]];
      }],
    ];
    expect(cases, "tamper inventory").toHaveLength(13);
    for (const [label, mutate] of cases) {
      const fixture = evidenceFixture();
      mutate(fixture);
      expect(() => validateApprovalPromptHoldEvidence(fixture), label).toThrow();
    }
  });
});
