import { describe, expect, it } from "vitest";
import {
  HARNESS_APPROVAL_CAPABILITIES,
  createHarnessApprovalDecision,
  createHarnessApprovalRequest,
  createHarnessApprovalSessionGrant,
  parseHarnessApprovalCapabilities,
  parseHarnessApprovalDecision,
  parseHarnessApprovalDecisionSubmission,
  parseHarnessApprovalRequest,
  parseHarnessApprovalRequestInput,
  requestMatchesHarnessApprovalSessionGrant,
  type HarnessApprovalRequest,
} from "../src/approval.js";

describe("normalized harness approval protocol", () => {
  it("parses a complete provider-neutral command request and canonicalizes its scope key order", () => {
    expect(parseHarnessApprovalRequest(commandRequest())).toEqual({
      requestId: "request-1",
      correlation: {
        threadId: 7,
        interactionId: 11,
        completeCallId: "complete-12",
        harnessSessionId: "session-3",
        providerItemId: "item-9",
      },
      title: "Run tests",
      reason: "The harness needs to verify the requested change.",
      action: { kind: "command", command: "npm test", workingDirectory: "/workspace/project" },
      scopeKeys: ["command:npm test", "cwd:/workspace/project", "environment:workspace-write"],
      scopeDescription: "Run npm test in /workspace/project with workspace-write access for this session.",
      createdAt: "2026-08-20T15:00:00.000Z",
    });
  });

  it.each([
    ["command", { kind: "command", command: "npm test", workingDirectory: "/workspace/project" }],
    ["file_change", { kind: "file_change", action: "Apply patch", workingDirectory: "/workspace/project", affectedFiles: ["src/a.ts"] }],
    ["network", { kind: "network", action: "Download package metadata", networkDestination: "registry.npmjs.org:443" }],
    ["other", { kind: "other", action: "Open the system credential prompt" }],
  ])("supports the normalized %s action kind", (_kind, action) => {
    expect(parseHarnessApprovalRequest(commandRequest({ action })).action).toEqual(action);
  });

  it("rejects incomplete ownership correlation and provider-native fields", () => {
    const request = commandRequest();
    const { providerItemId: _providerItemId, ...incompleteCorrelation } = request.correlation;
    expect(() => parseHarnessApprovalRequest({ ...request, correlation: incompleteCorrelation })).toThrow("providerItemId");
    expect(() => parseHarnessApprovalRequest({ ...request, providerPayload: { command_id: "raw" } })).toThrow("unsupported fields");
  });

  it("keeps adapter input separate from host-owned request authority", () => {
    const request = commandRequest();
    const input = {
      providerItemId: request.correlation.providerItemId,
      title: request.title,
      reason: request.reason,
      action: request.action,
      scopeKeys: request.scopeKeys,
      scopeDescription: request.scopeDescription,
    };
    expect(() => parseHarnessApprovalRequestInput({ ...input, requestId: "adapter-spoof" })).toThrow("unsupported fields");
    expect(createHarnessApprovalRequest(input, {
      requestId: request.requestId,
      threadId: request.correlation.threadId,
      interactionId: request.correlation.interactionId,
      completeCallId: request.correlation.completeCallId,
      harnessSessionId: request.correlation.harnessSessionId,
      createdAt: request.createdAt,
    })).toEqual(parseHarnessApprovalRequest(request));
  });

  it.each([
    [[], "non-empty array"],
    [["command:npm test", "command:npm test"], "duplicates"],
    [[" command:npm test"], "surrounding whitespace"],
    [["command:npm\ntest"], "control characters"],
  ])("rejects invalid normalized scope keys %#", (scopeKeys, message) => {
    expect(() => parseHarnessApprovalRequest(commandRequest({ scopeKeys }))).toThrow(message);
  });

  it("rejects unknown action kinds and missing kind-specific display details", () => {
    expect(() => parseHarnessApprovalRequest(commandRequest({ action: { kind: "provider_command", command: "npm test" } })))
      .toThrow("Unsupported harness approval action kind");
    expect(() => parseHarnessApprovalRequest(commandRequest({ action: { kind: "network", action: "Fetch" } })))
      .toThrow("networkDestination");
  });

  it("treats expiry as provider metadata that must follow request creation", () => {
    expect(parseHarnessApprovalRequest(commandRequest({ expiresAt: "2026-08-20T15:01:00.000Z" })).expiresAt)
      .toBe("2026-08-20T15:01:00.000Z");
    expect(() => parseHarnessApprovalRequest(commandRequest({ expiresAt: "2026-08-20T14:59:00.000Z" })))
      .toThrow("later than createdAt");
  });

  it.each(["approve_once", "approve_always", "deny"] as const)("parses the stable %s decision", (decision) => {
    expect(parseHarnessApprovalDecision({
      requestId: "request-1",
      decision,
      actor: "user",
      decidedAt: "2026-08-20T15:00:30.000Z",
      rationale: "Reviewed in the desktop.",
    })).toEqual({
      requestId: "request-1",
      decision,
      actor: "user",
      decidedAt: "2026-08-20T15:00:30.000Z",
      rationale: "Reviewed in the desktop.",
    });
  });

  it("rejects decisions that try to add scope or use unsupported values", () => {
    const decision = {
      requestId: "request-1",
      decision: "approve_once",
      actor: "user",
      decidedAt: "2026-08-20T15:00:30.000Z",
    };
    expect(() => parseHarnessApprovalDecision({ ...decision, scopeKeys: ["command:anything"] })).toThrow("unsupported fields");
    expect(() => parseHarnessApprovalDecision({ ...decision, decision: "allow" })).toThrow("Unsupported harness approval decision");
    expect(() => parseHarnessApprovalDecision({ ...decision, actor: "model" })).toThrow("Unsupported harness approval decision actor");
  });

  it("keeps client submission separate from host-owned decision authority", () => {
    const submission = { requestId: "request-1", decision: "approve_always" as const, rationale: "Reviewed." };
    expect(() => parseHarnessApprovalDecisionSubmission({ ...submission, actor: "user" })).toThrow("unsupported fields");
    expect(createHarnessApprovalDecision(submission, {
      actor: "user",
      decidedAt: "2026-08-20T15:00:30.000Z",
    })).toEqual({
      ...submission,
      actor: "user",
      decidedAt: "2026-08-20T15:00:30.000Z",
    });
    expect(createHarnessApprovalDecision({ requestId: "request-2", decision: "approve_once" }, {
      actor: "session_grant",
      decidedAt: "2026-08-20T15:01:00.000Z",
      sourceRequestId: "request-1",
    })).toEqual({
      requestId: "request-2",
      decision: "approve_once",
      actor: "session_grant",
      decidedAt: "2026-08-20T15:01:00.000Z",
      sourceRequestId: "request-1",
    });
  });

  it("keeps all three product decisions fixed during capability negotiation", () => {
    expect(parseHarnessApprovalCapabilities({
      protocolVersion: 1,
      decisions: ["deny", "approve_always", "approve_once"],
    })).toBe(HARNESS_APPROVAL_CAPABILITIES);
    expect(() => parseHarnessApprovalCapabilities({ protocolVersion: 1, decisions: ["approve_once", "deny"] }))
      .toThrow("must support approve_once, approve_always, and deny");
    expect(() => parseHarnessApprovalCapabilities({
      protocolVersion: 1,
      decisions: ["approve_once", "approve_always", "deny", "provider_choice"],
    })).toThrow("must support approve_once, approve_always, and deny");
  });
});

