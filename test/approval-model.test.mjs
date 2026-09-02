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
  it("queues, validates, selects, presents, and reveals approvals through one deterministic dock contract", () => {
    const later = receipt({ requestId: "later", createdAt: "2026-08-20T12:01:00Z" });
    const first = receipt({ requestId: "first" });
    const wrongThread = receipt({ requestId: "wrong-thread", threadId: 11 });
    const resolved = receipt({ requestId: "resolved", resolution: { outcome: "denied" } });
    const malformed = receipt({ requestId: "malformed", action: { kind: "command", command: "", workingDirectory: "/workspace" } });

    expect(pendingApprovalsForThread(
      state([later, wrongThread, resolved, malformed, first]),
      { id: 10 },
    ).map(({ request }) => request.requestId), "unique normalized requests ordered by creation").toEqual(["first", "later"]);
    expect(pendingApprovalsForThread(state([first], "running"), { id: 10 }), "no queue outside a waiting interaction").toEqual([]);

    const duplicate = receipt({ requestId: "duplicate" });
    expect(pendingApprovalsForThread(state([duplicate, duplicate]), { id: 10 }), "duplicate request IDs fail closed").toEqual([]);
    expect(validApprovalRequest(receipt({ action: { kind: "shell", command: "npm test" } })), "unsupported action kind").toBe(false);
    expect(validApprovalRequest(receipt({ action: { kind: "file_change", action: "Patch", workingDirectory: "/workspace", affectedFiles: [] } })), "file change without affected files").toBe(false);
    expect(validApprovalRequest(receipt({ action: { kind: "network", action: "Fetch", networkDestination: "" } })), "network without destination").toBe(false);

    const pending = [receipt({ requestId: "a" }), receipt({ requestId: "b" }), receipt({ requestId: "c" })];
    expect(selectedPendingApproval(pending, "b")?.request.requestId, "explicit selection").toBe("b");
    expect(selectedPendingApproval(pending, "stale")?.request.requestId, "stale selection falls back to the queue head").toBe("a");
    expect(approvalQueueTarget(pending, "a", -1), "queue wraps backwards").toBe("c");
    expect(approvalQueueTarget(pending, "c", 1), "queue wraps forwards").toBe("a");
    expect(approvalQueueTarget(pending, "b", "first"), "queue first target").toBe("a");
    expect(approvalQueueTarget(pending, "b", "last"), "queue last target").toBe("c");

    expect(approvalQueueKeyIntent({ key: "ArrowLeft" }, true), "left arrow maps in focus").toBe(-1);
    expect(approvalQueueKeyIntent({ key: "ArrowRight" }, true), "right arrow maps in focus").toBe(1);
    expect(approvalQueueKeyIntent({ key: "Home" }, true), "home maps in focus").toBe("first");
    expect(approvalQueueKeyIntent({ key: "End" }, true), "end maps in focus").toBe("last");
    expect(approvalQueueKeyIntent({ key: "ArrowRight" }, false), "keys ignored outside dock focus").toBeNull();
    expect(approvalQueueKeyIntent({ key: "ArrowRight", metaKey: true }, true), "modified keys ignored").toBeNull();

    expect(approvalActionPresentation({ kind: "command", command: "npm test", workingDirectory: "/workspace" }), "command presentation").toEqual({
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
    }).affectedFiles, "file change presentation keeps affected files").toEqual(["src/a.js"]);

    const always = receipt({ requestId: "always", resolution: { outcome: "approved", decision: "approve_always" } });
    const denied = receipt({ requestId: "denied", resolution: { outcome: "denied" } });
    expect(approvalResolutionLabel(always), "approve_always label").toBe("Approved for this session");
    expect(approvalResolutionLabel(denied), "denied label").toBe("Denied");
    expect(resolvedApprovalHistoryForThread(state([denied, always]), { id: 10 }), "resolved history for the thread").toHaveLength(2);
    expect(approvalDockMode([], resolvedApprovalHistoryForThread(state([always]), { id: 10 })), "history dock with only resolved receipts").toBe("history");
    expect(approvalDockMode([], []), "hidden dock without receipts").toBe("hidden");
    expect(validApprovalDecision("approve_once"), "approve_once decision").toBe(true);
    expect(validApprovalDecision("approve_always"), "approve_always decision").toBe(true);
    expect(validApprovalDecision("deny"), "deny decision").toBe(true);
    expect(validApprovalDecision("allow"), "unknown decision rejected").toBe(false);

    expect(shouldRevealApprovalHistory({
      dockMode: "history", wasHidden: true, wasHistoryOnly: false, threadChanged: false,
    }), "reveal when the dock becomes history from hidden").toBe(true);
    expect(shouldRevealApprovalHistory({
      dockMode: "history", wasHidden: false, wasHistoryOnly: false, threadChanged: false,
    }), "reveal when pending receipts just resolved").toBe(true);
    expect(shouldRevealApprovalHistory({
      dockMode: "history", wasHidden: false, wasHistoryOnly: true, threadChanged: true,
    }), "reveal on thread change").toBe(true);
    expect(shouldRevealApprovalHistory({
      dockMode: "history", wasHidden: false, wasHistoryOnly: true, threadChanged: false,
    }), "same-thread collapse is not overridden").toBe(false);
    expect(shouldRevealApprovalHistory({
      dockMode: "pending", wasHidden: true, wasHistoryOnly: false, threadChanged: true,
    }), "pending dock never forces history reveal").toBe(false);
  });
});
