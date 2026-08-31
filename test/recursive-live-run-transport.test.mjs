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
  it("authenticates product JSON requests with the loopback session cookie", async () => {
    const origin = await serve((request, response) => {
      expect(request.url).toBe("/api/model-families");
      expect(request.headers.cookie).toBe("relayer_session=session-value");
      expect(request.headers["content-type"]).toBe("application/json");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 41 }));
    });

    await expect(productRequest({
      origin,
      cookie: { name: "relayer_session", value: "session-value" },
    }, "/api/model-families", {
      method: "POST",
      body: JSON.stringify({ name: "Live run models" }),
    })).resolves.toEqual({ id: 41 });
  });

  it("reads completion invocation metadata through graph control authority", async () => {
    const graphUrl = await serve((request, response) => {
      expect(request.headers.authorization).toBe("Bearer graph-control");
      const nodeId = Number(request.url.split("/").at(-1));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ nodeId, invocation: nodeId === 2
        ? { sourceInteractionNodeId: 1, sourceActionId: 7 }
        : null }));
    });

    await expect(completionMetadata({
      graphUrl,
      graphControlToken: "graph-control",
    }, [1, 2])).resolves.toEqual([
      { nodeId: 1, invocation: null },
      { nodeId: 2, invocation: { sourceInteractionNodeId: 1, sourceActionId: 7 } },
    ]);
  });

  it("reads effective temporal features through graph control authority", async () => {
    const graphUrl = await serve((request, response) => {
      expect(request.url).toBe("/api/control/temporal-features");
      expect(request.headers.authorization).toBe("Bearer graph-control");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        configVersion: 1,
        schemaRead: true,
        rootCurrentWrite: true,
        projectionUi: true,
        invokeResolution: true,
        providerRecursion: true,
      }));
    });

    await expect(temporalFeatures({ graphUrl, graphControlToken: "graph-control" }))
      .resolves.toMatchObject({ configVersion: 1, providerRecursion: true });
  });

  it("reads sanitized durable attachment and settlement evidence from the production schema", async () => {
    const database = await completionDatabase();
    const canonicalAttachment = JSON.stringify({
      provider: "codex",
      schemaVersion: 1,
      threadId: "native-thread-secret",
      turnId: "native-turn-secret",
    });

    const evidence = await completionExecutionEvidence(database);

    expect(evidence).toEqual([
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
    expect(JSON.stringify(evidence)).not.toContain("native-thread-secret");
    expect(JSON.stringify(evidence)).not.toContain("native-turn-secret");
    expect(JSON.stringify(evidence)).not.toContain("rootLayer");
  });

  it("hashes canonical attachment JSON independently of stored object key order", async () => {
    const first = await completionDatabase();
    const second = await completionDatabase({ attachment: JSON.stringify({
      schemaVersion: 1,
      threadId: "native-thread-secret",
      provider: "codex",
      turnId: "native-turn-secret",
    }) });

    const [left] = await completionExecutionEvidence(first);
    const [right] = await completionExecutionEvidence(second);

    expect(left.attachment.sha256).toBe(right.attachment.sha256);
  });

  it("rejects malformed durable attachment JSON without returning its raw bytes", async () => {
    const database = await completionDatabase({ attachment: "{native-secret" });

    await expect(completionExecutionEvidence(database)).rejects.toThrow(
      "SQLite stored invalid attachment JSON for completion 202",
    );
    await expect(completionExecutionEvidence(database)).rejects.not.toThrow(/native-secret/);
  });

  it("rejects an unbounded provider identity or unsupported attachment schema", async () => {
    const identity = await completionDatabase({ attachment: JSON.stringify({
      provider: "codex secret identity",
      schemaVersion: 1,
    }) });
    const schema = await completionDatabase({ attachment: JSON.stringify({
      provider: "codex",
      schemaVersion: 2,
    }) });

    await expect(completionExecutionEvidence(identity)).rejects.toThrow(
      "SQLite stored an invalid provider attachment for completion 202",
    );
    await expect(completionExecutionEvidence(schema)).rejects.toThrow(
      "SQLite stored an invalid provider attachment for completion 202",
    );
  });

  it("marks malformed or non-object settlement JSON invalid without exposing it", async () => {
    const malformed = await completionDatabase({ settlement: "{settlement-secret" });
    const nonObject = await completionDatabase({ settlement: '"settlement-secret"' });

    const malformedEvidence = await completionExecutionEvidence(malformed);
    const nonObjectEvidence = await completionExecutionEvidence(nonObject);

    expect(malformedEvidence[0].settlement).toMatchObject({ present: true, valid: false });
    expect(nonObjectEvidence[0].settlement).toMatchObject({ present: true, valid: false });
    expect(JSON.stringify([malformedEvidence, nonObjectEvidence])).not.toContain("settlement-secret");
  });

  it("waits through the accepted-to-settled commit ordering race", async () => {
    const database = await completionDatabase({ phase: "attached", settlement: null });
    setTimeout(() => {
      execFileSync("/usr/bin/sqlite3", [database, `
        UPDATE completion_executions
        SET phase='settled', settlement_json='{"rootLayer":{"layer":{"id":900}}}', updated_at='2100'
        WHERE graph_completion_id=202;
      `]);
    }, 30);

    const evidence = await waitForSettledCompletionExecutionEvidence(database, [202], {
      timeoutMs: 1_000,
      pollIntervalMs: 10,
    });

    expect(evidence[0]).toMatchObject({
      completionId: 202,
      phase: "settled",
      settlement: { present: true, valid: true },
      updatedAt: "2100",
    });
  });

  it("fails a bounded settlement wait for missing rows and invalid timing", async () => {
    const database = await completionDatabase({ phase: "attached", settlement: null });

    await expect(waitForSettledCompletionExecutionEvidence(database, [202], {
      timeoutMs: 20,
      pollIntervalMs: 5,
    })).rejects.toThrow(/did not settle before timeout: 202/);
    await expect(waitForSettledCompletionExecutionEvidence(database, [202], {
      timeoutMs: Number.POSITIVE_INFINITY,
    })).rejects.toThrow(/bounded positive timing values/);
  });

  it("reports a missing database or SQLite executable as an evidence read failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recursive-live-transport-"));
    temporaryDirectories.push(directory);

    await expect(completionExecutionEvidence(join(directory, "missing.sqlite3"))).rejects.toThrow(
      /Could not read durable completion-execution evidence/,
    );
    await expect(completionExecutionEvidence(join(directory, "missing.sqlite3"), {
      sqliteExecutable: join(directory, "missing-sqlite3"),
    })).rejects.toThrow(/Could not read durable completion-execution evidence/);
  });
});