describe("exact harness approval session scope matching", () => {
  it("matches an identical request and a request whose required keys are a subset of the session grant", () => {
    const source = parseHarnessApprovalRequest(commandRequest());
    const grant = createHarnessApprovalSessionGrant(source);

    expect(requestMatchesHarnessApprovalSessionGrant(source, grant)).toBe(true);
    expect(requestMatchesHarnessApprovalSessionGrant(parseHarnessApprovalRequest(commandRequest({
      requestId: "request-2",
      correlation: { ...source.correlation, interactionId: 12, completeCallId: "complete-13", providerItemId: "item-10" },
      scopeKeys: ["command:npm test", "cwd:/workspace/project"],
    })), grant)).toBe(true);
  });

  it.each([
    ["prefix", ["command:npm"]],
    ["substring", ["npm test"]],
    ["path ancestor", ["cwd:/workspace"]],
    ["case folding", ["command:NPM TEST"]],
    ["inferred command equivalence", ["command:npm run test"]],
    ["one extra required key", ["command:npm test", "cwd:/workspace/project", "environment:workspace-write", "network:registry.npmjs.org:443"]],
  ])("does not match by %s", (_example, scopeKeys) => {
    const source = parseHarnessApprovalRequest(commandRequest());
    const later = parseHarnessApprovalRequest(commandRequest({ requestId: "later", scopeKeys }));
    expect(requestMatchesHarnessApprovalSessionGrant(later, createHarnessApprovalSessionGrant(source))).toBe(false);
  });

  it("does not cross a thread or live harness session boundary", () => {
    const source = parseHarnessApprovalRequest(commandRequest());
    const grant = createHarnessApprovalSessionGrant(source);
    const otherThread = parseHarnessApprovalRequest(commandRequest({
      requestId: "other-thread",
      correlation: { ...source.correlation, threadId: 8, providerItemId: "item-10" },
    }));
    const otherSession = parseHarnessApprovalRequest(commandRequest({
      requestId: "other-session",
      correlation: { ...source.correlation, harnessSessionId: "session-4", providerItemId: "item-11" },
    }));
    expect(requestMatchesHarnessApprovalSessionGrant(otherThread, grant)).toBe(false);
    expect(requestMatchesHarnessApprovalSessionGrant(otherSession, grant)).toBe(false);
  });

  it("fails closed for malformed grants", () => {
    const request = parseHarnessApprovalRequest(commandRequest());
    expect(requestMatchesHarnessApprovalSessionGrant(request, {
      sourceRequestId: "request-1",
      threadId: 7,
      harnessSessionId: "session-3",
      scopeKeys: [],
    })).toBe(false);
  });
});

function commandRequest(overrides: Record<string, unknown> = {}): HarnessApprovalRequest {
  const base: HarnessApprovalRequest = {
    requestId: "request-1",
    correlation: {
      threadId: 7,
      interactionId: 11,
      completeCallId: "complete-12",
      harnessSessionId: "session-3",
      providerItemId: "item-9",
    },
    title: "Run tests",
    reason: "The harness needs to verify the requested change.",
    action: { kind: "command", command: "npm test", workingDirectory: "/workspace/project" },
    scopeKeys: ["environment:workspace-write", "command:npm test", "cwd:/workspace/project"],
    scopeDescription: "Run npm test in /workspace/project with workspace-write access for this session.",
    createdAt: "2026-08-20T15:00:00.000Z",
  };
  return { ...base, ...overrides } as HarnessApprovalRequest;
}
