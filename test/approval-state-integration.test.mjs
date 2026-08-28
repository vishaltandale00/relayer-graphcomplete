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

  it("loads approval receipts and posts the exact decision route and body", async () => {
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
    expect(controller.appState.approvals).toEqual([pending]);

    await controller.decideApproval("request-1", "approve_once");

    expect(requestImplementation).toHaveBeenCalledWith(
      "/api/threads/10/interactions/20/approvals/request-1/decision",
      { method: "POST", body: JSON.stringify({ decision: "approve_once" }) },
    );
    expect(controller.appState.approvals[0].resolution?.outcome).toBe("approved");
    expect(controller.appState.pendingApprovalDecisions).toEqual([]);
  });

  it("prevents duplicate decisions while the first request is in flight", async () => {
    const post = deferred();
    const pending = approvalReceipt();
    requestImplementation = vi.fn(async (path) => {
      if (path.endsWith("/decision")) return post.promise;
      if (path.startsWith("/api/state?threadId=10")) return productState({ completionStatus: "running" });
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    Object.assign(controller.appState, productState({ approval: pending }));
    controller.viewState.currentThreadId = 10;

    const first = controller.decideApproval("request-1", "deny");
    await vi.waitFor(() => expect(controller.appState.pendingApprovalDecisions).toEqual(["request-1"]));
    await controller.decideApproval("request-1", "deny");
    expect(requestImplementation.mock.calls.filter(([path]) => path.endsWith("/decision"))).toHaveLength(1);
    post.resolve({ approval: pending });
    await first;
  });

  it("posts one approval decision even when its presentation cannot redraw", async () => {
    const pending = approvalReceipt();
    const resolved = productState({
      approval: approvalReceipt({ resolution: { outcome: "approved", decision: "approve_once", resolvedAt: "2026-08-20T12:01:00Z" } }),
      completionStatus: "running",
    });
    requestImplementation = vi.fn(async (path) => {
      if (path.endsWith("/decision")) return { approval: resolved.approvals[0] };
      if (path.startsWith("/api/state?threadId=10")) return resolved;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    Object.assign(controller.appState, productState({ approval: pending }));
    controller.viewState.currentThreadId = 10;
    renderFailure = new Error("The vendored Lucide renderer must load before Relayer icons are created.");

    await expect(controller.decideApproval("request-1", "approve_once")).resolves.toBeUndefined();

    expect(requestImplementation.mock.calls.filter(([path]) => path.endsWith("/decision"))).toHaveLength(1);
    expect(controller.appState.approvals[0].resolution?.outcome).toBe("approved");
    expect(controller.appState.pendingApprovalDecisions).toEqual([]);
  });

  it("does not refresh or mutate a newly selected thread after a stale decision resolves", async () => {
    const post = deferred();
    const pending = approvalReceipt();
    requestImplementation = vi.fn(async (path) => {
      if (path.endsWith("/decision")) return post.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const controller = await loadModules();
    Object.assign(controller.appState, productState({ approval: pending }));
    controller.appState.threads.push({ id: 11, title: "Other thread" });
    controller.viewState.currentThreadId = 10;

    const decision = controller.decideApproval("request-1", "approve_always");
    controller.viewState.currentThreadId = 11;
    post.resolve({ approval: pending });
    await decision;

    expect(requestImplementation.mock.calls.filter(([path]) => path.startsWith("/api/state"))).toEqual([]);
    expect(controller.viewState.currentThreadId).toBe(11);
  });

  it("fails closed before the API call when a request is stale or the decision is unknown", async () => {
    requestImplementation = vi.fn();
    const controller = await loadModules();
    Object.assign(controller.appState, productState({ approval: approvalReceipt(), completionStatus: "running" }));
    controller.viewState.currentThreadId = 10;

    await expect(controller.decideApproval("request-1", "approve_once"))
      .rejects.toMatchObject({ code: "approval_not_actionable" });
    await expect(controller.decideApproval("request-1", "allow"))
      .rejects.toThrow("Unsupported approval decision");
    expect(requestImplementation).not.toHaveBeenCalled();
  });
});
