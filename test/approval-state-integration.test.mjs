import { beforeEach, describe, expect, it, vi } from "vitest";

let requestImplementation;
let rendered;
let renderFailure;

function approvalReceipt({ requestId = "request-1", threadId = 10, interactionId = 20, resolution } = {}) {
  return {
    request: {
      requestId,
      correlation: {
        threadId,
        interactionId,
        completeCallId: "complete-1",
        harnessSessionId: "session-1",
      },
      title: "Run tests",
      reason: "The harness needs to run the test command.",
      action: { kind: "command", command: "npm test", workingDirectory: "/workspace" },
      scopeKeys: ["command:npm test", "cwd:/workspace"],
      scopeDescription: "Run npm test in /workspace",
      createdAt: "2026-08-20T12:00:00Z",
    },
    ...(resolution ? { resolution } : {}),
  };
}

function productState({ approval, completionStatus = "waiting_for_approval" } = {}) {
  return {
    projects: [],
    threads: [{ id: 10, title: "Approval thread", active: true }],
    interactions: [{ id: 20, threadId: 10, completionStatus }],
    actionInvocations: [],
    approvals: approval ? [approval] : [],
    capabilities: { canCompose: true },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function loadModules() {
  vi.resetModules();
  rendered = 0;
  renderFailure = null;
  Object.assign(globalThis, {
    document: { querySelector: () => null },
    location: new URL("http://127.0.0.1:43123/?threadId=10"),
    window: { relayerDesktop: undefined, relayerEvalReview: undefined },
  });
  globalThis.history = { replaceState: vi.fn() };
  vi.doMock("../desktop/renderer/src/api.js", () => ({
    request: (...args) => requestImplementation(...args),
  }));
  vi.doMock("../desktop/renderer/src/graph.js", () => ({
    renderThread: () => {
      rendered += 1;
      if (renderFailure) throw renderFailure;
    },
  }));
  vi.doMock("../desktop/renderer/src/navigation.js", () => ({
    renderScopeMenu: vi.fn(),
    renderSidebar: vi.fn(),
    setMainView: vi.fn(),
  }));
  const state = await import("../desktop/renderer/src/state.js");
  const threads = await import("../desktop/renderer/src/threads.js");
  return { ...state, ...threads };
}

describe("desktop approval state integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts one exact decision per receipt and settles state only for the thread that decided", async () => {
    const pending = approvalReceipt();
    const initial = productState({ approval: pending });
    const resolved = productState({
      approval: approvalReceipt({ resolution: { outcome: "approved", decision: "approve_once", resolvedAt: "2026-08-20T12:01:00Z" } }),
      completionStatus: "running",
    });
    requestImplementation = vi.fn(async (path) => {
      if (path.startsWith("/api/state?threadId=10")) {
        return requestImplementation.mock.calls.filter(([candidate]) => candidate.startsWith("/api/state?threadId=10")).length === 1
          ? initial
          : resolved;
      }
      if (path === "/api/threads/10/interactions/20/approvals/request-1/decision") {
        return { approval: resolved.approvals[0] };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    await controller.refreshState(10);
    expect(controller.appState.approvals, "receipts loaded from state").toEqual([pending]);

    await controller.decideApproval("request-1", "approve_once");

    expect(requestImplementation, "exact decision route and body").toHaveBeenCalledWith(
      "/api/threads/10/interactions/20/approvals/request-1/decision",
      { method: "POST", body: JSON.stringify({ decision: "approve_once" }) },
    );
    expect(controller.appState.approvals[0].resolution?.outcome, "resolution applied to state").toBe("approved");
    expect(controller.appState.pendingApprovalDecisions, "decision in-flight set cleared").toEqual([]);

    const post = deferred();
    const guardedPending = approvalReceipt();
    requestImplementation = vi.fn(async (path) => {
      if (path.endsWith("/decision")) return post.promise;
      if (path.startsWith("/api/state?threadId=10")) return productState({ completionStatus: "running" });
      throw new Error(`Unexpected request: ${path}`);
    });
    const guardedController = await loadModules();
    Object.assign(guardedController.appState, productState({ approval: guardedPending }));
    guardedController.viewState.currentThreadId = 10;

    const firstDecision = guardedController.decideApproval("request-1", "deny");
    await vi.waitFor(() => expect(guardedController.appState.pendingApprovalDecisions, "in-flight decision tracked").toEqual(["request-1"]));
    await guardedController.decideApproval("request-1", "deny");
    expect(
      requestImplementation.mock.calls.filter(([path]) => path.endsWith("/decision")),
      "duplicate decision suppressed while the first is in flight",
    ).toHaveLength(1);
    post.resolve({ approval: guardedPending });
    await firstDecision;

    const redrawPending = approvalReceipt();
    requestImplementation = vi.fn(async (path) => {
      if (path.endsWith("/decision")) return { approval: resolved.approvals[0] };
      if (path.startsWith("/api/state?threadId=10")) return resolved;
      throw new Error(`Unexpected request: ${path}`);
    });
    const redrawController = await loadModules();
    Object.assign(redrawController.appState, productState({ approval: redrawPending }));
    redrawController.viewState.currentThreadId = 10;
    renderFailure = new Error("The vendored Lucide renderer must load before Relayer icons are created.");

    await expect(redrawController.decideApproval("request-1", "approve_once"), "decision settles even when presentation cannot redraw").resolves.toBeUndefined();
    expect(requestImplementation.mock.calls.filter(([path]) => path.endsWith("/decision")), "decision posted exactly once despite redraw failure").toHaveLength(1);
    expect(redrawController.appState.approvals[0].resolution?.outcome, "resolution applied despite redraw failure").toBe("approved");
    expect(redrawController.appState.pendingApprovalDecisions, "in-flight set cleared despite redraw failure").toEqual([]);

    const stalePost = deferred();
    const stalePending = approvalReceipt();
    requestImplementation = vi.fn(async (path) => {
      if (path.endsWith("/decision")) return stalePost.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const staleController = await loadModules();
    Object.assign(staleController.appState, productState({ approval: stalePending }));
    staleController.appState.threads.push({ id: 11, title: "Other thread" });
    staleController.viewState.currentThreadId = 10;

    const staleDecision = staleController.decideApproval("request-1", "approve_always");
    staleController.viewState.currentThreadId = 11;
    stalePost.resolve({ approval: stalePending });
    await staleDecision;

    expect(
      requestImplementation.mock.calls.filter(([path]) => path.startsWith("/api/state")),
      "no state refresh after a stale decision resolves",
    ).toEqual([]);
    expect(staleController.viewState.currentThreadId, "newly selected thread untouched by the stale decision").toBe(11);

    requestImplementation = vi.fn();
    const closedController = await loadModules();
    Object.assign(closedController.appState, productState({ approval: approvalReceipt(), completionStatus: "running" }));
    closedController.viewState.currentThreadId = 10;

    await expect(closedController.decideApproval("request-1", "approve_once"), "stale receipt fails closed")
      .rejects.toMatchObject({ code: "approval_not_actionable" });
    await expect(closedController.decideApproval("request-1", "allow"), "unknown decision fails closed")
      .rejects.toThrow("Unsupported approval decision");
    expect(requestImplementation, "fail-closed checks never reach the API").not.toHaveBeenCalled();
  });
});
