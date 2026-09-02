import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  completionExecutionEvidence,
  completionMetadata,
  productRequest,
  temporalFeatures,
  waitForSettledCompletionExecutionEvidence,
} from "../scripts/recursive-live-run-transport.mjs";

const servers = [];
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function serve(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function completionDatabase({ attachment = JSON.stringify({
  turnId: "native-turn-secret",
  provider: "codex",
  schemaVersion: 1,
  threadId: "native-thread-secret",
}), settlement = '{"rootLayer":{"layer":{"id":900}}}', phase = "settled" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "recursive-live-transport-"));
  temporaryDirectories.push(directory);
  const database = join(directory, "product.sqlite3");
  const sql = `
    CREATE TABLE interactions (
      id INTEGER PRIMARY KEY,
      graph_node_id INTEGER,
      completion_status TEXT NOT NULL
    );
    CREATE TABLE action_invocations (
      source_interaction_id INTEGER NOT NULL,
      action_id INTEGER NOT NULL,
      result_interaction_id INTEGER NOT NULL,
      authoritative INTEGER NOT NULL
    );
    CREATE TABLE completion_executions (
      interaction_id INTEGER PRIMARY KEY,
      graph_completion_id INTEGER NOT NULL,
      phase TEXT NOT NULL,
      attachment_json TEXT,
      settlement_json TEXT,
      safe_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO interactions VALUES
      (1, 101, 'accepted'),
      (2, 202, 'accepted'),
      (3, 303, 'failed');
    INSERT INTO action_invocations VALUES
      (1, 41, 2, 1),
      (1, 42, 3, 1);
    INSERT INTO completion_executions VALUES
      (2, 202, ${sqlString(phase)}, ${sqlString(attachment)}, ${settlement === null ? "NULL" : sqlString(settlement)}, NULL, '1000', '2000'),
      (3, 303, 'settled', NULL, NULL, 'provider_start_failed', '3000', '4000');
  `;
  execFileSync("/usr/bin/sqlite3", [database, sql]);
  return database;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

describe("recursive live run transport", () => {
  it("authenticates product JSON and graph-control reads with their exact loopback credentials", async () => {
    const origin = await serve((request, response) => {
      expect.soft(request.url, "product request path").toBe("/api/model-families");
      expect.soft(request.headers.cookie, "loopback session cookie").toBe("relayer_session=session-value");
      expect.soft(request.headers["content-type"], "json content type").toBe("application/json");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 41 }));
    });

    await expect(productRequest({
      origin,
      cookie: { name: "relayer_session", value: "session-value" },
    }, "/api/model-families", {
      method: "POST",
      body: JSON.stringify({ name: "Live run models" }),
    }), "product JSON round-trip").resolves.toEqual({ id: 41 });

    const graphUrl = await serve((request, response) => {
      expect.soft(request.headers.authorization, "graph-control bearer authority").toBe("Bearer graph-control");
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/api/control/temporal-features") {
        response.end(JSON.stringify({
          configVersion: 1,
          schemaRead: true,
          rootCurrentWrite: true,
          projectionUi: true,
          invokeResolution: true,
          providerRecursion: true,
        }));
        return;
      }
      const nodeId = Number(request.url.split("/").at(-1));
      response.end(JSON.stringify({ nodeId, invocation: nodeId === 2
        ? { sourceInteractionNodeId: 1, sourceActionId: 7 }
        : null }));
    });

    await expect(completionMetadata({
      graphUrl,
      graphControlToken: "graph-control",
    }, [1, 2]), "invocation metadata per node").resolves.toEqual([
      { nodeId: 1, invocation: null },
      { nodeId: 2, invocation: { sourceInteractionNodeId: 1, sourceActionId: 7 } },
    ]);
    await expect(temporalFeatures({ graphUrl, graphControlToken: "graph-control" }), "effective temporal features")
      .resolves.toMatchObject({ configVersion: 1, providerRecursion: true });
  }, 15_000);

  it("reads sanitized, validated, settled completion-execution evidence from the production schema", async () => {
    const database = await completionDatabase();
    const canonicalAttachment = JSON.stringify({
      provider: "codex",
      schemaVersion: 1,
      threadId: "native-thread-secret",
      turnId: "native-turn-secret",
    });

    const evidence = await completionExecutionEvidence(database);

    expect(evidence, "sanitized evidence rows from the production schema").toEqual([
      {
        interactionId: 2,
        completionId: 202,
        sourceInteractionId: 1,
        sourceCompletionId: 101,
        sourceActionId: 41,
        phase: "settled",
        attachment: {
          present: true,
          provider: "codex",
          schemaVersion: 1,
          sha256: `sha256:${createHash("sha256").update(canonicalAttachment).digest("hex")}`,
        },
        settlement: { present: true, valid: true, completionStatus: "accepted" },
        createdAt: "1000",
        updatedAt: "2000",
      },
      {
        interactionId: 3,
        completionId: 303,
        sourceInteractionId: 1,
        sourceCompletionId: 101,
        sourceActionId: 42,
        phase: "settled",
        attachment: { present: false },
        settlement: {
          present: false,
          valid: false,
          completionStatus: "failed",
          safeReason: "provider_start_failed",
        },
        createdAt: "3000",
        updatedAt: "4000",
      },
    ]);
    const serialized = JSON.stringify(evidence);
    expect(serialized, "thread secret stays in the database").not.toContain("native-thread-secret");
    expect(serialized, "turn secret stays in the database").not.toContain("native-turn-secret");
    expect(serialized, "settlement payload stays in the database").not.toContain("rootLayer");

    const reordered = await completionDatabase({ attachment: JSON.stringify({
      schemaVersion: 1,
      threadId: "native-thread-secret",
      provider: "codex",
      turnId: "native-turn-secret",
    }) });
    const [reorderedRow] = await completionExecutionEvidence(reordered);
    expect(evidence[0].attachment.sha256, "the canonical hash ignores stored key order")
      .toBe(reorderedRow.attachment.sha256);

    const invalidCases = [
      ["malformed attachment JSON", { attachment: "{native-secret" },
        /SQLite stored invalid attachment JSON for completion 202/, /native-secret/],
      ["an unbounded provider identity", { attachment: JSON.stringify({ provider: "codex secret identity", schemaVersion: 1 }) },
        /SQLite stored an invalid provider attachment for completion 202/, /codex secret identity/],
      ["an unsupported attachment schema", { attachment: JSON.stringify({ provider: "codex", schemaVersion: 2 }) },
        /SQLite stored an invalid provider attachment for completion 202/, /native-secret/],
    ];
    expect(invalidCases, "invalid attachment inventory").toHaveLength(3);
    for (const [label, options, expected, secret] of invalidCases) {
      const candidate = await completionDatabase(options);
      await expect(completionExecutionEvidence(candidate), `${label}: fails closed`).rejects.toThrow(expected);
      await expect(completionExecutionEvidence(candidate), `${label}: raw bytes stay hidden`)
        .rejects.not.toThrow(secret);
    }

    const settlementCases = [
      ["malformed settlement JSON", "{settlement-secret"],
      ["a non-object settlement", '"settlement-secret"'],
    ];
    for (const [label, settlement] of settlementCases) {
      const candidate = await completionDatabase({ settlement });
      const rows = await completionExecutionEvidence(candidate);
      expect(rows[0].settlement, `${label}: present but invalid`).toMatchObject({ present: true, valid: false });
      expect(JSON.stringify(rows), `${label}: raw bytes stay hidden`).not.toContain("settlement-secret");
    }

    const pending = await completionDatabase({ phase: "attached", settlement: null });
    setTimeout(() => {
      execFileSync("/usr/bin/sqlite3", [pending, `
        UPDATE completion_executions
        SET phase='settled', settlement_json='{"rootLayer":{"layer":{"id":900}}}', updated_at='2100'
        WHERE graph_completion_id=202;
      `]);
    }, 30);
    const settled = await waitForSettledCompletionExecutionEvidence(pending, [202], {
      timeoutMs: 1_000,
      pollIntervalMs: 10,
    });
    expect(settled[0], "waits through the accepted-to-settled commit ordering race").toMatchObject({
      completionId: 202,
      phase: "settled",
      settlement: { present: true, valid: true },
      updatedAt: "2100",
    });

    const stuck = await completionDatabase({ phase: "attached", settlement: null });
    await expect(waitForSettledCompletionExecutionEvidence(stuck, [202], {
      timeoutMs: 20,
      pollIntervalMs: 5,
    }), "a bounded wait names the unsettled completion").rejects.toThrow(/did not settle before timeout: 202/);
    await expect(waitForSettledCompletionExecutionEvidence(stuck, [202], {
      timeoutMs: Number.POSITIVE_INFINITY,
    }), "wait timing must be bounded and positive").rejects.toThrow(/bounded positive timing values/);

    const directory = await mkdtemp(join(tmpdir(), "recursive-live-transport-"));
    temporaryDirectories.push(directory);
    await expect(completionExecutionEvidence(join(directory, "missing.sqlite3")),
      "a missing database is an evidence read failure").rejects.toThrow(/Could not read durable completion-execution evidence/);
    await expect(completionExecutionEvidence(join(directory, "missing.sqlite3"), {
      sqliteExecutable: join(directory, "missing-sqlite3"),
    }), "a missing SQLite executable is an evidence read failure")
      .rejects.toThrow(/Could not read durable completion-execution evidence/);
  }, 30_000);
});
