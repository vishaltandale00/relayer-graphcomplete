import { describe, expect, it, vi } from "vitest";
import {
  MAX_HARNESS_APPROVAL_RETAINED_EVENTS,
  MAX_HARNESS_APPROVAL_SESSION_GRANTS,
  MAX_HARNESS_APPROVAL_TERMINAL_TOMBSTONES,
  HarnessApprovalCoordinator,
} from "../src/approval-coordinator.js";
import type { HarnessApprovalRequestInput } from "../src/approval.js";

describe("HarnessApprovalCoordinator", () => {
  it.each([
    ["approve_once", "approved"],
    ["deny", "denied"],
  ] as const)("returns a distinct %s result and authoritative terminal event", async (choice, outcome) => {
    const coordinator = coordinatorFixture();
    const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    const waiting = channel.request(commandRequest("provider-1"));
    const request = coordinator.snapshot().pendingRequests[0]!;

    const resolution = coordinator.decide(request.requestId, { decision: choice, rationale: "Reviewed." });

    await expect(waiting).resolves.toMatchObject({ requestId: request.requestId, decision: choice, actor: "user" });
    expect(resolution).toMatchObject({ requestId: request.requestId, outcome, actor: "user", decision: choice });
    expect(coordinator.snapshot()).toMatchObject({
      latestSequence: 2,
      pendingRequests: [],
      events: [
        { sequence: 1, type: "requested" },
        { sequence: 2, type: "resolved", resolution: { outcome } },
      ],
    });
  });

  it("does not reuse approve_once authority for a later exact request", async () => {
    const coordinator = coordinatorFixture();
    const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    const first = channel.request(commandRequest("provider-1"));
    const firstRequest = coordinator.snapshot().pendingRequests[0]!;

    coordinator.decide(firstRequest.requestId, { decision: "approve_once" });
    await expect(first).resolves.toMatchObject({ decision: "approve_once", actor: "user" });

    const later = channel.request(commandRequest("provider-2"));
    const pending = coordinator.snapshot().pendingRequests;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      correlation: { interactionId: 17, completeCallId: "complete-1" },
      scopeKeys: ["command:npm test", "cwd:/workspace"],
    });
    coordinator.decide(pending[0]!.requestId, { decision: "deny" });
    await expect(later).resolves.toMatchObject({ decision: "deny", actor: "user" });
  });

  it("applies approve_always to exact matching pending and future requests in only the live session", async () => {
    const coordinator = coordinatorFixture();
    const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    const source = channel.request(commandRequest("provider-source", ["command:npm test", "cwd:/workspace"]));
    const matchingPending = channel.request(commandRequest("provider-pending", ["command:npm test"]));
    const nearPending = channel.request(commandRequest("provider-near", ["command:npm test -- --watch"]));
    const [sourceRequest, matchingRequest, nearRequest] = coordinator.snapshot().pendingRequests;

    coordinator.decide(sourceRequest!.requestId, { decision: "approve_always" });

    await expect(source).resolves.toMatchObject({ decision: "approve_always", actor: "user" });
    await expect(matchingPending).resolves.toMatchObject({
      decision: "approve_once",
      actor: "session_grant",
      sourceRequestId: sourceRequest!.requestId,
    });
    expect(coordinator.snapshot().pendingRequests.map(({ requestId }) => requestId)).toEqual([nearRequest!.requestId]);

    const matchingFuture = channel.request(commandRequest("provider-future", ["cwd:/workspace"]));
    await expect(matchingFuture).resolves.toMatchObject({
      decision: "approve_once",
      actor: "session_grant",
      sourceRequestId: sourceRequest!.requestId,
    });
    coordinator.decide(nearRequest!.requestId, { decision: "deny" });
    await expect(nearPending).resolves.toMatchObject({ decision: "deny" });

    const newLiveSession = coordinatorFixture("session-new");
    const newChannel = newLiveSession.beginCompletion({ interactionId: 18, completeCallId: "complete-2" });
    void newChannel.request(commandRequest("provider-new", ["command:npm test"]));
    expect(newLiveSession.snapshot().pendingRequests).toHaveLength(1);
  });

  it("keeps concurrent requests independently addressable and rejects stale or duplicate decisions", async () => {
    const coordinator = coordinatorFixture();
    const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    const first = channel.request(commandRequest("provider-1"));
    const second = channel.request(commandRequest("provider-2", ["network:example.com:443"]));
    const [firstRequest, secondRequest] = coordinator.snapshot().pendingRequests;

    coordinator.decide(secondRequest!.requestId, { decision: "deny" });

    await expect(second).resolves.toMatchObject({ decision: "deny" });
    expect(coordinator.snapshot().pendingRequests[0]?.requestId).toBe(firstRequest!.requestId);
    expect(() => coordinator.decide(secondRequest!.requestId, { decision: "approve_once" }))
      .toThrowError(expect.objectContaining({ code: "approval_request_resolved" }));
    expect(() => coordinator.decide("unknown", { decision: "approve_once" }))
      .toThrowError(expect.objectContaining({ code: "approval_request_not_found" }));
    coordinator.decide(firstRequest!.requestId, { decision: "approve_once" });
    await first;
  });

  it("records explicit provider expiry without deriving a Relayer timeout", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = coordinatorFixture();
      const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
      const provider = new AbortController();
      const waiting = channel.request(commandRequest("provider-1", undefined, "2026-08-20T15:05:00.000Z"), {
        signal: provider.signal,
        terminationOutcome: "expired",
        terminationRationale: "Provider request expired.",
      });
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(coordinator.snapshot().pendingRequests).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);

      provider.abort(new Error("provider expired"));

      await expect(waiting).rejects.toMatchObject({
        resolution: expect.objectContaining({ outcome: "expired", actor: "harness" }),
      });
      expect(coordinator.snapshot().events.at(-1)).toMatchObject({
        type: "resolved",
        resolution: { outcome: "expired", actor: "harness", rationale: "Provider request expired." },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records an already-aborted provider request as an explicit terminal event", async () => {
    const coordinator = coordinatorFixture();
    const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    const provider = new AbortController();
    provider.abort(new Error("Provider session ended."));

    const waiting = channel.request(commandRequest("provider-1"), { signal: provider.signal });

    await expect(waiting).rejects.toMatchObject({
      resolution: expect.objectContaining({ outcome: "aborted", actor: "harness", rationale: "Provider session ended." }),
    });
    expect(coordinator.snapshot()).toMatchObject({
      latestSequence: 2,
      pendingRequests: [],
      events: [{ type: "requested" }, { type: "resolved", resolution: { outcome: "aborted" } }],
    });
  });

  it.each([
    ["cancelled", "Harness completion was cancelled."],
    ["aborted", "Harness completion failed."],
  ] as const)("fails a waiting request closed when its completion is %s", async (outcome, rationale) => {
    const coordinator = coordinatorFixture();
    const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    const waiting = channel.request(commandRequest("provider-1"));

    coordinator.endCompletion("complete-1", outcome, rationale);

    await expect(waiting).rejects.toMatchObject({ resolution: expect.objectContaining({ outcome, actor: "host", rationale }) });
    await expect(channel.request(commandRequest("late"))).rejects.toMatchObject({ code: "approval_completion_inactive" });
  });

  it("aborts all pending requests and destroys grants when the live session closes", async () => {
    const coordinator = coordinatorFixture();
    const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    const waiting = channel.request(commandRequest("provider-1"));

    coordinator.close();

    await expect(waiting).rejects.toMatchObject({ resolution: expect.objectContaining({ outcome: "aborted", actor: "host" }) });
    expect(() => coordinator.beginCompletion({ interactionId: 18, completeCallId: "complete-2" }))
      .toThrowError(expect.objectContaining({ code: "approval_completion_inactive" }));
  });

  it("retains monotonic events, serves cursors, and never exposes provider routing IDs", async () => {
    const coordinator = coordinatorFixture();
    const channel = coordinator.beginCompletion({ interactionId: 91, completeCallId: "complete-1" });
    const waiting = channel.request(commandRequest("provider-secret"));
    const request = coordinator.snapshot().pendingRequests[0]!;
    coordinator.decide(request.requestId, { decision: "approve_once" });
    await waiting;

    const snapshot = coordinator.snapshot(1);
    expect(snapshot.latestSequence).toBe(2);
    expect(snapshot.events).toEqual([expect.objectContaining({ sequence: 2, type: "resolved" })]);
    expect(JSON.stringify(coordinator.snapshot())).not.toContain("provider-secret");
    expect(() => coordinator.snapshot(-1)).toThrowError(expect.objectContaining({ code: "invalid_approval_request" }));
  });

  it("rejects adapter attempts to inject host authority", async () => {
    const coordinator = coordinatorFixture();
    const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    const forged = { ...commandRequest("provider-1"), requestId: "forged" };

    await expect(channel.request(forged as unknown as HarnessApprovalRequestInput)).rejects.toMatchObject({
      code: "invalid_approval_request",
    });
    expect(coordinator.snapshot()).toMatchObject({ latestSequence: 0, pendingRequests: [], events: [] });
  });

  it("runtime-validates provider termination options before exposing a request", async () => {
    const coordinator = coordinatorFixture();
    const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    const provider = new AbortController();

    await expect(channel.request(commandRequest("provider-1"), {
      signal: provider.signal,
      terminationOutcome: "approved",
    } as never)).rejects.toMatchObject({ code: "invalid_approval_request" });

    provider.abort();
    expect(coordinator.snapshot()).toMatchObject({ latestSequence: 0, pendingRequests: [], events: [] });
  });

  it("fails an active completion closed when its terminal arguments are invalid at runtime", async () => {
    const coordinator = coordinatorFixture();
    const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    const waiting = channel.request(commandRequest("provider-1"));

    expect(() => coordinator.endCompletion("complete-1", "approved" as never))
      .toThrowError(expect.objectContaining({ code: "invalid_approval_request" }));

    await expect(waiting).rejects.toMatchObject({
      resolution: expect.objectContaining({ outcome: "aborted", actor: "host" }),
    });
    expect(coordinator.snapshot().events.at(-1)).toMatchObject({
      type: "resolved",
      resolution: { outcome: "aborted", actor: "host" },
    });
    await expect(channel.request(commandRequest("late"))).rejects.toMatchObject({
      code: "approval_completion_inactive",
    });
  });

  it("resets an acknowledged idle event epoch but never across a racing completion", async () => {
    const coordinator = coordinatorFixture();
    const firstChannel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    const first = firstChannel.request(commandRequest("provider-1"));
    const firstRequest = coordinator.snapshot().pendingRequests[0]!;
    coordinator.decide(firstRequest.requestId, { decision: "approve_once" });
    await first;
    coordinator.endCompletion("complete-1");

    const racingChannel = coordinator.beginCompletion({ interactionId: 18, completeCallId: "complete-2" });
    expect(coordinator.snapshot(2)).toMatchObject({ latestSequence: 2, events: [] });
    const racing = racingChannel.request(commandRequest("provider-2"));
    expect(coordinator.snapshot(2).events).toEqual([
      expect.objectContaining({ sequence: 3, type: "requested" }),
    ]);
    const racingRequest = coordinator.snapshot().pendingRequests[0]!;
    coordinator.decide(racingRequest.requestId, { decision: "deny" });
    await racing;
    coordinator.endCompletion("complete-2");

    expect(coordinator.snapshot(4)).toMatchObject({ latestSequence: 4, events: [] });
    expect(coordinator.snapshot()).toMatchObject({ latestSequence: 0, events: [] });
    const nextChannel = coordinator.beginCompletion({ interactionId: 19, completeCallId: "complete-3" });
    const next = nextChannel.request(commandRequest("provider-3"));
    expect(coordinator.snapshot().events[0]).toMatchObject({ sequence: 1, type: "requested" });
    coordinator.endCompletion("complete-3");
    await expect(next).rejects.toMatchObject({ resolution: { outcome: "aborted" } });
  });

  it("bounds terminal tombstones and session grants without widening authority", async () => {
    const coordinator = coordinatorFixture();
    const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    let firstRequestId = "";
    for (let index = 0; index <= MAX_HARNESS_APPROVAL_TERMINAL_TOMBSTONES; index += 1) {
      const waiting = channel.request(commandRequest(`provider-terminal-${index}`, [`terminal:${index}`]));
      const request = coordinator.snapshot().pendingRequests.at(-1)!;
      if (index === 0) firstRequestId = request.requestId;
      coordinator.decide(request.requestId, { decision: "approve_once" });
      await waiting;
    }
    expect(() => coordinator.decide(firstRequestId, { decision: "approve_once" }))
      .toThrowError(expect.objectContaining({ code: "approval_request_not_found" }));

    for (let index = 0; index <= MAX_HARNESS_APPROVAL_SESSION_GRANTS; index += 1) {
      const waiting = channel.request(commandRequest(`provider-grant-${index}`, [`grant:${index}`]));
      const request = coordinator.snapshot().pendingRequests.at(-1)!;
      coordinator.decide(request.requestId, { decision: "approve_always" });
      await waiting;
    }
    const noLongerGranted = channel.request(commandRequest("provider-old-grant", ["grant:0"]));
    const pending = coordinator.snapshot().pendingRequests.at(-1)!;
    expect(pending.scopeKeys).toEqual(["grant:0"]);
    coordinator.decide(pending.requestId, { decision: "deny" });
    await expect(noLongerGranted).resolves.toMatchObject({ decision: "deny", actor: "user" });
  });

  it("fails closed instead of dropping an unacknowledged event backlog", async () => {
    const coordinator = coordinatorFixture();
    const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    for (let index = 0; index < MAX_HARNESS_APPROVAL_RETAINED_EVENTS / 2; index += 1) {
      const waiting = channel.request(commandRequest(`provider-${index}`, [`request:${index}`]));
      const request = coordinator.snapshot().pendingRequests.at(-1)!;
      coordinator.decide(request.requestId, { decision: "approve_once" });
      await waiting;
    }
    expect(coordinator.snapshot().events).toHaveLength(MAX_HARNESS_APPROVAL_RETAINED_EVENTS);
    await expect(channel.request(commandRequest("provider-overflow", ["request:overflow"])))
      .rejects.toMatchObject({ code: "approval_event_backlog_full" });

    coordinator.endCompletion("complete-1");
    expect(coordinator.snapshot(MAX_HARNESS_APPROVAL_RETAINED_EVENTS)).toMatchObject({
      latestSequence: MAX_HARNESS_APPROVAL_RETAINED_EVENTS,
      events: [],
    });
    expect(coordinator.snapshot()).toMatchObject({ latestSequence: 0, events: [] });
  });
});

function coordinatorFixture(harnessSessionId = "session-1"): HarnessApprovalCoordinator {
  let request = 0;
  let timestamp = 0;
  return new HarnessApprovalCoordinator({
    threadId: 7,
    harnessSessionId,
    requestId: () => `request-${++request}`,
    now: () => new Date(Date.parse("2026-08-20T15:00:00.000Z") + timestamp++).toISOString(),
  });
}

function commandRequest(
  providerItemId: string,
  scopeKeys: readonly string[] = ["command:npm test", "cwd:/workspace"],
  expiresAt?: string,
): HarnessApprovalRequestInput {
  return {
    providerItemId,
    title: "Run tests",
    reason: "Verify the requested change.",
    action: { kind: "command", command: "npm test", workingDirectory: "/workspace" },
    scopeKeys,
    scopeDescription: "Run npm test in /workspace for this live session.",
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}
