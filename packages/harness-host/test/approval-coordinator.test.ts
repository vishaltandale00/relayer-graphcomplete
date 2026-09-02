import { describe, expect, it, vi } from "vitest";
import {
  MAX_HARNESS_APPROVAL_RETAINED_EVENTS,
  MAX_HARNESS_APPROVAL_SESSION_GRANTS,
  MAX_HARNESS_APPROVAL_TERMINAL_TOMBSTONES,
  HarnessApprovalCoordinator,
} from "../src/approval-coordinator.js";
import type { HarnessApprovalRequestInput } from "../src/approval.js";

describe("HarnessApprovalCoordinator", () => {
  it("resolves each user decision into an authoritative terminal event, never reuses once-grants, and keeps concurrent requests individually addressable", async () => {
    const coordinator = coordinatorFixture();
    const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });

    const forged = { ...commandRequest("provider-1"), requestId: "forged" };
    await expect(
      channel.request(forged as unknown as HarnessApprovalRequestInput),
      "adapters cannot inject host request identity",
    ).rejects.toMatchObject({ code: "invalid_approval_request" });
    expect(coordinator.snapshot(), "a forged request leaves no coordinator state").toMatchObject({
      latestSequence: 0, pendingRequests: [], events: [],
    });

    const first = channel.request(commandRequest("provider-secret"));
    const firstRequest = coordinator.snapshot().pendingRequests[0]!;
    const firstResolution = coordinator.decide(firstRequest.requestId, { decision: "approve_once", rationale: "Reviewed." });

    await expect(first, "approve_once resolves the waiting adapter").resolves.toMatchObject({
      requestId: firstRequest.requestId, decision: "approve_once", actor: "user",
    });
    expect(firstResolution, "approve_once produces the approved terminal outcome").toMatchObject({
      requestId: firstRequest.requestId, outcome: "approved", actor: "user", decision: "approve_once",
    });
    expect(coordinator.snapshot(), "the decision appends the authoritative resolved event").toMatchObject({
      latestSequence: 2,
      pendingRequests: [],
      events: [
        { sequence: 1, type: "requested" },
        { sequence: 2, type: "resolved", resolution: { outcome: "approved" } },
      ],
    });

    const cursor = coordinator.snapshot(1);
    expect(cursor.latestSequence, "cursors keep the monotonic latest sequence").toBe(2);
    expect(cursor.events, "cursors serve only events after the acknowledged sequence").toEqual([
      expect.objectContaining({ sequence: 2, type: "resolved" }),
    ]);
    expect(JSON.stringify(coordinator.snapshot()), "snapshots never expose provider routing IDs").not.toContain("provider-secret");
    expect(() => coordinator.snapshot(-1), "invalid cursors are rejected").toThrowError(expect.objectContaining({ code: "invalid_approval_request" }));

    const later = channel.request(commandRequest("provider-2"));
    const pending = coordinator.snapshot().pendingRequests;
    expect(pending, "approve_once grants no reusable authority for a later exact request").toHaveLength(1);
    expect(pending[0], "the later request is correlated and scoped exactly").toMatchObject({
      correlation: { interactionId: 17, completeCallId: "complete-1" },
      scopeKeys: ["command:npm test", "cwd:/workspace"],
    });
    const laterResolution = coordinator.decide(pending[0]!.requestId, { decision: "deny" });
    expect(laterResolution, "deny produces the denied terminal outcome").toMatchObject({ outcome: "denied", actor: "user", decision: "deny" });
    await expect(later, "deny resolves the waiting adapter").resolves.toMatchObject({ decision: "deny", actor: "user" });

    const third = channel.request(commandRequest("provider-3"));
    const fourth = channel.request(commandRequest("provider-4", ["network:example.com:443"]));
    const [thirdRequest, fourthRequest] = coordinator.snapshot().pendingRequests;

    coordinator.decide(fourthRequest!.requestId, { decision: "deny" });
    await expect(fourth, "a decided sibling resolves independently").resolves.toMatchObject({ decision: "deny" });
    expect(coordinator.snapshot().pendingRequests[0]?.requestId, "the other concurrent request stays independently addressable").toBe(thirdRequest!.requestId);
    expect(() => coordinator.decide(fourthRequest!.requestId, { decision: "approve_once" }), "stale decisions are rejected")
      .toThrowError(expect.objectContaining({ code: "approval_request_resolved" }));
    expect(() => coordinator.decide("unknown", { decision: "approve_once" }), "unknown request IDs are rejected")
      .toThrowError(expect.objectContaining({ code: "approval_request_not_found" }));
    coordinator.decide(thirdRequest!.requestId, { decision: "approve_once" });
    await expect(third, "the remaining request resolves on its own decision").resolves.toMatchObject({ decision: "approve_once" });
  });

  it("applies approve_always to exact matches in only the live session and evicts the oldest grant at the cap", async () => {
    const coordinator = coordinatorFixture();
    const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    const source = channel.request(commandRequest("provider-source", ["command:npm test", "cwd:/workspace"]));
    const matchingPending = channel.request(commandRequest("provider-pending", ["command:npm test"]));
    const nearPending = channel.request(commandRequest("provider-near", ["command:npm test -- --watch"]));
    const [sourceRequest, matchingRequest, nearRequest] = coordinator.snapshot().pendingRequests;

    coordinator.decide(sourceRequest!.requestId, { decision: "approve_always" });

    await expect(source, "approve_always resolves the source request as a user decision").resolves.toMatchObject({
      decision: "approve_always", actor: "user",
    });
    await expect(matchingPending, "an exact matching pending request is auto-approved by the session grant").resolves.toMatchObject({
      decision: "approve_once",
      actor: "session_grant",
      sourceRequestId: sourceRequest!.requestId,
    });
    expect(coordinator.snapshot().pendingRequests.map(({ requestId }) => requestId), "a near-miss request stays pending").toEqual([nearRequest!.requestId]);

    const matchingFuture = channel.request(commandRequest("provider-future", ["cwd:/workspace"]));
    await expect(matchingFuture, "a future exact match is auto-approved by the session grant").resolves.toMatchObject({
      decision: "approve_once",
      actor: "session_grant",
      sourceRequestId: sourceRequest!.requestId,
    });
    coordinator.decide(nearRequest!.requestId, { decision: "deny" });
    await expect(nearPending, "the near-miss resolves only on its own decision").resolves.toMatchObject({ decision: "deny" });

    const newLiveSession = coordinatorFixture("session-new");
    const newChannel = newLiveSession.beginCompletion({ interactionId: 18, completeCallId: "complete-2" });
    void newChannel.request(commandRequest("provider-new", ["command:npm test"]));
    expect(newLiveSession.snapshot().pendingRequests, "grants never apply in another live session").toHaveLength(1);

    for (let index = 0; index <= MAX_HARNESS_APPROVAL_SESSION_GRANTS; index += 1) {
      const waiting = channel.request(commandRequest(`provider-grant-${index}`, [`grant:${index}`]));
      const request = coordinator.snapshot().pendingRequests.at(-1)!;
      coordinator.decide(request.requestId, { decision: "approve_always" });
      await waiting;
    }
    const noLongerGranted = channel.request(commandRequest("provider-old-grant", ["grant:0"]));
    const pending = coordinator.snapshot().pendingRequests.at(-1)!;
    expect(pending.scopeKeys, "the evicted oldest grant no longer auto-approves its exact scope").toEqual(["grant:0"]);
    coordinator.decide(pending.requestId, { decision: "deny" });
    await expect(noLongerGranted, "grant eviction never widens authority").resolves.toMatchObject({ decision: "deny", actor: "user" });
  }, 10_000);

  it("records explicit provider and host termination without deriving Relayer timeouts", async () => {
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
      expect(coordinator.snapshot().pendingRequests, "provider expiry metadata never starts a Relayer timer").toHaveLength(1);
      expect(vi.getTimerCount(), "no timer is scheduled for provider-supplied expiry").toBe(0);

      provider.abort(new Error("provider expired"));

      await expect(waiting, "the provider abort settles the waiting request").rejects.toMatchObject({
        resolution: expect.objectContaining({ outcome: "expired", actor: "harness" }),
      });
      expect(coordinator.snapshot().events.at(-1), "the expiry is recorded as an explicit terminal event").toMatchObject({
        type: "resolved",
        resolution: { outcome: "expired", actor: "harness", rationale: "Provider request expired." },
      });
    } finally {
      vi.useRealTimers();
    }

    {
      const coordinator = coordinatorFixture();
      const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
      const provider = new AbortController();
      provider.abort(new Error("Provider session ended."));

      const waiting = channel.request(commandRequest("provider-1"), { signal: provider.signal });

      await expect(waiting, "an already-aborted provider request rejects immediately").rejects.toMatchObject({
        resolution: expect.objectContaining({ outcome: "aborted", actor: "harness", rationale: "Provider session ended." }),
      });
      expect(coordinator.snapshot(), "an already-aborted request is recorded as an explicit terminal event").toMatchObject({
        latestSequence: 2,
        pendingRequests: [],
        events: [{ type: "requested" }, { type: "resolved", resolution: { outcome: "aborted" } }],
      });
    }

    {
      const coordinator = coordinatorFixture();
      const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
      const provider = new AbortController();

      await expect(channel.request(commandRequest("provider-1"), {
        signal: provider.signal,
        terminationOutcome: "approved",
      } as never), "termination options are runtime-validated before exposing a request").rejects.toMatchObject({ code: "invalid_approval_request" });

      provider.abort();
      expect(coordinator.snapshot(), "an invalid termination request leaves no coordinator state").toMatchObject({
        latestSequence: 0, pendingRequests: [], events: [],
      });
    }

    const closures = [
      ["cancelled", "Harness completion was cancelled."],
      ["aborted", "Harness completion failed."],
    ] as const;
    for (const [outcome, rationale] of closures) {
      const coordinator = coordinatorFixture();
      const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
      const waiting = channel.request(commandRequest("provider-1"));

      coordinator.endCompletion("complete-1", outcome, rationale);

      await expect(waiting, `a ${outcome} completion fails every waiting request`).rejects.toMatchObject({
        resolution: expect.objectContaining({ outcome, actor: "host", rationale }),
      });
      await expect(channel.request(commandRequest("late")), `a ${outcome} completion is no longer active`).rejects.toMatchObject({
        code: "approval_completion_inactive",
      });
    }

    {
      const coordinator = coordinatorFixture();
      const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
      const waiting = channel.request(commandRequest("provider-1"));

      expect(() => coordinator.endCompletion("complete-1", "approved" as never), "invalid terminal arguments are rejected at runtime")
        .toThrowError(expect.objectContaining({ code: "invalid_approval_request" }));

      await expect(waiting, "an invalid closure still fails the waiting request closed").rejects.toMatchObject({
        resolution: expect.objectContaining({ outcome: "aborted", actor: "host" }),
      });
      expect(coordinator.snapshot().events.at(-1), "the failed closure records an aborted terminal event").toMatchObject({
        type: "resolved",
        resolution: { outcome: "aborted", actor: "host" },
      });
      await expect(channel.request(commandRequest("late")), "the failed closure leaves the completion inactive").rejects.toMatchObject({
        code: "approval_completion_inactive",
      });
    }

    {
      const coordinator = coordinatorFixture();
      const channel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
      const waiting = channel.request(commandRequest("provider-1"));

      coordinator.close();

      await expect(waiting, "closing the live session aborts every pending request").rejects.toMatchObject({
        resolution: expect.objectContaining({ outcome: "aborted", actor: "host" }),
      });
      expect(() => coordinator.beginCompletion({ interactionId: 18, completeCallId: "complete-2" }), "a closed session grants no further completions")
        .toThrowError(expect.objectContaining({ code: "approval_completion_inactive" }));
    }
  });

  it("bounds tombstones, retained events, and epochs without widening authority, dropping backlog, or racing completions", async () => {
    const bounded = coordinatorFixture();
    const boundedChannel = bounded.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    let firstRequestId = "";
    for (let index = 0; index <= MAX_HARNESS_APPROVAL_TERMINAL_TOMBSTONES; index += 1) {
      const waiting = boundedChannel.request(commandRequest(`provider-terminal-${index}`, [`terminal:${index}`]));
      const request = bounded.snapshot().pendingRequests.at(-1)!;
      if (index === 0) firstRequestId = request.requestId;
      bounded.decide(request.requestId, { decision: "approve_once" });
      await waiting;
    }
    expect(() => bounded.decide(firstRequestId, { decision: "approve_once" }), "an evicted tombstone never becomes decidable again")
      .toThrowError(expect.objectContaining({ code: "approval_request_not_found" }));

    const coordinator = coordinatorFixture();
    const firstChannel = coordinator.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    const first = firstChannel.request(commandRequest("provider-epoch"));
    const firstRequest = coordinator.snapshot().pendingRequests[0]!;
    coordinator.decide(firstRequest.requestId, { decision: "approve_once" });
    await first;
    coordinator.endCompletion("complete-1");

    const racingChannel = coordinator.beginCompletion({ interactionId: 18, completeCallId: "complete-2" });
    expect(coordinator.snapshot(2), "an acknowledged idle epoch resets its retained events").toMatchObject({ latestSequence: 2, events: [] });
    const racing = racingChannel.request(commandRequest("provider-2"));
    expect(coordinator.snapshot(2).events, "a racing completion is never reset away").toEqual([
      expect.objectContaining({ sequence: 3, type: "requested" }),
    ]);
    const racingRequest = coordinator.snapshot().pendingRequests[0]!;
    coordinator.decide(racingRequest.requestId, { decision: "deny" });
    await racing;
    coordinator.endCompletion("complete-2");

    expect(coordinator.snapshot(4), "the second acknowledged epoch resets again").toMatchObject({ latestSequence: 4, events: [] });
    expect(coordinator.snapshot(), "a full snapshot after an acknowledged epoch starts clean").toMatchObject({ latestSequence: 0, events: [] });
    const nextChannel = coordinator.beginCompletion({ interactionId: 19, completeCallId: "complete-3" });
    const next = nextChannel.request(commandRequest("provider-3"));
    expect(coordinator.snapshot().events[0], "the new epoch numbers events from one").toMatchObject({ sequence: 1, type: "requested" });
    coordinator.endCompletion("complete-3");
    await expect(next, "closing the epoch still aborts its waiting request").rejects.toMatchObject({ resolution: { outcome: "aborted" } });

    const backlogged = coordinatorFixture();
    const backlogChannel = backlogged.beginCompletion({ interactionId: 17, completeCallId: "complete-1" });
    for (let index = 0; index < MAX_HARNESS_APPROVAL_RETAINED_EVENTS / 2; index += 1) {
      const waiting = backlogChannel.request(commandRequest(`provider-${index}`, [`request:${index}`]));
      const request = backlogged.snapshot().pendingRequests.at(-1)!;
      backlogged.decide(request.requestId, { decision: "approve_once" });
      await waiting;
    }
    expect(backlogged.snapshot().events, "retention is bounded to the advertised maximum").toHaveLength(MAX_HARNESS_APPROVAL_RETAINED_EVENTS);
    await expect(backlogChannel.request(commandRequest("provider-overflow", ["request:overflow"])), "an unacknowledged backlog fails closed instead of dropping events")
      .rejects.toMatchObject({ code: "approval_event_backlog_full" });

    backlogged.endCompletion("complete-1");
    expect(backlogged.snapshot(MAX_HARNESS_APPROVAL_RETAINED_EVENTS), "acknowledging to the backlog edge exposes nothing new").toMatchObject({
      latestSequence: MAX_HARNESS_APPROVAL_RETAINED_EVENTS,
      events: [],
    });
    expect(backlogged.snapshot(), "acknowledging the backlog resets the epoch").toMatchObject({ latestSequence: 0, events: [] });
  }, 15_000);
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
