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
  it("parses a complete provider-neutral request with canonical scope order, every action kind, and provider expiry", () => {
    expect(parseHarnessApprovalRequest(commandRequest()), "canonicalizes scope key order while preserving host authority").toEqual({
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

    const actionKinds = [
      ["command", { kind: "command", command: "npm test", workingDirectory: "/workspace/project" }],
      ["file_change", { kind: "file_change", action: "Apply patch", workingDirectory: "/workspace/project", affectedFiles: ["src/a.ts"] }],
      ["network", { kind: "network", action: "Download package metadata", networkDestination: "registry.npmjs.org:443" }],
      ["other", { kind: "other", action: "Open the system credential prompt" }],
    ] as const;
    expect(actionKinds, "every normalized action kind is covered").toHaveLength(4);
    for (const [kind, action] of actionKinds) {
      expect(parseHarnessApprovalRequest(commandRequest({ action })).action, `passes the ${kind} action through unchanged`).toEqual(action);
    }

    expect(
      parseHarnessApprovalRequest(commandRequest({ expiresAt: "2026-08-20T15:01:00.000Z" })).expiresAt,
      "expiry is provider metadata that passes through when it follows creation",
    ).toBe("2026-08-20T15:01:00.000Z");
  });

  it("rejects malformed request shapes by named rule", () => {
    const request = commandRequest();
    const { providerItemId: _providerItemId, ...incompleteCorrelation } = request.correlation;
    const cases: ReadonlyArray<readonly [label: string, parse: () => unknown, message: string]> = [
      ["incomplete ownership correlation", () => parseHarnessApprovalRequest({ ...request, correlation: incompleteCorrelation }), "providerItemId"],
      ["provider-native payload fields", () => parseHarnessApprovalRequest({ ...request, providerPayload: { command_id: "raw" } }), "unsupported fields"],
      ["empty scope key list", () => parseHarnessApprovalRequest(commandRequest({ scopeKeys: [] })), "non-empty array"],
      ["duplicate scope keys", () => parseHarnessApprovalRequest(commandRequest({ scopeKeys: ["command:npm test", "command:npm test"] })), "duplicates"],
      ["scope key with surrounding whitespace", () => parseHarnessApprovalRequest(commandRequest({ scopeKeys: [" command:npm test"] })), "surrounding whitespace"],
      ["scope key with control characters", () => parseHarnessApprovalRequest(commandRequest({ scopeKeys: ["command:npm\ntest"] })), "control characters"],
      ["unknown action kind", () => parseHarnessApprovalRequest(commandRequest({ action: { kind: "provider_command", command: "npm test" } })), "Unsupported harness approval action kind"],
      ["network action without a destination", () => parseHarnessApprovalRequest(commandRequest({ action: { kind: "network", action: "Fetch" } })), "networkDestination"],
      ["expiry before request creation", () => parseHarnessApprovalRequest(commandRequest({ expiresAt: "2026-08-20T14:59:00.000Z" })), "later than createdAt"],
    ];
    expect(cases, "every rejection rule is covered").toHaveLength(9);
    for (const [label, parse, message] of cases) {
      expect(parse, label).toThrow(message);
    }
  });

  it("keeps adapter request input and client decision submission separate from host-owned authority", () => {
    const request = commandRequest();
    const input = {
      providerItemId: request.correlation.providerItemId,
      title: request.title,
      reason: request.reason,
      action: request.action,
      scopeKeys: request.scopeKeys,
      scopeDescription: request.scopeDescription,
    };
    expect(() => parseHarnessApprovalRequestInput({ ...input, requestId: "adapter-spoof" }), "adapters cannot supply request identity").toThrow("unsupported fields");
    expect(createHarnessApprovalRequest(input, {
      requestId: request.requestId,
      threadId: request.correlation.threadId,
      interactionId: request.correlation.interactionId,
      completeCallId: request.correlation.completeCallId,
      harnessSessionId: request.correlation.harnessSessionId,
      createdAt: request.createdAt,
    }), "the host stamps adapter input into an authoritative request").toEqual(parseHarnessApprovalRequest(request));

    const submission = { requestId: "request-1", decision: "approve_always" as const, rationale: "Reviewed." };
    expect(() => parseHarnessApprovalDecisionSubmission({ ...submission, actor: "user" }), "clients cannot supply decision authority").toThrow("unsupported fields");
    expect(createHarnessApprovalDecision(submission, {
      actor: "user",
      decidedAt: "2026-08-20T15:00:30.000Z",
    }), "the host stamps a user decision").toEqual({
      ...submission,
      actor: "user",
      decidedAt: "2026-08-20T15:00:30.000Z",
    });
    expect(createHarnessApprovalDecision({ requestId: "request-2", decision: "approve_once" }, {
      actor: "session_grant",
      decidedAt: "2026-08-20T15:01:00.000Z",
      sourceRequestId: "request-1",
    }), "the host stamps session-grant provenance").toEqual({
      requestId: "request-2",
      decision: "approve_once",
      actor: "session_grant",
      decidedAt: "2026-08-20T15:01:00.000Z",
      sourceRequestId: "request-1",
    });
  });

  it("parses exactly the stable product decisions and rejects scope or vocabulary extensions", () => {
    const decisions = ["approve_once", "approve_always", "deny"] as const;
    for (const decision of decisions) {
      expect(parseHarnessApprovalDecision({
        requestId: "request-1",
        decision,
        actor: "user",
        decidedAt: "2026-08-20T15:00:30.000Z",
        rationale: "Reviewed in the desktop.",
      }), `parses the stable ${decision} decision`).toEqual({
        requestId: "request-1",
        decision,
        actor: "user",
        decidedAt: "2026-08-20T15:00:30.000Z",
        rationale: "Reviewed in the desktop.",
      });
    }

    const decision = {
      requestId: "request-1",
      decision: "approve_once",
      actor: "user",
      decidedAt: "2026-08-20T15:00:30.000Z",
    };
    expect(() => parseHarnessApprovalDecision({ ...decision, scopeKeys: ["command:anything"] }), "decisions cannot add scope").toThrow("unsupported fields");
    expect(() => parseHarnessApprovalDecision({ ...decision, decision: "allow" }), "unsupported decision values are rejected").toThrow("Unsupported harness approval decision");
    expect(() => parseHarnessApprovalDecision({ ...decision, actor: "model" }), "unsupported decision actors are rejected").toThrow("Unsupported harness approval decision actor");
  });

  it("keeps all three product decisions fixed during capability negotiation", () => {
    expect(parseHarnessApprovalCapabilities({
      protocolVersion: 1,
      decisions: ["deny", "approve_always", "approve_once"],
    }), "capability negotiation normalizes to the fixed product contract").toBe(HARNESS_APPROVAL_CAPABILITIES);
    expect(() => parseHarnessApprovalCapabilities({ protocolVersion: 1, decisions: ["approve_once", "deny"] }))
      .toThrow("must support approve_once, approve_always, and deny");
    expect(() => parseHarnessApprovalCapabilities({
      protocolVersion: 1,
      decisions: ["approve_once", "approve_always", "deny", "provider_choice"],
    })).toThrow("must support approve_once, approve_always, and deny");
  });
});

