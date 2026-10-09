import { describe, expect, it, vi } from "vitest";

import { createSharePublishCoordinator } from "../desktop/main/services/share-publish-coordinator.mjs";
import { ShareSnapshotExportError } from "../desktop/main/services/relayer-app-server.mjs";
import { createShareServiceClient } from "../desktop/main/services/share-service-client.mjs";

const snapshot = new TextEncoder().encode(`${JSON.stringify({
  recordType: "header",
  conversation: { projectName: "Public project" },
})}\n${JSON.stringify({ recordType: "turn" })}\n`);

describe("share publication coordinator", () => {
  it("never publishes or uploads when native reusable Invocation export is unavailable", async () => {
    const report = vi.fn();
    const upload = vi.fn();
    const service = createShareServiceClient({ endpoint: "https://share.example.test", fetchImpl: upload, uploadFetchImpl: upload });
    const publish = vi.fn(service.publish);
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => { throw new ShareSnapshotExportError("reusable_invocation_portability_unavailable"); },
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer a", generation: 1 }),
      sourceThreadIdentity: async () => "thread:1",
      publish,
      issueHandledShareFailureReporter: () => ({ report }),
    });
    await expect(coordinator.create({ threadId: 1, title: "Analysis" })).resolves.toMatchObject({ code: "reusable_invocation_portability_unavailable", retryable: false });
    expect(publish).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("maps service oversize rejection to a terminal desktop failure across recovery", async () => {
    const client = createShareServiceClient({
      endpoint: "https://share.example.test",
      fetchImpl: async () => ({ ok: false, status: 413, json: async () => ({ error: "snapshot_too_large" }) }),
    });
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      sourceThreadIdentity: async () => "thread:1",
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer a", generation: 1 }),
      publish: client.publish,
    });
    await expect(coordinator.create({ threadId: 1, title: "Public" })).resolves.toMatchObject({ code: "share_snapshot_too_large", retryable: false });
    await expect(coordinator.pending({ threadId: 1 })).resolves.toMatchObject({ code: "share_snapshot_too_large", retryable: false });
  });

  it("retires a restored attempt whose frozen bytes disappeared without exporting or publishing", async () => {
    const value = {
      reference: "SHR-MISSING1", attemptId: "00112233445566778899aabbccddeeff",
      ownerKey: "owner-a", threadId: 1, sourceThreadId: "thread:1",
      title: "Public", snapshotBytes: snapshot, createdAt: 1,
      lastFailure: null, reportedFailures: [], publishedUrl: null,
    };
    const publish = vi.fn();
    const exportSnapshot = vi.fn();
    const save = vi.fn();
    const remove = vi.fn();
    const coordinator = createSharePublishCoordinator({
      exportSnapshot, sourceThreadIdentity: vi.fn(), publish,
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer a", generation: 1 }),
      attemptStore: { load: async ({ visit }) => { await visit(value); return []; }, read: async () => null, save, delete: remove },
    });
    await expect(coordinator.pending({ threadId: 1 })).resolves.toMatchObject({ retryable: true });
    await expect(coordinator.retry(value.reference)).resolves.toMatchObject({ code: "share_attempt_unavailable", retryable: false });
    await expect(coordinator.pending({ threadId: 1 })).resolves.toBeNull();
    await expect(coordinator.retry(value.reference)).resolves.toMatchObject({ code: "share_attempt_unavailable", retryable: false });
    expect(remove).toHaveBeenCalledExactlyOnceWith(value.reference);
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(exportSnapshot).not.toHaveBeenCalled();
  });
  it("hydrates only the retried durable attempt and bounds concurrent recovery", async () => {
    const values = [1, 2].map((index) => ({
      reference: `SHR-LAZY000${index}`, attemptId: "00112233445566778899aabbccddeeff",
      ownerKey: "owner-a", threadId: index, sourceThreadId: `thread:${index}`,
      title: "Public", snapshotBytes: snapshot, createdAt: index,
      lastFailure: null, reportedFailures: [], publishedUrl: null,
    }));
    let finish;
    const read = vi.fn(async (reference) => values.find((value) => value.reference === reference));
    const publish = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: vi.fn(), sourceThreadIdentity: vi.fn(), publish,
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer a", generation: 1 }),
      attemptStore: {
        load: async ({ visit }) => { for (const value of values) await visit(value); return []; },
        read, save: vi.fn(), delete: vi.fn(),
      },
    });
    await expect(coordinator.pending({ threadId: 1 })).resolves.toMatchObject({ attemptReferenceId: values[0].reference });
    expect(read).not.toHaveBeenCalled();
    const running = coordinator.retry(values[0].reference);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    await expect(coordinator.retry(values[1].reference)).resolves.toMatchObject({ code: "share_attempt_unavailable", retryable: true });
    expect(read).toHaveBeenCalledExactlyOnceWith(values[0].reference);
    finish({ url: "https://share.example.test/t/lazy" });
    await expect(running).resolves.toMatchObject({ status: "created" });
  });
  it("retries a transient initial load and revokes each operation reporter", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("EMFILE")).mockResolvedValue([]);
    const reporters = [];
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer a", generation: 1 }),
      sourceThreadIdentity: async () => "thread:42",
      publish: async () => { throw Object.assign(new Error("offline"), { code: "share_upload_failed" }); },
      attemptStore: { load, save: vi.fn(), delete: vi.fn() },
      issueHandledShareFailureReporter: () => {
        const reporter = { report: vi.fn(), revoke: vi.fn() };
        reporters.push(reporter);
        return reporter;
      },
      createReferenceId: () => "SHR-RECOVER1",
    });
    await expect(coordinator.pending({ threadId: 42 })).resolves.toBeNull();
    await expect(coordinator.create({ threadId: 42, title: "Public" })).resolves.toMatchObject({ code: "share_upload_failed" });
    await coordinator.preflight({ threadId: 42 });
    await coordinator.retry("SHR-RECOVER1");
    expect(load).toHaveBeenCalledTimes(2);
    expect(reporters).toHaveLength(3);
    for (const reporter of reporters) expect(reporter.revoke).toHaveBeenCalledOnce();
  });
  it("persists frozen bytes before publishing and reopens the same owner-bound attempt", async () => {
    const records = new Map();
    const attemptStore = {
      load: vi.fn(async () => [...records.values()].map((record) => structuredClone(record))),
      save: vi.fn(async (record) => { records.set(record.reference, structuredClone(record)); }),
      delete: vi.fn(async (reference) => records.delete(reference)),
    };
    const firstPublish = vi.fn(async () => {
      expect(attemptStore.save).toHaveBeenCalledOnce();
      throw Object.assign(new Error("lost response"), {
        code: "share_upload_failed",
        failureStage: "upload",
      });
    });
    const first = createSharePublishCoordinator({
      exportSnapshot: vi.fn(async () => snapshot),
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer first", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish: firstPublish,
      attemptStore,
      createAttemptId: () => "00112233445566778899aabbccddeeff",
      createReferenceId: () => "SHR-DURABLE1",
      now: () => 1_000,
    });

    await expect(first.create({ threadId: 42, title: "Public title" })).resolves.toMatchObject({
      status: "failed",
      attemptReferenceId: "SHR-DURABLE1",
      retryable: true,
    });
    expect(records.get("SHR-DURABLE1").snapshotBytes).toEqual(snapshot);

    const exportAfterRestart = vi.fn();
    const secondPublish = vi.fn(async ({ attempt, snapshotBytes }) => {
      expect(attempt.attemptId).toBe("00112233445566778899aabbccddeeff");
      expect(snapshotBytes).toEqual(snapshot);
      return { url: "https://share.example.test/t/recovered" };
    });
    let reopenedAccount = { ownerKey: "owner-a", authorization: "Bearer second", generation: 2 };
    const reopened = createSharePublishCoordinator({
      exportSnapshot: exportAfterRestart,
      accountSession: async () => reopenedAccount,
      sourceThreadIdentity: async () => { throw new Error("must not recalculate identity"); },
      publish: secondPublish,
      attemptStore,
    });

    await expect(reopened.pending({ threadId: 42 })).resolves.toMatchObject({
      status: "failed",
      attemptReferenceId: "SHR-DURABLE1",
      code: "share_upload_failed",
      retryable: true,
    });
    await expect(reopened.retry("SHR-DURABLE1")).resolves.toEqual({
      status: "created",
      attemptReferenceId: "SHR-DURABLE1",
      url: "https://share.example.test/t/recovered",
    });
    expect(exportAfterRestart).not.toHaveBeenCalled();
    expect(secondPublish).toHaveBeenCalledOnce();
    expect(records.get("SHR-DURABLE1")).toMatchObject({
      snapshotBytes: [],
      title: "",
      publishedUrl: "https://share.example.test/t/recovered",
    });
    await expect(reopened.pending({ threadId: 42 })).resolves.toEqual({
      status: "created",
      attemptReferenceId: "SHR-DURABLE1",
      url: "https://share.example.test/t/recovered",
    });
    reopenedAccount = { ownerKey: "owner-b", authorization: "Bearer replacement", generation: 3 };
    await expect(reopened.retry("SHR-DURABLE1")).resolves.toMatchObject({
      status: "failed",
      code: "share_attempt_unavailable",
      retryable: false,
    });
    reopenedAccount = null;
    await expect(reopened.retry("SHR-DURABLE1")).resolves.toMatchObject({
      status: "failed",
      code: "share_sign_in_required",
      retryable: false,
    });
    reopenedAccount = { ownerKey: "owner-a", authorization: "Bearer restored", generation: 4 };
    await reopened.dismiss("SHR-DURABLE1");
    expect(records.has("SHR-DURABLE1")).toBe(false);
  });

  it("hides another owner's durable attempt and deletes it only for an authenticated dismissal", async () => {
    const stored = {
      reference: "SHR-DURABLE2",
      attemptId: "ffeeddccbbaa99887766554433221100",
      ownerKey: "owner-a",
      threadId: 42,
      sourceThreadId: "installation:test:thread:42",
      title: "Public title",
      snapshotBytes: [...snapshot],
      createdAt: 1_000,
      lastFailure: {
        status: "failed",
        attemptReferenceId: "SHR-DURABLE2",
        code: "share_service_failed",
        retryable: true,
      },
      reportedFailures: [],
    };
    let account = { ownerKey: "owner-b", authorization: "Bearer b", generation: 2 };
    const attemptStore = {
      load: vi.fn(async () => [structuredClone(stored)]),
      save: vi.fn(),
      delete: vi.fn(async () => true),
    };
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: vi.fn(),
      accountSession: async () => account,
      sourceThreadIdentity: vi.fn(),
      publish: vi.fn(),
      attemptStore,
    });

    await expect(coordinator.pending({ threadId: 42 })).resolves.toBeNull();
    await expect(coordinator.dismiss("SHR-DURABLE2")).resolves.toMatchObject({
      status: "failed",
      code: "share_attempt_unavailable",
    });
    expect(attemptStore.delete).not.toHaveBeenCalled();

    account = { ownerKey: "owner-a", authorization: "Bearer a", generation: 3 };
    await expect(coordinator.pending({ threadId: 7 })).resolves.toBeNull();
    await expect(coordinator.dismiss("SHR-DURABLE2")).resolves.toEqual({
      status: "dismissed",
      attemptReferenceId: "SHR-DURABLE2",
    });
    expect(attemptStore.delete).toHaveBeenCalledWith("SHR-DURABLE2");
  });

  it("does not publish when the frozen attempt cannot be persisted", async () => {
    const publish = vi.fn();
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer a", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish,
      attemptStore: {
        load: async () => [],
        save: async () => { throw new Error("local storage unavailable"); },
        delete: async () => false,
      },
      createReferenceId: () => "SHR-NOSTORE1",
    });

    await expect(coordinator.create({ threadId: 42, title: "Public title" })).resolves.toMatchObject({
      status: "failed",
      code: "share_service_failed",
      retryable: false,
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("persists handled-failure deduplication across coordinator restart", async () => {
    const records = new Map();
    const attemptStore = {
      load: async () => [...records.values()].map((record) => structuredClone(record)),
      save: async (record) => { records.set(record.reference, structuredClone(record)); },
      delete: async (reference) => records.delete(reference),
    };
    const reportBeforeRestart = vi.fn(async () => ({ accepted: true }));
    const failingPublish = async () => {
      throw Object.assign(new Error("offline"), { code: "share_upload_failed", failureStage: "upload" });
    };
    const first = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer first", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish: failingPublish,
      attemptStore,
      issueHandledShareFailureReporter: () => ({ report: reportBeforeRestart }),
      createAttemptId: () => "00112233445566778899aabbccddeeff",
      createReferenceId: () => "SHR-REPORT01",
      now: () => 1_000,
    });
    await first.create({ threadId: 42, title: "Public title" });
    expect(reportBeforeRestart).toHaveBeenCalledOnce();

    const reportAfterRestart = vi.fn();
    const reopened = createSharePublishCoordinator({
      exportSnapshot: vi.fn(),
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer second", generation: 2 }),
      sourceThreadIdentity: vi.fn(),
      publish: failingPublish,
      attemptStore,
      issueHandledShareFailureReporter: () => ({ report: reportAfterRestart }),
    });
    await reopened.retry("SHR-REPORT01");
    expect(reportAfterRestart).not.toHaveBeenCalled();
  });

  it("keeps a published receipt durable but withholds its URL when ownership changes during the receipt save", async () => {
    let account = { ownerKey: "owner-a", authorization: "Bearer first", generation: 1 };
    let releaseReceiptSave;
    let saveCount = 0;
    let stored;
    const publish = vi.fn(async () => ({ url: "https://share.example.test/t/saved-before-switch" }));
    const attemptStore = {
      load: async () => [],
      save: vi.fn(async (record) => {
        saveCount += 1;
        stored = structuredClone(record);
        if (saveCount === 2) await new Promise((resolve) => { releaseReceiptSave = resolve; });
      }),
      delete: async () => false,
    };
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => account,
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish,
      attemptStore,
      createReferenceId: () => "SHR-SAVERACE",
    });

    const creating = coordinator.create({ threadId: 42, title: "Public title" });
    await vi.waitFor(() => expect(releaseReceiptSave).toBeTypeOf("function"));
    account = { ownerKey: "owner-b", authorization: "Bearer replacement", generation: 2 };
    releaseReceiptSave();

    await expect(creating).resolves.toMatchObject({ code: "share_sign_in_required" });
    expect(stored).toMatchObject({
      snapshotBytes: [],
      title: "",
      publishedUrl: "https://share.example.test/t/saved-before-switch",
    });
    account = { ownerKey: "owner-a", authorization: "Bearer restored", generation: 3 };
    await expect(coordinator.retry("SHR-SAVERACE")).resolves.toMatchObject({
      status: "created",
      url: "https://share.example.test/t/saved-before-switch",
    });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("never exposes or dismisses an attempt while publication is still running", async () => {
    let releasePublish;
    const attemptStore = {
      load: async () => [],
      save: vi.fn(async () => {}),
      delete: vi.fn(async () => true),
    };
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer current", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish: async () => new Promise((resolve) => { releasePublish = resolve; }),
      attemptStore,
      createReferenceId: () => "SHR-RUNNING1",
    });

    const creating = coordinator.create({ threadId: 42, title: "Public title" });
    await vi.waitFor(() => expect(releasePublish).toBeTypeOf("function"));
    await expect(coordinator.pending({ threadId: 42 })).resolves.toBeNull();
    await expect(coordinator.dismiss("SHR-RUNNING1")).resolves.toMatchObject({
      status: "failed",
      code: "share_attempt_unavailable",
    });
    expect(attemptStore.delete).not.toHaveBeenCalled();

    releasePublish({ url: "https://share.example.test/t/running-settled" });
    await expect(creating).resolves.toMatchObject({ status: "created" });
    await expect(coordinator.pending({ threadId: 42 })).resolves.toMatchObject({
      status: "created",
      url: "https://share.example.test/t/running-settled",
    });
  });

  it("lets dismissal claim an idle attempt before a captured retry finishes authenticating", async () => {
    const records = new Map();
    let releaseDelete;
    let releaseRetryAccount;
    let deferNextAccount = false;
    const account = { ownerKey: "owner-a", authorization: "Bearer current", generation: 1 };
    const attemptStore = {
      load: async () => [...records.values()].map((record) => structuredClone(record)),
      save: async (record) => { records.set(record.reference, structuredClone(record)); },
      delete: vi.fn(async (reference) => {
        await new Promise((resolve) => { releaseDelete = resolve; });
        return records.delete(reference);
      }),
    };
    const publish = vi.fn(async () => {
      throw Object.assign(new Error("offline"), { code: "share_upload_failed", failureStage: "upload" });
    });
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => {
        if (!deferNextAccount) return account;
        deferNextAccount = false;
        return new Promise((resolve) => { releaseRetryAccount = () => resolve(account); });
      },
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish,
      attemptStore,
      createReferenceId: () => "SHR-DISMISS1",
    });
    await coordinator.create({ threadId: 42, title: "Public title" });

    deferNextAccount = true;
    const retrying = coordinator.retry("SHR-DISMISS1");
    await vi.waitFor(() => expect(releaseRetryAccount).toBeTypeOf("function"));
    const dismissing = coordinator.dismiss("SHR-DISMISS1");
    await vi.waitFor(() => expect(releaseDelete).toBeTypeOf("function"));
    releaseRetryAccount();
    await expect(retrying).resolves.toMatchObject({
      status: "failed",
      code: "share_attempt_unavailable",
    });
    releaseDelete();
    await expect(dismissing).resolves.toEqual({
      status: "dismissed",
      attemptReferenceId: "SHR-DISMISS1",
    });

    expect(publish).toHaveBeenCalledOnce();
    expect(records.has("SHR-DISMISS1")).toBe(false);
    await expect(coordinator.pending({ threadId: 42 })).resolves.toBeNull();
  });

  it("restores retry authority when durable dismissal fails", async () => {
    let publishCount = 0;
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer current", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish: async () => {
        publishCount += 1;
        if (publishCount === 1) throw Object.assign(new Error("offline"), { code: "share_upload_failed" });
        return { url: "https://share.example.test/t/retried-after-delete-failure" };
      },
      attemptStore: {
        load: async () => [],
        save: async () => {},
        delete: async () => { throw new Error("delete failed"); },
      },
      createReferenceId: () => "SHR-DELFAIL1",
    });
    await coordinator.create({ threadId: 42, title: "Public title" });

    await expect(coordinator.dismiss("SHR-DELFAIL1")).resolves.toMatchObject({
      status: "failed",
      code: "share_service_failed",
    });
    await expect(coordinator.retry("SHR-DELFAIL1")).resolves.toMatchObject({
      status: "created",
      url: "https://share.example.test/t/retried-after-delete-failure",
    });
  });

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

  it("persists oversize export deduplication state before reporting", async () => {
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
      frames: [], httpStatus: null, networkCode: null,
      code: "share.snapshot_too_large",
      failureStage: "export",
      attemptReferenceId: "SHR-ABCDEF12",
      snapshotBytes: 16_777_217,
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain("private raw service response");
    expect(JSON.stringify(report.mock.calls)).not.toContain("Bearer secret");
  });

  it("persists preflight exporter failure state before reporting and reuses its reference", async () => {
    const report = vi.fn(async () => ({ accepted: true }));
    const exportSnapshot = vi.fn(async () => {
      throw new ShareSnapshotExportError("share_export_failed");
    });
    const coordinator = createSharePublishCoordinator({
      exportSnapshot,
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer secret", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish: vi.fn(),
      issueHandledShareFailureReporter: () => ({ report }),
      createReferenceId: () => "SHR-PREFLIGHT",
    });

    await expect(coordinator.preflight({ threadId: 42 })).resolves.toEqual({
      status: "failed",
      attemptReferenceId: "SHR-PREFLIGHT",
      code: "share_export_failed",
      retryable: false,
    });
    await expect(coordinator.pending({ threadId: 42 })).resolves.toEqual({
      status: "failed",
      attemptReferenceId: "SHR-PREFLIGHT",
      code: "share_export_failed",
      retryable: false,
    });
    await expect(coordinator.retry("SHR-PREFLIGHT")).resolves.toEqual({
      status: "failed",
      attemptReferenceId: "SHR-PREFLIGHT",
      code: "share_export_failed",
      retryable: false,
    });
    expect(exportSnapshot).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
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

  it("persists real exporter failure deduplication state before reporting", async () => {
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
      frames: expect.arrayContaining([expect.objectContaining({ module: "desktop/main/services/share-publish-coordinator.mjs" })]),
      httpStatus: null, networkCode: null,
      code: "share.export_failed",
      failureStage: "export",
      attemptReferenceId: "SHR-ABCDEF12",
      snapshotBytes: null,
    });
  });

  it("does not admit a handled failure unless its durable deduplication key is saved", async () => {
    let savedRecord = null;
    const report = vi.fn();
    const attemptStore = {
      load: async () => [],
      save: async (record) => {
        if (record.reportedFailures.length) throw new Error("deduplication persistence unavailable");
        savedRecord = structuredClone(record);
      },
      delete: async () => true,
    };
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer secret", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish: async () => {
        throw Object.assign(new Error("offline"), { code: "share_upload_failed", failureStage: "upload" });
      },
      issueHandledShareFailureReporter: () => ({ report }),
      attemptStore,
      createReferenceId: () => "SHR-ABCDEF12",
    });

    await expect(coordinator.create({ threadId: 42, title: "Public title" })).resolves.toMatchObject({
      code: "share_upload_failed",
    });
    expect(savedRecord?.reportedFailures).toEqual([]);
    expect(report).not.toHaveBeenCalled();
  });

  it("does not report an initial attempt-store save failure without durable deduplication state", async () => {
    const report = vi.fn();
    const publish = vi.fn();
    let saveCalls = 0;
    const coordinator = createSharePublishCoordinator({
      exportSnapshot: async () => snapshot,
      accountSession: async () => ({ ownerKey: "owner-a", authorization: "Bearer secret", generation: 1 }),
      sourceThreadIdentity: async (threadId) => `installation:test:thread:${threadId}`,
      publish,
      issueHandledShareFailureReporter: () => ({ report }),
      attemptStore: {
        load: async () => [],
        save: async () => {
          saveCalls += 1;
          if (saveCalls === 1) throw new Error("attempt persistence unavailable");
        },
        delete: async () => true,
      },
      createReferenceId: () => "SHR-ABCDEF12",
    });

    await expect(coordinator.create({ threadId: 42, title: "Public title" })).resolves.toMatchObject({
      status: "failed",
      attemptReferenceId: "SHR-ABCDEF12",
    });
    expect(publish).not.toHaveBeenCalled();
    expect(saveCalls).toBe(1);
    expect(report).not.toHaveBeenCalled();
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
