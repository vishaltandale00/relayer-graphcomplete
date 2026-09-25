import { describe, expect, it, vi } from "vitest";

import { createSharePublishCoordinator } from "../desktop/main/services/share-publish-coordinator.mjs";

const snapshot = new TextEncoder().encode(`${JSON.stringify({
  recordType: "header",
  conversation: { projectName: "Public project" },
})}\n${JSON.stringify({ recordType: "turn" })}\n`);

describe("share publication coordinator", () => {
  it("freezes bytes and attempt identity for retry while keeping authority inside main", async () => {
    const publish = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("lost response"), {
        code: "share_service_failed",
        failureStage: "service",
      }))
      .mockResolvedValueOnce({ url: "https://share.example.test/t/abc" });
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: vi.fn(async () => snapshot),
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer secret" }),
      publish,
      createAttemptId: () => "00112233445566778899aabbccddeeff",
      createReferenceId: () => "SHR-ABCDEF12",
    });

    const failed = await coordinator.create({ threadId: 42, title: "Public title" });
    expect(failed).toMatchObject({ status: "failed", attemptReferenceId: "SHR-ABCDEF12", retryable: true });
    await expect(coordinator.retry("SHR-ABCDEF12")).resolves.toEqual({
      status: "created",
      attemptReferenceId: "SHR-ABCDEF12",
      url: "https://share.example.test/t/abc",
    });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1][0].attempt).toEqual(publish.mock.calls[0][0].attempt);
    expect(publish.mock.calls[1][0].snapshotBytes).toEqual(publish.mock.calls[0][0].snapshotBytes);
    expect(publish.mock.calls[0][0].attempt.attemptId).toHaveLength(32);
    expect(JSON.stringify(failed)).not.toContain("Bearer secret");
  });

  it("rejects retry after an account transition without invoking publication", async () => {
    let ownerKey = "owner-a";
    const publish = vi.fn(async () => {
      throw Object.assign(new Error("offline"), { code: "share_upload_failed", failureStage: "upload" });
    });
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => ({ ownerKey, authorization: "Bearer secret" }),
      publish,
      createAttemptId: () => "00112233445566778899aabbccddeeff",
      createReferenceId: () => "SHR-ABCDEF12",
    });
    await coordinator.create({ threadId: 42, title: "Public title" });
    ownerKey = "owner-b";
    await expect(coordinator.retry("SHR-ABCDEF12")).resolves.toMatchObject({
      status: "failed",
      code: "share_attempt_unavailable",
      retryable: false,
    });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("reports only the closed privacy-safe failure record", async () => {
    const report = vi.fn(async () => ({ accepted: true }));
    const error = Object.assign(new Error("private raw service response"), {
      code: "share_snapshot_too_large",
      snapshotBytes: 16_777_217,
    });
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => { throw error; },
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer secret" }),
      publish: vi.fn(),
      reportHandledShareFailure: report,
      createReferenceId: () => "SHR-ABCDEF12",
    });
    await coordinator.create({ threadId: 42, title: "Public title" });
    expect(report).toHaveBeenCalledWith({
      code: "share.snapshot_too_large",
      failureStage: "export",
      attemptReferenceId: "SHR-ABCDEF12",
      snapshotBytes: 16_777_217,
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain("private raw service response");
    expect(JSON.stringify(report.mock.calls)).not.toContain("Bearer secret");
  });
});
