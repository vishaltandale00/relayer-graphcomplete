import { describe, expect, it, vi } from "vitest";
import {
  HarnessApprovalCoordinator,
  HarnessApprovalRequestTerminatedError,
  type HarnessApprovalChannel,
} from "../src/approval-coordinator.js";
import { answerCodexServerRequest, isExactGraphAuthoringLauncherCommand } from "../src/implementations/codex-approvals.js";
import type { HarnessApprovalDecision, HarnessApprovalRequestInput } from "../src/approval.js";
import type { JsonObject } from "../src/types.js";

describe("Codex approval bridge", () => {
  it.each(["approve_once", "approve_always"] as const)("maps v2 command %s to one provider accept", async (decision) => {
    const fixture = bridgeFixture(decision);
    fixture.items.set("item-1", {
      type: "commandExecution",
      id: "item-1",
      command: "npm test",
      cwd: "/workspace/project",
      source: "agent",
    });

    const result = await answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      environmentId: "local",
      reason: "Run verification",
      command: "npm test",
      cwd: "/workspace/project",
      proposedExecpolicyAmendment: ["npm", "test"],
    }), fixture.context);

    expect(result).toEqual({ decision: "accept" });
    expect(fixture.request).toHaveBeenCalledOnce();
    const input = fixture.request.mock.calls[0]![0];
    expect(input).toMatchObject({
      action: { kind: "command", command: "npm test", workingDirectory: "/workspace/project" },
      scopeKeys: [expect.stringMatching(/^codex:command:v1:sha256:[a-f0-9]{64}$/)],
    });
    expect(JSON.stringify(input)).not.toContain("proposedExecpolicyAmendment");
  });

  it("maps deny to decline and provider clearance to cancel", async () => {
    const denied = bridgeFixture("deny");
    denied.items.set("item-1", commandItem());
    await expect(answerCodexServerRequest(v2Command(), denied.context)).resolves.toEqual({ decision: "decline" });

    const cancelled = bridgeFixture("approve_once");
    cancelled.request.mockRejectedValue(new HarnessApprovalRequestTerminatedError({
      requestId: "request-1",
      correlation: { threadId: 1, interactionId: 2, completeCallId: "complete-1", harnessSessionId: "session-1" },
      outcome: "cancelled",
      actor: "host",
      resolvedAt: "2026-08-20T15:00:00.000Z",
    }));
    cancelled.items.set("item-1", commandItem());
    await expect(answerCodexServerRequest(v2Command(), cancelled.context)).resolves.toEqual({ decision: "cancel" });
  });

  it("accepts only the exact pinned internal graph launcher without creating a product approval", async () => {
    const fixture = bridgeFixture("deny");
    const launcher = "/immutable/runtime/graph-authoring-launcher";
    const command = `"${launcher}" <<'EOF'\nconsole.log("graph");\nEOF`;
    const context = { ...fixture.context, trustedGraphAuthoringLauncher: launcher };
    fixture.items.set("item-1", { ...commandItem(), command });

    await expect(answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command, cwd: "/workspace/project",
    }), context)).resolves.toEqual({ decision: "accept" });
    expect(fixture.request).not.toHaveBeenCalled();

    expect(isExactGraphAuthoringLauncherCommand(command, launcher)).toBe(true);
    expect(isExactGraphAuthoringLauncherCommand(`${command}\necho escaped\nEOF`, launcher)).toBe(false);
    expect(isExactGraphAuthoringLauncherCommand(`"${launcher}" --flag <<'EOF'\ngraph\nEOF`, launcher)).toBe(false);
  });

  it.each([
    { name: "different working directory", cwd: "/workspace/other", additionalPermissions: undefined },
    { name: "additional permissions", cwd: "/workspace/project", additionalPermissions: { fileSystem: { write: ["/workspace/other"] } } },
  ])("routes a pinned launcher with $name through the product approval channel", async ({ cwd, additionalPermissions }) => {
    const fixture = bridgeFixture("deny");
    const launcher = "/immutable/runtime/graph-authoring-launcher";
    const command = `"${launcher}" <<'EOF'\nconsole.log("graph");\nEOF`;
    const context = { ...fixture.context, trustedGraphAuthoringLauncher: launcher };
    fixture.items.set("item-1", { ...commandItem(), command, cwd });

    await expect(answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command, cwd,
      ...(additionalPermissions === undefined ? {} : { additionalPermissions }),
    }), context)).resolves.toEqual({ decision: "decline" });
    expect(fixture.request).toHaveBeenCalledOnce();
  });

  it("derives one exact key per proposed file path and change kind", async () => {
    const fixture = bridgeFixture("approve_always");
    fixture.items.set("file-1", {
      type: "fileChange",
      id: "file-1",
      changes: [
        { path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "@@" },
        { path: "/workspace/project/src/b.ts", kind: { type: "delete" }, diff: "@@" },
      ],
    });

    const result = await answerCodexServerRequest(serverRequest("item/fileChange/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "file-1",
      grantRoot: "/workspace/project",
    }), fixture.context);

    expect(result).toEqual({ decision: "accept" });
    expect(fixture.request.mock.calls[0]![0]).toMatchObject({
      action: {
        kind: "file_change",
        affectedFiles: ["/workspace/project/src/a.ts", "/workspace/project/src/b.ts"],
      },
      scopeKeys: [
        expect.stringMatching(/^codex:file:v1:sha256:/),
        expect.stringMatching(/^codex:file:v1:sha256:/),
      ],
    });
  });

  it("fails closed for under-specified network and possible TTY authority", async () => {
    const fixture = bridgeFixture("approve_once");
    fixture.items.set("item-1", commandItem());
    await expect(answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      environmentId: "local",
      networkApprovalContext: { host: "example.com", protocol: "https" },
    }), fixture.context)).resolves.toEqual({ decision: "decline" });

    fixture.items.set("item-2", { ...commandItem(), id: "item-2", source: "unifiedExecStartup" });
    await expect(answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-2",
      command: "npm test",
      cwd: "/workspace/project",
    }), fixture.context)).resolves.toEqual({ decision: "decline" });
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("accepts a future network shape only when host, protocol, and explicit port are exact", async () => {
    const fixture = bridgeFixture("approve_once");
    fixture.items.set("item-1", commandItem());

    const result = await answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      environmentId: "local",
      networkApprovalContext: { host: "example.com", protocol: "https", port: 443 },
    }), fixture.context);

    expect(result).toEqual({ decision: "accept" });
    expect(fixture.request.mock.calls[0]![0]).toMatchObject({
      action: { kind: "network", networkDestination: "example.com:443" },
      scopeKeys: [expect.stringMatching(/^codex:network:v1:sha256:/)],
    });
  });

  it.each(["approve_once", "approve_always"] as const)("grants the exact requested Codex permissions for the current turn on %s", async (decision) => {
    const fixture = bridgeFixture(decision);
    const result = await answerCodexServerRequest(permissionRequest({
      network: { enabled: true },
      fileSystem: {
        read: ["/workspace/shared", "/workspace/shared"],
        write: ["/workspace/project"],
        entries: [
          { path: { type: "path", path: "/workspace/project" }, access: "write" },
          { path: { type: "path", path: "/workspace/shared" }, access: "read" },
          { path: { type: "path", path: "/workspace/project" }, access: "write" },
        ],
      },
    }), fixture.context);

    expect(result).toEqual({
      scope: "turn",
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: null,
          write: null,
          entries: [
            { access: "read", path: { path: "/workspace/shared", type: "path" } },
            { access: "write", path: { path: "/workspace/project", type: "path" } },
          ],
        },
      },
    });
    const input = fixture.request.mock.calls[0]![0];
    expect(input).toMatchObject({
      providerItemId: "item/permissions/requestApproval:provider-request-1:permission-1",
      title: "Grant Codex permissions for this turn",
      action: { kind: "other", workingDirectory: "/workspace/project" },
      scopeKeys: [expect.stringMatching(/^codex:permissions:v1:sha256:[a-f0-9]{64}$/)],
    });
    expect(input.action.kind).toBe("other");
    if (input.action.kind !== "other") throw new Error("expected other approval action");
    expect(input.action.action).toContain("current turn");
    expect(input.action.action).toContain("/workspace/shared");
    expect(input.action.action).toContain("/workspace/project");
    expect(input.scopeDescription).toContain("only for the current turn");
    expect(input.scopeDescription).toContain("live Relayer harness session");
    expect(JSON.stringify(result)).not.toContain("session");
    expect(JSON.stringify(result)).not.toContain("strictAutoReview");
  });

  it("maps a denied or cleared Codex permission request to an empty turn grant", async () => {
    const denied = bridgeFixture("deny");
    await expect(answerCodexServerRequest(permissionRequest(networkPermission()), denied.context))
      .resolves.toEqual({ permissions: {}, scope: "turn" });

    const cleared = bridgeFixture("approve_once");
    cleared.request.mockRejectedValue(new HarnessApprovalRequestTerminatedError({
      requestId: "request-1",
      correlation: { threadId: 1, interactionId: 2, completeCallId: "complete-1", harnessSessionId: "session-1" },
      outcome: "aborted",
      actor: "host",
      resolvedAt: "2026-08-20T15:00:00.000Z",
    }));
    await expect(answerCodexServerRequest(permissionRequest(networkPermission()), cleared.context))
      .resolves.toEqual({ permissions: {}, scope: "turn" });
  });

  it("reuses approve always only for the exact canonical permission profile in the live session", async () => {
    let nextRequest = 0;
    const coordinator = new HarnessApprovalCoordinator({
      threadId: 1,
      harnessSessionId: "session-1",
      now: () => "2026-08-20T15:00:00.000Z",
      requestId: () => `request-${++nextRequest}`,
    });
    const approvals = coordinator.beginCompletion({ interactionId: 2, completeCallId: "complete-1" });
    const context = bridgeFixture("deny").context;
    const bridged = { ...context, approvals };
    const first = answerCodexServerRequest(permissionRequest(fileWritePermission("/workspace/CaseSensitive")), bridged);
    const firstPending = coordinator.snapshot(0).pendingRequests[0]!;
    coordinator.decide(firstPending.requestId, { decision: "approve_always" });
    await expect(first).resolves.toEqual({
      permissions: normalizedFileWritePermission("/workspace/CaseSensitive"),
      scope: "turn",
    });

    await expect(answerCodexServerRequest(
      permissionRequest(fileWritePermission("/workspace/CaseSensitive"), { id: "provider-request-2", itemId: "permission-2" }),
      bridged,
    )).resolves.toEqual({
      permissions: normalizedFileWritePermission("/workspace/CaseSensitive"),
      scope: "turn",
    });
    const exactResolution = coordinator.snapshot(0).events.filter((event) => event.type === "resolved").at(-1);
    expect(exactResolution).toMatchObject({ resolution: { actor: "session_grant", decision: "approve_once" } });

    const near = answerCodexServerRequest(
      permissionRequest(fileWritePermission("/workspace/casesensitive"), { id: "provider-request-3", itemId: "permission-3" }),
      bridged,
    );
    const nearPending = coordinator.snapshot(0).pendingRequests;
    expect(nearPending).toHaveLength(1);
    expect(nearPending[0]!.scopeKeys).not.toEqual(firstPending.scopeKeys);
    coordinator.decide(nearPending[0]!.requestId, { decision: "deny" });
    await expect(near).resolves.toEqual({ permissions: {}, scope: "turn" });
    coordinator.endCompletion("complete-1");
  });

  it("fails malformed, unsupported, inconsistent, and miscorrelated permissions closed", async () => {
    const fixture = bridgeFixture("approve_once");
    const complete = permissionRequest(networkPermission());
    const { reason: _reason, ...missingReason } = complete.params;
    const requests = [
      permissionRequest(networkPermission(), { turnId: "wrong-turn" }),
      permissionRequest(networkPermission(), { itemId: "" }),
      permissionRequest(networkPermission(), { startedAtMs: 0 }),
      permissionRequest({ network: { enabled: false }, fileSystem: null }),
      permissionRequest({ network: { enabled: true, futureAuthority: true }, fileSystem: null }),
      permissionRequest({ network: { enabled: true } }),
      permissionRequest(fileWritePermission("relative/path")),
      permissionRequest({
        network: null,
        fileSystem: {
          read: null,
          write: ["/workspace/a"],
          entries: [{ path: { type: "path", path: "/workspace/b" }, access: "write" }],
        },
      }),
      permissionRequest({
        network: null,
        fileSystem: {
          read: null,
          write: null,
          entries: [{ path: { type: "glob_pattern", pattern: "**/*.env" }, access: "read" }],
        },
      }),
      permissionRequest({ network: null, fileSystem: { read: [], write: [], futureAuthority: true } }),
      serverRequest("item/permissions/requestApproval", missingReason),
      serverRequest("item/permissions/requestApproval", null),
    ];
    for (const request of requests) {
      await expect(answerCodexServerRequest(request, fixture.context))
        .resolves.toEqual({ permissions: {}, scope: "turn" });
    }
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("makes canonical keys stable across ordering and distinct across every authority dimension", async () => {
    const base = {
      network: { enabled: true },
      fileSystem: {
        read: ["/workspace/b", "/workspace/a"],
        write: ["/workspace/c"],
        globScanMaxDepth: 4,
        entries: [
          { path: { type: "path", path: "/workspace/c" }, access: "write" },
          { path: { type: "path", path: "/workspace/b" }, access: "read" },
          { path: { type: "path", path: "/workspace/a" }, access: "read" },
          { path: { type: "glob_pattern", pattern: "**/*.env" }, access: "deny" },
        ],
      },
    };
    const reordered = {
      fileSystem: {
        entries: [...base.fileSystem.entries].reverse(),
        globScanMaxDepth: 4,
        write: ["/workspace/c"],
        read: ["/workspace/a", "/workspace/b"],
      },
      network: { enabled: true },
    };
    const baseKey = await capturePermissionScopeKey(base);
    expect(await capturePermissionScopeKey(reordered)).toBe(baseKey);
    expect(await capturePermissionScopeKey(base, { cwd: "/workspace/other" })).not.toBe(baseKey);
    expect(await capturePermissionScopeKey(base, { environmentId: "remote" })).not.toBe(baseKey);
    expect(await capturePermissionScopeKey({
      ...base,
      fileSystem: { ...base.fileSystem, globScanMaxDepth: 5 },
    })).not.toBe(baseKey);
    expect(await capturePermissionScopeKey({
      network: { enabled: true },
      fileSystem: {
        read: ["/workspace/b", "/workspace/a", "/workspace/c"],
        write: [],
        globScanMaxDepth: 4,
        entries: base.fileSystem.entries.map((entry) => (
          entry.access === "write" ? { ...entry, access: "read" } : entry
        )),
      },
    })).not.toBe(baseKey);
  });

  it("fails generic MCP elicitation closed without opening a Relayer approval", async () => {
    const fixture = bridgeFixture("approve_once");
    await expect(answerCodexServerRequest(serverRequest("mcpServer/elicitation/request", {}), fixture.context))
      .resolves.toEqual({ action: "decline", content: null, _meta: null });
    await expect(answerCodexServerRequest(serverRequest("item/tool/requestUserInput", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "tool-1",
      isBlocking: true,
      questions: [{ id: "q1", question: "Enter a secret", isSecret: true, options: null }],
    }), fixture.context)).resolves.toEqual({ answers: {} });
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("maps a recognized one-question MCP app approval using exact target and arguments", async () => {
    const fixture = bridgeFixture("approve_always");
    fixture.items.set("tool-1", {
      type: "mcpToolCall",
      id: "tool-1",
      server: "github",
      tool: "create_issue",
      arguments: { owner: "acme", repo: "app", title: "Bug" },
      appContext: { resourceUri: "github://acme/app" },
      readOnlyHint: false,
    });

    const result = await answerCodexServerRequest(serverRequest("item/tool/requestUserInput", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "tool-1",
      isBlocking: true,
      questions: [{
        id: "approve",
        question: "Create this issue?",
        isSecret: false,
        options: [{ label: "Accept" }, { label: "Decline" }, { label: "Cancel" }],
      }],
    }), fixture.context);

    expect(result).toEqual({ answers: { approve: { answers: ["Accept"] } } });
    expect(fixture.request.mock.calls[0]![0]).toMatchObject({
      action: { kind: "other", action: "Call github.create_issue" },
      scopeKeys: [expect.stringMatching(/^codex:mcp:v1:sha256:/)],
    });
  });

  it("maps legacy command and patch decisions without provider session grants", async () => {
    const approved = bridgeFixture("approve_always");
    await expect(answerCodexServerRequest(serverRequest("execCommandApproval", {
      conversationId: "thread-1",
      callId: "call-1",
      approvalId: null,
      command: ["npm", "test"],
      cwd: "/workspace/project",
      reason: null,
      parsedCmd: [],
    }), approved.context)).resolves.toEqual({ decision: "approved" });

    approved.items.set("unused", {});
    await expect(answerCodexServerRequest(serverRequest("applyPatchApproval", {
      conversationId: "thread-1",
      callId: "patch-1",
      fileChanges: { "src/a.ts": { type: "update", unified_diff: "@@", move_path: null } },
      reason: null,
      grantRoot: "/workspace/project",
    }), approved.context)).resolves.toEqual({ decision: "approved" });
    expect(JSON.stringify(await answerCodexServerRequest(serverRequest("execCommandApproval", {
      conversationId: "wrong-thread",
      command: ["npm", "test"],
      cwd: "/workspace/project",
    }), approved.context))).not.toContain("approved_for_session");
  });
});