describe("exact harness approval session scope matching", () => {
  it("matches only exact scope keys inside one thread and live session, and fails closed for malformed grants", () => {
    const source = parseHarnessApprovalRequest(commandRequest());
    const grant = createHarnessApprovalSessionGrant(source);

    expect(requestMatchesHarnessApprovalSessionGrant(source, grant), "an identical request matches its own grant").toBe(true);
    expect(requestMatchesHarnessApprovalSessionGrant(parseHarnessApprovalRequest(commandRequest({
      requestId: "request-2",
      correlation: { ...source.correlation, interactionId: 12, completeCallId: "complete-13", providerItemId: "item-10" },
      scopeKeys: ["command:npm test", "cwd:/workspace/project"],
    })), grant), "a request whose required keys are a subset of the grant matches").toBe(true);

    const divergences = [
      ["prefix", ["command:npm"]],
      ["substring", ["npm test"]],
      ["path ancestor", ["cwd:/workspace"]],
      ["case folding", ["command:NPM TEST"]],
      ["inferred command equivalence", ["command:npm run test"]],
      ["one extra required key", ["command:npm test", "cwd:/workspace/project", "environment:workspace-write", "network:registry.npmjs.org:443"]],
    ] as const;
    expect(divergences, "every fuzzy-matching strategy is covered").toHaveLength(6);
    for (const [example, scopeKeys] of divergences) {
      const later = parseHarnessApprovalRequest(commandRequest({ requestId: "later", scopeKeys: [...scopeKeys] }));
      expect(requestMatchesHarnessApprovalSessionGrant(later, grant), `does not match by ${example}`).toBe(false);
    }

    const otherThread = parseHarnessApprovalRequest(commandRequest({
      requestId: "other-thread",
      correlation: { ...source.correlation, threadId: 8, providerItemId: "item-10" },
    }));
    const otherSession = parseHarnessApprovalRequest(commandRequest({
      requestId: "other-session",
      correlation: { ...source.correlation, harnessSessionId: "session-4", providerItemId: "item-11" },
    }));
    expect(requestMatchesHarnessApprovalSessionGrant(otherThread, grant), "grants never cross a thread boundary").toBe(false);
    expect(requestMatchesHarnessApprovalSessionGrant(otherSession, grant), "grants never cross a live harness session boundary").toBe(false);
    expect(requestMatchesHarnessApprovalSessionGrant(source, {
      sourceRequestId: "request-1",
      threadId: 7,
      harnessSessionId: "session-3",
      scopeKeys: [],
    }), "malformed grants fail closed").toBe(false);
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
