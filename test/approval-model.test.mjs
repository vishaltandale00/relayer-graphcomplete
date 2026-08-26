import { describe, expect, it } from "vitest";
import {
  approvalActionPresentation,
  approvalDockMode,
  approvalQueueKeyIntent,
  approvalQueueTarget,
  approvalResolutionLabel,
  pendingApprovalsForThread,
  resolvedApprovalHistoryForThread,
  selectedPendingApproval,
  shouldRevealApprovalHistory,
  validApprovalDecision,
  validApprovalRequest,
} from "../desktop/renderer/src/approval-model.js";

function receipt({
  requestId = "request-1",
  threadId = 10,
  interactionId = 20,
  createdAt = "2026-08-20T12:00:00Z",
  action = { kind: "command", command: "npm test", workingDirectory: "/workspace" },
  resolution,
} = {}) {
  return {
    request: {
      requestId,
      correlation: {
        threadId,
        interactionId,
        completeCallId: "complete-1",
        harnessSessionId: "session-1",
      },
      title: `Approval ${requestId}`,
      reason: "The harness needs to run a command.",
      action,
      scopeKeys: ["command:npm test", "cwd:/workspace"],
      scopeDescription: "Run npm test in /workspace",
      createdAt,
    },
    ...(resolution ? { resolution: { requestId, resolvedAt: createdAt, ...resolution } } : {}),
  };
}

function state(approvals, completionStatus = "waiting_for_approval") {
  return {
    approvals,
    interactions: [{ id: 20, threadId: 10, completionStatus }],
  };
}

describe("desktop approval model", () => {
  it("queues only unique normalized requests correlated to a waiting interaction", () => {
    const later = receipt({ requestId: "later", createdAt: "2026-08-20T12:01:00Z" });
    const first = receipt({ requestId: "first" });
    const wrongThread = receipt({ requestId: "wrong-thread", threadId: 11 });
    const resolved = receipt({ requestId: "resolved", resolution: { outcome: "denied" } });
    const malformed = receipt({ requestId: "malformed", action: { kind: "command", command: "", workingDirectory: "/workspace" } });

    expect(pendingApprovalsForThread(
      state([later, wrongThread, resolved, malformed, first]),
      { id: 10 },
    ).map(({ request }) => request.requestId)).toEqual(["first", "later"]);
    expect(pendingApprovalsForThread(state([first], "running"), { id: 10 })).toEqual([]);
  });

  it("fails closed for duplicate request IDs and unsupported action shapes", () => {
    const duplicate = receipt({ requestId: "duplicate" });
    expect(pendingApprovalsForThread(state([duplicate, duplicate]), { id: 10 })).toEqual([]);
    expect(validApprovalRequest(receipt({ action: { kind: "shell", command: "npm test" } }))).toBe(false);
    expect(validApprovalRequest(receipt({ action: { kind: "file_change", action: "Patch", workingDirectory: "/workspace", affectedFiles: [] } }))).toBe(false);
    expect(validApprovalRequest(receipt({ action: { kind: "network", action: "Fetch", networkDestination: "" } }))).toBe(false);
  });

  it("selects and wraps a request queue deterministically", () => {
    const pending = [receipt({ requestId: "a" }), receipt({ requestId: "b" }), receipt({ requestId: "c" })];
    expect(selectedPendingApproval(pending, "b")?.request.requestId).toBe("b");
    expect(selectedPendingApproval(pending, "stale")?.request.requestId).toBe("a");
    expect(approvalQueueTarget(pending, "a", -1)).toBe("c");
    expect(approvalQueueTarget(pending, "c", 1)).toBe("a");
    expect(approvalQueueTarget(pending, "b", "first")).toBe("a");
    expect(approvalQueueTarget(pending, "b", "last")).toBe("c");
  });

  it("maps queue keyboard commands only when the dock itself owns focus", () => {
    expect(approvalQueueKeyIntent({ key: "ArrowLeft" }, true)).toBe(-1);
    expect(approvalQueueKeyIntent({ key: "ArrowRight" }, true)).toBe(1);
    expect(approvalQueueKeyIntent({ key: "Home" }, true)).toBe("first");
    expect(approvalQueueKeyIntent({ key: "End" }, true)).toBe("last");
    expect(approvalQueueKeyIntent({ key: "ArrowRight" }, false)).toBeNull();
    expect(approvalQueueKeyIntent({ key: "ArrowRight", metaKey: true }, true)).toBeNull();
  });

  it("presents exact normalized actions and terminal receipts", () => {
    expect(approvalActionPresentation({ kind: "command", command: "npm test", workingDirectory: "/workspace" })).toEqual({
      kind: "command",
      label: "Command",
      value: "npm test",
      workingDirectory: "/workspace",
      affectedFiles: [],
    });
    expect(approvalActionPresentation({
      kind: "file_change",
      action: "Apply patch",
      workingDirectory: "/workspace",
      affectedFiles: ["src/a.js"],
    }).affectedFiles).toEqual(["src/a.js"]);

    const always = receipt({ requestId: "always", resolution: { outcome: "approved", decision: "approve_always" } });
    const denied = receipt({ requestId: "denied", resolution: { outcome: "denied" } });
    expect(approvalResolutionLabel(always)).toBe("Approved for this session");
    expect(approvalResolutionLabel(denied)).toBe("Denied");
    expect(resolvedApprovalHistoryForThread(state([denied, always]), { id: 10 })).toHaveLength(2);
    expect(approvalDockMode([], resolvedApprovalHistoryForThread(state([always]), { id: 10 })))
      .toBe("history");
    expect(approvalDockMode([], [])).toBe("hidden");
    expect(validApprovalDecision("approve_once")).toBe(true);
    expect(validApprovalDecision("approve_always")).toBe(true);
    expect(validApprovalDecision("deny")).toBe(true);
    expect(validApprovalDecision("allow")).toBe(false);
  });

  it("reveals approval history on entry and thread changes without overriding a same-thread collapse", () => {
    expect(shouldRevealApprovalHistory({
      dockMode: "history", wasHidden: true, wasHistoryOnly: false, threadChanged: false,
    })).toBe(true);
    expect(shouldRevealApprovalHistory({
      dockMode: "history", wasHidden: false, wasHistoryOnly: false, threadChanged: false,
    })).toBe(true);
    expect(shouldRevealApprovalHistory({
      dockMode: "history", wasHidden: false, wasHistoryOnly: true, threadChanged: true,
    })).toBe(true);
    expect(shouldRevealApprovalHistory({
      dockMode: "history", wasHidden: false, wasHistoryOnly: true, threadChanged: false,
    })).toBe(false);
    expect(shouldRevealApprovalHistory({
      dockMode: "pending", wasHidden: true, wasHistoryOnly: false, threadChanged: true,
    })).toBe(false);
  });
});