function bridgeFixture(decision: HarnessApprovalDecision["decision"]) {
  const request = vi.fn(async (input: HarnessApprovalRequestInput): Promise<HarnessApprovalDecision> => ({
    requestId: "request-1",
    decision,
    actor: "user",
    decidedAt: "2026-08-20T15:00:00.000Z",
    ...(decision === "deny" ? { rationale: "No." } : {}),
  }));
  const items = new Map<string, JsonObject>();
  return {
    request,
    items,
    context: {
      approvals: { request } satisfies HarnessApprovalChannel,
      workingDirectory: "/workspace/project",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/workspace/project"], networkAccess: true },
      threadId: "thread-1",
      turnId: "turn-1",
      items,
    },
  };
}

function serverRequest(method: string, params: unknown) {
  return { id: "provider-request-1", method, params };
}

function permissionRequest(
  permissions: unknown,
  overrides: Partial<{
    id: string;
    threadId: string;
    turnId: string;
    itemId: string;
    environmentId: string | null;
    startedAtMs: number;
    cwd: string;
    reason: string | null;
  }> = {},
) {
  return {
    id: overrides.id ?? "provider-request-1",
    method: "item/permissions/requestApproval",
    params: {
      threadId: overrides.threadId ?? "thread-1",
      turnId: overrides.turnId ?? "turn-1",
      itemId: overrides.itemId ?? "permission-1",
      environmentId: overrides.environmentId === undefined ? "local" : overrides.environmentId,
      startedAtMs: overrides.startedAtMs ?? 1,
      cwd: overrides.cwd ?? "/workspace/project",
      reason: overrides.reason === undefined ? "Run the requested operation" : overrides.reason,
      permissions,
    },
  };
}

function networkPermission() {
  return { network: { enabled: true }, fileSystem: null };
}

function fileWritePermission(path: string) {
  return {
    network: null,
    fileSystem: {
      read: null,
      write: [path],
      entries: [{ path: { type: "path", path }, access: "write" }],
    },
  };
}

function normalizedFileWritePermission(path: string) {
  return {
    fileSystem: {
      read: null,
      write: null,
      entries: [{ access: "write", path: { path, type: "path" } }],
    },
  };
}

async function capturePermissionScopeKey(
  permissions: unknown,
  overrides: Parameters<typeof permissionRequest>[1] = {},
): Promise<string> {
  const fixture = bridgeFixture("approve_once");
  await answerCodexServerRequest(permissionRequest(permissions, overrides), fixture.context);
  expect(fixture.request).toHaveBeenCalledOnce();
  return fixture.request.mock.calls[0]![0].scopeKeys[0]!;
}

function commandItem(): JsonObject {
  return { type: "commandExecution", id: "item-1", command: "npm test", cwd: "/workspace/project", source: "agent" };
}

function v2Command() {
  return serverRequest("item/commandExecution/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    environmentId: "local",
    command: "npm test",
    cwd: "/workspace/project",
  });
}
