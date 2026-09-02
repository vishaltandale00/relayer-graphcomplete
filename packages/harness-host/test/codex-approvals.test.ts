import { describe, expect, it, vi } from "vitest";
import {
  HarnessApprovalCoordinator,
  HarnessApprovalRequestTerminatedError,
  type HarnessApprovalChannel,
} from "../src/approval-coordinator.js";
import { answerCodexServerRequest, isExactGraphAuthoringLauncherCommand, type CodexServerRequest } from "../src/implementations/codex-approvals.js";
import type { HarnessApprovalDecision, HarnessApprovalRequestInput } from "../src/approval.js";
import type { JsonObject } from "../src/types.js";

const LAUNCHER = "/immutable/runtime/graph-authoring-launcher";
const LAUNCHER_COMMAND = `"${LAUNCHER}" <<'EOF'\nconsole.log("graph");\nEOF`;

type BridgeFixture = ReturnType<typeof bridgeFixture>;

function launcherContext(fixture: BridgeFixture) {
  return { ...fixture.context, trustedGraphAuthoringLauncher: LAUNCHER };
}

describe("Codex approval bridge", () => {
  it("maps v2 command and legacy decisions through one normalized product approval", async () => {
    for (const decision of ["approve_once", "approve_always"] as const) {
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

      expect(result, `${decision} maps to one provider accept`).toEqual({ decision: "accept" });
      expect(fixture.request, `${decision} opens exactly one product approval`).toHaveBeenCalledOnce();
      const input = fixture.request.mock.calls[0]![0];
      expect(input, `${decision} submits the normalized command action`).toMatchObject({
        action: { kind: "command", command: "npm test", workingDirectory: "/workspace/project" },
        scopeKeys: [expect.stringMatching(/^codex:command:v1:sha256:[a-f0-9]{64}$/)],
      });
      expect(JSON.stringify(input), `${decision} never forwards provider amendment internals`).not.toContain("proposedExecpolicyAmendment");
    }

    const denied = bridgeFixture("deny");
    denied.items.set("item-1", commandItem());
    await expect(answerCodexServerRequest(v2Command(), denied.context), "deny maps to decline").resolves.toEqual({ decision: "decline" });

    const cancelled = bridgeFixture("approve_once");
    cancelled.request.mockRejectedValue(new HarnessApprovalRequestTerminatedError({
      requestId: "request-1",
      correlation: { threadId: 1, interactionId: 2, completeCallId: "complete-1", harnessSessionId: "session-1" },
      outcome: "cancelled",
      actor: "host",
      resolvedAt: "2026-08-20T15:00:00.000Z",
    }));
    cancelled.items.set("item-1", commandItem());
    await expect(answerCodexServerRequest(v2Command(), cancelled.context), "a cleared provider request maps to cancel").resolves.toEqual({ decision: "cancel" });

    const advertised = bridgeFixture("deny");
    advertised.items.set("item-1", commandItem());
    await expect(answerCodexServerRequest(v2Command({
      availableDecisions: [
        "accept",
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } },
        "cancel",
      ],
    }), advertised.context), "denial maps to the advertised non-grant command decision").resolves.toEqual({ decision: "cancel" });
    expect(advertised.request, "the advertised denial still opens the product approval").toHaveBeenCalledOnce();

    const legacy = bridgeFixture("approve_always");
    await expect(answerCodexServerRequest(serverRequest("execCommandApproval", {
      conversationId: "thread-1",
      callId: "call-1",
      approvalId: null,
      command: ["npm", "test"],
      cwd: "/workspace/project",
      reason: null,
      parsedCmd: [],
    }), legacy.context), "legacy command approvals map to approved").resolves.toEqual({ decision: "approved" });

    legacy.items.set("unused", {});
    await expect(answerCodexServerRequest(serverRequest("applyPatchApproval", {
      conversationId: "thread-1",
      callId: "patch-1",
      fileChanges: { "src/a.ts": { type: "update", unified_diff: "@@", move_path: null } },
      reason: null,
      grantRoot: "/workspace/project",
    }), legacy.context), "legacy patch approvals map to approved").resolves.toEqual({ decision: "approved" });
    expect(JSON.stringify(await answerCodexServerRequest(serverRequest("execCommandApproval", {
      conversationId: "wrong-thread",
      command: ["npm", "test"],
      cwd: "/workspace/project",
    }), legacy.context)), "legacy decisions never carry provider session grants").not.toContain("approved_for_session");
  });

  it("accepts only the exact pinned graph-authoring launcher and declines every divergence", async () => {
    const acceptCases: Array<[label: string, run: (fixture: BridgeFixture) => Promise<unknown>]> = [
      ["exact quoted heredoc", (fixture) => {
        fixture.items.set("item-1", { ...commandItem(), command: LAUNCHER_COMMAND, commandActions: [{ command: LAUNCHER_COMMAND }] });
        return answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
          threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: LAUNCHER_COMMAND, cwd: "/workspace/project",
        }), launcherContext(fixture));
      }],
      ["semantically equivalent representations across wrapper, request, and action", (fixture) => {
        const unquoted = `${LAUNCHER} <<'GRAPH'\nconsole.log("graph");\nGRAPH`;
        fixture.items.set("item-1", {
          ...commandItem(),
          command: `/bin/zsh -lc ${JSON.stringify(LAUNCHER_COMMAND)}`,
          commandActions: [{ command: unquoted }],
        });
        return answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
          threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: LAUNCHER_COMMAND, cwd: "/workspace/project",
          commandActions: [{ command: unquoted }],
        }), launcherContext(fixture));
      }],
      ["schema-valid outer overlay", (fixture) => {
        fixture.items.set("item-1", { ...commandItem(), command: LAUNCHER_COMMAND, commandActions: [{ command: LAUNCHER_COMMAND }] });
        return answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
          threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: LAUNCHER_COMMAND, cwd: "/workspace/project",
          additionalPermissions: {
            fileSystem: { read: [LAUNCHER], write: ["/workspace/other"] },
            network: { enabled: true },
          },
        }), launcherContext(fixture));
      }],
      ...([
        ["unified exec startup classification", { source: "unifiedExecStartup" }, {}],
        ["unified exec interaction classification", { source: "unifiedExecInteraction" }, {}],
        ["PTY transport classification", {}, { tty: true }],
      ] as const).map(([label, itemOverrides, requestOverrides]) => [label, (fixture: BridgeFixture) => {
        fixture.items.set("item-1", { ...commandItem(), ...itemOverrides, command: LAUNCHER_COMMAND, commandActions: [{ command: LAUNCHER_COMMAND }] });
        return answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
          threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: LAUNCHER_COMMAND, cwd: "/workspace/project", ...requestOverrides,
        }), launcherContext(fixture));
      }] as [string, (fixture: BridgeFixture) => Promise<unknown>]),
      ["before an incomplete Codex network classification", (fixture) => {
        fixture.items.set("item-1", {
          ...commandItem(),
          command: `/bin/zsh -lc ${JSON.stringify(LAUNCHER_COMMAND)}`,
          commandActions: [{ command: LAUNCHER_COMMAND }],
        });
        return answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
          threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: LAUNCHER_COMMAND, cwd: "/workspace/project",
          networkApprovalContext: { host: "127.0.0.1", protocol: "http" },
        }), launcherContext(fixture));
      }],
      ...(["-c", "-lc"] as const).map((flag) => [`sole zsh ${flag} display wrapper before command actions arrive`, (fixture: BridgeFixture) => {
        fixture.items.set("item-1", { ...commandItem(), command: `/bin/zsh ${flag} ${JSON.stringify(LAUNCHER_COMMAND)}` });
        return answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
          threadId: "thread-1", turnId: "turn-1", itemId: "item-1", cwd: "/workspace/project",
        }), launcherContext(fixture));
      }] as [string, (fixture: BridgeFixture) => Promise<unknown>]),
      ["sole request command action over a redacted item command", (fixture) => {
        fixture.items.set("item-1", { ...commandItem(), command: "/bin/zsh -c <redacted>" });
        return answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
          threadId: "thread-1", turnId: "turn-1", itemId: "item-1", cwd: "/workspace/project",
          commandActions: [{ type: "unknown", command: LAUNCHER_COMMAND }],
        }), launcherContext(fixture));
      }],
      ["sole request command action with advertised amendment decisions", (fixture) => {
        fixture.items.set("item-1", { ...commandItem(), command: "/bin/zsh -c <redacted>" });
        return answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
          threadId: "thread-1", turnId: "turn-1", itemId: "item-1", cwd: "/workspace/project",
          commandActions: [{ type: "unknown", command: LAUNCHER_COMMAND }],
          availableDecisions: [
            "accept",
            { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["/bin/zsh", "-c", LAUNCHER_COMMAND] } },
            "cancel",
          ],
        }), launcherContext(fixture));
      }],
    ];
    expect(acceptCases, "every trusted launcher representation is covered").toHaveLength(11);
    for (const [label, run] of acceptCases) {
      const fixture = bridgeFixture("deny");
      await expect.soft(run(fixture), `${label}: the pinned launcher is accepted`).resolves.toEqual({ decision: "accept" });
      expect.soft(fixture.request, `${label}: the pinned launcher never opens a product approval`).not.toHaveBeenCalled();
    }

    const recognitionCases = [
      ["quoted EOF heredoc", LAUNCHER_COMMAND, true],
      ["unquoted RELAYER_GRAPH_PROGRAM delimiter", `${LAUNCHER} <<'RELAYER_GRAPH_PROGRAM'\nconsole.log("graph");\nRELAYER_GRAPH_PROGRAM`, true],
      ["quoted RELAYER_GRAPH_PROGRAM delimiter", `"${LAUNCHER}" <<'RELAYER_GRAPH_PROGRAM'\nconsole.log("graph");\nRELAYER_GRAPH_PROGRAM`, true],
      ["end of input terminates the heredoc", `"${LAUNCHER}" <<'RELAYER_GRAPH_PROGRAM'\nconsole.log("graph");\n`, true],
      ["empty heredoc body", `"${LAUNCHER}" <<'EOF'\n`, false],
      ["escaped action after the EOF delimiter", `${LAUNCHER_COMMAND}\necho escaped\nEOF`, false],
      ["escaped action after the RELAYER_GRAPH_PROGRAM delimiter", `"${LAUNCHER}" <<'RELAYER_GRAPH_PROGRAM'\nconsole.log("graph");\nRELAYER_GRAPH_PROGRAM\necho escaped\nRELAYER_GRAPH_PROGRAM`, false],
      ["launcher arguments before the heredoc", `"${LAUNCHER}" --flag <<'EOF'\ngraph\nEOF`, false],
    ] as const;
    expect(recognitionCases, "every launcher shape is covered").toHaveLength(8);
    for (const [label, command, accepted] of recognitionCases) {
      expect(isExactGraphAuthoringLauncherCommand(command, LAUNCHER), `launcher recognition: ${label}`).toBe(accepted);
    }

    const declineCases: Array<[label: string, run: (fixture: BridgeFixture) => Promise<unknown>]> = [
      ["request command conflicts with the pinned launcher", (fixture) => {
        fixture.items.set("item-1", { ...commandItem(), command: LAUNCHER_COMMAND, commandActions: [{ command: LAUNCHER_COMMAND }] });
        return answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
          threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "echo escaped", cwd: "/workspace/project",
        }), launcherContext(fixture));
      }],
      ["request command action conflicts with the pinned launcher", (fixture) => {
        fixture.items.set("item-1", { ...commandItem(), command: LAUNCHER_COMMAND, commandActions: [{ command: LAUNCHER_COMMAND }] });
        return answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
          threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: LAUNCHER_COMMAND, cwd: "/workspace/project",
          commandActions: [{ command: "echo escaped" }],
        }), launcherContext(fixture));
      }],
      ["item command action conflicts with the pinned launcher", (fixture) => {
        fixture.items.set("item-1", { ...commandItem(), command: LAUNCHER_COMMAND, commandActions: [{ command: "echo escaped" }] });
        return answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
          threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: LAUNCHER_COMMAND, cwd: "/workspace/project",
        }), launcherContext(fixture));
      }],
      ["zsh display wrapper with an escaped continuation", (fixture) => {
        fixture.items.set("item-1", {
          ...commandItem(),
          command: `/bin/zsh -c ${JSON.stringify(LAUNCHER_COMMAND)}; echo escaped`,
        });
        return answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
          threadId: "thread-1", turnId: "turn-1", itemId: "item-1", cwd: "/workspace/project",
        }), launcherContext(fixture));
      }],
      ["a second item command action escapes the launcher", (fixture) => {
        fixture.items.set("item-1", { ...commandItem(), command: "/bin/zsh -c <redacted>" });
        return answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
          threadId: "thread-1", turnId: "turn-1", itemId: "item-1", cwd: "/workspace/project",
          commandActions: [{ type: "unknown", command: LAUNCHER_COMMAND }, { type: "unknown", command: "echo escaped" }],
        }), launcherContext(fixture));
      }],
      ["incomplete network classification with an escaped second action", (fixture) => {
        fixture.items.set("item-1", {
          ...commandItem(),
          command: `/bin/zsh -lc ${JSON.stringify(LAUNCHER_COMMAND)}`,
          commandActions: [{ command: LAUNCHER_COMMAND }, { command: "echo escaped" }],
        });
        return answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
          threadId: "thread-1", turnId: "turn-1", itemId: "item-1", cwd: "/workspace/project",
          networkApprovalContext: { host: "127.0.0.1", protocol: "http" },
        }), launcherContext(fixture));
      }],
    ];
    expect(declineCases, "every divergence is covered").toHaveLength(6);
    for (const [label, run] of declineCases) {
      const fixture = bridgeFixture("deny");
      await expect.soft(run(fixture), `${label}: the bridge fails closed`).resolves.toEqual({ decision: "decline" });
    }

    const otherCwd = bridgeFixture("deny");
    const otherCwdDir = "/workspace/other";
    otherCwd.items.set("item-1", { ...commandItem(), command: LAUNCHER_COMMAND, commandActions: [{ command: LAUNCHER_COMMAND }], cwd: otherCwdDir });
    await expect(answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: LAUNCHER_COMMAND, cwd: otherCwdDir,
    }), launcherContext(otherCwd)), "a pinned launcher from another working directory routes through the product approval channel").resolves.toEqual({ decision: "decline" });
    expect(otherCwd.request, "the other-directory launcher opens the product approval").toHaveBeenCalledOnce();
  }, 10_000);

  it("derives one exact key per file path and change kind and fails closed for under-specified authority", async () => {
    const fileFixture = bridgeFixture("approve_always");
    fileFixture.items.set("file-1", {
      type: "fileChange",
      id: "file-1",
      changes: [
        { path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "@@" },
        { path: "/workspace/project/src/b.ts", kind: { type: "delete" }, diff: "@@" },
      ],
    });

    const fileResult = await answerCodexServerRequest(serverRequest("item/fileChange/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "file-1",
      grantRoot: "/workspace/project",
    }), fileFixture.context);

    expect(fileResult, "an approved file change is accepted").toEqual({ decision: "accept" });
    expect(fileFixture.request.mock.calls[0]![0], "file changes derive one exact key per proposed path and change kind").toMatchObject({
      action: {
        kind: "file_change",
        affectedFiles: ["/workspace/project/src/a.ts", "/workspace/project/src/b.ts"],
      },
      scopeKeys: [
        expect.stringMatching(/^codex:file:v1:sha256:/),
        expect.stringMatching(/^codex:file:v1:sha256:/),
      ],
    });

    const networkFixture = bridgeFixture("approve_once");
    networkFixture.items.set("item-1", commandItem());
    const networkResult = await answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      environmentId: "local",
      networkApprovalContext: { host: "example.com", protocol: "https", port: 443 },
    }), networkFixture.context);

    expect(networkResult, "a future network shape is accepted only when host, protocol, and port are exact").toEqual({ decision: "accept" });
    expect(networkFixture.request.mock.calls[0]![0], "network approvals key the exact destination").toMatchObject({
      action: { kind: "network", networkDestination: "example.com:443" },
      scopeKeys: [expect.stringMatching(/^codex:network:v1:sha256:/)],
    });

    const underSpecified = bridgeFixture("approve_once");
    underSpecified.items.set("item-1", commandItem());
    await expect(answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      environmentId: "local",
      networkApprovalContext: { host: "example.com", protocol: "https" },
    }), underSpecified.context), "a network request without an explicit port fails closed").resolves.toEqual({ decision: "decline" });

    underSpecified.items.set("item-2", { ...commandItem(), id: "item-2", source: "unifiedExecStartup" });
    await expect(answerCodexServerRequest(serverRequest("item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-2",
      command: "npm test",
      cwd: "/workspace/project",
    }), underSpecified.context), "possible TTY authority from unified exec fails closed").resolves.toEqual({ decision: "decline" });
    expect(underSpecified.request, "under-specified authority never opens a product approval").not.toHaveBeenCalled();
  });

  it("grants the exact requested Codex permissions for the current turn and reuses approve_always only for the exact canonical profile", async () => {
    for (const decision of ["approve_once", "approve_always"] as const) {
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

      expect(result, `${decision} grants the exact requested permissions for the current turn`).toEqual({
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
      expect(input, `${decision} opens one keyed permission approval`).toMatchObject({
        providerItemId: "item/permissions/requestApproval:provider-request-1:permission-1",
        title: "Grant Codex permissions for this turn",
        action: { kind: "other", workingDirectory: "/workspace/project" },
        scopeKeys: [expect.stringMatching(/^codex:permissions:v1:sha256:[a-f0-9]{64}$/)],
      });
      expect(input.action.kind, `${decision} keeps the permission action opaque`).toBe("other");
      if (input.action.kind !== "other") throw new Error("expected other approval action");
      expect(input.action.action, `${decision} names the turn scope in the action`).toContain("current turn");
      expect(input.action.action, `${decision} names the read path`).toContain("/workspace/shared");
      expect(input.action.action, `${decision} names the write path`).toContain("/workspace/project");
      expect(input.scopeDescription, `${decision} bounds the scope description to the turn`).toContain("only for the current turn");
      expect(input.scopeDescription, `${decision} binds the grant to the live session`).toContain("live Relayer harness session");
      expect(JSON.stringify(result), `${decision} never grants session scope`).not.toContain("session");
      expect(JSON.stringify(result), `${decision} never echoes auto-review internals`).not.toContain("strictAutoReview");
    }

    const denied = bridgeFixture("deny");
    await expect(answerCodexServerRequest(permissionRequest(networkPermission()), denied.context), "a denied permission request maps to an empty turn grant")
      .resolves.toEqual({ permissions: {}, scope: "turn" });

    const cleared = bridgeFixture("approve_once");
    cleared.request.mockRejectedValue(new HarnessApprovalRequestTerminatedError({
      requestId: "request-1",
      correlation: { threadId: 1, interactionId: 2, completeCallId: "complete-1", harnessSessionId: "session-1" },
      outcome: "aborted",
      actor: "host",
      resolvedAt: "2026-08-20T15:00:00.000Z",
    }));
    await expect(answerCodexServerRequest(permissionRequest(networkPermission()), cleared.context), "a cleared permission request maps to an empty turn grant")
      .resolves.toEqual({ permissions: {}, scope: "turn" });

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
    await expect(first, "approve_always grants the exact requested profile").resolves.toEqual({
      permissions: normalizedFileWritePermission("/workspace/CaseSensitive"),
      scope: "turn",
    });

    await expect(answerCodexServerRequest(
      permissionRequest(fileWritePermission("/workspace/CaseSensitive"), { id: "provider-request-2", itemId: "permission-2" }),
      bridged,
    ), "an exact later profile is auto-approved by the session grant").resolves.toEqual({
      permissions: normalizedFileWritePermission("/workspace/CaseSensitive"),
      scope: "turn",
    });
    const exactResolution = coordinator.snapshot(0).events.filter((event) => event.type === "resolved").at(-1);
    expect(exactResolution, "the reused grant records session-grant provenance").toMatchObject({ resolution: { actor: "session_grant", decision: "approve_once" } });

    const near = answerCodexServerRequest(
      permissionRequest(fileWritePermission("/workspace/casesensitive"), { id: "provider-request-3", itemId: "permission-3" }),
      bridged,
    );
    const nearPending = coordinator.snapshot(0).pendingRequests;
    expect(nearPending, "a case-divergent profile stays pending").toHaveLength(1);
    expect(nearPending[0]!.scopeKeys, "the case-divergent profile keys differently").not.toEqual(firstPending.scopeKeys);
    coordinator.decide(nearPending[0]!.requestId, { decision: "deny" });
    await expect(near, "the denied near profile maps to an empty grant").resolves.toEqual({ permissions: {}, scope: "turn" });
    coordinator.endCompletion("complete-1");
  }, 10_000);

  it("fails malformed permissions closed and keys every authority dimension canonically", async () => {
    const fixture = bridgeFixture("approve_once");
    const complete = permissionRequest(networkPermission());
    const { reason: _reason, ...missingReason } = complete.params;
    const requests: ReadonlyArray<readonly [label: string, request: CodexServerRequest]> = [
      ["miscorrelated turn", permissionRequest(networkPermission(), { turnId: "wrong-turn" })],
      ["empty itemId", permissionRequest(networkPermission(), { itemId: "" })],
      ["non-positive startedAtMs", permissionRequest(networkPermission(), { startedAtMs: 0 })],
      ["empty permission set", permissionRequest({ network: { enabled: false }, fileSystem: null })],
      ["unsupported network authority", permissionRequest({ network: { enabled: true, futureAuthority: true }, fileSystem: null })],
      ["missing fileSystem field", permissionRequest({ network: { enabled: true } })],
      ["relative file path", permissionRequest(fileWritePermission("relative/path"))],
      ["entries inconsistent with the write list", permissionRequest({
        network: null,
        fileSystem: {
          read: null,
          write: ["/workspace/a"],
          entries: [{ path: { type: "path", path: "/workspace/b" }, access: "write" }],
        },
      })],
      ["glob entry without list authority", permissionRequest({
        network: null,
        fileSystem: {
          read: null,
          write: null,
          entries: [{ path: { type: "glob_pattern", pattern: "**/*.env" }, access: "read" }],
        },
      })],
      ["fileSystem future authority", permissionRequest({ network: null, fileSystem: { read: [], write: [], futureAuthority: true } })],
      ["missing reason", serverRequest("item/permissions/requestApproval", missingReason)],
      ["null params", serverRequest("item/permissions/requestApproval", null)],
    ];
    expect(requests, "every malformed permission shape is covered").toHaveLength(12);
    for (const [label, request] of requests) {
      await expect.soft(answerCodexServerRequest(request, fixture.context), `${label}: malformed permissions fail closed`)
        .resolves.toEqual({ permissions: {}, scope: "turn" });
    }
    expect(fixture.request, "malformed permissions never open a product approval").not.toHaveBeenCalled();

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
    expect(await capturePermissionScopeKey(reordered), "canonical keys are stable across ordering").toBe(baseKey);
    expect(await capturePermissionScopeKey(base, { cwd: "/workspace/other" }), "the working directory is an authority dimension").not.toBe(baseKey);
    expect(await capturePermissionScopeKey(base, { environmentId: "remote" }), "the environment is an authority dimension").not.toBe(baseKey);
    expect(await capturePermissionScopeKey({
      ...base,
      fileSystem: { ...base.fileSystem, globScanMaxDepth: 5 },
    }), "glob scan depth is an authority dimension").not.toBe(baseKey);
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
    }), "per-path access is an authority dimension").not.toBe(baseKey);
  }, 10_000);

  it("maps recognized MCP tool approvals by exact target and fails elicitation closed", async () => {
    const elicitation = bridgeFixture("approve_once");
    await expect(answerCodexServerRequest(serverRequest("mcpServer/elicitation/request", {}), elicitation.context), "generic MCP elicitation fails closed")
      .resolves.toEqual({ action: "decline", content: null, _meta: null });
    await expect(answerCodexServerRequest(serverRequest("item/tool/requestUserInput", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "tool-1",
      isBlocking: true,
      questions: [{ id: "q1", question: "Enter a secret", isSecret: true, options: null }],
    }), elicitation.context), "secret questions fail closed").resolves.toEqual({ answers: {} });
    expect(elicitation.request, "failed-closed elicitation never opens a Relayer approval").not.toHaveBeenCalled();

    const recognized = bridgeFixture("approve_always");
    recognized.items.set("tool-1", {
      type: "mcpToolCall",
      id: "tool-1",
      server: "github",
      tool: "create_issue",
      arguments: { owner: "acme", repo: "app", title: "Bug" },
      appContext: { resourceUri: "github://acme/app" },
      readOnlyHint: false,
    });

    const recognizedResult = await answerCodexServerRequest(serverRequest("item/tool/requestUserInput", {
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
    }), recognized.context);

    expect(recognizedResult, "a recognized one-question MCP approval answers the exact question").toEqual({ answers: { approve: { answers: ["Accept"] } } });
    expect(recognized.request.mock.calls[0]![0], "the MCP approval keys the exact target and arguments").toMatchObject({
      action: { kind: "other", action: "Call github.create_issue" },
      scopeKeys: [expect.stringMatching(/^codex:mcp:v1:sha256:/)],
    });

    const pinnedApproval = [
      ["approve_once", "Allow"],
      ["deny", "Cancel"],
    ] as const;
    for (const [decision, label] of pinnedApproval) {
      const fixture = bridgeFixture(decision);
      fixture.items.set("tool-1", {
        type: "mcpToolCall",
        id: "tool-1",
        server: "chrome-devtools",
        tool: "evaluate_script",
        arguments: { pageId: 1, function: "() => document.title" },
        readOnlyHint: false,
      });

      const result = await answerCodexServerRequest(serverRequest("item/tool/requestUserInput", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        isBlocking: true,
        questions: [{
          id: "mcp_tool_call_approval_call-1",
          header: "Approve app tool call?",
          question: "Allow chrome-devtools.evaluate_script?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Allow", description: "Run the tool and continue." },
            { label: "Cancel", description: "Cancel this tool call." },
          ],
        }],
      }), fixture.context);

      expect(result, `pinned Codex 0.147 MCP ${decision} answers with its exact ${label} label`).toEqual({
        answers: { "mcp_tool_call_approval_call-1": { answers: [label] } },
      });
      expect(fixture.request, `pinned Codex 0.147 MCP ${decision} opens one product approval`).toHaveBeenCalledOnce();
    }
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

function v2Command(overrides: Readonly<Record<string, unknown>> = {}) {
  return serverRequest("item/commandExecution/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    environmentId: "local",
    command: "npm test",
    cwd: "/workspace/project",
    ...overrides,
  });
}
