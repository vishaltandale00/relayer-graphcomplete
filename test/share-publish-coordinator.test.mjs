import { describe, expect, it, vi } from "vitest";

import { createSharePublishCoordinator } from "../desktop/main/services/share-publish-coordinator.mjs";
import { ShareSnapshotExportError } from "../desktop/main/services/relayer-app-server.mjs";

const snapshot = new TextEncoder().encode(`${JSON.stringify({
  recordType: "header",
  conversation: { projectName: "Public project" },
})}\n${JSON.stringify({ recordType: "turn" })}\n`);

describe("share publication coordinator", () => {
  it("preflights export eligibility/size and quota without retaining an attempt", async () => {
    const exportSnapshot = vi.fn(async () => snapshot);
    const preflightPublication = vi.fn(async ({ authorization, assertAuthority }) => {
      expect(authorization).toBe("Bearer secret");
      await assertAuthority();
    });
    const publish = vi.fn();
    const coordinator = createSharePublishCoordinator({
      exportSnapshot,
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer secret", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish,
      preflightPublication,
    });

    await expect(coordinator.preflight({ threadId: 42 })).resolves.toEqual({ status: "ready" });
    expect([...exportSnapshot.mock.calls[0][1]]).toHaveLength(120);
    expect(preflightPublication).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    await expect(coordinator.retry("SHR-NOT-CREATED")).resolves.toMatchObject({ code: "share_attempt_unavailable" });
  });

  it("freezes bytes and attempt identity for retry while keeping authority inside main", async () => {
    const publish = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("lost response"), {
        code: "share_service_failed",
        failureStage: "service",
      }))
      .mockResolvedValueOnce({ url: "https://share.example.test/t/abc" });
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: vi.fn(async () => snapshot),
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer secret", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
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
    let account = { ownerKey: "owner-a", authorization: "Bearer secret", generation: 1 };
    const publish = vi.fn(async () => {
      throw Object.assign(new Error("offline"), { code: "share_upload_failed", failureStage: "upload" });
    });
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => account,
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish,
      createAttemptId: () => "00112233445566778899aabbccddeeff",
      createReferenceId: () => "SHR-ABCDEF12",
    });
    await coordinator.create({ threadId: 42, title: "Public title" });
    account = { ownerKey: "owner-b", authorization: "Bearer secret", generation: 2 };
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
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer secret", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish: vi.fn(),
      issueHandledShareFailureReporter: () => ({ report }),
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

  it("does not report expected eligibility and validation failures", async () => {
    const report = vi.fn();
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => {
        throw Object.assign(new Error("expected eligibility failure"), {
          code: "share_no_accepted_completion",
          failureStage: "export",
        });
      },
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer secret", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish: vi.fn(),
      issueHandledShareFailureReporter: () => ({ report }),
      createReferenceId: () => "SHR-EXPECTED",
    });

    await expect(coordinator.preflight({ threadId: 42 })).resolves.toMatchObject({
      code: "share_no_accepted_completion",
      retryable: false,
    });
    expect(report).not.toHaveBeenCalled();
  });

  it("keeps the active-reservation capacity boundary typed and out of telemetry", async () => {
    const report = vi.fn();
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer secret", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish: async () => {
        throw Object.assign(new Error("expected reservation capacity"), {
          code: "reservation_limit_exhausted",
          failureStage: "service",
        });
      },
      issueHandledShareFailureReporter: () => ({ report }),
      createReferenceId: () => "SHR-CAPACITY",
    });

    await expect(coordinator.create({ threadId: 42, title: "Public title" })).resolves.toMatchObject({
      code: "reservation_limit_exhausted",
      retryable: false,
    });
    expect(report).not.toHaveBeenCalled();
  });

  it("revalidates account authority after export and closes arbitrary dependency codes", async () => {
    let currentAccount = { ownerKey: "owner-a", authorization: "Bearer old", generation: 1 };
    let releaseExport;
    const publish = vi.fn();
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: () => new Promise((resolve) => { releaseExport = () => resolve(snapshot); }),
      accountSession: async () => currentAccount,
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish,
      createReferenceId: () => "SHR-ABCDEF12",
    });
    const pending = coordinator.create({ threadId: 42, title: "Public title" });
    await vi.waitFor(() => expect(releaseExport).toBeTypeOf("function"));
    currentAccount = { ownerKey: "owner-a", authorization: "Bearer replacement", generation: 2 };
    releaseExport();
    await expect(pending).resolves.toMatchObject({ code: "share_sign_in_required", retryable: false });
    expect(publish).not.toHaveBeenCalled();

    const closed = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer secret", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish: async () => { throw { code: "private:///Users/person/token" }; },
      createReferenceId: () => "SHR-ABCDEF12",
    });
    await expect(closed.create({ threadId: 42, title: "Public title" })).resolves.toMatchObject({
      code: "share_service_failed",
    });
  });

  it("binds publication and failure reporting to the initiating account generation", async () => {
    let currentAccount = { ownerKey: "owner-a", authorization: "Bearer old", generation: 1 };
    let releasePublish;
    let failImmediately = false;
    const report = vi.fn();
    const reporters = new Map([[1, {
      report: async (record) => {
        if (currentAccount.generation === 1) await report(record);
      },
    }]]);
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => currentAccount,
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish: () => failImmediately
        ? Promise.reject(Object.assign(new Error("offline"), { code: "share_upload_failed", failureStage: "upload" }))
        : new Promise((_resolve, reject) => {
        releasePublish = () => reject(Object.assign(new Error("offline"), {
          code: "share_upload_failed",
          failureStage: "upload",
        }));
        }),
      issueHandledShareFailureReporter: ({ generation }) => reporters.get(generation) ?? null,
      createReferenceId: () => "SHR-ABCDEF12",
    });
    const pending = coordinator.create({ threadId: 42, title: "Public title" });
    await vi.waitFor(() => expect(releasePublish).toBeTypeOf("function"));
    currentAccount = { ownerKey: "owner-b", authorization: "Bearer new", generation: 2 };
    reporters.delete(1);
    releasePublish();
    await expect(pending).resolves.toMatchObject({ code: "share_upload_failed" });
    expect(report).not.toHaveBeenCalled();

    currentAccount = { ownerKey: "owner-a", authorization: "Bearer same-owner", generation: 3 };
    failImmediately = true;
    await expect(coordinator.retry("SHR-ABCDEF12")).resolves.toMatchObject({ code: "share_upload_failed" });
  });

  it("classifies the real exporter error at the export stage", async () => {
    const report = vi.fn();
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => { throw new ShareSnapshotExportError("share_export_failed"); },
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer secret", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish: vi.fn(),
      issueHandledShareFailureReporter: () => ({ report }),
      createReferenceId: () => "SHR-ABCDEF12",
    });
    await coordinator.create({ threadId: 42, title: "Public title" });
    expect(report).toHaveBeenCalledWith({
      code: "share.export_failed",
      failureStage: "export",
      attemptReferenceId: "SHR-ABCDEF12",
      snapshotBytes: null,
    });
  });

  it("preserves the service quota reset time in the closed renderer result", async () => {
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer secret", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish: async () => {
        throw Object.assign(new Error("quota"), {
          code: "daily_quota_exhausted",
          resetAt: "2026-09-27T00:00:00.000Z",
        });
      },
      createReferenceId: () => "SHR-QUOTA01",
    });

    await expect(coordinator.create({ threadId: 42, title: "Public title" })).resolves.toEqual({
      status: "failed",
      attemptReferenceId: "SHR-QUOTA01",
      code: "daily_quota_exhausted",
      retryable: false,
      resetAt: "2026-09-27T00:00:00.000Z",
    });
  });

  it("keeps an in-flight retry bound to its immutable generation and rejects overlap", async () => {
    let account = { ownerKey: "owner-a", authorization: "Bearer one", generation: 1 };
    let retryResolve;
    let call = 0;
    const publish = vi.fn(async () => {
      call += 1;
      if (call === 1) throw Object.assign(new Error("offline"), { code: "share_service_failed" });
      return new Promise((resolve) => { retryResolve = resolve; });
    });
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => account,
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish,
      createReferenceId: () => "SHR-ABCDEF12",
    });
    await coordinator.create({ threadId: 42, title: "Public title" });
    const oldRetry = coordinator.retry("SHR-ABCDEF12");
    await vi.waitFor(() => expect(retryResolve).toBeTypeOf("function"));
    account = { ownerKey: "owner-a", authorization: "Bearer two", generation: 2 };
    await expect(coordinator.retry("SHR-ABCDEF12")).resolves.toMatchObject({
      code: "share_attempt_unavailable",
      retryable: false,
    });
    retryResolve({ url: "https://share.example.test/t/stale" });
    await expect(oldRetry).resolves.toMatchObject({ code: "share_sign_in_required" });
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
